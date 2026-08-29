import { Elysia, t } from "elysia";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
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

// ── Shared segmented transcode ────────────────────────────────────────────────────────
//
// The `/transcode` endpoint below streams one continuous ogg per request, which has three
// properties that make it unusable as the *primary* path, and which together are why Quest
// had no video at all:
//
//   1. The client cannot play until the whole file has arrived, because Godot's
//      VideoStreamPlayer opens a path through FileAccess — it does not stream. So
//      time-to-first-frame is the entire clip's encode, and the 120 s watchdog SIGKILLs
//      anything longer than about two minutes of encoding first.
//   2. One request is one ffmpeg. With MAX_CONCURRENT_TRANSCODES at 1, the second person in
//      the cinema gets a 503.
//   3. Nothing is cached, so ten people watching one film is ten identical encodes.
//
// A *job* fixes all three and is what makes "only one person needs to encode" true. The job
// is keyed by the source URL and the encode settings, so everyone watching the same thing
// attaches to the same ffmpeg and reads the same segments off disk; the first viewer pays for
// the encode and everyone after is served from cache. ffmpeg writes short self-contained ogg
// segments (`-f segment`), so playback starts one segment in rather than one clip in, and the
// client feeds them to the screen with the same `AppendSegment` playlist machinery the desktop
// local-ffmpeg path already uses.
const JOB_ROOT = process.env.VIDEO_JOB_DIR ?? "/tmp/serika-video";
/// How long a finished job's segments stay on disk after the last request touches them. This
/// is the entire "shared encode" win — set it to zero and every viewer re-encodes.
const JOB_TTL_MS = Number(process.env.VIDEO_JOB_TTL_MS ?? 30 * 60 * 1000);
/// Segment length. Dominates time-to-first-frame, so short; but each one is a separate ogg
/// header plus an HTTP round trip, so not tiny.
const JOB_SEGMENT_SECONDS = Number(process.env.VIDEO_SEGMENT_SECONDS ?? 6);
/// Total bytes of cached segments tolerated before the reaper starts evicting the
/// least-recently-used finished jobs, whatever their TTL.
const JOB_CACHE_MAX_BYTES = Number(process.env.VIDEO_CACHE_MAX_BYTES ?? 4 * 1024 * 1024 * 1024);

interface TranscodeJob {
  id: string;
  dir: string;
  proc: ReturnType<typeof spawn> | null;
  /** Encoder has exited; the segment list is final. */
  done: boolean;
  error: string | null;
  title: string | null;
  duration: number | null;
  lastAccess: number;
  /** Resolves once ffmpeg has been spawned (or failed to start). */
  starting: Promise<void> | null;
}

const jobs = new Map<string, TranscodeJob>();

function jobKey(url: string): string {
  return createHash("sha256")
    .update(`${url}|h=${SERVER_MAX_HEIGHT}|s=${JOB_SEGMENT_SECONDS}|v1`)
    .digest("hex")
    .slice(0, 16);
}

/// Number of segments that are safe to hand out.
///
/// ffmpeg is still writing the highest-numbered segment, so it is a truncated ogg until the
/// next one appears — serving it gives the client a corrupt file and a decoder error that
/// looks exactly like "the transcode is broken". A segment is therefore complete only once a
/// later one exists, or once the encoder has exited.
async function completeSegments(job: TranscodeJob): Promise<number> {
  let names: string[];
  try {
    names = await readdir(job.dir);
  } catch {
    return 0;
  }
  const count = names.filter(n => /^seg_\d+\.ogv$/.test(n)).length;
  if (count === 0) return 0;
  return job.done ? count : count - 1;
}

async function startJob(url: string): Promise<TranscodeJob> {
  const id = jobKey(url);
  const existing = jobs.get(id);
  if (existing) {
    existing.lastAccess = Date.now();
    return existing;
  }

  const job: TranscodeJob = {
    id,
    dir: `${JOB_ROOT}/${id}`,
    proc: null,
    done: false,
    error: null,
    title: null,
    duration: null,
    lastAccess: Date.now(),
    starting: null,
  };
  // Registered before the async work so a second viewer arriving mid-resolve attaches to this
  // job rather than starting a duplicate encode of the same film — which is the exact race
  // that "everyone presses play at once" produces.
  jobs.set(id, job);

  job.starting = (async () => {
    try {
      await mkdir(job.dir, { recursive: true });
      const resolved = await resolveVideo(url);
      job.title = resolved.title ?? null;
      job.duration = resolved.duration ?? null;

      const track = resolved.tracks.find(t => (t.height ?? 0) <= SERVER_MAX_HEIGHT)
        ?? resolved.tracks.find(t => (t.height ?? 0) <= 720)
        ?? resolved.tracks[0];
      if (!track) throw new Error("no_playable_streams");

      const args: string[] = ["-y", "-threads", String(SERVER_ENCODE_THREADS)];
      if (resolved.headers["User-Agent"]) args.push("-user_agent", resolved.headers["User-Agent"]);
      if (resolved.headers.Referer) args.push("-headers", `Referer: ${resolved.headers.Referer}\r\n`);
      args.push("-i", track.url);

      const separateAudio = !track.hasAudio && Boolean(resolved.audioUrl);
      if (separateAudio && resolved.audioUrl) {
        if (resolved.headers["User-Agent"]) args.push("-user_agent", resolved.headers["User-Agent"]);
        if (resolved.headers.Referer) args.push("-headers", `Referer: ${resolved.headers.Referer}\r\n`);
        args.push("-i", resolved.audioUrl);
      }
      args.push("-map", separateAudio ? "0:v:0" : "0:v:0", "-map", separateAudio ? "1:a:0?" : "0:a:0?");

      args.push(
        "-vf", `scale=-2:min(${SERVER_MAX_HEIGHT}\\,ih)`,
        "-pix_fmt", "yuv420p",
        "-c:v", "libtheora", "-q:v", "5", "-threads", String(SERVER_ENCODE_THREADS),
        "-c:a", "libvorbis", "-q:a", "4",
        "-shortest",
        // Self-contained ogg chunks. `-reset_timestamps` makes each one start at zero, which is
        // what lets the client hand them to the player as independent clips.
        "-f", "segment",
        "-segment_time", String(JOB_SEGMENT_SECONDS),
        "-segment_format", "ogg",
        "-reset_timestamps", "1",
        `${job.dir}/seg_%04d.ogv`,
      );

      // stderr is piped and *drained* into a small ring buffer. Discarding it entirely (what
      // /transcode does) means a failed encode is indistinguishable from an empty one: the job
      // reports `done` with zero segments and the player shows a black screen with no reason
      // anywhere. Draining is what makes piping safe — an unread pipe fills its 64 KB kernel
      // buffer and wedges ffmpeg mid-write, which is the trap /transcode avoids by ignoring it.
      const ff = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
      job.proc = ff;
      activeTranscodes++;

      let tail = "";
      ff.stderr?.on("data", (chunk: Buffer) => {
        tail = (tail + chunk.toString("utf8")).slice(-4096);
      });

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        activeTranscodes--;
        job.done = true;
        job.proc = null;
      };
      ff.on("error", (e) => { job.error = e instanceof Error ? e.message : String(e); release(); });
      ff.on("close", async (code) => {
        // Mark done *before* counting: `completeSegments` withholds the last segment while the
        // encoder is still running, so counting first would report 0 for a job that produced
        // exactly one segment and flag a good clip as a failure.
        job.done = true;
        // A non-zero exit having produced nothing is a real failure worth reporting. A non-zero
        // exit *after* segments exist is usually the viewer cancelling or the source ending
        // untidily, and the segments are still good — reporting that as an error would throw
        // away a perfectly playable clip.
        if (code !== 0 && (await completeSegments(job).catch(() => 0)) === 0) {
          const lines = tail.trim().split("\n").filter(l => /error|failed|invalid|denied|404|403/i.test(l));
          job.error = `ffmpeg_failed: ${(lines.at(-1) ?? `exit ${code}`).slice(0, 300)}`;
        }
        release();
      });
    } catch (e) {
      job.error = e instanceof Error ? e.message : String(e);
      job.done = true;
    }
  })();

  return job;
}

/// Drop jobs whose segments nobody has asked for in a while, and evict the oldest finished
/// ones if the cache has outgrown its disk budget. A running encode is never evicted.
async function reapJobs(): Promise<void> {
  const now = Date.now();
  const finished: { job: TranscodeJob; bytes: number }[] = [];
  let total = 0;

  for (const job of [...jobs.values()]) {
    if (job.proc) continue; // still encoding — leave it alone
    let bytes = 0;
    try {
      for (const name of await readdir(job.dir)) {
        bytes += (await stat(`${job.dir}/${name}`)).size;
      }
    } catch { /* directory already gone */ }

    if (now - job.lastAccess > JOB_TTL_MS) {
      jobs.delete(job.id);
      await rm(job.dir, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    total += bytes;
    finished.push({ job, bytes });
  }

  if (total <= JOB_CACHE_MAX_BYTES) return;
  finished.sort((a, b) => a.job.lastAccess - b.job.lastAccess);
  for (const { job, bytes } of finished) {
    if (total <= JOB_CACHE_MAX_BYTES) break;
    jobs.delete(job.id);
    await rm(job.dir, { recursive: true, force: true }).catch(() => {});
    total -= bytes;
  }
}

setInterval(() => { void reapJobs(); }, 60_000).unref?.();

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
      // Datacenter IPs get YouTube's "sign in to confirm you're not a bot". The android
      // / tv_embedded clients skip that gate; without them every resolve 422s.
      "--extractor-args", "youtube:player_client=android,ios,tv_embedded,web",
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
    "/session",
    async ({ query, set }) => {
      // Start (or attach to) a shared segmented transcode and report its progress. Polled by
      // the client while it plays: `segments` is how many are safe to fetch, `done` says the
      // encoder has finished so the count is final.
      //
      // This is the path Quest uses for everything, and the path any client uses when it has
      // no local ffmpeg. It is deliberately not gated on platform: a second desktop viewer of
      // a film someone already queued should also read the cache rather than re-encode.
      const url = (query.url ?? "").trim();
      if (!url) { set.status = 400; return { error: "missing_url" }; }

      try {
        const existing = jobs.get(jobKey(url));
        // The concurrency cap now limits *distinct* encodes, not viewers — attaching to a job
        // that already exists costs nothing, so it must never be refused.
        if (!existing && activeTranscodes >= MAX_CONCURRENT_TRANSCODES) {
          set.status = 503;
          return { error: "transcode_busy" };
        }

        const job = await startJob(url);
        await job.starting;
        job.lastAccess = Date.now();

        if (job.error) {
          set.status = job.error === "no_playable_streams" ? 422 : 500;
          return { error: job.error };
        }
        return {
          id: job.id,
          segments: await completeSegments(job),
          done: job.done,
          segmentSeconds: JOB_SEGMENT_SECONDS,
          title: job.title,
          duration: job.duration,
        };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
    { query: t.Object({ url: t.String() }) },
  )
  .get(
    "/segment/:id/:n",
    async ({ params, set }) => {
      // Serve one finished segment. Segments are immutable once complete, so they cache hard —
      // which matters when a roomful of people are a few seconds apart in the same film.
      const job = jobs.get(params.id);
      if (!job) { set.status = 404; return { error: "unknown_job" }; }
      job.lastAccess = Date.now();

      const n = Number(params.n);
      if (!Number.isInteger(n) || n < 0) { set.status = 400; return { error: "bad_segment" }; }
      if (n >= await completeSegments(job)) {
        // Not an error: the encoder simply has not got there yet. 425 tells the client to
        // keep polling rather than treat the clip as broken and skip to the next one.
        set.status = 425;
        return { error: "not_ready" };
      }

      const file = Bun.file(`${job.dir}/seg_${String(n).padStart(4, "0")}.ogv`);
      if (!(await file.exists())) { set.status = 404; return { error: "missing_segment" }; }
      return new Response(file, {
        headers: {
          "content-type": "video/ogg",
          "cache-control": "public, max-age=86400, immutable",
        },
      });
    },
    { params: t.Object({ id: t.String(), n: t.String() }) },
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
