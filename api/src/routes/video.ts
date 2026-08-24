import { Elysia, t } from "elysia";
import { spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { redis } from "../db.ts";
import { authed } from "../auth-plugin.ts";

// Video URL resolution. The client cannot run yt-dlp (least of all on Quest), so the server
// turns any supported page URL into concrete, directly-playable stream URLs.
//
// Supported inputs:
//   - YouTube, Niconico, Bilibili and every other yt-dlp extractor
//   - direct media: .mp4/.webm/.mkv/.mov, HLS (.m3u8), DASH (.mpd)
//
// Adaptive formats (HLS/DASH) are returned as their manifest so the player can switch
// renditions itself; progressive formats are returned per-resolution. Tracks are always
// sorted best-first, so "default to highest" is just picking tracks[0].

const CACHE_TTL_SECONDS = 60 * 30; // resolved URLs are usually signed and expire
const RESOLVE_TIMEOUT_MS = 25_000;
const YTDLP = process.env.YTDLP_PATH ?? "yt-dlp";

/// Live server-side transcodes. Each one is a whole ffmpeg process pinning a core, so this is
/// capped rather than left to grow with demand; over the cap the endpoint returns 503 and the
/// client falls back or retries. Most desktop clients transcode locally and never come here.
const MAX_CONCURRENT_TRANSCODES = Number(process.env.MAX_CONCURRENT_TRANSCODES ?? 1);
/// Threads and vertical resolution for a server-side transcode. Bounded so one clip cannot
/// pin the whole box: this endpoint is only a fallback for clients without local ffmpeg, and
/// the API shares its host with everything else.
const SERVER_ENCODE_THREADS = Number(process.env.VIDEO_ENCODE_THREADS ?? 2);
const SERVER_MAX_HEIGHT = Number(process.env.VIDEO_MAX_HEIGHT ?? 480);
let activeTranscodes = 0;

export type Protocol = "progressive" | "hls" | "dash";

export interface Track {
  id: string;
  url: string;
  protocol: Protocol;
  container: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  /** Progressive tracks with no audio stream need a separate audio track muxed in. */
  hasAudio: boolean;
  bitrate: number | null;
  label: string;
}

export interface Resolved {
  provider: string;
  title: string | null;
  thumbnail: string | null;
  /** Seconds; null for live streams. */
  duration: number | null;
  isLive: boolean;
  tracks: Track[];
  /** Best audio-only stream, for muxing with video-only progressive tracks. */
  audioUrl: string | null;
  /** HTTP headers the player must send (referer/cookies) — Bilibili and Niconico need these. */
  headers: Record<string, string>;
}

// ── URL safety ────────────────────────────────────────────────────────────────────────────

const PRIVATE_V4 = [
  /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^0\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
];

/// Reject anything that is not public http(s). Without this the resolver is an SSRF gadget:
/// an attacker could point it at the relay, Redis, or cloud metadata and read the response.
async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid_url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("unsupported_scheme");

  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("private_host");
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch {
    throw new Error("dns_failed");
  }
  for (const a of addrs) {
    if (a.family === 4 && PRIVATE_V4.some((re) => re.test(a.address))) throw new Error("private_host");
    // IPv6 loopback/link-local/unique-local.
    if (a.family === 6 && /^(::1|fe80:|fc|fd)/i.test(a.address)) throw new Error("private_host");
  }
  return u;
}

// ── Direct media fast path ────────────────────────────────────────────────────────────────

function directKind(u: URL): Protocol | null {
  const p = u.pathname.toLowerCase();
  if (p.endsWith(".m3u8")) return "hls";
  if (p.endsWith(".mpd")) return "dash";
  if (/\.(mp4|webm|mkv|mov|m4v|ogv|avi)$/.test(p)) return "progressive";
  return null;
}

function directResolve(u: URL, kind: Protocol): Resolved {
  const name = decodeURIComponent(u.pathname.split("/").pop() || "video");
  return {
    provider: "direct",
    title: name,
    thumbnail: null,
    duration: null,
    isLive: kind !== "progressive",
    audioUrl: null,
    headers: {},
    tracks: [
      {
        id: "direct",
        url: u.toString(),
        protocol: kind,
        container: kind === "progressive" ? (u.pathname.split(".").pop() ?? null) : null,
        width: null,
        height: null,
        fps: null,
        vcodec: null,
        acodec: null,
        hasAudio: true,
        bitrate: null,
        // Adaptive manifests carry every rendition; the player picks and can switch.
        label: kind === "hls" ? "HLS (auto)" : kind === "dash" ? "DASH (auto)" : "Source",
      },
    ],
  };
}

// ── yt-dlp ────────────────────────────────────────────────────────────────────────────────

// A real browser UA. Bilibili and Niconico serve 412/403 to the default yt-dlp agent.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function runYtDlp(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const args = [
      "-J",                     // dump a single JSON object
      "--no-warnings",
      "--no-playlist",
      "--no-call-home",
      "--socket-timeout", "15",
      "--user-agent", BROWSER_UA,
    ];

    // Bilibili's WAF rejects anonymous datacenter traffic (HTTP 412) unless the request
    // carries a site Referer and, usually, a logged-in cookie jar. Both are operator-supplied:
    //   YTDLP_COOKIES_FILE  Netscape cookie jar (bilibili SESSDATA, age-gated YouTube, …)
    //   YTDLP_PROXY         egress proxy for geo-restricted sources
    if (/bilibili\.com/i.test(url)) args.push("--referer", "https://www.bilibili.com/");
    if (/nicovideo\.jp/i.test(url)) args.push("--referer", "https://www.nicovideo.jp/");
    if (process.env.YTDLP_COOKIES_FILE) args.push("--cookies", process.env.YTDLP_COOKIES_FILE);
    if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);

    args.push(url);
    const child = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("resolve_timeout"));
    }, RESOLVE_TIMEOUT_MS);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error((e as any).code === "ENOENT" ? "ytdlp_missing" : String(e)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim().split("\n").pop() || "resolve_failed"));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("bad_ytdlp_output"));
      }
    });
  });
}

function protocolOf(f: any): Protocol {
  const p = String(f.protocol ?? "");
  if (p.includes("m3u8")) return "hls";
  if (p.includes("dash") || p === "http_dash_segments") return "dash";
  return "progressive";
}

function labelFor(f: any, proto: Protocol): string {
  const h = f.height ? `${f.height}p` : f.format_note || "audio";
  const fps = f.fps && f.fps >= 50 ? String(Math.round(f.fps)) : "";
  const tag = proto === "hls" ? " HLS" : proto === "dash" ? " DASH" : "";
  return `${h}${fps}${tag}`.trim();
}

function toResolved(info: any): Resolved {
  const formats: any[] = Array.isArray(info.formats) ? info.formats : [];

  const videos = formats.filter((f) => f.url && f.vcodec && f.vcodec !== "none");
  const audios = formats.filter((f) => f.url && f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none"));

  // Best audio-only stream for muxing with video-only (DASH/adaptive) tracks.
  const bestAudio = audios.sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0];

  const tracks: Track[] = videos.map((f) => {
    const proto = protocolOf(f);
    return {
      id: String(f.format_id),
      url: f.url,
      protocol: proto,
      container: f.ext ?? null,
      width: f.width ?? null,
      height: f.height ?? null,
      fps: f.fps ?? null,
      vcodec: f.vcodec ?? null,
      acodec: f.acodec && f.acodec !== "none" ? f.acodec : null,
      hasAudio: Boolean(f.acodec && f.acodec !== "none"),
      bitrate: f.tbr ? Math.round(f.tbr) : null,
      label: labelFor(f, proto),
    };
  });

  // Best first: resolution, then fps, then bitrate. The client defaults to tracks[0].
  tracks.sort((a, b) =>
    (b.height ?? 0) - (a.height ?? 0) ||
    (b.fps ?? 0) - (a.fps ?? 0) ||
    (b.bitrate ?? 0) - (a.bitrate ?? 0));

  const headers: Record<string, string> = {};
  const hh = info.http_headers ?? videos[0]?.http_headers ?? {};
  for (const k of ["Referer", "User-Agent", "Origin", "Cookie"]) {
    if (hh[k]) headers[k] = hh[k];
  }

  return {
    provider: info.extractor_key ?? info.extractor ?? "unknown",
    title: info.title ?? null,
    thumbnail: info.thumbnail ?? null,
    duration: typeof info.duration === "number" ? info.duration : null,
    isLive: Boolean(info.is_live),
    tracks,
    audioUrl: bestAudio?.url ?? null,
    headers,
  };
}

export async function resolveVideo(rawUrl: string): Promise<Resolved> {
  const u = await assertPublicUrl(rawUrl);

  const cacheKey = `video:resolve:${u.toString()}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try { return JSON.parse(cached) as Resolved; } catch { /* fall through */ }
  }

  const kind = directKind(u);
  const resolved = kind ? directResolve(u, kind) : toResolved(await runYtDlp(u.toString()));

  if (resolved.tracks.length === 0) throw new Error("no_playable_streams");

  // Cache well inside the signature lifetime of the URLs we just handed out.
  await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(resolved)).catch(() => {});
  return resolved;
}

export const videoRoutes = new Elysia({ prefix: "/v1/video" })
  .use(authed)
  .get(
    "/resolve",
    async ({ query, set }) => {
      const url = (query.url ?? "").trim();
      if (!url) { set.status = 400; return { error: "missing_url" }; }
      try {
        return await resolveVideo(url);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set.status =
          msg === "ytdlp_missing" ? 503 :
          msg === "resolve_timeout" ? 504 :
          msg === "private_host" || msg === "unsupported_scheme" || msg === "invalid_url" ? 400 :
          422;
        return { error: msg };
      }
    },
    { query: t.Object({ url: t.String() }) },
  )
  .get(
    "/transcode",
    async ({ query, set, headers }) => {
      // Transcoding proxy: resolve the URL → pick best track → pipe through ffmpeg →
      // stream ogv/Theora to the client. This lets the Godot client play YouTube etc.
      // without a native mp4/webm decoder GDExtension.
      const url = (query.url ?? "").trim();
      if (!url) { set.status = 400; return { error: "missing_url" }; }

      const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
      const TRANSCODE_TIMEOUT_MS = 120_000;

      try {
        const resolved = await resolveVideo(url);
        // Prefer a track at or below the encode cap so ffmpeg isn't downscaling a 1080p/4K
        // source it will only throw away — that decode is pure wasted CPU on a shared box.
        const track = resolved.tracks.find(t => (t.height ?? 0) <= SERVER_MAX_HEIGHT)
          ?? resolved.tracks.find(t => (t.height ?? 0) <= 720)
          ?? resolved.tracks[0];
        if (!track) { set.status = 422; return { error: "no_playable_streams" }; }

        // Build ffmpeg args: input from the resolved URL (+ audioUrl if separate) → ogv/Theora output to stdout.
        const ffArgs: string[] = ["-y", "-threads", String(SERVER_ENCODE_THREADS)];

        // Video input
        if (resolved.headers["User-Agent"]) ffArgs.push("-user_agent", resolved.headers["User-Agent"]);
        if (resolved.headers.Referer) ffArgs.push("-headers", `Referer: ${resolved.headers.Referer}\r\n`);
        ffArgs.push("-i", track.url);

        const hasSeparateAudio = !track.hasAudio && Boolean(resolved.audioUrl);
        if (hasSeparateAudio && resolved.audioUrl) {
          if (resolved.headers["User-Agent"]) ffArgs.push("-user_agent", resolved.headers["User-Agent"]);
          if (resolved.headers.Referer) ffArgs.push("-headers", `Referer: ${resolved.headers.Referer}\r\n`);
          ffArgs.push("-i", resolved.audioUrl);
        }

        // Stream mapping
        if (hasSeparateAudio) {
          ffArgs.push("-map", "0:v:0", "-map", "1:a:0?");
        } else {
          ffArgs.push("-map", "0:v:0", "-map", "0:a:0?");
        }

        // Video and Audio codec settings for Godot VideoStreamTheora. Cap height (even
        // dimensions for yuv420p) and thread count so a fallback transcode stays cheap.
        ffArgs.push(
          "-vf", `scale=-2:min(${SERVER_MAX_HEIGHT}\\,ih)`,
          "-pix_fmt", "yuv420p",
          "-c:v", "libtheora", "-q:v", "5", "-threads", String(SERVER_ENCODE_THREADS),
          "-c:a", "libvorbis", "-q:a", "4",
          "-shortest",
          "-f", "ogg",
          "pipe:1"
        );

        const ffEnv: Record<string, string> = { ...process.env as Record<string, string> };

        // Every request spawns a full transcode, which is the most expensive thing this
        // service does. Without a cap, N concurrent viewers means N ffmpeg processes and the
        // box falls over; refusing early is much better than dying.
        if (activeTranscodes >= MAX_CONCURRENT_TRANSCODES) {
          set.status = 503;
          return { error: "transcode_busy" };
        }

        // stderr is `ignore`, not `pipe`. A piped stderr that nothing reads fills its 64 KB
        // kernel buffer and then blocks ffmpeg forever mid-write — the process wedges, holds
        // its resources, and only dies on the timeout SIGKILL. ffmpeg writes progress there
        // continuously, so this was reliably reached on any clip of real length.
        const ff = spawn(FFMPEG, ffArgs, {
          stdio: ["ignore", "pipe", "ignore"],
          env: ffEnv,
        });

        activeTranscodes++;
        const timer = setTimeout(() => { try { ff.kill("SIGKILL"); } catch { /* gone */ } },
                                 TRANSCODE_TIMEOUT_MS);

        // Exactly-once cleanup: several of the handlers below can fire for the same transcode
        // (stdout end *and* process close, say), and double-decrementing the slot counter
        // would slowly hand out more concurrent transcodes than the cap allows.
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          activeTranscodes--;
          clearTimeout(timer);
          if (!ff.killed) { try { ff.kill("SIGKILL"); } catch { /* already gone */ } }
        };

        ff.on("error", release);
        ff.on("close", release);

        // ReadableStream from ffmpeg stdout, *with backpressure*. The previous version
        // enqueued every chunk the moment it arrived, so if the client read slower than
        // ffmpeg encoded — the normal case, since ffmpeg outruns most connections — the queue
        // grew without bound until the process ran out of memory. Pausing the pipe when the
        // consumer is behind is what keeps memory flat.
        const readable = new ReadableStream({
          start(controller) {
            ff.stdout.on("data", (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk));
              if ((controller.desiredSize ?? 1) <= 0) ff.stdout.pause();
            });
            ff.stdout.on("end", () => {
              release();
              try { controller.close(); } catch { /* already closed */ }
            });
            ff.stdout.on("error", (err) => {
              release();
              try { controller.error(err); } catch { /* already errored */ }
            });
            ff.on("close", () => {
              release();
              try { controller.close(); } catch { /* already closed */ }
            });
          },
          pull() {
            ff.stdout.resume();
          },
          cancel() {
            // The viewer navigated away or skipped — stop burning CPU on a stream nobody wants.
            release();
          },
        });

        return new Response(readable, {
          headers: {
            "content-type": "video/ogg",
            "cache-control": "no-cache",
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set.status =
          msg === "ytdlp_missing" || msg === "ffmpeg_missing" ? 503 :
          msg === "resolve_timeout" ? 504 :
          msg === "private_host" || msg === "unsupported_scheme" || msg === "invalid_url" ? 400 :
          422;
        return { error: msg };
      }
    },
    { query: t.Object({ url: t.String() }) },
  );
