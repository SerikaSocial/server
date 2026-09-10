// TypeScript port of tools/ska/vrm2ska.py — builds a Serika `.ska` avatar container from an
// uploaded VRM (0.x or 1.0) or plain GLB. Kept dependency-free (no glTF library) so it runs in
// the Bun API on the upload path. The `.ska` byte layout is documented in tools/ska/ska_format.md
// and parsed byte-identically by the Godot client (game/Avatar/SkaFile.cs).

import { parsePMX, extractPMXHumanoid, findHeadY } from "./pmx.ts";
import { pmxToGlb } from "./pmx_to_glb.ts";

const GLB_MAGIC = 0x46546c67; // "glTF" little-endian
const JSON_CHUNK = 0x4e4f534a; // "JSON"

const KNOWN_ROLES = new Set([
  "hips", "spine", "chest", "upperChest", "neck", "head", "leftEye", "rightEye", "jaw",
  "leftUpperLeg", "leftLowerLeg", "leftFoot", "leftToes",
  "rightUpperLeg", "rightLowerLeg", "rightFoot", "rightToes",
  "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand",
  "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
  "leftThumbProximal", "leftThumbIntermediate", "leftThumbDistal",
  "leftIndexProximal", "leftIndexIntermediate", "leftIndexDistal",
  "leftMiddleProximal", "leftMiddleIntermediate", "leftMiddleDistal",
  "leftRingProximal", "leftRingIntermediate", "leftRingDistal",
  "leftLittleProximal", "leftLittleIntermediate", "leftLittleDistal",
  "rightThumbProximal", "rightThumbIntermediate", "rightThumbDistal",
  "rightIndexProximal", "rightIndexIntermediate", "rightIndexDistal",
  "rightMiddleProximal", "rightMiddleIntermediate", "rightMiddleDistal",
  "rightRingProximal", "rightRingIntermediate", "rightRingDistal",
  "rightLittleProximal", "rightLittleIntermediate", "rightLittleDistal",
]);

export interface ToggleMeta {
  name: string;
  defaultOn: boolean;
  saved: boolean;
}

export interface SkaMeta {
  name: string;
  author: string;
  sourceFormat: "vrm0" | "vrm1" | "glb" | "pmx";
  faceYawDegrees: number;
  heightMeters: number;
  eyeHeightMeters: number;
  humanoid: Record<string, string>;
  toggles?: ToggleMeta[];
}

export type UploadKind = "vrm" | "glb" | "fbx" | "pmx" | "unitypackage" | "unknown";

/// Decompress gzip bytes if the gzip magic (0x1F 0x8B) is present, otherwise return as-is.
/// VRoid Hub serves VRM files gzip-compressed even though the extension is .vrm.
export function maybeGunzip(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return Bun.gunzipSync(bytes as Uint8Array);
  }
  return bytes;
}

/// Sniff the uploaded bytes. FBX has a distinctive ASCII header; VRM/GLB share the glTF magic;
/// PMX starts with "PMX "; unitypackage is a gzip tar archive (0x1F 0x8B).
/// Gzip-compressed VRM (as served by VRoid Hub) is detected by peeking inside the gzip stream.
export function sniffKind(bytes: Uint8Array, filename?: string): UploadKind {
  if (filename && filename.toLowerCase().endsWith(".unitypackage")) return "unitypackage";
  if (bytes.length >= 4) {
    const magic = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    if (magic === GLB_MAGIC) return "glb"; // may be VRM; refined during parse
  }
  // PMX magic: "PMX " in ASCII
  if (bytes.length >= 4) {
    const head = new TextDecoder("ascii").decode(bytes.subarray(0, 4));
    if (head === "PMX ") return "pmx";
  }
  // Gzip magic (0x1F 0x8B) — could be a unitypackage (tar.gz) or a gzip-compressed VRM.
  // Peek inside to check: decompress a small prefix and look for the glTF magic.
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      const decompressed = Bun.gunzipSync(bytes as Uint8Array);
      if (decompressed.length >= 4) {
        const innerMagic = new DataView(decompressed.buffer, decompressed.byteOffset, 4).getUint32(0, true);
        if (innerMagic === GLB_MAGIC) return "glb"; // gzip-compressed VRM/GLB
      }
    } catch {
      // Not a valid gzip stream or decompression failed — fall through to unitypackage
    }
    return "unitypackage";
  }
  // Binary FBX starts with "Kaydara FBX Binary  ".
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 20));
  if (head.startsWith("Kaydara FBX Binary")) return "fbx";
  return "unknown";
}

function readGlbJson(bytes: Uint8Array): any {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new Error("not a GLB/VRM (bad magic)");
  const chunkLen = dv.getUint32(12, true);
  const chunkType = dv.getUint32(16, true);
  if (chunkType !== JSON_CHUNK) throw new Error("first GLB chunk is not JSON");
  const jsonBytes = bytes.subarray(20, 20 + chunkLen);
  return JSON.parse(new TextDecoder("utf-8").decode(jsonBytes));
}

/// Rebuild a GLB with a modified JSON chunk. The binary chunk is carried over unchanged.
/// Used to strip problematic extensions (e.g. KHR_texture_transform with default values that
/// some importers — including Godot's — choke on) without re-encoding the binary payload.
function rewriteGlbJson(bytes: Uint8Array, modifier: (gltf: any) => void): Uint8Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkLen = dv.getUint32(12, true);
  const jsonBytes = bytes.subarray(20, 20 + chunkLen);
  const gltf = JSON.parse(new TextDecoder("utf-8").decode(jsonBytes));
  modifier(gltf);
  const newJson = Buffer.from(JSON.stringify(gltf), "utf-8");
  // Pad JSON to 4-byte alignment with spaces (glTF spec).
  const padLen = (4 - (newJson.length % 4)) % 4;
  const paddedJson = Buffer.concat([newJson, Buffer.alloc(padLen, 0x20)]);
  // Binary chunk starts right after the JSON chunk.
  const binHeaderOff = 20 + chunkLen;
  const binChunkLen = dv.getUint32(binHeaderOff, true);
  const binChunkType = dv.getUint32(binHeaderOff + 4, true);
  const binData = bytes.subarray(binHeaderOff + 8, binHeaderOff + 8 + binChunkLen);
  // Rebuild GLB: header (12) + JSON chunk (8 + jsonLen) + BIN chunk (8 + binLen).
  const totalLen = 12 + 8 + paddedJson.length + 8 + binData.length;
  const out = Buffer.alloc(totalLen);
  out.write("glTF", 0, "latin1");
  out.writeUInt32LE(2, 4); // version
  out.writeUInt32LE(totalLen, 8); // total length
  out.writeUInt32LE(paddedJson.length, 12); // JSON chunk length
  out.writeUInt32LE(JSON_CHUNK, 16); // JSON chunk type
  paddedJson.copy(out, 20);
  const binOff = 20 + paddedJson.length;
  out.writeUInt32LE(binData.length, binOff);
  out.writeUInt32LE(binChunkType, binOff + 4);
  Buffer.from(binData).copy(out, binOff + 8);
  return out as Uint8Array;
}

/// Strip KHR_texture_transform from all texture references when it carries only default values
/// (offset [0,0], scale [1,1], rotation 0). Some GLB exporters — including VRoid Hub's VRM
/// pipeline — emit this extension on every texture even when it is a no-op, and Godot's glTF
/// importer can fail to load textures that carry it.
function stripDefaultTextureTransform(glb: Uint8Array): Uint8Array {
  try {
    return rewriteGlbJson(glb, (gltf) => {
      const materials = gltf.materials ?? [];
      for (const mat of materials) {
        const pbr = mat.pbrMetallicRoughness;
        if (pbr?.baseColorTexture?.extensions?.KHR_texture_transform) {
          const tt = pbr.baseColorTexture.extensions.KHR_texture_transform;
          const isDefault =
            (!tt.offset || (tt.offset[0] === 0 && tt.offset[1] === 0)) &&
            (!tt.scale || (tt.scale[0] === 1 && tt.scale[1] === 1)) &&
            (!tt.rotation || tt.rotation === 0);
          if (isDefault) delete pbr.baseColorTexture.extensions.KHR_texture_transform;
          if (Object.keys(pbr.baseColorTexture.extensions).length === 0)
            delete pbr.baseColorTexture.extensions;
        }
      }
    });
  } catch {
    return glb; // if rewrite fails, return the original GLB unchanged
  }
}

/// Auto-detect avatar toggles from material names. Looks for common prop/accessory keywords
/// (Shield, Sword, Weapon, Hat, Glasses, Cape, etc.) in material names and creates a toggle
/// for each unique keyword found. The client's toggle system matches by material name to
/// hide/show individual mesh surfaces.
function autoDetectToggles(gltf: any): ToggleMeta[] {
  const KEYWORDS = [
    "Shield", "Sword", "Weapon", "Spear", "Bow", "Axe", "Staff", "Wand",
    "Hat", "Crown", "Helmet", "Glasses", "Mask", "Cape", "Cloak",
    "Backpack", "Wings", "Horns", "Tail", "Earring", "Necklace",
  ];
  const found = new Map<string, ToggleMeta>();
  for (const mat of gltf.materials ?? []) {
    const name = (mat.name ?? "").toLowerCase();
    for (const kw of KEYWORDS) {
      if (name.includes(kw.toLowerCase())) {
        // Capitalize for the display name.
        const display = kw;
        if (!found.has(display)) {
          found.set(display, { name: display, defaultOn: true, saved: false });
        }
      }
    }
  }
  return [...found.values()];
}

function nodeName(gltf: any, idx: number | undefined): string | null {
  const nodes = gltf.nodes ?? [];
  if (idx == null || idx < 0 || idx >= nodes.length) return null;
  return nodes[idx].name || `Node_${idx}`;
}

function extractHumanoid(gltf: any): Record<string, string> {
  const ext = gltf.extensions ?? {};
  const out: Record<string, string> = {};

  const vrmc = ext.VRMC_vrm;
  if (vrmc) {
    const bones = vrmc.humanoid?.humanBones ?? {};
    for (const [role, spec] of Object.entries<any>(bones)) {
      if (KNOWN_ROLES.has(role) && spec && typeof spec === "object") {
        const n = nodeName(gltf, spec.node);
        if (n) out[role] = n;
      }
    }
    validateAndFixBoneMappings(gltf, out);
    return out;
  }

  const vrm = ext.VRM;
  if (vrm) {
    for (const spec of vrm.humanoid?.humanBones ?? []) {
      const role = spec.bone;
      if (KNOWN_ROLES.has(role)) {
        const n = nodeName(gltf, spec.node);
        if (n) out[role] = n;
      }
    }
    validateAndFixBoneMappings(gltf, out);
  }
  return out;
}

/// Defensive sanity check on VRM-declared bone mappings. Some authored VRM files have
/// incorrect mappings (e.g. eyes mapped to ear bones, hips mapped to the armature root).
/// For each suspicious mapping, try to find a better candidate by name among the glTF nodes.
function validateAndFixBoneMappings(gltf: any, out: Record<string, string>): void {
  const nodeNames: string[] = (gltf.nodes ?? []).map((_: any, i: number) => nodeName(gltf, i) ?? "");
  const lower = nodeNames.map((n: string) => n.toLowerCase());

  // Eye bones should contain "eye" in the name — some VRM files map them to ear bones.
  for (const role of ["leftEye", "rightEye"] as const) {
    const mapped = out[role];
    if (mapped && !mapped.toLowerCase().includes("eye")) {
      const want = role === "leftEye" ? ["eye.l", "eye.left", "lefteye", "left_eye"] : ["eye.r", "eye.right", "righteye", "right_eye"];
      const idx = lower.findIndex((n: string) => want.includes(n));
      if (idx >= 0) out[role] = nodeNames[idx];
    }
  }

  // Hips should not be the armature root (commonly named "root" or "armature").
  const hips = out["hips"];
  if (hips && (hips.toLowerCase() === "root" || hips.toLowerCase() === "armature")) {
    const idx = lower.findIndex((n: string) => n === "hips" || n === "hip" || n === "pelvis");
    if (idx >= 0) out["hips"] = nodeNames[idx];
  }

  // Thumb proximal should contain "proximal" — some VRM files shift it to intermediate.
  for (const role of ["leftThumbProximal", "rightThumbProximal"] as const) {
    const mapped = out[role];
    if (mapped && !mapped.toLowerCase().includes("proximal")) {
      const side = role.startsWith("left") ? ".l" : ".r";
      const idx = lower.findIndex((n: string) => n.includes("thumb") && n.includes("proximal") && n.endsWith(side));
      if (idx >= 0) out[role] = nodeNames[idx];
    }
  }
}

/// Approximate rest-pose world Y of each node by summing local translations down the scene tree
/// (ignores rotation/scale — good enough for height/eye-height measurement).
function nodeWorldY(gltf: any): Map<number, number> {
  const nodes = gltf.nodes ?? [];
  const world = new Map<number, number>();
  const localY = (n: any): number => {
    if (Array.isArray(n.translation)) return n.translation[1];
    if (Array.isArray(n.matrix)) return n.matrix[13];
    return 0;
  };
  let roots: number[] = [];
  const sceneIdx = gltf.scene ?? 0;
  const scenes = gltf.scenes ?? [];
  if (scenes[sceneIdx]?.nodes) roots = scenes[sceneIdx].nodes;
  if (!roots.length) roots = nodes.map((_: any, i: number) => i);

  const walk = (i: number, parentY: number) => {
    const y = parentY + localY(nodes[i]);
    world.set(i, y);
    for (const c of nodes[i].children ?? []) walk(c, y);
  };
  for (const r of roots) walk(r, 0);
  return world;
}

function measure(gltf: any, humanoid: Record<string, string>): { height: number; eye: number } {
  const world = nodeWorldY(gltf);
  const nameToIdx = new Map<string, number>();
  (gltf.nodes ?? []).forEach((_: any, i: number) => nameToIdx.set(nodeName(gltf, i)!, i));
  const headIdx = nameToIdx.get(humanoid.head);
  const headY = headIdx != null && world.has(headIdx) ? world.get(headIdx)! : 1.4;
  return { height: round3(headY + 0.18), eye: round3(headY + 0.08) };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/// Extract the embedded thumbnail image from a VRM/GLB file.
/// VRM 0.x: `extensions.VRM.meta.texture` → index into `textures` → `.source` → `images`.
/// VRM 1.0: `extensions.VRMC_vrm.meta.thumbnailImage` → index into `images`.
/// Fallback: looks for an image named "Thumbnail", then the first image in the GLB.
/// Returns the raw image bytes + mime type, or null if no suitable image is present.
export function extractThumbnail(glbBytes: Uint8Array): { bytes: Uint8Array; mimeType: string } | null {
  try {
    const gltf = readGlbJson(glbBytes);
    const ext = gltf.extensions ?? {};
    const images = gltf.images ?? [];
    const textures = gltf.textures ?? [];
    const bufferViews = gltf.bufferViews ?? [];

    let imageIdx: number | undefined;

    // VRM 1.0: meta.thumbnailImage is a direct index into images
    if (ext.VRMC_vrm?.meta?.thumbnailImage != null) {
      imageIdx = ext.VRMC_vrm.meta.thumbnailImage;
    }
    // VRM 0.x: meta.texture is an index into textures, then .source gives the image
    else if (ext.VRM?.meta?.texture != null) {
      const texIdx = ext.VRM.meta.texture;
      const tex = textures[texIdx];
      if (tex?.source != null) imageIdx = tex.source;
    }

    // Fallback 1: look for an image named "Thumbnail" (case-insensitive)
    if (imageIdx == null) {
      for (let i = 0; i < images.length; i++) {
        const name = (images[i]?.name ?? "").toLowerCase();
        if (name === "thumbnail") { imageIdx = i; break; }
      }
    }

    // Fallback 2: first image in the GLB that has a bufferView
    if (imageIdx == null) {
      for (let i = 0; i < images.length; i++) {
        if (images[i]?.bufferView != null) { imageIdx = i; break; }
      }
    }

    if (imageIdx == null) return null;

    const image = images[imageIdx];
    if (!image || image.bufferView == null) return null;

    const bv = bufferViews[image.bufferView];
    if (!bv) return null;

    // Binary chunk starts after: 12 (header) + 8 (chunk0 header) + jsonChunkLen + 8 (chunk1 header)
    const dv = new DataView(glbBytes.buffer, glbBytes.byteOffset, glbBytes.byteLength);
    const jsonChunkLen = dv.getUint32(12, true);
    const binOffset = 20 + jsonChunkLen + 8;
    const start = binOffset + (bv.byteOffset ?? 0);
    const end = start + bv.byteLength;
    const bytes = glbBytes.subarray(start, end);

    const mimeType = image.mimeType ?? "image/png";
    return { bytes, mimeType };
  } catch {
    return null;
  }
}

/// Wrap a GLB payload + meta into the `.ska` container. Returns a Buffer.
export function buildSka(glb: Uint8Array, meta: SkaMeta): Buffer {
  const metaBytes = Buffer.from(JSON.stringify(meta), "utf-8");
  const header = Buffer.alloc(12);
  header.write("SKA1", 0, "latin1");
  header.writeUInt32LE(1, 4);
  header.writeUInt32LE(metaBytes.length, 8);
  const glbLen = Buffer.alloc(4);
  glbLen.writeUInt32LE(glb.length, 0);
  return Buffer.concat([header, metaBytes, glbLen, Buffer.from(glb)]);
}

export interface ConvertResult {
  ska: Buffer;
  meta: SkaMeta;
}

/// Convert an uploaded VRM/GLB into a `.ska`. Throws for non-humanoid or unsupported input.
export function vrmOrGlbToSka(
  bytes: Uint8Array,
  overrides: { name?: string; author?: string } = {},
): ConvertResult {
  const gltf = readGlbJson(bytes);
  const humanoid = extractHumanoid(gltf);
  if (!humanoid.head) {
    throw new Error("no 'head' humanoid bone found — the model must be a rigged humanoid (VRM, or a GLB with a VRM humanoid extension)");
  }

  const ext = gltf.extensions ?? {};
  const vrmMeta = ext.VRMC_vrm?.meta ?? ext.VRM?.meta ?? {};
  const name = overrides.name || vrmMeta.name || vrmMeta.title || "Untitled Avatar";
  const author = overrides.author || vrmMeta.author || (vrmMeta.authors ?? [])[0] || "unknown";

  let sourceFormat: SkaMeta["sourceFormat"] = "glb";
  let faceYaw = 0;
  if (ext.VRMC_vrm) sourceFormat = "vrm1";
  else if (ext.VRM) { sourceFormat = "vrm0"; faceYaw = 180; }

  const { height, eye } = measure(gltf, humanoid);
  const toggles = autoDetectToggles(gltf);
  const meta: SkaMeta = {
    name, author, sourceFormat, faceYawDegrees: faceYaw,
    heightMeters: height, eyeHeightMeters: eye, humanoid,
    toggles: toggles.length > 0 ? toggles : undefined,
  };
  const fixedGlb = stripDefaultTextureTransform(bytes);
  return { ska: buildSka(fixedGlb, meta), meta };
}

/// Convert a PMX (Miku Miku Dance) file to `.ska`. Parses the PMX, converts to GLB,
/// extracts humanoid bone mapping from MMD bone names, and packages into .ska.
/// `textureBytes` maps texture index → { bytes, mimeType } for external texture files.
export function pmxToSka(
  bytes: Uint8Array,
  overrides: { name?: string; author?: string } = {},
  textureBytes?: Map<number, { bytes: Uint8Array; mimeType: string }>,
): ConvertResult {
  const model = parsePMX(bytes);
  const humanoid = extractPMXHumanoid(model);
  if (!humanoid.head) {
    throw new Error("no 'head' bone found — the PMX model must have a humanoid skeleton with standard MMD bone names (頭/Head, 首/Neck, etc.)");
  }

  const { glb } = pmxToGlb(model, textureBytes);
  const headY = findHeadY(model, humanoid);
  const name = overrides.name || model.name || model.nameEn || "Untitled Avatar";
  const author = overrides.author || "unknown";

  const meta: SkaMeta = {
    name,
    author,
    sourceFormat: "pmx",
    faceYawDegrees: 180, // MMD models typically face +Z like VRM 0.x
    heightMeters: round3(headY + 0.18),
    eyeHeightMeters: round3(headY + 0.08),
    humanoid,
  };
  return { ska: buildSka(glb, meta), meta };
}
