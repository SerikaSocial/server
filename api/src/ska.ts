// TypeScript port of tools/ska/vrm2ska.py — builds a Serika `.ska` avatar container from an
// uploaded VRM (0.x or 1.0) or plain GLB. Kept dependency-free (no glTF library) so it runs in
// the Bun API on the upload path. The `.ska` byte layout is documented in tools/ska/ska_format.md
// and parsed byte-identically by the Godot client (game/Avatar/SkaFile.cs).

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

export interface SkaMeta {
  name: string;
  author: string;
  sourceFormat: "vrm0" | "vrm1" | "glb";
  faceYawDegrees: number;
  heightMeters: number;
  eyeHeightMeters: number;
  humanoid: Record<string, string>;
}

export type UploadKind = "vrm" | "glb" | "fbx" | "unknown";

/// Sniff the uploaded bytes. FBX has a distinctive ASCII header; VRM/GLB share the glTF magic
/// (we tell them apart by the VRM extension after parsing JSON).
export function sniffKind(bytes: Uint8Array): UploadKind {
  if (bytes.length >= 4) {
    const magic = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
    if (magic === GLB_MAGIC) return "glb"; // may be VRM; refined during parse
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
  }
  return out;
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
  const meta: SkaMeta = {
    name, author, sourceFormat, faceYawDegrees: faceYaw,
    heightMeters: height, eyeHeightMeters: eye, humanoid,
  };
  return { ska: buildSka(bytes, meta), meta };
}
