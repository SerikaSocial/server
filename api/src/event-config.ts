export type Point = [number, number, number];
export type CameraKey = { time: number; position: Point; target: Point; fov: number; cut?: boolean };
export type ShowConfig = {
  revealTime?: number;
  effects?: { time: number; duration: number; kind: "fire" | "smoke" | "sparks" | "laser"; pattern?: "lines" | "fan" | "comet"; strength: number; group: number; seed: number }[];
  stageAudio?: boolean; stageAudioGainDb?: number; lightSticks?: boolean;
  stageAudioLeftKey?: string; stageAudioRightKey?: string; introAudioKey?: string;
  performerPath?: { time: number; position: Point; yaw: number }[];
  introKey?: string; introDuration?: number;
  segments?: { title: string; start: number; duration: number }[];
  lights?: { time: number; color: Point; energy: number; look?: string; fade?: number; accent?: number }[];
  mouth?: number[]; mouthFps?: number; mouthRound?: number[]; mouthGain?: number;
  beats?: number[]; musicEnergy?: number[]; musicFps?: number;
  artistKey?: string; animationKey?: string; audioKey?: string; clip?: string; duration: number;
  performer?: Point; yaw?: number; scale?: number; cameras?: CameraKey[];
  /** YouTube watch-party: live/main URL. When set, concert performer assets are optional. */
  videoUrl?: string;
  preshowVideoUrl?: string;
  preshowStartSeconds?: number;
  preshowDuration?: number;
  /** Unix milliseconds. Clients switch from preshow to videoUrl at this wall clock. */
  scheduledStart?: number;
};
export const EVENT_TRANSITIONS: Record<string, Record<string, string>> = {
  draft: { open: "open" }, open: { play: "live", close: "ended" },
  live: { stop: "open", close: "ended" }, ended: { open: "open" },
};
export function transition(status: string, action: string): string {
  const next = EVENT_TRANSITIONS[status]?.[action];
  if (!next) throw new Error(`Cannot ${action} an event that is ${status}.`);
  return next;
}
function youtubeUrl(value: unknown, label: string): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 500) throw new Error(`Invalid ${label}.`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`Invalid ${label}.`); }
  if (parsed.protocol !== "https:") throw new Error(`${label} must be https.`);
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  if (host !== "youtube.com" && host !== "youtu.be" && host !== "youtube-nocookie.com")
    throw new Error(`${label} must be a YouTube URL.`);
  return value;
}

export function validateShowConfig(value: unknown): ShowConfig {
  const c = value as ShowConfig;
  const finite = (n: unknown, min: number, max: number) => typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
  const point = (p: unknown): p is Point => Array.isArray(p) && p.length === 3 && p.every(n => finite(n, -1000, 1000));
  if (!c || typeof c !== "object") throw new Error("Show settings are missing.");
  const videoUrl = youtubeUrl(c.videoUrl, "video URL");
  const preshowVideoUrl = youtubeUrl(c.preshowVideoUrl, "preshow video URL");
  const videoEvent = !!videoUrl;
  if (videoEvent) {
    if (!finite(c.duration, .1, 14400)) throw new Error("Track duration must be between 0.1 seconds and four hours.");
    if (c.preshowStartSeconds !== undefined && !finite(c.preshowStartSeconds, 0, 14400)) throw new Error("Invalid preshow start offset.");
    if (c.preshowDuration !== undefined && !finite(c.preshowDuration, 1, 14400)) throw new Error("Invalid preshow duration.");
    if (c.scheduledStart !== undefined && !finite(c.scheduledStart, 1e12, 4e12)) throw new Error("Invalid scheduled start.");
  } else {
  for (const key of [c.artistKey, c.animationKey, c.audioKey])
    if (typeof key !== "string" || !/^events\/[a-f0-9]{64}\/(artist\.ska|animation\.glb|track\.(ogg|mp3|wav))$/.test(key)) throw new Error("Upload the artist, animation GLB and audio first.");
  if (!c.artistKey.endsWith('/artist.ska') || !c.animationKey.endsWith('/animation.glb') || !/\/track\.(ogg|mp3|wav)$/.test(c.audioKey)) throw new Error("Show asset types do not match.");
  }
  for (const flag of [c.stageAudio,c.lightSticks])
    if (flag !== undefined && typeof flag !== "boolean") throw new Error("Stage audio and light sticks must be enabled or disabled.");
  for (const key of [c.stageAudioLeftKey,c.stageAudioRightKey,c.introAudioKey])
    if (key != null && (typeof key !== "string" || !/^events\/[a-f0-9]{64}\/track\.(ogg|mp3|wav)$/.test(key))) throw new Error("Upload valid stage and intro audio tracks.");
  if (c.stageAudio && (!c.stageAudioLeftKey || !c.stageAudioRightKey)) throw new Error("Stage audio requires both left and right mono tracks.");
  if (c.stageAudioGainDb !== undefined && !finite(c.stageAudioGainDb,-30,0)) throw new Error("Stage audio gain must be between -30 and 0 dB.");
  if (!videoEvent) {
  if (typeof c.clip !== "string" || !c.clip.trim() || c.clip.length > 200) throw new Error("Choose an animation clip.");
  if (!finite(c.duration, .1, 14400)) throw new Error("Track duration must be between 0.1 seconds and four hours.");
  if (!point(c.performer) || !finite(c.yaw, -360, 360) || !finite(c.scale, .1, 10)) throw new Error("Invalid performer placement.");
  if (!Array.isArray(c.cameras) || c.cameras.length < 1 || c.cameras.length > 256) throw new Error("Add between 1 and 256 camera points.");
  }
  let previous = -1;
  for (const shot of c.cameras ?? []) {
    if (!finite(shot.time, 0, c.duration) || shot.time <= previous || !point(shot.position) || !point(shot.target) || !finite(shot.fov, 10, 120)) throw new Error("Camera times must increase; positions, targets and FOV must be valid.");
    if (shot.position.every((n, i) => Math.abs(n - shot.target[i]!) < .001)) throw new Error("A camera cannot look at its own position.");
    previous = shot.time;
  }
  if (!videoEvent && c.cameras![0]!.time !== 0) throw new Error("The first camera point must start at zero.");
  if (c.performerPath && (!Array.isArray(c.performerPath) || c.performerPath.length > 256)) throw new Error("Too many performer path points.");
  previous = -1;
  for (const key of c.performerPath ?? []) {
    if (!key || !finite(key.time, 0, c.duration) || key.time <= previous || !point(key.position) || !finite(key.yaw, -360, 360)) throw new Error("Invalid performer path point.");
    previous = key.time;
  }
  if (c.performerPath?.length && c.performerPath[0]!.time !== 0) throw new Error("Performer path must start at zero.");
  if (c.introKey && (!/^events\/[a-f0-9]{64}\/intro\.ogv$/.test(c.introKey) || !finite(c.introDuration, .1, 14400))) throw new Error("Upload an OGV intro with a valid duration.");
  if (c.segments && (!Array.isArray(c.segments) || c.segments.length > 100)) throw new Error("Invalid set list.");
  let end = 0;
  for (const segment of c.segments ?? []) {
    if (!segment || typeof segment.title !== "string" || segment.title.length > 200 || !finite(segment.start, Math.max(0,end-1e-6), c.duration) || !finite(segment.duration, .1, c.duration) || segment.start + segment.duration > c.duration + .01) throw new Error("Set-list segments must be ordered and fit the show.");
    end = segment.start + segment.duration;
  }
  if (c.lights && (!Array.isArray(c.lights) || c.lights.length > 1024)) throw new Error("Too many lighting cues.");
  previous = -1;
  for (const cue of c.lights ?? []) {
    if (!cue || !finite(cue.time, 0, c.duration) || cue.time <= previous || !point(cue.color) || !cue.color.every(n => n >= 0 && n <= 1) || !finite(cue.energy, 0, 3)) throw new Error("Invalid lighting cue.");
    if (cue.look !== undefined && !["black", "entrance", "intimate", "side", "lift", "sweep", "anthem", "reveal", "drive", "finale"].includes(cue.look)) throw new Error("Invalid lighting look.");
    if (cue.fade !== undefined && !finite(cue.fade, .1, 30)) throw new Error("Invalid lighting fade.");
    if (cue.accent !== undefined && !finite(cue.accent, 0, 1)) throw new Error("Invalid lighting accent.");
    previous = cue.time;
  }
  if (c.revealTime !== undefined && !finite(c.revealTime, 0, Math.min(120,c.duration))) throw new Error("Invalid reveal time.");
  if (c.effects !== undefined && (!Array.isArray(c.effects) || c.effects.length > 512)) throw new Error("Too many stage effect cues.");
  previous = -1;
  for (const cue of c.effects ?? []) {
    if (!cue || !finite(cue.time, 0, c.duration) || cue.time < previous || !finite(cue.duration, .1, 15) || cue.time + cue.duration > c.duration + .01 || !["fire","smoke","sparks","laser"].includes(cue.kind) || !finite(cue.strength, 0, 1) || !Number.isInteger(cue.group) || !finite(cue.group, 0, 3) || !Number.isInteger(cue.seed) || !finite(cue.seed, 0, 2147483647)) throw new Error("Invalid stage effect cue.");
    if (cue.pattern !== undefined && !["lines","fan","comet"].includes(cue.pattern)) throw new Error("Invalid laser pattern.");
    previous = cue.time;
  }
  if (c.mouthGain !== undefined && !finite(c.mouthGain,.1,2)) throw new Error("Invalid mouth gain.");
  for (const rate of [c.mouthFps,c.musicFps]) if (rate !== undefined && !finite(rate,1,25)) throw new Error("Invalid audio analysis sample rate.");
  for (const envelope of [c.mouthRound,c.beats,c.musicEnergy])
    if (envelope && (!Array.isArray(envelope) || envelope.length > 360001 || !envelope.every(n=>finite(n,0,1)))) throw new Error("Invalid audio analysis envelope.");
  if (c.mouth && (!Array.isArray(c.mouth) || c.mouth.length > 360001 || !c.mouth.every(n => finite(n, 0, 1)))) throw new Error("Invalid mouth envelope.");
  return { revealTime: c.revealTime ?? 0, effects: c.effects ?? [], stageAudio: c.stageAudio ?? false, stageAudioGainDb: c.stageAudioGainDb ?? -6, lightSticks: c.lightSticks ?? false,
    stageAudioLeftKey: c.stageAudioLeftKey ?? undefined, stageAudioRightKey: c.stageAudioRightKey ?? undefined, introAudioKey: c.introAudioKey ?? undefined,
    performerPath: c.performerPath ?? [], introKey: c.introKey, introDuration: c.introDuration, segments: c.segments ?? [], lights: c.lights ?? [], mouth: c.mouth ?? [], mouthGain: c.mouthGain ?? 1.3, mouthFps: c.mouthFps ?? 5, mouthRound: c.mouthRound ?? [], beats: c.beats ?? [], musicEnergy: c.musicEnergy ?? [], musicFps: c.musicFps ?? 25, artistKey: c.artistKey, animationKey: c.animationKey, audioKey: c.audioKey, clip: c.clip,
    duration: c.duration, performer: c.performer ?? [0, 0, 0], yaw: c.yaw ?? 0, scale: c.scale ?? 1, cameras: c.cameras ?? [],
    videoUrl, preshowVideoUrl, preshowStartSeconds: c.preshowStartSeconds ?? 0, preshowDuration: c.preshowDuration ?? 0, scheduledStart: c.scheduledStart };
}

/** Shared by create/edit so optional audio receives the same existence checks. */
export function showAssetKeys(config: ShowConfig): string[] {
  return [config.artistKey,config.animationKey,config.audioKey,config.introKey,config.stageAudioLeftKey,config.stageAudioRightKey,config.introAudioKey].filter((key): key is string => !!key);
}

/** Public URLs are derived from validated storage keys, never trusted from a draft. */
export function serializeShowConfig(config: ShowConfig, publicUrl: (key: string) => string) {
  return { ...config,
    artistUrl: config.artistKey ? publicUrl(config.artistKey) : null,
    animationUrl: config.animationKey ? publicUrl(config.animationKey) : null,
    audioUrl: config.audioKey ? publicUrl(config.audioKey) : null,
    introUrl: config.introKey ? publicUrl(config.introKey) : null,
    stageAudioLeftUrl: config.stageAudioLeftKey ? publicUrl(config.stageAudioLeftKey) : null,
    stageAudioRightUrl: config.stageAudioRightKey ? publicUrl(config.stageAudioRightKey) : null,
    introAudioUrl: config.introAudioKey ? publicUrl(config.introAudioKey) : null };
}
/** Reject external glTF references before handing any asset to an engine importer. */
export function inspectGlb(bytes: Uint8Array): any {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length || view.getUint32(16, true) !== 0x4e4f534a) throw new Error("A valid embedded GLB 2 file is required.");
  const length = view.getUint32(12, true);
  if (length > bytes.length - 20) throw new Error("Invalid GLB JSON chunk.");
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  for (const item of [...(json.buffers ?? []), ...(json.images ?? [])])
    if (item.uri && !String(item.uri).startsWith("data:")) throw new Error("Embed all textures and buffers in the GLB.");
  return json;
}

/** Canonical names keep unnamed or punctuation-heavy exporter clips selectable in Godot. */
export function prepareAnimationGlb(bytes: Uint8Array) {
  const g = inspectGlb(bytes);
  if (!g.animations?.length || !g.skins?.length) throw new Error("The GLB must contain a skeleton and animation clips.");
  const names = new Set<string>();
  const clips = g.animations.map((a: any, i: number) => {
    const base = String(a.name || `Animation_${i + 1}`).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 160) || `Animation_${i + 1}`;
    let name = base, suffix = 2; while (names.has(name)) name = `${base}_${suffix++}`;
    names.add(name); a.name = name;
    return { name, duration: Math.max(0, ...(a.samplers ?? []).map((s: any) => g.accessors?.[s.input]?.max?.[0] ?? 0)) };
  });
  const oldLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true);
  const json = new TextEncoder().encode(JSON.stringify(g)), padded = (json.length + 3) & ~3;
  const rest = bytes.subarray(20 + oldLength), output = new Uint8Array(20 + padded + rest.length), header = new DataView(output.buffer);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, output.length, true);
  header.setUint32(12, padded, true); header.setUint32(16, 0x4e4f534a, true);
  output.fill(32, 20, 20 + padded); output.set(json, 20); output.set(rest, 20 + padded);
  return { bytes: output, clips };
}
