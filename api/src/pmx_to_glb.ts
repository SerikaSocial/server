// PMX → glTF 2.0 binary (GLB) converter.
//
// Converts a parsed PMX model into a GLB that Godot's GltfDocument can import.
// The GLB contains:
//   - One mesh primitive per PMX material (grouped vertices/indices)
//   - POSITION, NORMAL, TEXCOORD_0, JOINTS_0, WEIGHTS_0 attributes
//   - Skinning: joints nodes (bones) + skin with inverse bind matrices
//   - Materials with baseColorTexture when a texture is referenced
//
// PMX coordinate system: Y-up, right-handed (same as glTF) — no axis flip needed.
// PMX bone positions are world-space (relative to model origin).

import { pmxUnitScale, type PMXModel } from "./pmx.ts";

// ── glTF helpers ─────────────────────────────────────────────────────────────

interface GltfNode {
  name?: string;
  translation?: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
  children?: number[];
  mesh?: number;
  skin?: number;
}

interface GltfMesh {
  primitives: {
    attributes: Record<string, number>;
    indices: number;
    material: number;
  }[];
}

interface GltfMaterial {
  name: string;
  pbrMetallicRoughness: {
    baseColorFactor?: [number, number, number, number];
    baseColorTexture?: { index: number };
    metallicFactor: number;
    roughnessFactor: number;
  };
  doubleSided?: boolean;
  alphaMode?: "OPAQUE" | "MASK" | "BLEND";
  alphaCutoff?: number;
}

/// Does this image carry an alpha channel? Alpha testing and blending are both expensive on tile
/// GPUs (they defeat early-Z), so materials only opt out of `OPAQUE` when the texture actually
/// needs it. Only PNG is sniffed — it is what MMD models overwhelmingly ship — and anything
/// unrecognised is assumed opaque.
function imageHasAlpha(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType !== "image/png") return false;
  // PNG: 8-byte signature, then the IHDR chunk; colour type is the 25th byte overall.
  if (bytes.length < 26) return false;
  const colorType = bytes[25];
  return colorType === 4 || colorType === 6; // grey+alpha, or RGBA
}

interface GltfSkin {
  joints: number[];
  inverseBindMatrices: number;
}

interface GltfAccessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

interface GltfBufferView {
  buffer: number;
  byteOffset: number;
  byteLength: number;
  target?: number;
}

interface GltfImage {
  bufferView: number;
  mimeType: string;
}

interface GltfTexture {
  source: number;
}

interface GltfJson {
  asset: { version: string; generator: string };
  scene: number;
  scenes: { nodes: number[] }[];
  nodes: GltfNode[];
  meshes: GltfMesh[];
  materials: GltfMaterial[];
  accessors: GltfAccessor[];
  bufferViews: GltfBufferView[];
  buffers: { byteLength: number }[];
  skins?: GltfSkin[];
  textures?: GltfTexture[];
  images?: GltfImage[];
}

const COMPONENT_FLOAT = 5126;
const COMPONENT_UNSIGNED_BYTE = 5121;
const COMPONENT_UNSIGNED_SHORT = 5123;
const COMPONENT_UNSIGNED_INT = 5125;

const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

// ── Binary buffer builder ────────────────────────────────────────────────────

/// Appends straight into one growable byte buffer and records each view as an (offset, length)
/// slice of it. Views are opened with `beginView` and closed by the next `beginView` or `build`.
///
/// Note this writes into a `Uint8Array`, not a `number[]`. A 15 MB model held as an array of
/// boxed JS numbers costs well over 100 MB of transient heap on the API process, which is the
/// difference between converting a dense MMD model and OOMing the container.
class BufferBuilder {
  private bytes = new Uint8Array(1 << 16);
  private len = 0;
  private views: { start: number; end: number; target?: number }[] = [];

  private reserve(n: number): void {
    if (this.len + n <= this.bytes.length) return;
    let cap = this.bytes.length;
    while (cap < this.len + n) cap *= 2;
    const grown = new Uint8Array(cap);
    grown.set(this.bytes.subarray(0, this.len));
    this.bytes = grown;
  }

  /// Open a new view. Views are 4-byte aligned, as glTF requires for accessor-backed data.
  beginView(target?: number): number {
    this.padTo4();
    const idx = this.views.length;
    this.views.push({ start: this.len, end: this.len, target });
    return idx;
  }

  private get view() { return this.views[this.views.length - 1]; }

  f32(v: number): void {
    this.reserve(4);
    new DataView(this.bytes.buffer, this.len, 4).setFloat32(0, v, true);
    this.len += 4;
    if (this.views.length) this.view.end = this.len;
  }

  u16(v: number): void {
    this.reserve(2);
    new DataView(this.bytes.buffer, this.len, 2).setUint16(0, v, true);
    this.len += 2;
    if (this.views.length) this.view.end = this.len;
  }

  u32(v: number): void {
    this.reserve(4);
    new DataView(this.bytes.buffer, this.len, 4).setUint32(0, v, true);
    this.len += 4;
    if (this.views.length) this.view.end = this.len;
  }

  raw(src: Uint8Array): void {
    this.reserve(src.length);
    this.bytes.set(src, this.len);
    this.len += src.length;
    if (this.views.length) this.view.end = this.len;
  }

  /// Pad the *buffer* (not the current view) up to the next 4-byte boundary.
  padTo4(): void {
    while (this.len % 4 !== 0) {
      this.reserve(1);
      this.bytes[this.len++] = 0;
    }
  }

  build(): { views: GltfBufferView[]; buffer: Uint8Array } {
    this.padTo4();
    const gltfViews: GltfBufferView[] = this.views.map(v => ({
      buffer: 0,
      byteOffset: v.start,
      byteLength: v.end - v.start,
      target: v.target,
    }));
    return { views: gltfViews, buffer: this.bytes.subarray(0, this.len) };
  }
}

// ── PMX → GLB ────────────────────────────────────────────────────────────────

export interface PmxConvertResult {
  glb: Uint8Array;
  boneNames: string[]; // glTF node names for each bone (by bone index)
  boneNodeIndices: number[]; // glTF node index for each PMX bone
}

/// Convert a parsed PMX model into a GLB.
/// `textureBytes` maps texture index → { bytes, mimeType } for embedded textures.
export function pmxToGlb(
  model: PMXModel,
  textureBytes?: Map<number, { bytes: Uint8Array; mimeType: string }>,
): PmxConvertResult {
  // Everything positional — vertices, bone rest translations, inverse bind matrices — is baked
  // into metres here rather than left to a scale on the root node, so downstream consumers
  // (Godot's skeleton import, the web preview's auto-framing, the .ska height fields) all agree.
  const s = pmxUnitScale(model);
  const buf = new BufferBuilder();
  const accessors: GltfAccessor[] = [];
  const materials: GltfMaterial[] = [];
  const textures: GltfTexture[] = [];
  const images: GltfImage[] = [];
  const texIdxByPmxTexture = new Map<number, number>();

  // ── Build bone nodes first (they come before mesh nodes in the node array) ──
  const nodes: GltfNode[] = [];
  const boneNodeIndices: number[] = [];

  // Build a children map
  const childrenMap = new Map<number, number[]>();
  for (let i = 0; i < model.bones.length; i++) {
    const parent = model.bones[i].parentId;
    if (parent >= 0 && parent < model.bones.length) {
      if (!childrenMap.has(parent)) childrenMap.set(parent, []);
      childrenMap.get(parent)!.push(i);
    }
  }

  // Create nodes for bones — convert PMX world-space positions to parent-relative
  for (let i = 0; i < model.bones.length; i++) {
    const bone = model.bones[i];
    // glTF node translation is relative to parent. PMX bone positions are world-space.
    // For root bones (no parent), use the world position directly.
    // For child bones, subtract parent's world position.
    let translation: [number, number, number] = [
      bone.position[0] * s, bone.position[1] * s, bone.position[2] * s,
    ];
    if (bone.parentId >= 0 && bone.parentId < model.bones.length) {
      const parent = model.bones[bone.parentId];
      translation = [
        (bone.position[0] - parent.position[0]) * s,
        (bone.position[1] - parent.position[1]) * s,
        (bone.position[2] - parent.position[2]) * s,
      ];
    }
    const node: GltfNode = {
      name: bone.name,
      translation,
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    };
    const children = childrenMap.get(i);
    if (children && children.length > 0) {
      node.children = children.map(c => c); // will fix up indices after all nodes are added
    }
    boneNodeIndices.push(nodes.length);
    nodes.push(node);
  }

  // Fix up children indices — they already point to bone indices which == node indices
  // since bones are the first N nodes
  for (let i = 0; i < model.bones.length; i++) {
    const children = childrenMap.get(i);
    if (children) {
      nodes[i].children = children.map(c => boneNodeIndices[c]);
    }
  }

  // Find root bones (parentId < 0 or out of range)
  const rootBones: number[] = [];
  for (let i = 0; i < model.bones.length; i++) {
    const parent = model.bones[i].parentId;
    if (parent < 0 || parent >= model.bones.length) {
      rootBones.push(boneNodeIndices[i]);
    }
  }

  // ── Build mesh ──────────────────────────────────────────────────────────────
  // Group indices by material
  let indexOffset = 0;
  const primitives: GltfMesh["primitives"] = [];

  for (let matIdx = 0; matIdx < model.materials.length; matIdx++) {
    const mat = model.materials[matIdx];
    const vertCount = mat.vertexCount;
    const matIndices = model.indices.slice(indexOffset, indexOffset + vertCount);
    indexOffset += vertCount;

    if (matIndices.length === 0) continue;

    // Collect unique vertices used by this material
    const usedVertSet = new Set<number>();
    for (const idx of matIndices) usedVertSet.add(idx);
    const usedVerts = [...usedVertSet].sort((a, b) => a - b);
    const oldToNew = new Map<number, number>();
    usedVerts.forEach((v, i) => oldToNew.set(v, i));

    // POSITION accessor
    const posView = buf.beginView(TARGET_ARRAY_BUFFER);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const vi of usedVerts) {
      const src = model.vertices[vi].position;
      const p: [number, number, number] = [src[0] * s, src[1] * s, src[2] * s];
      buf.f32(p[0]); buf.f32(p[1]); buf.f32(p[2]);
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
      if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
    }
    buf.padTo4();
    const posAcc = accessors.length;
    accessors.push({
      bufferView: posView, componentType: COMPONENT_FLOAT, count: usedVerts.length,
      type: "VEC3", min: [minX, minY, minZ], max: [maxX, maxY, maxZ],
    });

    // NORMAL accessor
    const normView = buf.beginView(TARGET_ARRAY_BUFFER);
    for (const vi of usedVerts) {
      const n = model.vertices[vi].normal;
      buf.f32(n[0]); buf.f32(n[1]); buf.f32(n[2]);
    }
    buf.padTo4();
    const normAcc = accessors.length;
    accessors.push({
      bufferView: normView, componentType: COMPONENT_FLOAT, count: usedVerts.length,
      type: "VEC3",
    });

    // TEXCOORD_0 accessor
    const uvView = buf.beginView(TARGET_ARRAY_BUFFER);
    for (const vi of usedVerts) {
      const uv = model.vertices[vi].uv;
      buf.f32(uv[0]); buf.f32(uv[1]);
    }
    buf.padTo4();
    const uvAcc = accessors.length;
    accessors.push({
      bufferView: uvView, componentType: COMPONENT_FLOAT, count: usedVerts.length,
      type: "VEC2",
    });

    // JOINTS_0 and WEIGHTS_0 — use up to 4 bones per vertex
    const jointsView = buf.beginView(TARGET_ARRAY_BUFFER);
    for (const vi of usedVerts) {
      const v = model.vertices[vi];
      const bones = v.bones.slice(0, 4);
      while (bones.length < 4) bones.push(0);
      for (let j = 0; j < 4; j++) {
        buf.u16(bones[j] >= 0 ? bones[j] : 0);
      }
    }
    buf.padTo4();
    const jointsAcc = accessors.length;
    accessors.push({
      bufferView: jointsView, componentType: COMPONENT_UNSIGNED_SHORT, count: usedVerts.length,
      type: "VEC4",
    });

    const weightsView = buf.beginView(TARGET_ARRAY_BUFFER);
    for (const vi of usedVerts) {
      const v = model.vertices[vi];
      const weights = v.weights.slice(0, 4);
      while (weights.length < 4) weights.push(0);
      const sum = weights.reduce((a, b) => a + b, 0) || 1;
      for (let j = 0; j < 4; j++) {
        buf.f32(weights[j] / sum);
      }
    }
    buf.padTo4();
    const weightsAcc = accessors.length;
    accessors.push({
      bufferView: weightsView, componentType: COMPONENT_FLOAT, count: usedVerts.length,
      type: "VEC4",
    });

    // INDICES accessor
    const idxView = buf.beginView(TARGET_ELEMENT_ARRAY_BUFFER);
    for (const idx of matIndices) {
      const newIdx = oldToNew.get(idx)!;
      if (usedVerts.length > 65535) {
        buf.u32(newIdx);
      } else {
        buf.u16(newIdx);
      }
    }
    buf.padTo4();
    const idxAcc = accessors.length;
    accessors.push({
      bufferView: idxView,
      componentType: usedVerts.length > 65535 ? COMPONENT_UNSIGNED_INT : COMPONENT_UNSIGNED_SHORT,
      count: matIndices.length,
      type: "SCALAR",
    });

    // Material. One glTF material per PMX material that actually draws something — never index
    // `materials` by `matIdx`, because materials with no indices are skipped above and the two
    // numbering schemes drift apart the moment that happens.
    const pbr: GltfMaterial["pbrMetallicRoughness"] = {
      metallicFactor: 0,
      roughnessFactor: 1,
      baseColorFactor: mat.diffuse,
    };
    let textureAlpha = false;
    if (mat.textureIndex >= 0 && mat.textureIndex < model.textures.length) {
      // Textures are shared between materials in MMD (hair and face often reuse one atlas), so
      // embed each PMX texture once and reuse the glTF texture index.
      let texIdx = texIdxByPmxTexture.get(mat.textureIndex);
      const tex = textureBytes?.get(mat.textureIndex);
      if (texIdx == null && tex) {
        const imgView = buf.beginView();
        buf.raw(tex.bytes);
        buf.padTo4();
        const imgIdx = images.length;
        images.push({ bufferView: imgView, mimeType: tex.mimeType });
        texIdx = textures.length;
        textures.push({ source: imgIdx });
        texIdxByPmxTexture.set(mat.textureIndex, texIdx);
      }
      if (texIdx != null) pbr.baseColorTexture = { index: texIdx };
      if (tex) textureAlpha = imageHasAlpha(tex.bytes, tex.mimeType);
    }

    // MMD leans on alpha-cutout textures for hair strands, eyelashes and eyebrow overlays; with
    // no alpha mode those render as opaque rectangles across the face. A translucent diffuse
    // alpha means genuine blending; an alpha channel in the texture alone is a cutout.
    const diffuseAlpha = mat.diffuse?.[3] ?? 1;
    const alphaMode = diffuseAlpha < 1 ? "BLEND" : textureAlpha ? "MASK" : "OPAQUE";
    const matGltfIdx = materials.length;
    materials.push({
      name: mat.name || mat.nameEn || `Material_${matIdx}`,
      pbrMetallicRoughness: pbr,
      doubleSided: true, // MMD models are often double-sided
      alphaMode,
      ...(alphaMode === "MASK" ? { alphaCutoff: 0.5 } : {}),
    });

    primitives.push({
      attributes: {
        POSITION: posAcc,
        NORMAL: normAcc,
        TEXCOORD_0: uvAcc,
        JOINTS_0: jointsAcc,
        WEIGHTS_0: weightsAcc,
      },
      indices: idxAcc,
      material: matGltfIdx,
    });
  }

  // ── Build mesh node ─────────────────────────────────────────────────────────
  const meshIdx = 0; // single mesh
  const meshes: GltfMesh[] = [{ primitives }];

  // Inverse bind matrices — PMX bone positions are world-space (relative to model origin).
  // The IBM is the inverse of the bone's world transform in rest pose.
  // Since PMX bones have identity rotation/scale in rest pose, the IBM is just
  // a translation by the negated bone position.
  const ibmView = buf.beginView();
  for (let i = 0; i < model.bones.length; i++) {
    const bone = model.bones[i];
    // 4x4 column-major (glTF format): inverse of translation-only matrix
    buf.f32(1); buf.f32(0); buf.f32(0); buf.f32(0);
    buf.f32(0); buf.f32(1); buf.f32(0); buf.f32(0);
    buf.f32(0); buf.f32(0); buf.f32(1); buf.f32(0);
    buf.f32(-bone.position[0] * s); buf.f32(-bone.position[1] * s); buf.f32(-bone.position[2] * s); buf.f32(1);
  }
  buf.padTo4();
  const ibmAcc = accessors.length;
  accessors.push({
    bufferView: ibmView, componentType: COMPONENT_FLOAT, count: model.bones.length,
    type: "MAT4",
  });

  // Skin
  const skin: GltfSkin = {
    joints: boneNodeIndices.slice(0, Math.min(boneNodeIndices.length, 65536)),
    inverseBindMatrices: ibmAcc,
  };

  // Mesh node (after bone nodes)
  const meshNodeIdx = nodes.length;
  nodes.push({
    name: "Mesh",
    mesh: meshIdx,
    skin: 0,
  });

  // Scene: root bones + mesh node
  const sceneNodes = [...rootBones, meshNodeIdx];

  // ── Assemble GLB ────────────────────────────────────────────────────────────
  const { views, buffer } = buf.build();

  const gltf: GltfJson = {
    asset: { version: "2.0", generator: "Serika PMX Converter" },
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: buffer.length }],
    skins: [skin],
  };
  if (textures.length > 0) gltf.textures = textures;
  if (images.length > 0) gltf.images = images;

  const jsonStr = JSON.stringify(gltf);
  const jsonBytes = new TextEncoder().encode(jsonStr);
  // Pad the JSON chunk to 4 bytes with *spaces* (0x20), as glTF requires. Zero padding leaves
  // trailing NULs inside the chunk, and strict parsers — including three.js/model-viewer — throw
  // on them, so any model whose JSON length was not already a multiple of 4 produced an
  // unloadable GLB.
  const paddedLen = Math.ceil(jsonBytes.length / 4) * 4;
  const jsonPadded = new Uint8Array(paddedLen).fill(0x20);
  jsonPadded.set(jsonBytes);

  // GLB structure: 12-byte header + JSON chunk + BIN chunk
  const jsonChunkLen = jsonPadded.length;
  const binChunkLen = buffer.length;
  const totalLen = 12 + 8 + jsonChunkLen + 8 + binChunkLen;

  const glb = new Uint8Array(totalLen);
  const dv = new DataView(glb.buffer);

  // Header
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true); // version
  dv.setUint32(8, totalLen, true);

  // JSON chunk
  dv.setUint32(12, jsonChunkLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  glb.set(jsonPadded, 20);

  // BIN chunk
  const binOffset = 20 + jsonChunkLen;
  dv.setUint32(binOffset, binChunkLen, true);
  dv.setUint32(binOffset + 4, 0x004e4942, true); // "BIN\0"
  glb.set(buffer, binOffset + 8);

  return {
    glb,
    boneNames: model.bones.map(b => b.name),
    boneNodeIndices,
  };
}
