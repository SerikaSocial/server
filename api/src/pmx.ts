// PMX (Polygon Model eXtended) parser — Miku Miku Dance's native format.
// Spec reference: https://gist.github.com/elf163/3638f8e6ee2722523a0139e1d0f1a614
//
// This parser extracts the minimum needed for avatar conversion:
// - vertices (position, normal, UV, bone weights)
// - indices (triangles)
// - bones (name, parent, position, transform)
// - materials (texture index, diffuse, toon, sphere)
// - textures (file paths)
//
// The output is a structured object that pmxToGlb() converts to glTF.

export interface PMXVertex {
  position: [number, number, number];
  normal: [number, number, number];
  uv: [number, number];
  boneType: number; // 0=BDEF1, 1=BDEF2, 2=BDEF4, 3=SDEF, 4=QDEF
  bones: number[]; // bone indices (1-4 depending on type)
  weights: number[]; // corresponding weights
  edgeScale: number;
}

export interface PMXBone {
  name: string;
  nameEn: string;
  position: [number, number, number];
  parentId: number;
  transformLevel: number;
  flags: number;
  // flag bits
  hasRotatable: boolean;
  hasMovable: boolean;
  hasVisible: boolean;
  hasEnabled: boolean;
  // IK
  isIK: boolean;
  ikTarget: number;
  ikLoopCount: number;
  ikUnitAngle: number;
  ikLinks: { target: number; hasAngleLimit: boolean; lowerLimit: [number, number, number]; upperLimit: [number, number, number] }[];
  // Additional transform
  appendBoneId: number;
  appendOffset: [number, number, number];
  hasAppendRotation: boolean;
  hasAppendTranslation: boolean;
  // Fixed axis
  hasFixedAxis: boolean;
  fixedAxis: [number, number, number];
  // Local axes
  hasLocalAxes: boolean;
  localXAxis: [number, number, number];
  localZAxis: [number, number, number];
  // External parent
  externalParentKey: number;
}

export interface PMXMaterial {
  name: string;
  nameEn: string;
  diffuse: [number, number, number, number]; // RGBA
  specular: [number, number, number];
  specularStrength: number;
  ambient: [number, number, number];
  drawFlags: number;
  edgeColor: [number, number, number, number];
  edgeScale: number;
  textureIndex: number;
  sphereIndex: number;
  sphereMode: number; // 0=none, 1=multiply, 2=add
  toonFlag: boolean; // true=shared toon, false=separate texture
  toonIndex: number;
  comment: string;
  vertexCount: number; // number of vertices this material draws
}

export interface PMXTexture {
  path: string;
}

export interface PMXModel {
  name: string;
  nameEn: string;
  comment: string;
  commentEn: string;
  vertices: PMXVertex[];
  indices: number[];
  textures: PMXTexture[];
  materials: PMXMaterial[];
  bones: PMXBone[];
  // header
  encoding: number; // 0=UTF-16LE, 1=UTF-8
  uvAdditionalCount: number;
  vertexIndexSize: number;
  textureIndexSize: number;
  materialIndexSize: number;
  boneIndexSize: number;
  morphIndexSize: number;
  rigidbodyIndexSize: number;
}

class ByteReader {
  private dv: DataView;
  private offset = 0;
  readonly encoding: number = 0;

  constructor(bytes: Uint8Array) {
    // Create a DataView that respects the Uint8Array's offset and length
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number { return this.dv.byteLength - this.offset; }

  u8(): number { return this.dv.getUint8(this.offset++); }
  i8(): number { return this.dv.getInt8(this.offset++); }
  u16(): number { const v = this.dv.getUint16(this.offset, true); this.offset += 2; return v; }
  i16(): number { const v = this.dv.getInt16(this.offset, true); this.offset += 2; return v; }
  u32(): number { const v = this.dv.getUint32(this.offset, true); this.offset += 4; return v; }
  i32(): number { const v = this.dv.getInt32(this.offset, true); this.offset += 4; return v; }
  f32(): number { const v = this.dv.getFloat32(this.offset, true); this.offset += 4; return v; }

  vec3(): [number, number, number] {
    return [this.f32(), this.f32(), this.f32()];
  }
  vec4(): [number, number, number, number] {
    return [this.f32(), this.f32(), this.f32(), this.f32()];
  }

  text(encoding: number): string {
    const len = this.i32();
    const bytes = new Uint8Array(this.dv.buffer, this.dv.byteOffset + this.offset, len);
    this.offset += len;
    if (encoding === 0) {
      // UTF-16LE
      return new TextDecoder("utf-16le").decode(bytes);
    }
    return new TextDecoder("utf-8").decode(bytes);
  }

  index(size: number, signed: boolean): number {
    switch (size) {
      case 1: return signed ? this.i8() : this.u8();
      case 2: return signed ? this.i16() : this.u16();
      case 4: return signed ? this.i32() : this.u32();
      default: throw new Error(`bad index size ${size}`);
    }
  }

  seek(n: number): void { this.offset = n; }
  skip(n: number): void { this.offset += n; }
}

/// Parse a PMX file from raw bytes. Throws on malformed input.
export function parsePMX(bytes: Uint8Array): PMXModel {
  const r = new ByteReader(bytes);

  // Magic: "PMX " (4 bytes)
  const magic = new TextDecoder("ascii").decode(bytes.subarray(0, 4));
  if (magic !== "PMX ") throw new Error("not a PMX file (bad magic)");

  r.seek(4);
  const version = r.f32();
  if (version !== 2.0 && version !== 2.1) throw new Error(`unsupported PMX version ${version}`);

  // Globals count
  const globalsCount = r.u8();
  if (globalsCount < 8) throw new Error(`PMX globals count too small: ${globalsCount}`);

  const encoding = r.u8(); // 0=UTF-16LE, 1=UTF-8
  const uvAdditionalCount = r.u8();
  const vertexIndexSize = r.u8();
  const textureIndexSize = r.u8();
  const materialIndexSize = r.u8();
  const boneIndexSize = r.u8();
  const morphIndexSize = r.u8();
  const rigidbodyIndexSize = r.u8();

  // Model name
  const name = r.text(encoding);
  const nameEn = r.text(encoding);
  const comment = r.text(encoding);
  const commentEn = r.text(encoding);

  // Vertices
  const vertexCount = r.i32();
  const vertices: PMXVertex[] = [];
  for (let i = 0; i < vertexCount; i++) {
    const position = r.vec3();
    const normal = r.vec3();
    const uv: [number, number] = [r.f32(), r.f32()];
    // Skip additional UVs
    for (let a = 0; a < uvAdditionalCount; a++) r.skip(16);
    const boneType = r.u8();
    const bones: number[] = [];
    const weights: number[] = [];
    switch (boneType) {
      case 0: // BDEF1
        bones.push(r.index(boneIndexSize, true));
        weights.push(1);
        break;
      case 1: { // BDEF2
        const b0 = r.index(boneIndexSize, true);
        const b1 = r.index(boneIndexSize, true);
        const w0 = r.f32();
        bones.push(b0, b1);
        weights.push(w0, 1 - w0);
        break;
      }
      case 2: { // BDEF4
        bones.push(r.index(boneIndexSize, true));
        bones.push(r.index(boneIndexSize, true));
        bones.push(r.index(boneIndexSize, true));
        bones.push(r.index(boneIndexSize, true));
        weights.push(r.f32(), r.f32(), r.f32(), r.f32());
        break;
      }
      case 3: { // SDEF
        const b0 = r.index(boneIndexSize, true);
        const b1 = r.index(boneIndexSize, true);
        const w0 = r.f32();
        bones.push(b0, b1);
        weights.push(w0, 1 - w0);
        r.skip(36); // SDEF data (c, r0, r1) — 3 vec3s
        break;
      }
      case 4: { // QDEF
        bones.push(r.index(boneIndexSize, true));
        bones.push(r.index(boneIndexSize, true));
        bones.push(r.index(boneIndexSize, true));
        bones.push(r.index(boneIndexSize, true));
        weights.push(r.f32(), r.f32(), r.f32(), r.f32());
        break;
      }
      default:
        throw new Error(`unknown bone type ${boneType} at vertex ${i}`);
    }
    const edgeScale = r.f32();
    vertices.push({ position, normal, uv, boneType, bones, weights, edgeScale });
  }

  // Indices
  const indexCount = r.i32();
  const indices: number[] = [];
  for (let i = 0; i < indexCount; i++) {
    indices.push(r.index(vertexIndexSize, false));
  }

  // Textures
  const textureCount = r.i32();
  const textures: PMXTexture[] = [];
  for (let i = 0; i < textureCount; i++) {
    textures.push({ path: r.text(encoding) });
  }

  // Materials
  const materialCount = r.i32();
  const materials: PMXMaterial[] = [];
  for (let i = 0; i < materialCount; i++) {
    const matName = r.text(encoding);
    const matNameEn = r.text(encoding);
    const diffuse = r.vec4();
    const specular = r.vec3();
    const specularStrength = r.f32();
    const ambient = r.vec3();
    const drawFlags = r.u8();
    const edgeColor = r.vec4();
    const edgeScale = r.f32();
    const textureIndex = r.index(textureIndexSize, true);
    const sphereIndex = r.index(textureIndexSize, true);
    const sphereMode = r.u8();
    const toonFlag = r.u8() !== 0;
    const toonIndex = toonFlag ? r.u8() : r.index(textureIndexSize, true);
    const matComment = r.text(encoding);
    const vertexCountForMat = r.i32();
    materials.push({
      name: matName, nameEn: matNameEn, diffuse, specular, specularStrength,
      ambient, drawFlags, edgeColor, edgeScale, textureIndex, sphereIndex,
      sphereMode, toonFlag, toonIndex, comment: matComment, vertexCount: vertexCountForMat,
    });
  }

  // Bones
  const boneCount = r.i32();
  const bones: PMXBone[] = [];
  for (let i = 0; i < boneCount; i++) {
    const boneName = r.text(encoding);
    const boneNameEn = r.text(encoding);
    const position = r.vec3();
    const parentId = r.index(boneIndexSize, true);
    const transformLevel = r.i32();
    const flags = r.u16();

    // PMX 2.0/2.1 bone flag bits (per spec + reference impls):
    // 0x0001: indexed tail position (tail is bone index vs vec3)
    // 0x0002: rotatable
    // 0x0004: movable
    // 0x0008: visible
    // 0x0010: enabled
    // 0x0020: IK
    // 0x0080: local append (modifier for append)
    // 0x0100: append/inherit rotation
    // 0x0200: append/inherit translation
    // 0x0400: fixed axis
    // 0x0800: local axes
    // 0x1000: physics after deform
    // 0x2000: external parent
    const hasIndexedTail = (flags & 0x0001) !== 0;
    const hasRotatable = (flags & 0x0002) !== 0;
    const hasMovable = (flags & 0x0004) !== 0;
    const hasVisible = (flags & 0x0008) !== 0;
    const hasEnabled = (flags & 0x0010) !== 0;
    const isIK = (flags & 0x0020) !== 0;
    const hasAppendLocal = (flags & 0x0080) !== 0;
    const hasAppendRotation = (flags & 0x0100) !== 0;
    const hasAppendTranslation = (flags & 0x0200) !== 0;
    const hasFixedAxis = (flags & 0x0400) !== 0;
    const hasLocalAxes = (flags & 0x0800) !== 0;
    const hasExternalParent = (flags & 0x2000) !== 0;

    // Tail position: bone index if indexed tail flag set, otherwise vec3
    if (hasIndexedTail) {
      r.index(boneIndexSize, true); // tail bone index (unused for skeleton)
    } else {
      r.vec3(); // tail position (unused for skeleton)
    }

    let ikTarget = 0, ikLoopCount = 0, ikUnitAngle = 0;
    let ikLinks: PMXBone["ikLinks"] = [];
    if (isIK) {
      ikTarget = r.index(boneIndexSize, true);
      ikLoopCount = r.i32();
      ikUnitAngle = r.f32();
      const linkCount = r.i32();
      ikLinks = [];
      for (let l = 0; l < linkCount; l++) {
        const target = r.index(boneIndexSize, true);
        const hasAngleLimit = r.u8() !== 0;
        const lowerLimit: [number, number, number] = hasAngleLimit ? r.vec3() : [0, 0, 0];
        const upperLimit: [number, number, number] = hasAngleLimit ? r.vec3() : [0, 0, 0];
        ikLinks.push({ target, hasAngleLimit, lowerLimit, upperLimit });
      }
    }

    let appendBoneId = -1;
    let appendOffset: [number, number, number] = [0, 0, 0];
    if (hasAppendRotation || hasAppendTranslation) {
      appendBoneId = r.index(boneIndexSize, true);
      const ratio = r.f32();
      appendOffset = [ratio, 0, 0];
    }

    let fixedAxis: [number, number, number] = [0, 0, 0];
    if (hasFixedAxis) {
      fixedAxis = r.vec3();
    }

    let localXAxis: [number, number, number] = [1, 0, 0];
    let localZAxis: [number, number, number] = [0, 0, 1];
    if (hasLocalAxes) {
      localXAxis = r.vec3();
      localZAxis = r.vec3();
    }

    let externalParentKey = 0;
    if (hasExternalParent) {
      externalParentKey = r.i32();
    }

    bones.push({
      name: boneName, nameEn: boneNameEn, position, parentId, transformLevel, flags,
      hasRotatable, hasMovable, hasVisible, hasEnabled, isIK, ikTarget, ikLoopCount,
      ikUnitAngle, ikLinks, appendBoneId, appendOffset, hasAppendRotation,
      hasAppendTranslation, hasFixedAxis, fixedAxis, hasLocalAxes, localXAxis,
      localZAxis, externalParentKey,
    });
  }

  return {
    name, nameEn, comment, commentEn, vertices, indices, textures, materials, bones,
    encoding, uvAdditionalCount, vertexIndexSize, textureIndexSize, materialIndexSize,
    boneIndexSize, morphIndexSize, rigidbodyIndexSize,
  };
}

/// MMD bone name → Serika humanoid role mapping.
/// MMD uses Japanese names; we map the standard set.
const MMD_BONE_MAP: Record<string, string> = {
  // Japanese names
  "センター": "hips",
  "上半身": "spine",
  "下半身": "hips", // lower body — not a standard role but maps close
  "上半身２": "chest",
  "首": "neck",
  "頭": "head",
  "左肩": "leftShoulder",
  "右肩": "rightShoulder",
  "左腕": "leftUpperArm",
  "右腕": "rightUpperArm",
  "左ひじ": "leftLowerArm",
  "右ひじ": "rightLowerArm",
  "左手首": "leftHand",
  "右手首": "rightHand",
  "左足": "leftUpperLeg",
  "右足": "rightUpperLeg",
  "左ひざ": "leftLowerLeg",
  "右ひざ": "rightLowerLeg",
  "左足首": "leftFoot",
  "右足首": "rightFoot",
  "左足先": "leftToes",
  "右足先": "rightToes",
  "左足ＩＫ": "leftFoot",
  "右足ＩＫ": "rightFoot",
  "左つま先ＩＫ": "leftToes",
  "右つま先ＩＫ": "rightToes",
  "左目": "leftEye",
  "右目": "rightEye",
  // English names (some models use them)
  "Center": "hips",
  "Upper body": "spine",
  "Lower body": "hips",
  "Chest": "chest",
  "Neck": "neck",
  "Head": "head",
  "Left shoulder": "leftShoulder",
  "Right shoulder": "rightShoulder",
  "Left arm": "leftUpperArm",
  "Right arm": "rightUpperArm",
  "Left elbow": "leftLowerArm",
  "Right elbow": "rightLowerArm",
  "Left wrist": "leftHand",
  "Right wrist": "rightHand",
  "Left leg": "leftUpperLeg",
  "Right leg": "rightUpperLeg",
  "Left knee": "leftLowerLeg",
  "Right knee": "rightLowerLeg",
  "Left ankle": "leftFoot",
  "Right ankle": "rightFoot",
  "Left toe": "leftToes",
  "Right toe": "rightToes",
  "Left eye": "leftEye",
  "Right eye": "rightEye",
};

/// Extract humanoid bone map from a parsed PMX model.
/// Returns a Record<role, boneName> suitable for .ska meta.
export function extractPMXHumanoid(model: PMXModel): Record<string, string> {
  const out: Record<string, string> = {};
  for (const bone of model.bones) {
    // Try Japanese name first, then English
    const role = MMD_BONE_MAP[bone.name] ?? MMD_BONE_MAP[bone.nameEn];
    if (role && !out[role]) {
      out[role] = bone.name; // use the Japanese name as the glTF node name
    }
  }
  return out;
}

/// Find the head bone's Y position (in meters) for height measurement.
/// PMX bone positions are relative to the model origin (not accumulated up the chain).
/// We normalize to meters using the model's bounding box height (assuming ~1.6m avatar).
export function findHeadY(model: PMXModel, humanoid: Record<string, string>): number {
  // Compute bounding box height from vertices
  let minY = Infinity, maxY = -Infinity;
  for (const v of model.vertices) {
    if (v.position[1] < minY) minY = v.position[1];
    if (v.position[1] > maxY) maxY = v.position[1];
  }
  const bboxHeight = maxY - minY;
  const unitsPerMeter = bboxHeight / 1.6;

  const headName = humanoid.head;
  if (!headName) return 1.4;
  const bone = model.bones.find(b => b.name === headName);
  if (!bone) return 1.4;
  return bone.position[1] / unitsPerMeter;
}
