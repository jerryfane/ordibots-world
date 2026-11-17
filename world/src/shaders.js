// WGSL for the reef plaza. Scene pass: group 0 = scene uniform S, group 1 = one draw (D + base/metal-rough textures),
// group 2 = samplers + shadow map. Post: group 0 = S, group 1 = sampler, source A, source B (the hangar's bloom chain).
// World units: the sand is y = 0, a resting bot's origin sits about 11 above it (the hangar's floor was at -11).
const WGSL_COMMON = /* wgsl */ `
struct S { vp: mat4x4f, ivp: mat4x4f, lvp: mat4x4f,
  eye: vec4f,    // camera position, w = time
  misc: vec4f }; // z bloom strength, w exposure
@group(0) @binding(0) var<uniform> s: S;
const PI = 3.14159265;
const KEY = vec3f(0.32, 0.9, 0.28); // the sun, straight-ish down through the water
fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453); }
// open water seen along r: dark below, teal towards the surface, the sun's glow and slow light shafts above
fn water(r: vec3f) -> vec3f {
  var c = mix(vec3f(0.004, 0.022, 0.04), vec3f(0.03, 0.17, 0.22), smoothstep(-0.35, 0.55, r.y));
  c += vec3f(0.3, 0.55, 0.55) * pow(max(dot(r, normalize(KEY)), 0.0), 18.0);
  let az = atan2(r.z, r.x);
  let shafts = pow(0.5 + 0.5 * sin(az * 23.0 + 2.0 * sin(az * 7.0 + s.eye.w * 0.15) + s.eye.w * 0.2), 8.0);
  c += vec3f(0.05, 0.13, 0.13) * shafts * smoothstep(0.05, 0.6, r.y) * (1.0 - smoothstep(0.75, 1.0, r.y));
  return c;
}
// moving caustic light on whatever faces the surface (tileable every 60 units)
fn caustic(xz: vec2f, time: f32) -> f32 {
  let p = fract(xz / 60.0) * 6.2831853 - 250.0;
  var i = p;
  var c = 1.0;
  for (var n = 0; n < 4; n++) {
    let t = time * 0.35 * (1.0 - 3.5 / f32(n + 1));
    i = p + vec2f(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2f(p.x / (sin(i.x + t) / 0.005), p.y / (cos(i.y + t) / 0.005)));
  }
  c = 1.17 - pow(c / 4.0, 1.4);
  return pow(abs(c), 8.0);
}
fn fog(c: vec3f, wp: vec3f) -> vec3f {
  let d = wp - s.eye.xyz;
  return mix(c, water(normalize(d)), 1.0 - exp(-length(d) * 0.0052));
}`;

const WGSL_SCENE = WGSL_COMMON + /* wgsl */ `
struct D { m: mat4x4f, n: mat4x4f, base: vec4f,
  emis: vec4f,   // emissive rgb, w = emissive from the base colour (screens, halo, wings)
  pbr: vec4f,    // x metal, y rough (fsAdd: falloff sharpness), z flags (1 base tex, 2 metal-rough tex, 4 face, 8 rainbow)
  x: vec4f };    // x sign of det(m), y centre of the face artwork's eye band (v), z blink 0..1, w fade near the camera
@group(1) @binding(0) var<uniform> d: D;
@group(1) @binding(1) var baseTex: texture_2d<f32>;
@group(1) @binding(2) var mrTex: texture_2d<f32>;
@group(2) @binding(0) var samp: sampler;
@group(2) @binding(1) var shadowMap: texture_depth_2d;
@group(2) @binding(2) var cmp: sampler_comparison;

struct V { @builtin(position) clip: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f };

fn out(w: vec4f, n: vec3f, uv: vec2f) -> V {
  var o: V;
  o.wp = w.xyz;
  o.n = (d.n * vec4f(n, 0.0)).xyz;
  o.uv = uv;
  o.clip = s.vp * w;
  return o;
}
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f) -> V {
  return out(d.m * vec4f(p, 1.0), n, uv);
}
// kelp: uv.y is the height along the strand, uv.x its own phase; the tip sways most
@vertex fn vsKelp(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f) -> V {
  var w = d.m * vec4f(p, 1.0);
  let t = s.eye.w * 0.8 + uv.x;
  let k = uv.y * uv.y * 7.0;
  w.x += (sin(t + uv.y * 2.5) + 0.4 * sin(t * 2.3 + 1.0)) * k;
  w.z += (cos(t * 0.8 + uv.y * 2.0) * 0.7) * k;
  return out(w, n, uv);
}
@vertex fn vsShadow(@location(0) p: vec3f) -> @builtin(position) vec4f {
  return s.lvp * d.m * vec4f(p, 1.0);
}

fn shadowAt(wp: vec3f, nl: f32) -> f32 {
  let l = s.lvp * vec4f(wp, 1.0);
  let uv = l.xy * vec2f(0.5, -0.5) + 0.5;
  let z = l.z - 0.002 - 0.003 * (1.0 - nl);
  var sum = 0.0;
  let r = 3.0 / f32(textureDimensions(shadowMap).x);
  let a0 = hash(wp.xz * 31.0) * 6.283;
  for (var i = 0; i < 8; i++) {
    let f = f32(i);
    let a = a0 + f * 2.39996;
    sum += textureSampleCompareLevel(shadowMap, cmp, uv + vec2f(cos(a), sin(a)) * sqrt((f + 0.5) / 8.0) * r, z);
  }
  let inside = all(uv > vec2f(0.0)) && all(uv < vec2f(1.0));
  return select(1.0, sum / 8.0, inside);
}
// light under water for reflections: the water itself, brighter towards the surface, sunlit sand below the horizon;
// r widens and dims it
fn env(dir: vec3f, r: f32) -> vec3f {
  let up = water(dir) * 2.2 + vec3f(0.5, 0.8, 0.8) * smoothstep(0.55 - r * 0.5, 0.95, dir.y) * (1.0 - 0.6 * r);
  return mix(up, vec3f(0.62, 0.52, 0.38) * 0.75, smoothstep(0.02 + r * 0.2, -0.12 - r * 0.2, dir.y));
}
fn envBRDF(f0: vec3f, r: f32, nv: f32) -> vec3f {
  let r4 = r * vec4f(-1.0, -0.0275, -0.572, 0.022) + vec4f(1.0, 0.0425, 1.04, -0.04);
  let a = min(r4.x * r4.x, exp2(-9.28 * nv)) * r4.x + r4.y;
  let ab = vec2f(-1.04, 1.04) * a + r4.zw;
  return f0 * ab.x + ab.y;
}
fn light(n: vec3f, v: vec3f, l: vec3f, col: vec3f, alb: vec3f, f0: vec3f, metal: f32, r: f32) -> vec3f {
  let nl = max(dot(n, l), 0.0);
  let h = normalize(l + v);
  let nh = max(dot(n, h), 0.0);
  let nv = max(dot(n, v), 1e-3);
  let a = r * r;
  let a2 = a * a;
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * dd * dd);
  let k = a * 0.5;
  let Vis = 0.25 / ((nv * (1.0 - k) + k) * (nl * (1.0 - k) + k));
  let F = f0 + (1.0 - f0) * pow(1.0 - max(dot(v, h), 0.0), 5.0);
  return ((1.0 - F) * (1.0 - metal) * alb / PI + D * Vis * F) * col * nl;
}
const SUN = vec3f(2.6, 2.75, 2.5);
@fragment fn fs(i: V, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  let flags = u32(d.pbr.z);
  var uv = i.uv;
  // scenery that fades out (dithered) when the camera comes close, so kelp never fills the view
  if (d.x.w > 0.0 && hash(i.clip.xy) > smoothstep(25.0, 60.0, length(i.wp - s.eye.xyz))) { discard; }
  // face blink: squash the artwork's eye band (v = centre ± 0.1) towards its centre line
  let ec = d.x.y;
  if ((flags & 4u) != 0u && d.x.z > 0.0 && abs(uv.y - ec) < 0.1) {
    let c = (uv.y - ec) / max(1.0 - d.x.z, 0.02) + ec;
    uv = select(vec2f(0.03), vec2f(uv.x, c), abs(c - ec) < 0.1);
  }
  var base = d.base;
  if ((flags & 1u) != 0u) { base *= textureSample(baseTex, samp, uv); }
  if ((flags & 8u) != 0u) {
    // the Rainbow stand-in: six bands across the ribbon, shaded like the original's six round tubes
    let k = u32(clamp(uv.y * 6.0, 0.0, 5.99));
    var R = array<vec3f, 6>(vec3f(0.9, 0.02, 0.02), vec3f(1.0, 0.25, 0.0), vec3f(1.0, 0.8, 0.0), vec3f(0.1, 0.65, 0.05), vec3f(0.02, 0.3, 1.0), vec3f(0.35, 0.03, 0.6));
    base = vec4f(R[k] * (0.55 + 0.45 * sin(PI * fract(uv.y * 6.0))), 1.0);
  }
  var metal = d.pbr.x;
  var r = d.pbr.y;
  if ((flags & 2u) != 0u) {
    let mr = textureSample(mrTex, samp, uv);
    r *= mr.g;
    metal *= mr.b;
  }
  r = clamp(r, 0.04, 1.0);
  var n = normalize(i.n);
  if (ff != (d.x.x > 0.0)) { n = -n; }
  let v = normalize(s.eye.xyz - i.wp);
  let nv = max(dot(n, v), 1e-3);
  let alb = base.rgb;
  let f0 = mix(vec3f(0.04), alb, metal);
  let key = normalize(KEY);
  let sh = shadowAt(i.wp, dot(n, key));
  let cau = 0.55 + 1.6 * caustic(i.wp.xz + i.wp.y * 0.35, s.eye.w);
  var c = light(n, v, key, SUN * sh * cau, alb, f0, metal, r);
  let rim = vec3f(0.25, 0.75, 0.8);
  c += light(n, v, normalize(vec3f(-0.6, 0.2, 0.75)), rim * 1.1, alb, f0, metal, r);
  c += light(n, v, normalize(vec3f(0.7, 0.1, -0.7)), rim * 0.7, alb, f0, metal, r);
  // ambient: sand bounce from below, water from above, darker close to the sand
  let ao = (0.65 + 0.35 * n.y) * mix(0.5, 1.0, smoothstep(0.0, 6.0, i.wp.y));
  let fe = envBRDF(f0, r, nv);
  c += (env(n, 1.0) * 0.5 * alb * (1.0 - metal) + env(reflect(-v, n), r) * fe * mix(0.6, 1.0, sh)) * ao;
  c += vec3f(0.35, 0.3, 0.2) * 0.18 * alb * max(-n.y, 0.0);
  c += pow(1.0 - nv, 4.0) * rim * 0.25 * ao;
  c += d.emis.rgb + base.rgb * d.emis.w;
  return vec4f(fog(c, i.wp), 1.0);
}

// lasers: additive, brightest where the surface faces the camera, fading along the beam (uv.y)
@fragment fn fsAdd(i: V) -> @location(0) vec4f {
  let v = normalize(s.eye.xyz - i.wp);
  let nv = abs(dot(normalize(i.n), v));
  let along = pow(1.0 - i.uv.y, 2.2) * (0.8 + 0.2 * sin(i.uv.y * 90.0 - s.eye.w * 18.0));
  let f = exp(-length(i.wp - s.eye.xyz) * 0.0052);
  return vec4f(d.emis.rgb * pow(nv, d.pbr.y) * along * f, 1.0);
}

// the sand: rippled, caustics, shadows, a ring of glowing anemone dots around the plaza
struct F { @builtin(position) clip: vec4f, @location(0) wp: vec3f };
@vertex fn vsFloor(@builtin(vertex_index) k: u32) -> F {
  var Q = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  let q = Q[k] * 1500.0 + s.eye.xz;
  var o: F;
  o.wp = vec3f(q.x, 0.0, q.y);
  o.clip = s.vp * vec4f(o.wp, 1.0);
  return o;
}
@fragment fn fsFloor(i: F) -> @location(0) vec4f {
  let p = i.wp.xz;
  let t = s.eye.w;
  let ph = dot(p, vec2f(0.31, 0.12)) + 2.2 * sin(p.y * 0.043 + p.x * 0.021) + sin(p.x * 0.11) * 0.6;
  let rk = 0.22 * cos(ph);
  let n = normalize(vec3f(-rk * 0.31, 1.0, -rk * 0.12));
  let grain = hash(floor(p * 3.0));
  let r = length(p);
  var alb = vec3f(0.6, 0.5, 0.36) * (0.86 + 0.14 * grain) * (0.92 + 0.08 * sin(ph));
  // the plaza: a smoother pale disc with a darker pebble band at its edge
  alb *= mix(1.08, 1.0, smoothstep(58.0, 64.0, r));
  alb *= 1.0 - 0.3 * smoothstep(2.5, 0.5, abs(r - 66.0)) * (0.6 + 0.4 * hash(floor(p * 1.3)));
  let key = normalize(KEY);
  let sh = shadowAt(i.wp, dot(n, key));
  let cau = 0.5 + 1.8 * caustic(p, t);
  var c = alb * (SUN * max(dot(n, key), 0.0) * sh * cau / PI + water(vec3f(0.0, 1.0, 0.0)) * 1.4);
  // anemone lights: 48 around the plaza edge, slowly pulsing
  let seg = round(atan2(p.y, p.x) / (2.0 * PI / 48.0));
  let a = seg * 2.0 * PI / 48.0;
  let dd = length(p - vec2f(cos(a), sin(a)) * 70.0);
  c += vec3f(0.2, 1.4, 1.5) * smoothstep(1.3, 0.3, dd) * (0.55 + 0.45 * sin(t * 1.7 + seg * 1.3));
  return vec4f(fog(c, i.wp), 1.0);
}

struct B { @builtin(position) clip: vec4f, @location(0) ndc: vec2f };
@vertex fn vsBack(@builtin(vertex_index) k: u32) -> B {
  let p = vec2f(f32(k & 1u) * 4.0 - 1.0, f32(k >> 1u) * 4.0 - 1.0);
  return B(vec4f(p, 1.0, 1.0), p);
}
@fragment fn fsBack(i: B) -> @location(0) vec4f {
  let a = s.ivp * vec4f(i.ndc, 1.0, 1.0);
  let b = s.ivp * vec4f(i.ndc, 0.0, 1.0);
  return vec4f(water(normalize(a.xyz / a.w - b.xyz / b.w)), 1.0);
}`;

const WGSL_POST = WGSL_COMMON + /* wgsl */ `
@group(1) @binding(0) var samp: sampler;
@group(1) @binding(1) var A: texture_2d<f32>;
@group(1) @binding(2) var Bl: texture_2d<f32>;
struct P { @builtin(position) clip: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) k: u32) -> P {
  let p = vec2f(f32(k & 1u) * 4.0 - 1.0, f32(k >> 1u) * 4.0 - 1.0);
  return P(vec4f(p, 0.0, 1.0), p * vec2f(0.5, -0.5) + 0.5);
}
fn a(uv: vec2f) -> vec3f { return textureSampleLevel(A, samp, uv, 0.0).rgb; }
// 4 bilinear taps = a 4×4 box: the bloom chain's downsample; the first one also keeps only what is over threshold
fn box(uv: vec2f) -> vec3f {
  let t = 1.0 / vec2f(textureDimensions(A));
  return (a(uv - t) + a(uv + t) + a(uv + vec2f(t.x, -t.y)) + a(uv - vec2f(t.x, -t.y))) * 0.25;
}
@fragment fn fsPre(i: P) -> @location(0) vec4f {
  let c = min(box(i.uv), vec3f(40.0));
  let br = max(c.r, max(c.g, c.b));
  let k = clamp(br - 1.0, 0.0, 0.8);
  let w = max(k * k / 3.2, br - 1.8) / max(br, 1e-4);
  return vec4f(c * max(w, 0.0), 1.0);
}
@fragment fn fsDown(i: P) -> @location(0) vec4f { return vec4f(box(i.uv), 1.0); }
// 3×3 tent upsample, added onto the next larger level
@fragment fn fsUp(i: P) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(A));
  let x = vec2f(t.x, 0.0);
  let y = vec2f(0.0, t.y);
  let c = a(i.uv) * 4.0 + (a(i.uv + x) + a(i.uv - x) + a(i.uv + y) + a(i.uv - y)) * 2.0 +
    a(i.uv + t) + a(i.uv - t) + a(i.uv + x - y) + a(i.uv - x + y);
  return vec4f(c / 16.0, 1.0);
}
fn aces(x: vec3f) -> vec3f { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0)); }
@fragment fn fsComp(i: P) -> @location(0) vec4f {
  var c = aces((a(i.uv) + textureSampleLevel(Bl, samp, i.uv, 0.0).rgb * s.misc.z) * s.misc.w);
  let q = i.uv - 0.5;
  c *= 1.0 - 0.6 * dot(q, q);
  c = pow(c, vec3f(1.0 / 2.2)) + (hash(i.clip.xy + fract(s.eye.w)) - 0.5) / 255.0;
  return vec4f(c, 1.0);
}`;
