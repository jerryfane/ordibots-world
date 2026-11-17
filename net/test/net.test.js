// net.js against entmoot-lite's fake node (real join(), gossip relayed between clients by test/hub.js)
// and a fake RTCPeerConnection for the player-to-player channels.
import test from 'node:test'
import assert from 'node:assert/strict'
import nc from 'node:crypto'
import { hub, until, sleep, FakeRTC, GROUP } from './hub.js'
import { sealSignal, unsealSignal, xPrivate, edToX } from '../net.js'

const key = () => crypto.getRandomValues(new Uint8Array(32))
/** base64 Ed25519 public key of a seed (= the net id) */
const pubOf = (seed) => nc.createPublicKey(nc.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
const T = '3,12,14,16,42,24,25,37'
const collect = (net) => {
  const ev = { peer: [], leave: [], chat: [], state: [] }
  for (const k of Object.keys(ev)) net.on(k, (x) => ev[k].push(x))
  return ev
}
const pair = async (h, a = {}, b = {}) => {
  const A = await h.add({ key: key(), me: { bot: 1571, t: T }, ...a }); const ea = collect(A)
  const B = await h.add({ key: key(), me: { bot: 375 }, ...b }); const eb = collect(B)
  return { A, B, ea, eb }
}
const opened = (n, id) => n.peers.get(id)?.p2p === 'open'

test('presence: both see each other with bot, traits and name; ids are Entmoot pubkeys', async () => {
  const h = hub()
  const { A, B, ea, eb } = await pair(h)
  await until(() => ea.peer.length && eb.peer.length)
  assert.equal(A.me.id, A.entmoot.me.entmoot_pubkey)
  assert.deepEqual({ ...A.me }, { id: A.me.id, bot: 1571, t: T, name: 'Ordibot #1571' })
  const pa = eb.peer[0]; const pb = ea.peer[0]
  assert.equal(pa.id, A.me.id); assert.equal(pa.bot, 1571); assert.equal(pa.t, T); assert.equal(pa.name, 'Ordibot #1571')
  assert.equal(pb.id, B.me.id); assert.equal(pb.bot, 375); assert.equal(pb.t, undefined)
  assert.equal(B.peers.get(A.me.id), pa)
  assert.ok(pa.lastSeen > 0)
  assert.deepEqual(h.topics().filter((t) => t === 'world/hello').length, 2)
  await A.close(); await B.close()
})

test('P2P: one offer and one answer on world/signal/<recipient>, movement never stored', async () => {
  const h = hub()
  const { A, B, ea, eb } = await pair(h)
  await until(() => opened(A, B.me.id) && opened(B, A.me.id))
  const sig = h.stored.filter((m) => m.topics[0].startsWith('world/signal/'))
  assert.equal(sig.length, 2)
  const [lo, hi] = A.me.id < B.me.id ? [A, B] : [B, A]
  const b64url = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const offer = sig[0] // stored before the answer; its type is sealed (see the signal encryption tests)
  assert.equal(offer.author.entmoot_pubkey, lo.me.id, 'the smaller id offers')
  assert.equal(offer.topics[0], 'world/signal/' + b64url(hi.me.id))
  // the unordered, unreliable channel
  const pc = [...FakeRTC.all.values()].find((p) => p.channels[0]?.init)
  assert.deepEqual(pc.channels[0].init, { ordered: false, maxRetransmits: 0 })

  A.sendState({ t: 1, x: 1.23456, y: 0, z: -2, yaw: 0.5, anim: 'walk' })
  await until(() => eb.state.length)
  assert.deepEqual(eb.state[0], { from: A.me.id, t: 1, x: 1.235, y: 0, z: -2, yaw: 0.5, anim: 'walk' })
  B.sendState({ t: 2, x: 0, y: 0, z: 0, yaw: 0, anim: 0 })
  await until(() => ea.state.length)
  assert.equal(ea.state[0].from, B.me.id)
  assert.ok(!h.topics().some((t) => t === 'world/pos'), 'no Entmoot fallback while P2P works')
  await A.close(); await B.close()
})

test('sendState: at most 15 Hz, latest wins', async () => {
  const h = hub()
  const { A, B, eb } = await pair(h)
  await until(() => opened(A, B.me.id) && opened(B, A.me.id))
  const t0 = Date.now()
  let i = 0
  while (Date.now() - t0 < 1000) { A.sendState({ t: ++i, x: i, y: 0, z: 0, yaw: 0, anim: 'walk' }); await sleep(4) }
  await sleep(150)
  assert.ok(i > 100, 'called ' + i + ' times')
  assert.ok(eb.state.length >= 14 && eb.state.length <= 17, eb.state.length + ' states in ~1 s')
  assert.equal(eb.state.at(-1).t, i, 'the last call arrives')
  for (let k = 1; k < eb.state.length; k++) assert.ok(eb.state[k].t > eb.state[k - 1].t)
  assert.throws(() => A.sendState({ t: 1, x: NaN, y: 0, z: 0, yaw: 0 }))
  await A.close(); await B.close()
})

test('chat: both ways over world/chat, no echo, history at join; 280 chars', async () => {
  const h = hub()
  const { A, B, ea, eb } = await pair(h)
  await until(() => ea.peer.length && eb.peer.length)
  await A.chat('hello from A')
  await B.chat('x'.repeat(400))
  await until(() => eb.chat.length && ea.chat.length)
  assert.deepEqual({ ...eb.chat[0], at: 0 }, { from: A.me.id, text: 'hello from A', at: 0, bot: 1571, name: 'Ordibot #1571' })
  assert.equal(ea.chat[0].text.length, 280)
  assert.equal(ea.chat.length, 1, 'no echo of our own chat')
  assert.equal(eb.chat.length, 1)
  const C = await h.add({ key: key(), me: { bot: 1170 } }); const ec = collect(C)
  await until(() => ec.chat.length === 2 && ec.peer.length === 2)
  assert.deepEqual(ec.chat.map((c) => [c.from, c.history, c.name]), [[A.me.id, true, 'Ordibot #1571'], [B.me.id, true, 'Ordibot #375']])
  await A.close(); await B.close(); await C.close()
})

test('three players: every pair gets its own channel; a closed player leaves for the others', async () => {
  const h = hub()
  const { A, B, ea, eb } = await pair(h)
  const C = await h.add({ key: key(), me: { bot: 1170 } }); const ec = collect(C)
  await until(() => [A, B, C].every((n) => [...n.peers.values()].filter((p) => p.p2p === 'open').length === 2))
  assert.equal(h.topics().filter((t) => t.startsWith('world/signal/')).length, 6)
  C.sendState({ t: 5, x: 5, y: 0, z: 0, yaw: 0, anim: 'idle' })
  await until(() => ea.state.length && eb.state.length)
  await C.close()
  await until(() => ea.leave.includes(C.me.id) && eb.leave.includes(C.me.id))
  assert.ok(!A.peers.has(C.me.id))
  assert.equal(ec.leave.length, 0)
  await A.close(); await B.close()
})

test('P2P fails (strict NAT): state falls back to world/pos at most every 20 s', async () => {
  const h = hub()
  FakeRTC.block = true
  try {
    const { A, B, eb } = await pair(h)
    await until(() => A.peers.get(B.me.id)?.p2p === 'failed' && B.peers.get(A.me.id)?.p2p === 'failed')
    for (let i = 0; i < 20; i++) { A.sendState({ t: i, x: i, y: 0, z: 0, yaw: 0, anim: 'walk' }); await sleep(70) }
    await until(() => eb.state.length)
    assert.equal(h.topics().filter((t) => t === 'world/pos').length, 1, 'one pos in ~1.4 s')
    assert.equal(eb.state[0].from, A.me.id)
    assert.equal(eb.state.length, 1)
    assert.ok(A.peers.get(B.me.id).why)
    await A.close(); await B.close()
  } finally { FakeRTC.block = false }
})

test('budget: chat is refused with code "rate" before the node would drop messages', async () => {
  const h = hub()
  const A = await h.add({ key: key(), me: { bot: 2 } })
  let sent = 0; let err
  for (let i = 0; i < 30 && !err; i++) await A.chat('c' + i).then(() => sent++, (e) => { err = e })
  assert.equal(err?.code, 'rate')
  // standard policy (6/min, burst 12): hello took one, one spare, two reserved for hello/signal
  assert.equal(sent, 8)
  assert.ok(h.stored.length <= 12)
  await A.close()
  await until(() => h.topics().includes('world/bye')) // else B finds A's fresh hello and offers to it
  const B = await h.add({ key: key(), me: { bot: 2 }, rate: { perMin: 12, burst: 24 } })
  sent = 0; err = null
  for (let i = 0; i < 40 && !err; i++) await B.chat('c' + i).then(() => sent++, (e) => { err = e })
  assert.equal(sent, 20)
  await B.close()
})

test('hostile hellos: bad traits dropped, bad bot ignored; reload with the same key is leave + peer', async () => {
  const h = hub()
  const k = key()
  const { A, ea } = await (async () => {
    const A = await h.add({ key: key(), me: { bot: 1571 } })
    return { A, ea: collect(A) }
  })()
  const X = await h.add({ key: k, me: { bot: 9 } })
  await until(() => ea.peer.length === 1)
  await X.entmoot.publish('world/hello', JSON.stringify({ bot: 'x<script>', s: 'zz' }))
  await X.entmoot.publish('world/hello', JSON.stringify({ bot: 10, t: '1,2,<img src=x onerror=alert(1)>', s: 'yy' }))
  await until(() => ea.peer.length === 2)
  assert.equal(ea.leave[0], X.me.id, 'new session of the same key: leave first')
  assert.equal(ea.peer[1].bot, 10)
  assert.equal(ea.peer[1].t, undefined)
  assert.equal(ea.peer[1].name, 'Ordibot #10')
  await X.close(); await A.close()
})

test('quick reload: a stored hello of an old session never replaces a live session heard while joining', async () => {
  const h = hub()
  // X's id must sort after A's: then only A offers, and X's own (still running) net stays silent toward A
  let ka; let kx
  do { ka = key(); kx = key() } while (!(pubOf(ka) < pubOf(kx)))
  const X = await h.add({ key: kx, me: { bot: 375 } })
  await until(() => h.stored.length === 1) // X's hello (its session) is stored, before A subscribes
  let open; const gate = new Promise((resolve) => { open = resolve })
  const a = h.add({ key: ka, me: { bot: 1571 } }, { historyGate: gate })
  await until(() => h.topics().length === 1 && sleep(20)) // A is reading history (held at the gate)
  // X reloads: its new session's hello reaches A live, before A's history answer (which lists only session 1)
  await X.entmoot.publish('world/hello', JSON.stringify({ bot: 375, s: 'reloaded' }))
  await sleep(30)
  open()
  const A = await a
  const ea = collect(A)
  await sleep(20)
  assert.equal(A.peers.get(X.me.id)?.s, 'reloaded', 'the live session stays')
  assert.equal(ea.peer.length, 1)
  assert.equal(ea.leave.length, 0)
  await A.close(); await X.close()
})

test('join race: the smaller id missed the other hello; the larger id knocks with its own offer', async () => {
  const h = hub()
  let ka; let kb
  do { ka = key(); kb = key() } while (!(pubOf(ka) < pubOf(kb)))
  const A = await h.add({ key: ka, me: { bot: 1571 } })
  const ea = collect(A)
  // every hello is lost for A (B's: sent before A subscribed, stored after A listed history)
  h.lose(A, (m) => m.topics[0] === 'world/hello')
  const B = await h.add({ key: kb, me: { bot: 375 } })
  await until(() => B.peers.has(A.me.id))
  assert.ok(!A.peers.has(B.me.id))
  const t0 = Date.now()
  await until(() => opened(A, B.me.id) && opened(B, A.me.id), 14000)
  assert.ok(Date.now() - t0 > 7000, 'the knock waits for the smaller id first')
  assert.equal(ea.peer[0].id, B.me.id)
  assert.equal(h.topics().filter((t) => t.startsWith('world/signal/')).length, 2)
  await A.close(); await B.close()
})

test('node connection drops: P2P keeps flowing, chats missed meanwhile arrive late, then live again with a fresh hello', async () => {
  const h = hub()
  const { A, B, ea, eb } = await pair(h)
  await until(() => opened(A, B.me.id) && opened(B, A.me.id))
  let reconnects = 0
  B.on('reconnect', () => reconnects++)
  h.drop(B)
  await until(() => !B.online)
  await assert.rejects(B.chat('while away'), (e) => e.code === 'offline')
  A.sendState({ t: 7, x: 1, y: 0, z: 0, yaw: 0, anim: 'walk' })
  await until(() => eb.state.some((s) => s.t === 7)) // P2P doesn't need the node
  await A.chat('said while B was away')
  await until(() => reconnects === 1, 5000)
  assert.equal(B.online, true)
  assert.deepEqual(eb.chat.map((c) => [c.text, !!c.late]), [['said while B was away', true]])
  assert.ok(opened(B, A.me.id), 'the open channel was kept')
  const reHello = () => h.stored.some((m) => m.topics[0] === 'world/hello' && m.author.entmoot_pubkey === B.me.id && JSON.parse(Buffer.from(m.content, 'base64').toString()).re === 1)
  await until(reHello) // a fresh hello that says B was reconnecting
  await A.chat('said after B came back')
  await until(() => eb.chat.length === 2)
  assert.equal(eb.chat[1].late, undefined)
  await B.chat('B is back')
  await until(() => ea.chat.some((c) => c.text === 'B is back'))
  await A.close(); await B.close()
})

test('events from before the first handler replay in their order across types', async () => {
  const h = hub()
  const X = await h.add({ key: key(), me: { bot: 375 } })
  const A = await h.add({ key: key(), me: { bot: 1571 } })
  // handlers attached late (after an await): meanwhile X reloads (a new session's hello)
  await until(() => A.peers.has(X.me.id))
  await X.entmoot.publish('world/hello', JSON.stringify({ bot: 375, s: 'second' }))
  await until(() => A.peers.get(X.me.id)?.s === 'second')
  const seen = []
  A.on('peer', (p) => seen.push('peer ' + p.s))
  A.on('leave', () => seen.push('leave'))
  await sleep(10)
  // (X's own net is still running: its next heartbeat would flip A back to the first session later)
  assert.deepEqual(seen.slice(0, 3), ['peer ' + seen[0].slice(5), 'leave', 'peer second'])
  assert.notEqual(seen[0], 'peer second')
  await A.close(); await X.close()
})

test('sendState keeps 15 Hz when timers fire late (busy host)', async () => {
  const h = hub()
  const { A, B, eb } = await pair(h)
  await until(() => opened(A, B.me.id) && opened(B, A.me.id))
  const real = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...a) => real(fn, (ms || 0) + 60, ...a) // every timer ~60 ms late
  try {
    const t0 = performance.now(); let i = 0
    while (performance.now() - t0 < 1000) { A.sendState({ t: ++i, x: i, y: 0, z: 0, yaw: 0, anim: 'walk' }); await new Promise((resolve) => real(resolve, 4)) }
  } finally { globalThis.setTimeout = real }
  await sleep(150)
  assert.ok(eb.state.length >= 13, eb.state.length + ' states in ~1 s with late timers')
  await A.close(); await B.close()
})

test('contended: the key keeps losing its connection, so net says so and keeps trying', { timeout: 30000 }, async () => {
  const h = hub()
  const { A, B } = await pair(h)
  await until(() => opened(A, B.me.id) && opened(B, A.me.id))
  let contended = 0
  B.on('contended', () => contended++)
  // another device with B's key: the node closes B's connection each time it comes back (3 short drops)
  for (let i = 0; i < 3; i++) {
    await until(() => B.online)
    h.drop(B)
    await until(() => !B.online)
  }
  await until(() => contended === 1)
  assert.equal(B.offlineReason, 'contended')
  await assert.rejects(B.chat('hi'), (e) => e.code === 'offline')
  assert.ok(opened(B, A.me.id), 'open P2P channels are kept; it is not a permanent stop')
  await A.close(); await B.close()
})

test('replaced: another tab of this browser takes the key, so net gives up (event, reason, chat refused, peers gone)', { timeout: 30000 }, async () => {
  const all = new Set()
  const BC = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = class {
    constructor (name) { this.name = name; all.add(this) }
    postMessage (data) { for (const c of all) if (c !== this && c.name === this.name) queueMicrotask(() => c.onmessage?.({ data })) }
    close () { all.delete(this) }
  }
  try {
    const h = hub()
    const k = key()
    const { A, B, eb } = await pair(h, {}, { key: k })
    await until(() => opened(A, B.me.id) && opened(B, A.me.id))
    let replaced = 0
    B.on('replaced', () => replaced++)
    const B2 = await h.add({ key: k, me: { bot: 375 } }) // the same key in another tab
    await until(() => replaced === 1)
    assert.equal(B.online, false)
    assert.equal(B.offlineReason, 'replaced')
    await assert.rejects(B.chat('hi'), (e) => e.code === 'replaced')
    assert.equal(B.peers.size, 0)
    assert.ok(eb.leave.includes(A.me.id))
    assert.equal(B2.online, true)
    await A.close(); await B2.close()
  } finally { globalThis.BroadcastChannel = BC }
})

// ---- signal encryption (the world group is public on entmoot.xyz: SDPs must not show IP addresses) ----------
const text = (m) => Buffer.from(m.content, 'base64').toString()
const edPub = (seed) => pubOf(seed)
const GID = 'Z3JvdXA='

test('signals: what the group stores is only sealed envelopes, no SDP, candidate or IP address', async () => {
  const h = hub()
  const { A, B } = await pair(h)
  await until(() => opened(A, B.me.id) && opened(B, A.me.id))
  const sig = h.stored.filter((m) => m.topics[0].startsWith('world/signal/'))
  assert.equal(sig.length, 2)
  for (const m of sig) {
    const t = text(m)
    assert.doesNotMatch(t, /candidate|sdp|192\.168\.17\.23|10\.9\.8\.7|offer|answer/, 'stored in the clear: ' + t.slice(0, 80))
    assert.deepEqual(Object.keys(JSON.parse(t)).sort(), ['c', 'e', 'n', 'v'])
  }
  await A.close(); await B.close()
})

test('signals: seal/unseal round trip; the payload names its sender', async () => {
  const a = key(); const b = key()
  const A = edPub(a); const B = edPub(b)
  const env = await sealSignal({ fromId: A, toId: B, groupId: GID }, { type: 'offer', sdp: 'v=0 a=candidate:1 1 udp 1 1.2.3.4 9 typ host' })
  const o = await unsealSignal({ priv: await xPrivate(b), fromId: A, toId: B, groupId: GID }, env)
  assert.equal(o.type, 'offer'); assert.match(o.sdp, /1\.2\.3\.4/); assert.equal(o.from, A)
  // the Ed25519 → X25519 map matches the seed's X25519 key (both sides agree on the recipient key)
  const nc = await import('node:crypto')
  const priv = nc.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(nc.createHash('sha512').update(b).digest().subarray(0, 32))]), format: 'der', type: 'pkcs8' })
  assert.equal(Buffer.from(edToX(Buffer.from(B, 'base64'))).toString('hex'), nc.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'))
})

test('signals: a wrong recipient, another group or a forged sender cannot open it', async () => {
  const a = key(); const b = key(); const c = key()
  const A = edPub(a); const B = edPub(b); const C = edPub(c)
  const env = await sealSignal({ fromId: A, toId: B, groupId: GID }, { type: 'offer', sdp: 'x' })
  await assert.rejects(unsealSignal({ priv: await xPrivate(c), fromId: A, toId: C, groupId: GID }, env))
  await assert.rejects(unsealSignal({ priv: await xPrivate(b), fromId: A, toId: B, groupId: 'b3RoZXI=' }, env))
  // C (also a member) re-posts A's envelope as its own message: the binding to the author fails
  await assert.rejects(unsealSignal({ priv: await xPrivate(b), fromId: C, toId: B, groupId: GID }, env))
})

test('signals: tampering with the ciphertext, nonce or ephemeral key fails', async () => {
  const a = key(); const b = key()
  const A = edPub(a); const B = edPub(b)
  const env = JSON.parse(await sealSignal({ fromId: A, toId: B, groupId: GID }, { type: 'answer', sdp: 'y' }))
  const priv = await xPrivate(b)
  for (const f of ['c', 'n', 'e']) {
    const bytes = Buffer.from(env[f], 'base64'); bytes[bytes.length - 1] ^= 1
    await assert.rejects(unsealSignal({ priv, fromId: A, toId: B, groupId: GID }, JSON.stringify({ ...env, [f]: bytes.toString('base64') })), f)
  }
})

test('signals: a plaintext offer is refused (no answer)', async () => {
  const h = hub()
  // X's id sorts first, so B never has an offer of its own pending to X (which would make it ignore X's)
  let kx; let kb
  do { kx = key(); kb = key() } while (!(pubOf(kx) < pubOf(kb)))
  const B = await h.add({ key: kb, me: { bot: 375 } })
  const X = await h.add({ key: kx, me: { bot: 2 } })
  await until(() => B.peers.has(X.me.id))
  const b64url = (x) => x.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  // an old-style plaintext offer from X to B's current session (its `s` from B's stored hello)
  const bSession = JSON.parse(text(h.stored.find((m) => m.topics[0] === 'world/hello' && m.author.entmoot_pubkey === B.me.id))).s
  const xSession = JSON.parse(text(h.stored.find((m) => m.topics[0] === 'world/hello' && m.author.entmoot_pubkey === X.me.id))).s
  await X.entmoot.publish('world/signal/' + b64url(B.me.id), JSON.stringify({ type: 'offer', sid: 'plain1', sdp: 'fake pc999 a=candidate:1', s: xSession, to: bSession, bot: 2 }))
  await sleep(1500) // an answer (if any) is out well within this
  // everything B sent to X, opened with X's key: no answer to the plaintext offer
  const priv = await xPrivate(kx)
  const toX = h.stored.filter((m) => m.author.entmoot_pubkey === B.me.id && m.topics[0] === 'world/signal/' + b64url(X.me.id))
  const opened = await Promise.all(toX.map((m) => unsealSignal({ priv, fromId: B.me.id, toId: X.me.id, groupId: GROUP }, text(m)).catch(() => { try { return JSON.parse(text(m)) } catch { return {} } })))
  assert.ok(!opened.some((o) => o.type === 'answer' && o.sid === 'plain1'), 'B answered a plaintext offer')
  await assert.rejects(unsealSignal({ priv: await xPrivate(key()), fromId: X.me.id, toId: B.me.id, groupId: GID }, JSON.stringify({ type: 'offer', sdp: 'x' })), /plaintext refused/)
  await B.close(); await X.close()
})

test('signals: without the WebCrypto pieces to seal, P2P is off with a reason and chat still works', async () => {
  const h = hub()
  const subtle = globalThis.crypto.subtle
  const importKey = subtle.importKey
  // a browser that can't import an X25519 private key (pkcs8): signals can't be opened
  subtle.importKey = function (format, data, alg, ...a) {
    if (format === 'pkcs8' && (alg?.name || alg) === 'X25519') return Promise.reject(Object.assign(Error('not supported'), { name: 'NotSupportedError' }))
    return importKey.call(this, format, data, alg, ...a)
  }
  let A
  try { A = await h.add({ key: key(), me: { bot: 1571 } }) } finally { subtle.importKey = importKey }
  const ea = collect(A)
  const B = await h.add({ key: key(), me: { bot: 375 } }); const eb = collect(B)
  await until(() => A.peers.has(B.me.id) && B.peers.has(A.me.id))
  assert.match(A.p2pOff, /P2P off/)
  assert.equal(B.p2pOff, null)
  await until(() => A.peers.get(B.me.id).p2p === 'failed')
  assert.match(A.peers.get(B.me.id).why, /P2P off/)
  await A.chat('chat still works')
  await until(() => eb.chat.some((c) => c.text === 'chat still works'))
  await B.chat('both ways')
  await until(() => ea.chat.some((c) => c.text === 'both ways'))
  assert.ok(!h.stored.some((m) => m.topics[0].startsWith('world/signal/') && m.author.entmoot_pubkey === A.me.id), 'A sends no signals')
  await A.close(); await B.close()
})
