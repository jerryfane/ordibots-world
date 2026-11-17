// Ordibots World login proofs, checked in every player's browser against the ord server that serves the world
// (no external API, no index of ours). A proof { bot, addr, sig, iat, exp } says: the holder of Ordibot `bot`,
// at `addr`, lets the Entmoot member key `member` enter group `group` from iat to exp (unix seconds). It holds when
//   1. sig is a BIP-322 "simple" signature by addr over statement(...) (P2TR key path = BIP-340 Schnorr, or P2WPKH
//      = ECDSA), verified here: bech32/bech32m, BIP-322 to_spend/to_sign, BIP-341/BIP-143 sighash, secp256k1 in
//      BigInt (verify only, public data only: no secret ever passes through this file);
//   2. GET /r/inscription/<bot> says addr holds the bot now;
//   3. GET /r/parents/<bot> lists the Ordibots parent (every real bot, v1 cursed and v2 blessed, is its child).
// The bot's number and traits come from its own inscription: /content/<bot> is `<script t="…" id="N" …>`.
export const PARENT = '49a08d8f22cfb2816b7e3a2cf25d93ea98b0a4dbb5c12e7b0599de958d78e1b4i0';
export const DOMAIN = 'ordibots-world';
const TTL = 600000; // a check is reused for 10 min; after that the next hello checks again
const RETRY = 30000; // the ord server failed (not the proof): check again after 30 s
const SKEW = 300; // s: issued-at may lie this far in the future (clock drift)
const LIFE = 30 * 86400; // s: the longest proof lifetime accepted

const enc = (s) => new TextEncoder().encode(s);
const cat = (...a) => {
  const o = new Uint8Array(a.reduce((n, b) => n + b.length, 0));
  let i = 0;
  for (const b of a) o.set(b, i), (i += b.length);
  return o;
};
const big = (b) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
const fail = (why) => {
  throw Object.assign(Error(why), { proof: 1 });
};
const iso = (s) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
const okId = (s) => typeof s == 'string' && /^[0-9a-f]{64}i\d{1,9}$/.test(s);

/** the exact text the wallet signs (iat/exp: unix seconds) */
export const statement = ({ group, member, bot, addr, iat, exp }) =>
  [`${DOMAIN}: enter as the holder of this Ordibot`, 'Domain: ' + DOMAIN, 'Group: ' + group, 'Member: ' + member, 'Bot: ' + bot, 'Address: ' + addr, 'Issued At: ' + iso(iat), 'Expires At: ' + iso(exp)].join('\n');

// ── hashes: SHA-256 from WebCrypto (entmoot-lite needs it as well), RIPEMD-160 here
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));
const dsha = async (b) => sha256(await sha256(b));
const tagged = async (tag, ...b) => {
  const t = await sha256(enc(tag));
  return sha256(cat(t, t, ...b));
};
const RL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13];
const RR = [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11];
const SL = [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6];
const SR = [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11];
const KL = [0, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e], KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0];
const rf = (j, x, y, z) => (j < 16 ? x ^ y ^ z : j < 32 ? (x & y) | (~x & z) : j < 48 ? (x | ~y) ^ z : j < 64 ? (x & z) | (y & ~z) : x ^ (y | ~z));
const rotl = (x, n) => (x << n) | (x >>> (32 - n));
export function ripemd160(m) {
  const n = (((m.length + 8) >> 6) + 1) << 6, b = new Uint8Array(n), v = new DataView(b.buffer);
  b.set(m), (b[m.length] = 0x80), v.setUint32(n - 8, m.length * 8, true), v.setUint32(n - 4, Math.floor(m.length / 0x20000000), true);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  for (let o = 0; o < n; o += 64) {
    const X = Array.from({ length: 16 }, (_, i) => v.getUint32(o + i * 4, true));
    let [al, bl, cl, dl, el] = h, [ar, br, cr, dr, er] = h, t;
    for (let j = 0; j < 80; j++) {
      t = (rotl((al + rf(j, bl, cl, dl) + X[RL[j]] + KL[j >> 4]) | 0, SL[j]) + el) | 0;
      (al = el), (el = dl), (dl = rotl(cl, 10)), (cl = bl), (bl = t);
      t = (rotl((ar + rf(79 - j, br, cr, dr) + X[RR[j]] + KR[j >> 4]) | 0, SR[j]) + er) | 0;
      (ar = er), (er = dr), (dr = rotl(cr, 10)), (cr = br), (br = t);
    }
    t = (h[1] + cl + dr) | 0;
    (h[1] = (h[2] + dl + er) | 0), (h[2] = (h[3] + el + ar) | 0), (h[3] = (h[4] + al + br) | 0), (h[4] = (h[0] + bl + cr) | 0), (h[0] = t);
  }
  const out = new Uint8Array(20), w = new DataView(out.buffer);
  h.forEach((x, i) => w.setUint32(i * 4, x, true));
  return out;
}

// ── secp256k1, verify only (public inputs: variable time is fine). Points are Jacobian [X, Y, Z]; Z = 0 is infinity.
const P = 2n ** 256n - 0x1000003d1n, N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n, 1n];
const md = (a, m = P) => ((a % m) + m) % m;
const pw = (b, e, m = P) => {
  let r = 1n;
  for (b = md(b, m); e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m;
  return r;
};
const inv = (a, m = P) => pw(a, m - 2n, m);
const INF = [0n, 1n, 0n];
const dbl = ([X, Y, Z]) => {
  if (!Z || !Y) return INF;
  const A = (X * X) % P, B = (Y * Y) % P, C = (B * B) % P, D = md(2n * ((X + B) ** 2n - A - C)), E = 3n * A, X3 = md(E * E - 2n * D);
  return [X3, md(E * (D - X3) - 8n * C), md(2n * Y * Z)];
};
const add = (p, q) => {
  if (!p[2]) return q;
  if (!q[2]) return p;
  const [X1, Y1, Z1] = p, [X2, Y2, Z2] = q, Z11 = (Z1 * Z1) % P, Z22 = (Z2 * Z2) % P;
  const U1 = (X1 * Z22) % P, U2 = (X2 * Z11) % P, S1 = (((Y1 * Z2) % P) * Z22) % P, S2 = (((Y2 * Z1) % P) * Z11) % P;
  if (U1 == U2) return S1 == S2 ? dbl(p) : INF;
  const H = md(U2 - U1), I = (4n * H * H) % P, J = (H * I) % P, r = md(2n * (S2 - S1)), V = (U1 * I) % P, X3 = md(r * r - J - 2n * V);
  return [X3, md(r * (V - X3) - 2n * S1 * J), md(((Z1 + Z2) ** 2n - Z11 - Z22) * H)];
};
/** a·G + b·Q (Shamir's trick), affine [x, y] or null at infinity */
const mul2 = (a, b, Q) => {
  const GQ = add(G, Q);
  let R = INF;
  for (let i = 255n; i >= 0n; i--) {
    R = dbl(R);
    const x = (a >> i) & 1n, y = (b >> i) & 1n;
    if (x || y) R = add(R, x && y ? GQ : x ? G : Q);
  }
  if (!R[2]) return null;
  const zi = inv(R[2]), z2 = (zi * zi) % P;
  return [(R[0] * z2) % P, (((R[1] * z2) % P) * zi) % P];
};
const lift = (x, odd = 0) => {
  if (x >= P) return null;
  const c = md(x ** 3n + 7n), y = pw(c, (P + 1n) / 4n);
  if ((y * y) % P != c) return null;
  return [x, (y & 1n) == BigInt(odd) ? y : P - y, 1n];
};
/** BIP-340 */
export async function schnorrVerify(pub, msg, sig) {
  const Q = pub.length == 32 && lift(big(pub)), r = big(sig.slice(0, 32)), s = big(sig.slice(32));
  if (!Q || sig.length != 64 || r >= P || s >= N) return false;
  const e = big(await tagged('BIP0340/challenge', sig.slice(0, 32), pub, msg)) % N;
  const R = mul2(s, md(-e, N), Q);
  return !!R && !(R[1] & 1n) && R[0] == r;
}
/** ECDSA over a 32-byte digest; pub compressed (33 B); r, s as BigInt; low S required */
function ecdsaVerify(pub, z, r, s) {
  const Q = pub.length == 33 && (pub[0] == 2 || pub[0] == 3) && lift(big(pub.slice(1)), pub[0] - 2);
  if (!Q || r < 1n || r >= N || s < 1n || s > N >> 1n) return false;
  const w = inv(s, N), R = mul2(md(big(z) * w, N), md(r * w, N), Q);
  return !!R && R[0] % N == r;
}
/** strict DER (BIP-66) with the sighash byte at the end → [r, s] or null */
function der(b) {
  const L = b.length, lr = b[3], ls = b[5 + lr];
  if (L < 9 || L > 73 || b[0] != 0x30 || b[1] != L - 3 || b[2] != 2 || 5 + lr >= L || lr + ls + 7 != L) return null;
  if (!lr || b[4] & 0x80 || (lr > 1 && !b[4] && !(b[5] & 0x80))) return null;
  if (b[lr + 4] != 2 || !ls || b[lr + 6] & 0x80 || (ls > 1 && !b[lr + 6] && !(b[lr + 7] & 0x80))) return null;
  return [big(b.slice(4, 4 + lr)), big(b.slice(6 + lr, 6 + lr + ls))];
}

// ── addresses: bech32 (BIP-173) / bech32m (BIP-350), mainnet segwit v0 key hash (bc1q…) and v1 taproot (bc1p…)
const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const polymod = (v) => {
  let c = 1;
  for (const x of v) {
    const b = c >>> 25;
    c = ((c & 0x1ffffff) << 5) ^ x;
    [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3].forEach((g, i) => (b >> i) & 1 && (c ^= g));
  }
  return c;
};
/** address → { v, prog, spk } (spk = scriptPubKey); throws on anything but bc1q (20 B) and bc1p (32 B) */
export function decodeAddress(a) {
  if (typeof a != 'string' || a.length > 90 || (a != a.toLowerCase() && a != a.toUpperCase())) fail('bad address');
  a = a.toLowerCase();
  const k = a.lastIndexOf('1'), d = [...a.slice(k + 1)].map((c) => CS.indexOf(c));
  if (a.slice(0, k) != 'bc' || d.length < 7 || d.includes(-1)) fail('bad address');
  const c = polymod([3, 3, 0, 2, 3, ...d]), v = d[0];
  if (c != (v ? 0x2bc830a3 : 1)) fail('bad address checksum');
  let acc = 0, bits = 0;
  const prog = [];
  for (const x of d.slice(1, -6)) {
    (acc = (acc << 5) | x), (bits += 5);
    if (bits >= 8) prog.push((acc >> (bits -= 8)) & 255);
  }
  if (bits >= 5 || acc & ((1 << bits) - 1)) fail('bad address padding');
  if (!((v == 0 && prog.length == 20) || (v == 1 && prog.length == 32))) fail('unsupported address type (only bc1q key hash and bc1p taproot)');
  return { v, prog: Uint8Array.from(prog), spk: Uint8Array.from([v ? 0x50 + v : 0, prog.length, ...prog]) };
}

// ── BIP-322 simple
const u32 = (n) => Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24);
const Z4 = u32(0), Z8 = new Uint8Array(8), VAR = (n) => Uint8Array.of(n); // every length here is < 0xfd
const OUT = cat(Z8, VAR(1), Uint8Array.of(0x6a)); // to_sign's single output: 0 sat, OP_RETURN
export const messageHash = (m) => tagged('BIP0322-signed-message', typeof m == 'string' ? enc(m) : m);
/** to_spend's txid (internal byte order) */
export async function toSpendId(spk, message) {
  const tx = cat(Z4, VAR(1), new Uint8Array(32), u32(0xffffffff), VAR(34), Uint8Array.of(0, 32), await messageHash(message), Z4, VAR(1), Z8, VAR(spk.length), spk, Z4);
  return dsha(tx);
}
/** a consensus-encoded witness stack → array of items (all bytes consumed) */
function witness(b) {
  let i = 0;
  const n = () => {
    const x = b[i++];
    if (x < 0xfd) return x;
    if (x != 0xfd || i + 2 > b.length) fail('bad witness');
    return (i += 2), b[i - 2] | (b[i - 1] << 8);
  };
  const items = [];
  for (let k = n(); k-- > 0; ) {
    const l = n();
    if (i + l > b.length) fail('bad witness');
    items.push(b.slice(i, (i += l)));
  }
  if (i != b.length || !items.length) fail('bad witness');
  return items;
}
const unb64 = (s) => {
  if (!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s) || !s) fail('signature is not base64');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
/**
 * BIP-322 simple signature check (with or without the "smp" prefix; wallets such as Xverse send none).
 * Resolves true, or throws an Error with .proof set and the reason.
 */
export async function verifyMessage(addr, message, sig) {
  const { v, prog, spk } = decodeAddress(addr);
  if (typeof sig != 'string' || sig.length > 400) fail('bad signature');
  if (/^(ful|pof)/.test(sig)) fail('only BIP-322 simple signatures are accepted');
  const w = witness(unb64(sig.replace(/^smp/, '')));
  const id = await toSpendId(spk, message), prevouts = cat(id, Z4);
  if (v == 1) {
    // P2TR key path: one item, a 64-byte signature (SIGHASH_DEFAULT) or 65 with SIGHASH_ALL
    const [s] = w;
    if (w.length != 1 || !(s.length == 64 || (s.length == 65 && s[64] == 1))) fail('invalid signature');
    const m = cat(Uint8Array.of(0, s.length == 65 ? 1 : 0), Z4, Z4, await sha256(prevouts), await sha256(Z8), await sha256(cat(VAR(spk.length), spk)), await sha256(Z4), await sha256(OUT), Uint8Array.of(0), Z4);
    if (!(await schnorrVerify(prog, await tagged('TapSighash', m), s.slice(0, 64)))) fail('invalid signature');
    return true;
  }
  // P2WPKH: [DER signature + SIGHASH_ALL, 33-byte compressed key]; BIP-143 sighash
  const [s, pub] = w, rs = w.length == 2 && s[s.length - 1] == 1 && der(s);
  if (!rs || pub.length != 33) fail('invalid signature');
  if (ripemd160(await sha256(pub)).some((x, i) => x != prog[i])) fail('invalid signature');
  const code = cat(Uint8Array.of(0x19, 0x76, 0xa9, 0x14), prog, Uint8Array.of(0x88, 0xac));
  const z = await dsha(cat(Z4, await dsha(prevouts), await dsha(Z4), prevouts, code, Z8, Z4, await dsha(OUT), Z4, u32(1)));
  if (!ecdsaVerify(pub, z, ...rs)) fail('invalid signature');
  return true;
}

// ── the proof
/** shape and time checks (no network): the statement, or throws */
export function checkProof(group, member, p, now = Date.now()) {
  if (!p || typeof p != 'object' || !okId(p.bot) || typeof p.addr != 'string' || typeof p.sig != 'string') fail('malformed proof');
  if (typeof member != 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(member)) fail('bad member key');
  const { iat, exp } = p, t = now / 1000;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat || exp - iat > LIFE) fail('bad proof times');
  if (iat > t + SKEW) fail('proof issued in the future');
  if (exp <= t) fail('proof expired');
  return statement({ group, member, bot: p.bot, addr: p.addr, iat, exp });
}

/**
 * The checker a world uses: verify(member, proof) → { ok: true, id, n, t, addr, exp } | { ok: false, why, retry? }
 * (n = bot number, t = trait index string, both from /content/<id>). Results are cached for 10 min (30 s when the
 * ord server failed); bot(id) → { id, n, t } reads a bot's own inscription (cached for good: content never changes).
 * @param {object} o
 * @param {string} o.group  Entmoot group id (base64)
 * @param {string} [o.base]  ord server origin; default '' = the one serving this page (recursive endpoints)
 * @param {typeof fetch} [o.fetch]
 * @param {() => number} [o.now]  ms clock (tests)
 */
export function makeVerifier({ group, base = '', fetch = (...a) => globalThis.fetch(...a), now = Date.now }) {
  const get = async (path, json = true) => {
    const r = await fetch(base + path);
    if (!r.ok) throw Object.assign(Error(`${path.split('/').slice(0, 3).join('/')}: HTTP ${r.status}`), { status: r.status });
    return json ? r.json() : r.text();
  };
  const forever = new Map(); // content and parents: they never change
  const once = (k, f) => {
    let p = forever.get(k);
    if (!p) forever.set(k, (p = f())), p.catch(() => forever.delete(k));
    return p;
  };
  const bot = (id) =>
    once('c' + id, async () => {
      if (!okId(id)) fail('bad inscription id');
      const s = (await get('/content/' + id, false)).slice(0, 4096), t = s.match(/\bt="(\d{1,3}(?:,\d{1,3}){0,15})"/)?.[1], n = s.match(/\bid="(\d{1,5})"/)?.[1];
      if (!t) fail('not an Ordibot (no t= attribute)');
      return { id, n: n == null ? null : +n, t };
    });
  const child = (id) =>
    once('p' + id, async () => {
      for (let page = 0; page < 10; page++) {
        const r = await get(`/r/parents/${id}` + (page ? '/' + page : ''));
        if (r?.ids?.includes(PARENT)) return true;
        if (!r?.more) return false;
      }
      return false;
    });
  const cache = new Map();
  const check = async (member, p) => {
    let st;
    try {
      st = checkProof(group, member, p, now());
      await verifyMessage(p.addr, st, p.sig);
    } catch (e) {
      return { ok: false, why: e.proof ? e.message : 'proof check failed: ' + e.message };
    }
    try {
      const [rec, isChild, info] = await Promise.all([get('/r/inscription/' + p.bot), child(p.bot), bot(p.bot)]);
      if (rec?.address !== p.addr) return { ok: false, why: 'the bot is held by another address now' };
      if (!isChild) return { ok: false, why: 'not an Ordibot (no Ordibots parent)' };
      return { ok: true, ...info, addr: p.addr, exp: p.exp };
    } catch (e) {
      return e.proof || e.status == 404 ? { ok: false, why: e.message } : { ok: false, why: 'ord server: ' + e.message, retry: true };
    }
  };
  return {
    bot,
    /** whether the inscription is a child of the Ordibots parent (cached for good) */
    child,
    async verify(member, p) {
      const k = member + ' ' + JSON.stringify([p?.bot, p?.addr, p?.sig, p?.iat, p?.exp]), t = now(), c = cache.get(k);
      if (c && t < c.until) {
        const r = await c.p;
        return r.ok && r.exp * 1000 <= now() ? { ok: false, why: 'proof expired' } : r;
      }
      const e = { until: t + TTL, p: check(member, p) };
      cache.set(k, e);
      if (cache.size > 512) cache.delete(cache.keys().next().value);
      const r = await e.p;
      if (r.retry) e.until = t + RETRY;
      return r;
    },
  };
}

/**
 * The newest usable bearer invite among candidates (objects or JSON strings: the one the engine embeds, a newer one
 * passed in, later the newest inscription on the config sat): same group, no target identity, not expired.
 */
export function pickInvite(candidates, group, now = Date.now()) {
  let best;
  for (let c of candidates) {
    try {
      if (typeof c == 'string') c = JSON.parse(c);
    } catch {
      continue;
    }
    if (c?.group_id !== group || c.target_public_key?.length || !(c.expires_at_ms > now)) continue;
    if (!best || c.issued_at_ms > best.issued_at_ms) best = c;
  }
  return best;
}
