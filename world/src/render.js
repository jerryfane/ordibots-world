// The WebGPU reef: sand, rocks, kelp, up to 8 Ordibots assembled exactly like the hangar (onchain/payload-v2.js
// rules: place / look below are the hangar's), PBR, sun shadow map, caustics, fog, bloom.
// createRenderer(canvas, shot) → null without WebGPU, else { bot(t), frame(t, eye, target), project(p), lost }.
const BG = { 'Bitcoin Orange': 0xf7921d, Purple: 0x8e6fb6, Brown: 0x8b5850, Blue: 0x6b8494 };
const GLITCH = { Black: 0, Red: 0xcc0000, White: 0xffffff };
const STANDARD = 0x3e999f;
// laser beam eye [y, z] pairs per face index (the original's table; beam x starts at 4.5, 5.5 on a triangular head)
const LASER = { 16: [2.5, 2.5], 19: [2.5, 2.5], 20: [2.5, 2.5], 17: [2.5, 1.5], 18: [2.5, 1.5], 21: [2.5, 1.5, -2.5], 22: [1.5, 1.5] };
const DEFAULT_T = '38,1,7,13,21,33,43,37'; // Ordibot #0
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// a bot's traits: [[type, name, asset]…], its background colour, glitch tint, laser, triangular head, aureola, face
function botTraits(t) {
  const idx = ('' + t).split(',').map(Number).filter((i) => TRAITS[i]);
  const traits = idx.map((i) => TRAITS[i]);
  let bg = BG.Blue, glitch, laser;
  for (const [type, name] of traits) {
    if (type == 'Background') bg = BG[name]; // as in the original, the last one wins
    if (type == 'Glitch') glitch = GLITCH[name];
    if (type == 'Laser Eye') laser = 1;
  }
  return { traits, bg, glitch, laser, tri: idx.some((i) => i >= 7 && i <= 9), aur: idx.includes(25), face: idx.find((i) => i >= 16 && i <= 22) };
}

// a ribbon along a path: rect cross-section [±hw in z, ±ht in y], uv.y across the width (the Rainbow stand-in)
function ribbon(path, N, hw, ht) {
  const pos = [], nor = [], uv = [], idx = [];
  for (const [a, b, n, va, vb] of [[[-hw, ht], [hw, ht], [1, 0], 0, 1], [[hw, -ht], [-hw, -ht], [-1, 0], 1, 0], [[-hw, -ht], [-hw, ht], [0, -1], 0.01, 0.01], [[hw, ht], [hw, -ht], [0, 1], 0.99, 0.99]]) {
    const o = pos.length / 3;
    for (let i = 0; i <= N; i++) {
      const [x, y, z] = path(i / N);
      for (const [c, v] of [[a, va], [b, vb]]) pos.push(x, y + c[1], z + c[0]), nor.push(0, n[0], n[1]), uv.push(i / N, v);
      if (i) idx.push(o + 2 * i - 2, o + 2 * i - 1, o + 2 * i, o + 2 * i - 1, o + 2 * i + 1, o + 2 * i);
    }
  }
  return { pos, nor, uv, idx };
}
// an open cone along +x from radius r0 to r1 over len, uv.y 0 → 1 along it (laser beams)
function cone(r0, r1, len, seg = 20) {
  const pos = [], nor = [], uv = [], idx = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
    pos.push(0, c * r0, s * r0, len, c * r1, s * r1), nor.push(0, c, s, 0, c, s), uv.push(i / seg, 0, i / seg, 1);
    if (i) idx.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
  }
  return { pos, nor, uv, idx };
}

// where the original renderer puts each part: [position, uniform scale] (gltf.scene.position / .scale)
function place(type, tri, aur) {
  const T = (a, b) => (tri ? a : b);
  return {
    Face: [[T(1.5, 0.25), -10, 0]], Belly: [[3.1, -10, 0]], Belly_Empty: [[3, -10, 2]], Antenna: [[0, -6, 5]],
    Wings: [[T(-6.2, -5), 0, 0], 0.06], Aureola: [[0, 11, 0]], Tail: [[-6, -1, -9], 0.06], Horn: [[0, 8.5, 0]],
    Headphones: [[0, 5, 0], 0.085], Crown: [[0, T(8.5, 7.5), 0], 3], Hat: [[0, 8.5, 4], 12],
    Jetpack: [[T(-7.5, -6.5), 1.5, 0], 0.065], Glasses: [[T(6.5, 5), 3, 0], 6], Backpack: [[-4.3, -4.5, 0], 0.03],
    Diamond: [[0, aur ? 17 : 13, 0], 1],
  }[type] || [[0, -10, 0]];
}

// PBR look per part (the hangar's): gold is metal, the screens and halo glow, Glitch traits recolour body and head
function look(type, name, m, glitch) {
  const L = (h) => [...lin(h), 1];
  const o = { base: m.base, metal: m.metal, rough: Math.max(m.rough, 0.3), emis: [0, 0, 0, 0], flags: (m.baseTex ? 1 : 0) | (m.mrTex ? 2 : 0), band: 0, baseTex: m.baseTex, mrTex: m.mrTex };
  const part = type == 'Body' || type.startsWith('Head');
  if (/Golden/.test(name)) Object.assign(o, { base: [1, 0.5, 0.1, 1], metal: 1, rough: 0.26 });
  if (/Standard/.test(name)) o.base = L(glitch ?? STANDARD), (o.emis = [...o.base.slice(0, 3).map((v) => v * 0.12), 0]), (o.rough = 0.32);
  if (part && glitch != null) {
    Object.assign(o, { base: L(glitch || 0x080808), metal: 0, rough: glitch ? 0.26 : 0.14 });
    if (glitch == 0xffffff) o.emis = [0, 0, 0, 0.55];
  }
  if (type == 'Face') Object.assign(o, { base: /Green/.test(name) ? L(0x44ff00) : [1, 1, 1, 1], rough: 0.12, flags: 5, band: name == 'Unimpressed Face' ? 0.595 : 0.415, emis: [0, 0, 0, 1] });
  if (/Belly|Antenna/.test(type)) Object.assign(o, { base: [0.012, 0.012, 0.014, 1], rough: 0.22 });
  if (type == 'Wings') o.emis = [0, 0, 0, 0.3];
  if (type == 'Aureola') o.emis = [0, 0, 0, 2.4];
  if (type == 'Tail' || type == 'Horn') o.emis = [0.3, 0, 0, 0];
  if (name == 'Blue Headphones') Object.assign(o, { base: L(0x2b63d9), flags: o.flags & 2 });
  if (type == 'Jetpack') o.metal = 0.8;
  if (type == 'Diamond') Object.assign(o, { metal: 0, rough: 0.05, emis: [...lin(0x2986cc), 0] });
  if (type == 'Rainbow') Object.assign(o, { flags: 8, rough: 0.75, emis: [0, 0, 0, 0.6] });
  return o;
}

// seeded scenery shared by every player: rocks [x, z, radius] and kelp groves; the world uses ROCKS for collisions
const rng = ((a) => () => ((a = (a + 0x6d2b79f5) | 0), (((a ^ (a >>> 15)) * (a | 1)) >>> 0) / 4294967296))(7);
const ROCKS = [];
for (let i = 0; i < 18; i++) {
  const a = rng() * 6.283, d = i < 5 ? 95 + rng() * 25 : 120 + rng() * 140, r = i < 5 ? 7 + rng() * 6 : 8 + rng() * 16;
  ROCKS.push([Math.cos(a) * d, Math.sin(a) * d, r]);
}
// a low-poly boulder (flat shaded): a squashed, lumpy sphere sunk a little into the sand
function rocks() {
  const pos = [], nor = [], uv = [], idx = [];
  for (const [cx, cz, R] of ROCKS) {
    const k = [rng() * 9, rng() * 9, rng() * 9], P = [];
    const at = (i, j) => {
      const th = (i / 6) * Math.PI, ph = (j / 9) * 2 * Math.PI, d = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      const r = R * (1 + 0.22 * Math.sin(d[0] * 3 + k[0]) * Math.sin(d[1] * 3 + k[1]) + 0.12 * Math.sin(d[2] * 5 + k[2]));
      return [cx + d[0] * r, (d[1] * 0.62 - 0.25) * r, cz + d[2] * r];
    };
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 9; j++) {
        const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), e = at(i, j + 1);
        for (const [p, q, w] of [[a, b, c], [a, c, e]]) {
          const n = norm(cross(sub(q, p), sub(w, p)));
          if (!isFinite(n[0])) continue;
          for (const v of [p, q, w]) idx.push(pos.length / 3), pos.push(...v), nor.push(...n.map((x) => -x)), uv.push(0, 0);
        }
      }
  }
  return { pos, nor, uv, idx };
}
// kelp strands: twisted ribbons, 4–9 per grove next to the rocks; uv = [phase, height fraction] drives the sway
function kelp() {
  const pos = [], nor = [], uv = [], idx = [];
  for (const [rx, rz, rr] of ROCKS.slice(0, 12))
    for (let s = 4 + rng() * 6; s-- > 0; ) {
      const a = rng() * 6.283, d = rr + 3 + rng() * 9, x = rx + Math.cos(a) * d, z = rz + Math.sin(a) * d;
      const h = 30 + rng() * 55, tw = rng() * 6, ph = rng() * 6.283, N = 12, o = pos.length / 3;
      for (let i = 0; i <= N; i++) {
        const f = i / N, t = tw + f * 4, w = 2.2 * (1 - 0.65 * f) * (0.6 + 0.4 * Math.sin(f * 9 + ph)) + 0.4, c = Math.cos(t), sn = Math.sin(t);
        pos.push(x - c * w, f * h, z - sn * w, x + c * w, f * h, z + sn * w);
        nor.push(-sn, 0, c, -sn, 0, c), uv.push(ph, f, ph, f);
        if (i) idx.push(o + 2 * i - 2, o + 2 * i - 1, o + 2 * i, o + 2 * i - 1, o + 2 * i + 1, o + 2 * i);
      }
    }
  return { pos, nor, uv, idx };
}

async function createRenderer(cv, shot) {
  const gpu = navigator.gpu, adapter = gpu && (await gpu.requestAdapter()), dev = adapter && (await adapter.requestDevice());
  if (!dev) return null;
  const ctx = cv.getContext('webgpu'), fmt = gpu.getPreferredCanvasFormat();
  const U = GPUBufferUsage, TU = GPUTextureUsage, FR = GPUShaderStage.FRAGMENT, VF = GPUShaderStage.VERTEX | FR;
  ctx.configure({ device: dev, format: fmt, alphaMode: 'opaque', usage: TU.RENDER_ATTACHMENT | (shot ? TU.COPY_SRC : 0) });
  const buf = (data, usage) => {
    const b = dev.createBuffer({ size: (data.byteLength + 3) & ~3, usage: usage | U.COPY_DST });
    dev.queue.writeBuffer(b, 0, data);
    return b;
  };
  const tex = (w, h, format, usage = TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, sampleCount = 1) =>
    dev.createTexture({ size: [w, h], format, usage, sampleCount });
  const bgl = (...e) => dev.createBindGroupLayout({ entries: e.map(([visibility, r], binding) => ({ binding, visibility, ...r })) });
  const bind = (layout, ...r) => dev.createBindGroup({ layout, entries: r.map((resource, binding) => ({ binding, resource })) });
  const L0 = bgl([VF, { buffer: {} }]), L1 = bgl([VF, { buffer: {} }], [FR, { texture: {} }], [FR, { texture: {} }]);
  const L2 = bgl([FR, { sampler: {} }], [FR, { texture: { sampleType: 'depth' } }], [FR, { sampler: { type: 'comparison' } }]);
  const LP = bgl([FR, { sampler: {} }], [FR, { texture: {} }], [FR, { texture: {} }]);
  const module = (code) => {
    const m = dev.createShaderModule({ code });
    m.getCompilationInfo().then((i) => i.messages.map((e) => e.type == 'error' && console.error(e.lineNum + ': ' + e.message)));
    return m;
  };
  const mS = module(WGSL_SCENE), mP = module(WGSL_POST);
  const ATTR = [['float32x3', 0], ['float32x3', 12], ['float32x2', 24]].map(([format, offset], shaderLocation) => ({ format, offset, shaderLocation }));
  const ADD = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
  const sceneLayout = dev.createPipelineLayout({ bindGroupLayouts: [L0, L1, L2] });
  const pipe = (vs, fs, o = {}) => dev.createRenderPipeline({
    layout: sceneLayout,
    vertex: { module: mS, entryPoint: vs, buffers: o.mesh === 0 ? [] : [{ arrayStride: 32, attributes: ATTR }] },
    fragment: { module: mS, entryPoint: fs, targets: [{ format: 'rgba16float', blend: o.blend }] },
    primitive: { topology: o.topo || 'triangle-list' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: o.write ?? true, depthCompare: o.cmp || 'less' },
    multisample: { count: 4 },
  });
  // draw kinds: 1 solid (casts shadows), 2 additive beams, 3 kelp
  const pipes = { 1: pipe('vs', 'fs'), 3: pipe('vsKelp', 'fs'), 2: pipe('vs', 'fsAdd', { blend: ADD, write: false }) };
  const pFloor = pipe('vsFloor', 'fsFloor', { mesh: 0, topo: 'triangle-strip' });
  const pBack = pipe('vsBack', 'fsBack', { mesh: 0, write: false, cmp: 'always' });
  const pShadow = dev.createRenderPipeline({
    layout: dev.createPipelineLayout({ bindGroupLayouts: [L0, L1] }),
    vertex: { module: mS, entryPoint: 'vsShadow', buffers: [{ arrayStride: 32, attributes: [ATTR[0]] }] },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 },
  });
  const postLayout = dev.createPipelineLayout({ bindGroupLayouts: [L0, LP] });
  const post = (fs, format = 'rgba16float', blend) => dev.createRenderPipeline({
    layout: postLayout, vertex: { module: mP, entryPoint: 'vs' }, fragment: { module: mP, entryPoint: fs, targets: [{ format, blend }] },
  });
  const pPre = post('fsPre'), pDown = post('fsDown'), pUp = post('fsUp', 'rgba16float', ADD), pComp = post('fsComp', fmt);
  const sRep = dev.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
  const sClamp = dev.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const SHADOW = 2048, shadow = tex(SHADOW, SHADOW, 'depth32float');
  const G2 = bind(L2, sRep, shadow.createView(), dev.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' }));
  const white = tex(1, 1, 'rgba8unorm', TU.TEXTURE_BINDING | TU.COPY_DST);
  dev.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), {}, [1, 1]);
  const sBuf = dev.createBuffer({ size: 224, usage: U.UNIFORM | U.COPY_DST }), gS = bind(L0, { buffer: sBuf });
  const G1 = bind(L1, { buffer: dev.createBuffer({ size: 192, usage: U.UNIFORM }) }, white.createView(), white.createView());

  // textures: glTF images, at most 512 px, shared between bots
  const texCache = new Map();
  const upload = (img, srgb, pending) => {
    if (!img) return white;
    const c = texCache.get(img) || {};
    if (c[srgb]) return c[srgb];
    const k = Math.min(1, 512 / Math.max(img.width, img.height)), w = Math.round(img.width * k), h = Math.round(img.height * k);
    const t = (c[srgb] = tex(w, h, srgb ? 'rgba8unorm-srgb' : 'rgba8unorm', TU.TEXTURE_BINDING | TU.COPY_DST | TU.RENDER_ATTACHMENT));
    texCache.set(img, c);
    pending.push((c.p = (k < 1 ? createImageBitmap(img, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' }) : Promise.resolve(img))
      .then((source) => dev.queue.copyExternalImageToTexture({ source }, { texture: t }, [w, h]))));
    return t;
  };
  // geometry → vertex/index buffers, once per mesh (a part's mesh is shared by every bot wearing it)
  const mesh = (g) => {
    const n = g.pos.length / 3, v = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) v.set([g.pos[3 * i], g.pos[3 * i + 1], g.pos[3 * i + 2], g.nor[3 * i], g.nor[3 * i + 1], g.nor[3 * i + 2], g.uv[2 * i], g.uv[2 * i + 1]], 8 * i);
    return { vb: buf(v, U.VERTEX), ib: buf(new Uint32Array(g.idx), U.INDEX), count: g.idx.length };
  };
  const meshes = new Map(); // asset id → Promise<[{mesh, M, mat}]>
  const part = (asset) => meshes.get(asset) || meshes.set(asset, loadGltf('/content/' + asset).then((ps) => ps.filter((p) => !p.draco).map((p) => ({ mesh: mesh(p), M: p.M, mat: p.mat })))).get(asset);
  const once = {};
  const shared = (k, f) => once[k] || (once[k] = mesh(f()));

  // a draw: a mesh, its material and its own uniform; d.place(M, blink) rewrites the uniform
  const D = new Float32Array(48);
  const draw = (m, o, kind, pending) => {
    const u = dev.createBuffer({ size: 192, usage: U.UNIFORM | U.COPY_DST });
    const d = { ...m, kind, u, g: bind(L1, { buffer: u }, upload(o.baseTex, 1, pending).createView(), upload(o.mrTex, 0, pending).createView()) };
    d.place = (M, blink = 0) => {
      const N = invert(M);
      D.set(M);
      D.set(N.map((_, i) => N[(i % 4) * 4 + (i >> 2)]), 16);
      D.set(o.base, 32), D.set(o.emis, 36), D.set([o.metal, o.rough, o.flags, 0], 40), D.set([Math.sign(det3(M)), o.band, blink, o.fade || 0], 44);
      dev.queue.writeBuffer(u, 0, D);
    };
    return d;
  };
  const statics = [];
  const solid = (o) => ({ base: [...lin(o), 1], emis: [0, 0, 0, 0], metal: 0, rough: 0.85, flags: 0, band: 0 });
  for (const [g, o, kind] of [[rocks(), solid(0x6d6a63), 1], [kelp(), { ...solid(0x4d6a1c), rough: 0.55, emis: [0, 0, 0, 0.12], fade: 1 }, 3]]) {
    const d = draw(mesh(g), o, kind, []);
    d.place(I4()), statics.push(d);
  }

  // one Ordibot: inst.draws (local matrices), inst.set(M, blink, t) places it; inst.ready once parts are loaded
  const bots = new Set();
  const bot = (t) => {
    const { traits, bg, glitch, laser, tri, aur, face } = botTraits(t), pending = [], parts = [];
    const inst = { bg, draws: [], ready: false, visible: true };
    const add = (m, L, o, kind, spin) => parts.push({ d: draw(m, o, kind, pending), L, spin });
    inst.loaded = Promise.all(traits.map(async ([type, name, asset]) => {
      const [p, s = 0.05] = place(type, tri, aur), P = trs(p, 0, [s, s, s]);
      if (type == 'Rainbow') {
        // Draco-compressed in the original: the hangar's measured ribbon stands in
        const path = (u, x = -1.4 - 134.6 * u) => [x, -4.9 + 2.9 * Math.exp(-(((x + 54) / 24) ** 2)), 0];
        return add(shared('rb', () => ribbon(path, 80, 3.05, 0.95)), I4(), look(type, name, { base: [1, 1, 1, 1], metal: 0, rough: 0.3 }), 1);
      }
      if (!asset) return;
      try {
        for (const m of await part(asset))
          add(m.mesh, mul(P, m.M), look(type, name, m.mat, glitch), 1, type == 'Diamond' && ((t) => mul(trs(p, [0, Math.sin(t * 0.6), 0, Math.cos(t * 0.6)]), m.M)));
      } catch (e) {
        console.warn('Ordibot part ' + name + ' failed to load: ' + e.message);
      }
    })).then(async () => {
      if (laser && LASER[face]) {
        const [y, z, z2 = -z] = LASER[face];
        for (const zz of [z, z2])
          for (const [k, r0, r1, e, f] of [['lg', 0.35, 2, [2.2, 0.05, 0.03], 2.5], ['lc', 0.25, 0.5, [3, 1.4, 1.3], 0.8]])
            add(shared(k, () => cone(r0, r1, 150)), trs([tri ? 5.5 : 4.5, y, zz]), { base: [0, 0, 0, 1], emis: [...e, 0], metal: 0, rough: f, flags: 0, band: 0 }, 2);
      }
      await Promise.all(pending.concat([...texCache.values()].map((c) => c.p)));
      inst.draws = parts.map((p) => p.d);
      inst.ready = true;
    });
    inst.set = (B, blink, t) => {
      for (const p of parts) p.d.place(mul(B, p.spin ? p.spin(t) : p.L), blink);
    };
    inst.remove = () => {
      bots.delete(inst);
      for (const p of parts) p.d.u.destroy();
    };
    bots.add(inst);
    return inst;
  };

  let W, H, hdr, msaa, depth, postG, vp, grab, frames = 0;
  const resize = () => {
    const r = Math.min(devicePixelRatio, 2), w = Math.max(1, Math.round(cv.clientWidth * r)), h = Math.max(1, Math.round(cv.clientHeight * r));
    if (w == W && h == H) return;
    (cv.width = W = w), (cv.height = H = h);
    hdr = tex(w, h, 'rgba16float');
    msaa = tex(w, h, 'rgba16float', TU.RENDER_ATTACHMENT, 4);
    depth = tex(w, h, 'depth24plus', TU.RENDER_ATTACHMENT, 4);
    const blooms = [1, 2, 3, 4, 5].map((i) => tex(Math.max(1, w >> i), Math.max(1, h >> i), 'rgba16float'));
    const v = (t) => t.createView();
    // [pipeline, source, target, load]: threshold + downsample, 4 more downsamples, 4 additive upsamples, composite
    postG = [[pPre, hdr, blooms[0]], ...[1, 2, 3, 4].map((i) => [pDown, blooms[i - 1], blooms[i]]), ...[4, 3, 2, 1].map((i) => [pUp, blooms[i], blooms[i - 1], 1]), [pComp, hdr]]
      .map(([p, a, t, load]) => [p, bind(LP, sClamp, v(a), p == pComp ? v(blooms[0]) : white.createView()), t && v(t), load]);
  };
  const S = new Float32Array(56), KEY = norm([0.32, 0.9, 0.28]);
  const R = {
    bot, mode: 'webgpu', lost: dev.lost,
    // world point → [css x, css y] on the canvas, or null behind the camera
    project: (p) => {
      if (!vp) return null;
      const c = [0, 1, 3].map((r) => vp[r] * p[0] + vp[4 + r] * p[1] + vp[8 + r] * p[2] + vp[12 + r]);
      return c[2] > 0.5 ? [(c[0] / c[2] / 2 + 0.5) * cv.clientWidth, (0.5 - c[1] / c[2] / 2) * cv.clientHeight] : null;
    },
    frame: (t, eye, tgt, onShot) => {
      resize();
      vp = mul(perspective(0.62, W / H, 1, 2500), lookAt(eye, tgt));
      // the sun's shadow map follows the camera's target
      const lvp = mul(ortho(110, 1, 500), lookAt(tgt.map((v, i) => v + KEY[i] * 250), tgt));
      S.set(vp), S.set(invert(vp), 16), S.set(lvp, 32), S.set([...eye, t], 48), S.set([0, 0, 0.55, 1.1], 52);
      dev.queue.writeBuffer(sBuf, 0, S);
      const list = [...statics];
      for (const b of bots) if (b.ready && b.visible) list.push(...b.draws);
      const enc = dev.createCommandEncoder();
      const drawAll = (pass, kind, pipeline) => {
        if (pipeline) pass.setPipeline(pipeline);
        for (const d of list)
          if (d.kind == kind) pass.setBindGroup(1, d.g), pass.setVertexBuffer(0, d.vb), pass.setIndexBuffer(d.ib, 'uint32'), pass.drawIndexed(d.count);
      };
      let pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: shadow.createView(), depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'store' } });
      pass.setPipeline(pShadow), pass.setBindGroup(0, gS), drawAll(pass, 1), pass.end();
      pass = enc.beginRenderPass({
        colorAttachments: [{ view: msaa.createView(), resolveTarget: hdr.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 1] }],
        depthStencilAttachment: { view: depth.createView(), depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'discard' },
      });
      pass.setBindGroup(0, gS), pass.setBindGroup(1, G1), pass.setBindGroup(2, G2);
      pass.setPipeline(pBack), pass.draw(3), pass.setPipeline(pFloor), pass.draw(4);
      for (const k of [1, 3, 2]) drawAll(pass, k, pipes[k]);
      pass.end();
      for (const [p, g, target, load] of postG) {
        pass = enc.beginRenderPass({ colorAttachments: [{ view: target || ctx.getCurrentTexture().createView(), loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        pass.setPipeline(p), pass.setBindGroup(0, gS), pass.setBindGroup(1, g), pass.draw(3), pass.end();
      }
      // #shot (headless test screenshots): SwiftShader does not composite WebGPU canvases, so finished frames are
      // read back into the 2D canvas `shot` laid over the WebGPU one
      if (shot && !grab && ++frames > 2) {
        const bpr = Math.ceil((W * 4) / 256) * 256, w = W, h = H;
        grab = dev.createBuffer({ size: bpr * h, usage: U.COPY_DST | U.MAP_READ });
        enc.copyTextureToBuffer({ texture: ctx.getCurrentTexture() }, { buffer: grab, bytesPerRow: bpr }, [w, h]);
        dev.queue.submit([enc.finish()]);
        grab.mapAsync(GPUMapMode.READ).then(() => {
          const src = new Uint8Array(grab.getMappedRange()), img = new ImageData(w, h), bgr = fmt == 'bgra8unorm';
          for (let y = 0; y < h; y++)
            for (let x = 0; x < w; x++) {
              const i = y * bpr + x * 4, o = (y * w + x) * 4;
              img.data.set([src[i + (bgr ? 2 : 0)], src[i + 1], src[i + (bgr ? 0 : 2)], 255], o);
            }
          (shot.width = w), (shot.height = h), shot.getContext('2d').putImageData(img, 0, 0);
          grab.destroy(), (grab = 0), onShot();
        });
      } else dev.queue.submit([enc.finish()]);
    },
  };
  return R;
}
