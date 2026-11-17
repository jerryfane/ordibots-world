// Minimal glTF 2.0 reader for the Ordibots trait models: GLB or .gltf with data: URIs; node hierarchy (matrix or TRS),
// float positions/normals/uvs, u8/u16/u32 indices, metal/rough base material with base-colour and metal-rough textures.
// Draco-compressed primitives (only the Rainbow uses KHR_draco_mesh_compression) come back as {draco: true}.
const COMP = { 5120: [1, 'getInt8'], 5121: [1, 'getUint8'], 5122: [2, 'getInt16'], 5123: [2, 'getUint16'], 5125: [4, 'getUint32'], 5126: [4, 'getFloat32'] };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const b64 = (s) => Uint8Array.from(atob(s.slice(s.indexOf(',') + 1)), (c) => c.charCodeAt(0));

async function loadGltf(url) {
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const dv = new DataView(buf.buffer);
  let j, bin;
  if (dv.getUint32(0, true) == 0x46546c67) {
    const n = dv.getUint32(12, true);
    j = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + n)));
    bin = buf.subarray(28 + n, 28 + n + dv.getUint32(20 + n, true));
  } else j = JSON.parse(new TextDecoder().decode(buf));
  const buffers = (j.buffers || []).map((b) => (b.uri ? b64(b.uri) : bin));
  const view = (i) => {
    const v = j.bufferViews[i], b = buffers[v.buffer];
    return b.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
  };
  // copied out element by element: handles strides, offsets and unaligned views alike
  const acc = (i, Out = Float32Array) => {
    const a = j.accessors[i], [n, get] = COMP[a.componentType], k = SIZE[a.type], raw = view(a.bufferView);
    const stride = j.bufferViews[a.bufferView].byteStride || k * n, out = new Out(a.count * k);
    const src = new DataView(raw.buffer, raw.byteOffset + (a.byteOffset || 0));
    for (let e = 0; e < a.count; e++) for (let c = 0; c < k; c++) out[e * k + c] = src[get](e * stride + c * n, true);
    return out;
  };
  const images = await Promise.all((j.images || []).map((im) =>
    createImageBitmap(new Blob([im.uri ? b64(im.uri) : view(im.bufferView)], { type: im.mimeType || 'image/png' }))));
  const tex = (t) => t && images[j.textures[t.index].source];
  const mats = (j.materials || []).map((m) => {
    const p = m.pbrMetallicRoughness || {};
    return {
      name: m.name || '', base: p.baseColorFactor || [1, 1, 1, 1], metal: p.metallicFactor ?? 1, rough: p.roughnessFactor ?? 1,
      baseTex: tex(p.baseColorTexture), mrTex: tex(p.metallicRoughnessTexture),
    };
  });
  const prims = [];
  const walk = (ni, parent) => {
    const n = j.nodes[ni], M = mul(parent, n.matrix || trs(n.translation, n.rotation, n.scale));
    if (n.mesh != null)
      for (const p of j.meshes[n.mesh].primitives) {
        const mat = mats[p.material] || { name: '', base: [1, 1, 1, 1], metal: 1, rough: 1 };
        if (p.extensions && p.extensions.KHR_draco_mesh_compression) {
          prims.push({ draco: true, M, mat });
          continue;
        }
        const pos = acc(p.attributes.POSITION), count = pos.length / 3;
        prims.push({
          M, mat, pos,
          nor: p.attributes.NORMAL != null ? acc(p.attributes.NORMAL) : new Float32Array(count * 3),
          uv: p.attributes.TEXCOORD_0 != null ? acc(p.attributes.TEXCOORD_0) : new Float32Array(count * 2),
          idx: p.indices != null ? acc(p.indices, Uint32Array) : Uint32Array.from({ length: count }, (_, i) => i),
        });
      }
    for (const c of n.children || []) walk(c, M);
  };
  for (const r of j.scenes[j.scene || 0].nodes) walk(r, I4());
  return prims;
}
