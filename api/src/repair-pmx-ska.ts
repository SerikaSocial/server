// One-shot backfill for `.ska` avatars produced by the broken PMX converter.
//
// Two defects shipped into stored files and neither can be fixed by re-running the converter,
// because the API does not retain the uploaded `.pmx`:
//
//   1. Every `JOINTS_0` bufferView has `byteLength: 0`. The joints and weights views were opened
//      back to back with no writes in between, so the joint data landed in the *weights* view,
//      interleaved 4×u16 + 4×f32 per vertex. three.js/model-viewer fails with "Length out of
//      range of buffer" and Godot's glTF parser rejects it the same way — the avatar simply never
//      loads. The data is all still there, so this de-interleaves it into two correct views.
//
//   2. Geometry was left in PMX units (~12 units per metre) while only the *reported* height was
//      normalised, making every PMX avatar a ~20 m giant. Positions, bone rest translations and
//      inverse bind matrices are rescaled here to match what the fixed converter now emits.
//
// Both are repaired in the GLB embedded in the `.ska`; the container header and meta are
// preserved. The repaired file gets a new content-hash key and the AvatarVersion row is updated.
//
//   bun api/src/repair-pmx-ska.ts            # dry run: report what would change
//   bun api/src/repair-pmx-ska.ts --apply    # rewrite and re-upload
//   bun api/src/repair-pmx-ska.ts --apply --id <avatarId>

import { getObjectBytes, putBytes } from "./storage.ts";

// Raw SQL rather than Prisma on purpose. This is a one-shot maintenance script that has to be
// runnable from an operator's machine, and the Prisma query engine is a platform-specific binary
// that hangs indefinitely when its target does not match the host — which is exactly what
// happened the first time this was run. `Bun.SQL` speaks the wire protocol directly, so the only
// requirement is that DATABASE_URL is reachable.
const sql = new Bun.SQL(process.env.DATABASE_URL!);

interface AvatarRow {
  id: string;
  name: string;
  version_id: string | null;
  cdn_key: string | null;
  stats: Record<string, unknown> | null;
}

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const SOURCE_FORMAT_PMX = 4;

const align4 = (n: number) => Math.ceil(n / 4) * 4;

interface Ska {
  version: number;
  meta: Record<string, unknown>;
  glb: Uint8Array;
}

export function parseSka(bytes: Uint8Array): Ska {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "SKA1") throw new Error("not a .ska");
  const version = dv.getUint32(4, true);
  const metaLen = dv.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + metaLen)));
  const glbLen = dv.getUint32(12 + metaLen, true);
  return { version, meta, glb: bytes.subarray(16 + metaLen, 16 + metaLen + glbLen) };
}

export function buildSka(ska: Ska): Uint8Array {
  const metaBytes = new TextEncoder().encode(JSON.stringify(ska.meta));
  const out = new Uint8Array(12 + metaBytes.length + 4 + ska.glb.length);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode("SKA1"), 0);
  dv.setUint32(4, ska.version, true);
  dv.setUint32(8, metaBytes.length, true);
  out.set(metaBytes, 12);
  dv.setUint32(12 + metaBytes.length, ska.glb.length, true);
  out.set(ska.glb, 16 + metaBytes.length);
  return out;
}

function splitGlb(glb: Uint8Array): { json: any; bin: Uint8Array } {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error("not a GLB");
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== JSON_CHUNK) throw new Error("first chunk is not JSON");
  // NUL-padded JSON from the old writer would break JSON.parse, so trim padding explicitly.
  const jsonText = new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)).replace(/[\0\s]+$/, "");
  const binHeader = 20 + jsonLen;
  const binLen = dv.getUint32(binHeader, true);
  if (dv.getUint32(binHeader + 4, true) !== BIN_CHUNK) throw new Error("second chunk is not BIN");
  return { json: JSON.parse(jsonText), bin: glb.subarray(binHeader + 8, binHeader + 8 + binLen) };
}

function assembleGlb(json: any, bin: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = new Uint8Array(align4(jsonBytes.length)).fill(0x20); // spaces, per spec
  jsonPadded.set(jsonBytes);
  const binPadded = bin.length % 4 === 0 ? bin : (() => {
    const b = new Uint8Array(align4(bin.length));
    b.set(bin);
    return b;
  })();

  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonPadded.length, true);
  dv.setUint32(16, JSON_CHUNK, true);
  out.set(jsonPadded, 20);
  const binHeader = 20 + jsonPadded.length;
  dv.setUint32(binHeader, binPadded.length, true);
  dv.setUint32(binHeader + 4, BIN_CHUNK, true);
  out.set(binPadded, binHeader + 8);
  return out;
}

interface RepairReport {
  jointsFixed: number;
  scale: number;
  positionsScaled: number;
}

/// Repair a GLB in place. Returns null when nothing needed changing.
export function repairGlb(glb: Uint8Array): { glb: Uint8Array; report: RepairReport } | null {
  const { json, bin } = splitGlb(glb);
  const report: RepairReport = { jointsFixed: 0, scale: 1, positionsScaled: 0 };

  // Work on a copy: `bin` aliases the caller's buffer.
  let out = new Uint8Array(bin);
  const extra: Uint8Array[] = [];
  let extraOffset = align4(out.length);

  const appendView = (data: Uint8Array, target?: number): number => {
    const pad = extraOffset % 4 === 0 ? 0 : 4 - (extraOffset % 4);
    if (pad) { extra.push(new Uint8Array(pad)); extraOffset += pad; }
    const idx = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset: extraOffset, byteLength: data.length, target });
    extra.push(data);
    extraOffset += data.length;
    return idx;
  };

  // ── 1. De-interleave collapsed JOINTS_0/WEIGHTS_0 pairs ────────────────────────────────────
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const jAcc = json.accessors[prim.attributes?.JOINTS_0];
      const wAcc = json.accessors[prim.attributes?.WEIGHTS_0];
      if (!jAcc || !wAcc) continue;
      const jView = json.bufferViews[jAcc.bufferView];
      const wView = json.bufferViews[wAcc.bufferView];
      if (!jView || !wView || jView.byteLength !== 0) continue;

      const count = jAcc.count;
      const stride = 4 * 2 + 4 * 4; // 4×u16 joints + 4×f32 weights, per vertex
      if (wView.byteLength !== count * stride) {
        throw new Error(
          `primitive has an empty joints view but weights view is ${wView.byteLength} bytes, ` +
          `expected ${count * stride} for ${count} vertices — unrecognised corruption`,
        );
      }

      const src = new DataView(out.buffer, out.byteOffset + wView.byteOffset, wView.byteLength);
      const joints = new Uint8Array(count * 8);
      const weights = new Uint8Array(count * 16);
      const jDv = new DataView(joints.buffer);
      const wDv = new DataView(weights.buffer);
      for (let v = 0; v < count; v++) {
        const base = v * stride;
        for (let k = 0; k < 4; k++) jDv.setUint16(v * 8 + k * 2, src.getUint16(base + k * 2, true), true);
        for (let k = 0; k < 4; k++) wDv.setFloat32(v * 16 + k * 4, src.getFloat32(base + 8 + k * 4, true), true);
      }

      jAcc.bufferView = appendView(joints, 34962);
      wAcc.bufferView = appendView(weights, 34962);
      report.jointsFixed++;
    }
  }

  // ── 2. Rescale geometry from PMX units to metres ───────────────────────────────────────────
  // The scale is derived the same way the converter derives it: the vertex bounding box height
  // over a nominal 1.6 m avatar. Accessor min/max are authoritative and cheap to read.
  let minY = Infinity, maxY = -Infinity;
  const posAccessors = new Set<number>();
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const idx = prim.attributes?.POSITION;
      if (idx == null) continue;
      posAccessors.add(idx);
      const a = json.accessors[idx];
      if (a?.min) minY = Math.min(minY, a.min[1]);
      if (a?.max) maxY = Math.max(maxY, a.max[1]);
    }
  }
  const bbox = maxY - minY;
  const scale = Number.isFinite(bbox) && bbox > 0 ? 1.6 / bbox : 1;
  report.scale = scale;

  // Anything within a few percent of 1 is already in metres; leave it alone rather than nudge
  // a correctly-converted avatar around.
  if (Math.abs(scale - 1) > 0.02) {
    const scaleFloats = (view: any, count: number, components: number, only?: number[]) => {
      const dv = new DataView(out.buffer, out.byteOffset + view.byteOffset, view.byteLength);
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < components; c++) {
          if (only && !only.includes(c)) continue;
          const off = (i * components + c) * 4;
          dv.setFloat32(off, dv.getFloat32(off, true) * scale, true);
        }
      }
    };

    for (const idx of posAccessors) {
      const a = json.accessors[idx];
      scaleFloats(json.bufferViews[a.bufferView], a.count, 3);
      if (a.min) a.min = a.min.map((n: number) => n * scale);
      if (a.max) a.max = a.max.map((n: number) => n * scale);
      report.positionsScaled += a.count;
    }

    // Inverse bind matrices: column-major MAT4, translation is components 12..14.
    for (const skin of json.skins ?? []) {
      if (skin.inverseBindMatrices == null) continue;
      const a = json.accessors[skin.inverseBindMatrices];
      scaleFloats(json.bufferViews[a.bufferView], a.count, 16, [12, 13, 14]);
    }

    // Bone rest translations live in the JSON, not the binary.
    for (const node of json.nodes ?? []) {
      if (Array.isArray(node.translation)) {
        node.translation = node.translation.map((n: number) => n * scale);
      }
    }
  }

  if (report.jointsFixed === 0 && report.positionsScaled === 0) return null;

  if (extra.length) {
    const merged = new Uint8Array(extraOffset);
    merged.set(out, 0);
    let pos = align4(out.length);
    for (const chunk of extra) { merged.set(chunk, pos); pos += chunk.length; }
    out = merged;
  }
  json.buffers[0].byteLength = out.length;
  return { glb: assembleGlb(json, out), report };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const skaKeyFor = (hash: string) => `av/${hash.slice(0, 2)}/${hash}.ska`;

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const onlyId = args[args.indexOf("--id") + 1];

  // Latest version row per PMX avatar. DISTINCT ON is the cheap Postgres way to say
  // "one row per avatar, highest version wins".
  const avatars: AvatarRow[] = args.includes("--id")
    ? await sql`
        SELECT DISTINCT ON (a.id) a.id, a.name, v.id AS version_id, v.cdn_key, v.stats
        FROM avatars a LEFT JOIN avatar_versions v ON v.avatar_id = a.id
        WHERE a.source_format = ${SOURCE_FORMAT_PMX} AND a.id = ${onlyId}::uuid
        ORDER BY a.id, v.version DESC`
    : await sql`
        SELECT DISTINCT ON (a.id) a.id, a.name, v.id AS version_id, v.cdn_key, v.stats
        FROM avatars a LEFT JOIN avatar_versions v ON v.avatar_id = a.id
        WHERE a.source_format = ${SOURCE_FORMAT_PMX}
        ORDER BY a.id, v.version DESC`;

  console.log(`${avatars.length} PMX avatar(s) to inspect${apply ? "" : " (dry run)"}\n`);
  let repaired = 0;

  for (const avatar of avatars) {
    if (!avatar.version_id || !avatar.cdn_key) {
      console.log(`- ${avatar.name}: no version row, skipped`); continue;
    }

    const bytes = await getObjectBytes(avatar.cdn_key);
    if (!bytes) { console.log(`- ${avatar.name}: ${avatar.cdn_key} missing from storage, skipped`); continue; }

    let result;
    try {
      const ska = parseSka(bytes);
      const fixed = repairGlb(ska.glb);
      if (!fixed) { console.log(`- ${avatar.name}: already healthy`); continue; }
      ska.glb = fixed.glb;
      result = { ska: buildSka(ska), report: fixed.report };
    } catch (e) {
      console.log(`- ${avatar.name}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const { report } = result;
    console.log(
      `- ${avatar.name} (${avatar.id}): joints views rebuilt=${report.jointsFixed}, ` +
      `scale=${report.scale.toFixed(4)}, vertices rescaled=${report.positionsScaled}`,
    );
    repaired++;
    if (!apply) continue;

    const hash = await sha256Hex(result.ska);
    const key = skaKeyFor(hash);
    // Upload before the row moves: the old key stays valid until the update lands, so a failure
    // here leaves clients pointed at the previous (broken, but present) file rather than a 404.
    await putBytes(key, result.ska, "application/octet-stream");

    const stats = {
      ...(avatar.stats ?? {}),
      sizeBytes: result.ska.length,
      repairedAt: new Date().toISOString(),
    };
    await sql`
      UPDATE avatar_versions
      SET cdn_key = ${key}, blake3 = ${Buffer.from(hash, "hex")}, stats = ${JSON.stringify(stats)}::jsonb
      WHERE id = ${avatar.version_id}::uuid`;
    console.log(`    → uploaded ${key} and updated version ${avatar.version_id}`);
  }

  console.log(`\n${repaired} avatar(s) ${apply ? "repaired" : "would be repaired"}`);
  await sql.end();
}

if (import.meta.main) main().catch(e => { console.error(e); process.exit(1); });
