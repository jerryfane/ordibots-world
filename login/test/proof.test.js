// proof.js: BIP-322 official vectors, BIP-340 vectors, locally signed proofs (throwaway keys; bip322-js and noble are
// test-only dependencies, never in the shipped bundle), tamper cases and the /r/ checks against a fake ord server.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { Signer } from 'bip322-js'
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js'
import { bech32, bech32m } from '@scure/base'
import { statement, verifyMessage, decodeAddress, ripemd160, schnorrVerify, checkProof, makeVerifier, pickInvite, messageHash, toSpendId, PARENT } from '../proof.js'

const V = (f) => JSON.parse(readFileSync(new URL('vectors/' + f, import.meta.url)))
const basic = V('bip322-basic-test-vectors.json')
const gen = V('bip322-generated-test-vectors.json')
const hex = (b) => Buffer.from(b).toString('hex')
const rejects = async (p, re) => assert.rejects(p, (e) => (re ? re.test(e.message) : true) && e.proof === 1)

// ── throwaway keys (fresh every run) and their addresses
const wif = (k) => {
  const b = Buffer.concat([Buffer.from([0x80]), k, Buffer.from([1])])
  const c = createHash('sha256').update(createHash('sha256').update(b).digest()).digest().subarray(0, 4)
  return b58(Buffer.concat([b, c]))
}
const b58 = (b) => {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let n = BigInt('0x' + (hex(b) || '0')); let s = ''
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n }
  for (const x of b) { if (x) break; s = '1' + s }
  return s
}
const h160 = (b) => createHash('ripemd160').update(createHash('sha256').update(b).digest()).digest()
const taproot = (k) => {
  // BIP-86 output key: P + H_TapTweak(P)·G
  const P = schnorr.getPublicKey(k)
  const t = createHash('sha256').update('TapTweak').digest()
  const tw = BigInt('0x' + createHash('sha256').update(Buffer.concat([t, t, P])).digest('hex'))
  const Q = secp256k1.Point.fromHex('02' + hex(P)).add(secp256k1.Point.BASE.multiply(tw))
  return bech32m.encode('bc', [1, ...bech32m.toWords(Q.toBytes(true).subarray(1))])
}
const wpkh = (k) => bech32.encode('bc', [0, ...bech32.toWords(h160(secp256k1.getPublicKey(k, true)))])
const tr = randomBytes(32); const TR = taproot(tr)
const wk = randomBytes(32); const WK = wpkh(wk)
const sign = (k, addr, msg) => Signer.sign(wif(k), addr, msg)

test('RIPEMD-160 and the BIP-322 message hash match their references', async () => {
  for (const s of ['', 'abc', 'message digest', 'a'.repeat(1000), randomBytes(119).toString('latin1')]) {
    const b = Buffer.from(s, 'latin1')
    assert.equal(hex(ripemd160(b)), createHash('ripemd160').update(b).digest('hex'))
  }
  for (const v of basic.tx_hashes) assert.equal(hex(await messageHash(v.message)), v.message_hash)
})

test('BIP-340 official vectors (verify rows)', async () => {
  const rows = readFileSync(new URL('vectors/bip340-test-vectors.csv', import.meta.url), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','))
  let n = 0
  for (const [i, , pub, , msg, sig, result] of rows) {
    const ok = await schnorrVerify(Buffer.from(pub, 'hex'), Buffer.from(msg, 'hex'), Buffer.from(sig, 'hex'))
    // vectors 0-3 sign 32-byte messages; 15-18 use other lengths, which BIP-340 allows: all must agree
    assert.equal(ok, result === 'TRUE', 'vector ' + i)
    n++
  }
  assert.ok(n >= 15)
})

test('BIP-322 official vectors: every simple P2WPKH/P2TR signature verifies', async () => {
  let n = 0
  for (const v of [...basic.simple, ...gen.simple]) {
    if (!/^(p2wpkh|p2tr)$/.test(v.type)) continue
    for (const s of v.bip322_signatures) { assert.equal(await verifyMessage(v.address, v.message, s), true, v.type + ' ' + v.message); n++ }
  }
  assert.ok(n >= 6, n + ' signatures')
})

test('BIP-322 official error vectors are all rejected', async () => {
  let n = 0
  for (const v of [...basic.error, ...gen.error]) { await rejects(verifyMessage(v.address, v.message, v.signature)); n++ }
  assert.equal(n, basic.error.length + gen.error.length)
})

test('BIP-322 vectors this verifier does not support are refused, not accepted (P2WSH, full, P2PKH)', async () => {
  for (const v of [...basic.simple, ...gen.simple, ...gen.full]) {
    if (/^(p2wpkh|p2tr)$/.test(v.type)) continue
    for (const s of v.bip322_signatures) await rejects(verifyMessage(v.address, v.message, s))
  }
})

test('addresses: bech32 / bech32m, checksum, case, network and type', () => {
  assert.equal(decodeAddress(TR).v, 1); assert.equal(decodeAddress(WK).v, 0)
  assert.equal(decodeAddress(TR.toUpperCase()).prog.length, 32)
  const flip = (a) => a.slice(0, -1) + (a.at(-1) === 'q' ? 'p' : 'q')
  const up = (a) => a.replace(/[a-z](?=[^a-z]*$)/, (c) => c.toUpperCase()) // mixed case
  for (const bad of [flip(TR), flip(WK), up(TR), 'tb1' + TR.slice(3),
    bech32.encode('bc', [1, ...bech32.toWords(randomBytes(32))]), // v1 with bech32 (not m)
    bech32m.encode('bc', [0, ...bech32m.toWords(randomBytes(20))]), // v0 with bech32m
    bech32.encode('bc', [0, ...bech32.toWords(randomBytes(32))]), // P2WSH
    '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', '', 'bc1', null]) assert.throws(() => decodeAddress(bad), (e) => e.proof === 1, String(bad))
})

const GROUP = Buffer.alloc(32, 9).toString('base64') // any group id: the statement only binds it
const MEMBER = randomBytes(32).toString('base64')
const BOT = '26b0d110a22b5ec1f7543288648a278be0f953767180249481ab2377957cce6fi726'
const NOW = Date.UTC(2026, 10, 17, 15)
const iat = NOW / 1000 - 60; const exp = iat + 86400
const proofFor = (k, addr, o = {}) => {
  const p = { bot: BOT, addr, iat, exp, ...o }
  return { ...p, sig: sign(k, addr, statement({ group: GROUP, member: o.member || MEMBER, ...p })) }
}

test('locally signed proofs verify: taproot (Schnorr) and P2WPKH (ECDSA), from a throwaway key', async () => {
  for (const [k, a] of [[tr, TR], [wk, WK]]) {
    const p = proofFor(k, a)
    assert.equal(await verifyMessage(a, checkProof(GROUP, MEMBER, p, NOW), p.sig), true)
    assert.equal(await verifyMessage(a, checkProof(GROUP, MEMBER, p, NOW), 'smp' + p.sig), true, 'with the smp prefix too')
  }
  const st = statement({ group: GROUP, member: MEMBER, bot: BOT, addr: TR, iat, exp })
  assert.match(st, /^ordibots-world: enter as the holder of this Ordibot\nDomain: ordibots-world\nGroup: \S+\nMember: \S+\nBot: [0-9a-f]{64}i726\nAddress: bc1p\w+\nIssued At: 2026-11-17T14:59:00Z\nExpires At: 2026-11-18T14:59:00Z$/)
})

test('tampered: statement fields, signature bytes, address, expiry', async () => {
  const p = proofFor(tr, TR)
  const st = (q, m = MEMBER, g = GROUP) => checkProof(g, m, q, NOW)
  // the statement is rebuilt from the proof + the hello's author: any field changed breaks the signature
  await rejects(verifyMessage(TR, st(p, randomBytes(32).toString('base64')), p.sig), /invalid signature/) // other member key
  await rejects(verifyMessage(TR, st(p, MEMBER, 'AAAA' + GROUP.slice(4)), p.sig), /invalid signature/) // other group
  await rejects(verifyMessage(TR, st({ ...p, bot: BOT.replace(/i726$/, 'i725') }), p.sig), /invalid signature/) // other bot
  await rejects(verifyMessage(TR, st({ ...p, exp: p.exp + 3600 }), p.sig), /invalid signature/) // stretched expiry
  await rejects(verifyMessage(TR, st({ ...p, iat: p.iat + 1 }), p.sig), /invalid signature/)
  // signature bytes: every byte flipped in turn (taproot: 64 signature bytes behind 2 bytes of stack framing)
  const raw = Buffer.from(p.sig, 'base64')
  for (let i = 0; i < raw.length; i++) {
    const b = Buffer.from(raw); b[i] ^= 1 << (i % 8)
    await rejects(verifyMessage(TR, st(p), b.toString('base64')))
  }
  // P2WPKH: flipped DER byte, swapped public key, high-S
  const q = proofFor(wk, WK); const w = Buffer.from(q.sig, 'base64')
  for (const i of [5, 20, w.length - 40, w.length - 1]) { const b = Buffer.from(w); b[i] ^= 4; await rejects(verifyMessage(WK, st(q), b.toString('base64'))) }
  const other = secp256k1.getPublicKey(randomBytes(32), true); const b2 = Buffer.from(w); b2.set(other, w.length - 33)
  await rejects(verifyMessage(WK, st(q), b2.toString('base64')), /invalid signature/)
  // address: a valid signature presented for another address (same type, other key; other type)
  await rejects(verifyMessage(taproot(randomBytes(32)), st(p), p.sig), /invalid signature/)
  await rejects(verifyMessage(WK, st(p), p.sig), /invalid signature/)
  await rejects(verifyMessage(TR, st(q), q.sig), /invalid signature/)
  // expiry and times (no signature check needed to refuse)
  assert.throws(() => checkProof(GROUP, MEMBER, p, exp * 1000 + 1), /expired/)
  assert.throws(() => checkProof(GROUP, MEMBER, { ...p, iat: NOW / 1000 + 3600, exp: NOW / 1000 + 7200 }, NOW), /future/)
  assert.throws(() => checkProof(GROUP, MEMBER, { ...p, exp: iat + 31 * 86400 }, NOW), /times/)
  assert.throws(() => checkProof(GROUP, MEMBER, { ...p, exp: iat }, NOW), /times/)
  assert.throws(() => checkProof(GROUP, MEMBER, { ...p, bot: 1571 }, NOW), /malformed/)
  assert.throws(() => checkProof(GROUP, 'nope', p, NOW), /member/)
})

test('high-S ECDSA is refused (BIP-322 LOW_S), even though it is the same signature', async () => {
  const q = proofFor(wk, WK); const w = Buffer.from(q.sig, 'base64')
  // parse [count][len][DER+hashtype][33][pub]; rebuild DER with s' = n - s
  const N = secp256k1.Point.CURVE().n
  const derLen = w[1]; const d = w.subarray(2, 2 + derLen - 1)
  const rl = d[3]; const r = d.subarray(4, 4 + rl); const s = BigInt('0x' + hex(d.subarray(6 + rl)))
  const hs = N - s; let sh = Buffer.from(hs.toString(16).padStart(64, '0'), 'hex'); if (sh[0] & 0x80) sh = Buffer.concat([Buffer.from([0]), sh])
  const der = Buffer.concat([Buffer.from([0x30, 4 + r.length + sh.length, 2, r.length]), r, Buffer.from([2, sh.length]), sh, Buffer.from([1])])
  const pub = w.subarray(w.length - 33)
  const sig = Buffer.concat([Buffer.from([2, der.length]), der, Buffer.from([33]), pub]).toString('base64')
  await rejects(verifyMessage(WK, checkProof(GROUP, MEMBER, q, NOW), sig), /invalid signature/)
})

test('P2WPKH: a correct signature over the right sighash by a key that does not hash to the address is refused', async () => {
  // the attacker signs the exact BIP-143 sighash of WK's to_sign with their own key and ships their own pubkey
  const k2 = randomBytes(32); const pub2 = secp256k1.getPublicKey(k2, true)
  const st = checkProof(GROUP, MEMBER, proofFor(wk, WK), NOW)
  const { prog, spk } = decodeAddress(WK)
  const d = (b) => createHash('sha256').update(createHash('sha256').update(b).digest()).digest()
  const Z4 = Buffer.alloc(4); const Z8 = Buffer.alloc(8)
  const prevouts = Buffer.concat([await toSpendId(spk, st), Z4])
  const code = Buffer.concat([Buffer.from('1976a914', 'hex'), prog, Buffer.from('88ac', 'hex')])
  const z = d(Buffer.concat([Z4, d(prevouts), d(Z4), prevouts, code, Z8, Z4, d(Buffer.from('0000000000000000016a', 'hex')), Z4, Buffer.from('01000000', 'hex')]))
  const der = secp256k1.sign(z, k2, { prehash: false, format: 'der' })
  const sig = Buffer.concat([Buffer.from([2, der.length + 1]), der, Buffer.from([1, 33]), pub2]).toString('base64')
  await rejects(verifyMessage(WK, st, sig), /invalid signature/)
})

// ── the full check against a fake ord server
const BODY = `<script t="3,12,14,16,42,24,25,37" id="1571" src="/content/bc0a1f356ac7a0215a85ce4a393c7e1a3aac2adcd4417b6376553523570ba771i0" m='{"p":"brc69" "s":"ordibots-3d"}'></script>`
const COPY = BOT.replace(/^26/, 'ff')
const ord = ({ holder = TR, parents = [PARENT], down = false } = {}) => {
  const calls = []
  const f = async (url) => {
    calls.push(url)
    const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) })
    if (down) return { ok: false, status: 502, json: async () => ({}), text: async () => '' }
    let m
    if ((m = url.match(/^\/content\/(\w+)$/))) return { ok: true, status: 200, text: async () => BODY }
    if ((m = url.match(/^\/r\/inscription\/(\w+)$/))) return json({ id: m[1], address: holder })
    if ((m = url.match(/^\/r\/parents\/(\w+)$/))) return json({ ids: m[1] === COPY ? [] : parents, more: false, page_index: 0 })
    return { ok: false, status: 404 }
  }
  return { f, calls }
}

test('verifier: valid proof → ok with the bot number and traits from /content; cached 10 min, re-checked after', async () => {
  let t = NOW; const o = ord()
  const v = makeVerifier({ group: GROUP, fetch: o.f, now: () => t })
  const p = proofFor(tr, TR)
  assert.deepEqual(await v.verify(MEMBER, p), { ok: true, id: BOT, n: 1571, t: '3,12,14,16,42,24,25,37', addr: TR, exp })
  const n = o.calls.length
  await v.verify(MEMBER, p); assert.equal(o.calls.length, n, 'cached')
  t += 11 * 60000
  await v.verify(MEMBER, p); assert.equal(o.calls.length, n + 1, 'after 10 min: /r/inscription again (content and parents never change)')
})

test('verifier: not a child of the Ordibots parent (a copy inscribed by someone else) → refused', async () => {
  const o = ord()
  const v = makeVerifier({ group: GROUP, fetch: o.f, now: () => NOW })
  const r = await v.verify(MEMBER, proofFor(tr, TR, { bot: COPY }))
  assert.equal(r.ok, false); assert.match(r.why, /parent/)
  const r2 = await makeVerifier({ group: GROUP, fetch: ord({ parents: ['aa'.repeat(32) + 'i0'] }).f, now: () => NOW }).verify(MEMBER, proofFor(tr, TR))
  assert.equal(r2.ok, false); assert.match(r2.why, /parent/)
})

test('verifier: address mismatch (bot sold / held elsewhere) → refused; the holder changing is noticed after the cache', async () => {
  let holder = TR; let t = NOW
  const f = async (u) => ord({ holder }).f(u)
  const v = makeVerifier({ group: GROUP, fetch: f, now: () => t })
  const p = proofFor(tr, TR)
  assert.equal((await v.verify(MEMBER, p)).ok, true)
  holder = WK
  assert.equal((await v.verify(MEMBER, p)).ok, true, 'still cached')
  t += 10 * 60000 + 1
  const r = await v.verify(MEMBER, p)
  assert.equal(r.ok, false); assert.match(r.why, /another address/)
  // a valid signature by WK for the bot TR holds: refused
  const r2 = await makeVerifier({ group: GROUP, fetch: ord().f, now: () => NOW }).verify(MEMBER, proofFor(wk, WK))
  assert.equal(r2.ok, false); assert.match(r2.why, /another address/)
})

test('verifier: bad signature, wrong member, expired in cache; ord down → retry soon, not a verdict', async () => {
  let t = NOW
  const v = makeVerifier({ group: GROUP, fetch: ord().f, now: () => t })
  const p = proofFor(tr, TR)
  assert.match((await v.verify(MEMBER, { ...p, sig: proofFor(tr, TR, { exp: exp + 1 }).sig })).why, /invalid signature/)
  assert.match((await v.verify(randomBytes(32).toString('base64'), p)).why, /invalid signature/)
  assert.equal((await v.verify(MEMBER, p)).ok, true)
  t = exp * 1000 + 1
  assert.match((await v.verify(MEMBER, p)).why, /expired/)
  // a proof that expires while its check is still cached: expired at once, not 10 min later
  t = NOW
  const short = proofFor(tr, TR, { exp: NOW / 1000 + 120 })
  assert.equal((await v.verify(MEMBER, short)).ok, true)
  t = NOW + 180000
  assert.match((await v.verify(MEMBER, short)).why, /expired/)
  let down = true; t = NOW
  const v2 = makeVerifier({ group: GROUP, fetch: (u) => ord({ down }).f(u), now: () => t })
  const r = await v2.verify(MEMBER, p)
  assert.equal(r.ok, false); assert.equal(r.retry, true)
  down = false
  assert.equal((await v2.verify(MEMBER, p)).ok, false, 'within 30 s: the cached failure')
  t += 31000
  assert.equal((await v2.verify(MEMBER, p)).ok, true, 'after 30 s: checked again')
})

test('pickInvite: newest valid bearer invite of the group; targeted, foreign, expired and junk ignored', () => {
  const inv = (o) => ({ group_id: GROUP, issued_at_ms: 1, expires_at_ms: NOW + 1e6, ...o })
  const a = inv({ issued_at_ms: 10 }); const b = inv({ issued_at_ms: 20 })
  assert.equal(pickInvite([a, JSON.stringify(b)], GROUP, NOW).issued_at_ms, 20)
  assert.equal(pickInvite([a, inv({ issued_at_ms: 30, target_public_key: [1] }), inv({ issued_at_ms: 40, group_id: 'x' }), inv({ issued_at_ms: 50, expires_at_ms: NOW - 1 }), '{nope', null], GROUP, NOW), a)
  assert.equal(pickInvite([], GROUP, NOW), undefined)
})
