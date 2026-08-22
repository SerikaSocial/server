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

import type { PMXModel } from "./pmx.ts";

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

class BufferBuilder {
  private views: { data: Uint8Array; target?: number }[] = [];
  private current: number[] = [];
  private currentTarget: number | undefined;
  private currentViewIdx = -1;

  beginView(target?: number): number {
    this.flush();
    this.currentTarget = target;
    this.currentViewIdx = this.views.length;
    this.views.push({ data: new Uint8Array(0), target });
    return this.currentViewIdx;
  }

  f32(v: number): void {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, v, true);
    this.current.push(...new Uint8Array(buf));
  }

  u8(v: number): void {
    this.current.push(v & 0xff);
  }

  u16(v: number): void {
    const buf = new ArrayBuffer(2);
    new DataView(buf).setUint16(0, v, true);
    this.current.push(...new Uint8Array(buf));
  }

  u32(v: number): void {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, v, true);
    this.current.push(...new Uint8Array(buf));
  }

  i8(v: number): void {
    this.current.push(v & 0xff);
  }

  raw(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) this.current.push(bytes[i]);
  }

  padTo4(): void {
    while (this.current.length % 4 !== 0) this.current.push(0);
  }

  flush(): void {
    if (this.current.length > 0 && this.currentViewIdx >= 0) {
      this.views[this.currentViewIdx] = {
        data: new Uint8Array(this.current),
        target: this.currentTarget,
      };
      this.current = [];
    }
  }

  build(): { views: GltfBufferView[]; buffer: Uint8Array } {
    this.flush();
    const gltfViews: GltfBufferView[] = [];
    let offset = 0;
    const chunks: Uint8Array[] = [];
    for (const v of this.views) {
      // Align to 4 bytes
      while (offset % 4 !== 0) { chunks.push(new Uint8Array([0])); offset++; }
      gltfViews.push({
        buffer: 0,
        byteOffset: offset,
        byteLength: v.data.length,
        target: v.target,
      });
      chunks.push(v.data);
      offset += v.data.length;
    }
    const buffer = new Uint8Array(offset);
    let pos = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, pos);
      pos += chunk.length;
    }
    return { views: gltfViews, buffer };
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
  const buf = new BufferBuilder();
  const accessors: GltfAccessor[] = [];
  const materials: GltfMaterial[] = [];
  const textures: GltfTexture[] = [];
  const images: GltfImage[] = [];

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
    let translation: [number, number, number] = bone.position;
    if (bone.parentId >= 0 && bone.parentId < model.bones.length) {
      const parent = model.bones[bone.parentId];
      translation = [
        bone.position[0] - parent.position[0],
        bone.position[1] - parent.position[1],
        bone.position[2] - parent.position[2],
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
      const p = model.vertices[vi].position;
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

    // Material
    let matGltfIdx = -1;
    if (matIdx < materials.length) matGltfIdx = matIdx;
    else {
      // Build material
      const pbr: GltfMaterial["pbrMetallicRoughness"] = {
        metallicFactor: 0,
        roughnessFactor: 1,
      };
      // Set base color from diffuse
      pbr.baseColorFactor = mat.diffuse;
      // Texture
      if (mat.textureIndex >= 0 && mat.textureIndex < model.textures.length) {
        if (textureBytes && textureBytes.has(mat.textureIndex)) {
          const tex = textureBytes.get(mat.textureIndex)!;
          const imgView = buf.beginView();
          buf.raw(tex.bytes);
          buf.padTo4();
          const imgIdx = images.length;
          images.push({ bufferView: imgView, mimeType: tex.mimeType });
          const texIdx = textures.length;
          textures.push({ source: imgIdx });
          pbr.baseColorTexture = { index: texIdx };
        }
      }
      const gltfMat: GltfMaterial = {
        name: mat.name || mat.nameEn || `Material_${matIdx}`,
        pbrMetallicRoughness: pbr,
        doubleSided: true, // MMD models are often double-sided
      };
      matGltfIdx = materials.length;
      materials.push(gltfMat);
    }

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
    buf.f32(-bone.position[0]); buf.f32(-bone.position[1]); buf.f32(-bone.position[2]); buf.f32(1);
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
  // Pad JSON to 4 bytes
  const jsonPadded = jsonBytes.length % 4 === 0 ? jsonBytes : new Uint8Array(
    Math.ceil(jsonBytes.length / 4) * 4,
  );
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
