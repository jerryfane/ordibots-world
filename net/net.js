// Ordibots World networking: presence and chat over an Entmoot group (entmoot-lite), movement over
// direct WebRTC data channels between players, signaled through the group. Topics and schemas: README.md.
//   const net = await createNet({ addr, groupId, key, invite, me: { bot, t }, onerror })
//   net.on('peer' | 'leave' | 'chat' | 'state', fn); net.sendState({ t, x, y, z, yaw, anim }); await net.chat(text)
import { join } from './entmoot-lite.js'

const HEARTBEAT_MS = 29000 // world/hello repeats (contract: at most every 30 s)
const PEER_TTL_MS = 75000 // no hello, pos or P2P packet for this long: the peer has left
const FRESH_MS = 45000 // peers from history count only if they spoke this recently
const STATE_MS = 1000 / 15 // sendState: at most 15 Hz, latest wins
const POS_MS = 20000 // world/pos fallback: at most once per 20 s (the group allows 6 msgs/min)
const PING_MS = 2000 // P2P keepalive + round trip time
const LINK_IDLE_MS = 15000 // an open channel that carried nothing for this long is dead
const ICE_WAIT_MS = 4000 // non-trickle: wait for ICE gathering, at most this long
const ANSWER_WAIT_MS = 15000 // offer sent, no channel open after this: the attempt failed
const RETRY_MS = [15000, 30000, 60000] // offerer retries; after the last one the pair stays on world/pos
const KNOCK_MS = 8000 // the larger id offers too if the smaller one hasn't after this long
const RESERVE = 2 // tokens chat and pos leave for hello and signaling
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }]

const b64url = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const num = (v) => typeof v === 'number' && Number.isFinite(v)
const round = (v) => Math.round(v * 1000) / 1000
const okBot = (b) => Number.isInteger(b) && b >= 0 && b < 1e6
const okTraits = (t) => typeof t === 'string' && /^\d{1,4}(,\d{1,4}){0,15}$/.test(t)
const okAnim = (a) => a == null || (typeof a === 'string' && a.length <= 32) || num(a)
const rateError = () => Object.assign(Error('rate limited: wait a few seconds'), { code: 'rate' })

// ---- signal encryption ------------------------------------------------------------------------------
// Signals (SDP offers/answers) carry the players' IP candidates and are stored in the group, which anyone may
// read once it is public (entmoot.xyz). So each one is encrypted to its recipient: the recipient's Entmoot
// Ed25519 key (the topic names it) is mapped to X25519; a fresh X25519 key per message, ECDH, HKDF-SHA256
// (salt = ephemeral key ‖ recipient's X25519 key, info = "ordibots-world/signal/v1" ‖ sender ‖ recipient ‖
// group, also the AES-GCM additional data), AES-256-GCM. Envelope: {v:1, e, n, c} (standard base64).
// The sender is authenticated by Entmoot's signature on the message; the payload's `from` must match it.
// Plaintext signals are refused. Needs WebCrypto X25519 and AES-GCM (Chrome 133+, Firefox 130+, Safari 17+).
const subtle = globalThis.crypto?.subtle
const SIGNAL_INFO = 'ordibots-world/signal/v1'
const P = 2n ** 255n - 19n
const PKCS8_X25519 = Uint8Array.of(0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20)
const utf8 = (s) => new TextEncoder().encode(s)
const join2 = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o }
const b64e = (b) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s) }
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const le2n = (b) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n)
const n2le = (n) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++, n >>= 8n) b[i] = Number(n & 255n); return b }
const powmod = (b, e) => { let r = 1n; for (b %= P; e > 0n; e >>= 1n, b = b * b % P) if (e & 1n) r = r * b % P; return r }
/** Ed25519 public key (32 bytes) → X25519 public key: u = (1 + y) / (1 − y) mod p */
export const edToX = (ed) => {
  if (ed?.length !== 32) throw Error('not an Ed25519 public key')
  const b = ed.slice(); b[31] &= 127
  const y = le2n(b)
  if (y >= P || y === 1n) throw Error('not an Ed25519 public key')
  return n2le((1n + y) * powmod(P + 1n - y, P - 2n) % P)
}
/** our X25519 private key from the Ed25519 seed: the first half of SHA-512(seed), clamped */
export const xPrivate = async (seed) => {
  const h = new Uint8Array(await subtle.digest('SHA-512', seed)).slice(0, 32)
  h[0] &= 248; h[31] &= 127; h[31] |= 64
  return subtle.importKey('pkcs8', join2(PKCS8_X25519, h), { name: 'X25519' }, false, ['deriveBits'])
}
const xPublic = (raw) => subtle.importKey('raw', raw, { name: 'X25519' }, false, [])
const signalInfo = (fromId, toId, groupId) => utf8(`${SIGNAL_INFO}\0${fromId}\0${toId}\0${groupId}`)
const aesKey = async (priv, pubRaw, salt, info) => {
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: await xPublic(pubRaw) }, priv, 256))
  if (shared.every((x) => x === 0)) throw Error('signal: low-order key')
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
/** encrypt signal `o` from member `fromId` to member `toId` (base64 Ed25519 keys) of group `groupId` */
export async function sealSignal ({ fromId, toId, groupId }, o) {
  const toX = edToX(b64d(toId))
  const eph = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
  const e = new Uint8Array(await subtle.exportKey('raw', eph.publicKey))
  const info = signalInfo(fromId, toId, groupId)
  const key = await aesKey(eph.privateKey, toX, join2(e, toX), info)
  const n = crypto.getRandomValues(new Uint8Array(12))
  const c = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: n, additionalData: info }, key, utf8(JSON.stringify({ ...o, from: fromId }))))
  return JSON.stringify({ v: 1, e: b64e(e), n: b64e(n), c: b64e(c) })
}
/**
 * decrypt a signal for us (`priv` from xPrivate(seed), `toId` our id) that member `fromId` signed; throws on
 * plaintext, a wrong recipient, tampering, or a payload whose `from` isn't the author
 */
export async function unsealSignal ({ priv, fromId, toId, groupId }, text) {
  let env
  try { env = JSON.parse(text) } catch { throw Error('signal: not an envelope') }
  if (env?.v !== 1 || ![env.e, env.n, env.c].every((x) => typeof x === 'string')) throw Error('signal: not an envelope (plaintext refused)')
  const e = b64d(env.e); const n = b64d(env.n)
  if (e.length !== 32 || n.length !== 12) throw Error('signal: bad envelope')
  const myX = edToX(b64d(toId))
  const info = signalInfo(fromId, toId, groupId)
  const key = await aesKey(priv, e, join2(e, myX), info)
  const o = JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv: n, additionalData: info }, key, b64d(env.c))))
  if (o?.from !== fromId) throw Error('signal: sender mismatch')
  return o
}

/**
 * @param {object} o
 * @param {string} o.addr  node multiaddr (webrtc-direct with certhash)
 * @param {string} o.groupId  base64 group id
 * @param {Uint8Array} o.key  32-byte Ed25519 seed; never stored
 * @param {object} [o.invite]  target-bound invite JSON (first join of this key only)
 * @param {{bot: number, t?: string}} o.me  bot number and trait index string ("3,12,14,...")
 * @param {(e: Error) => void} [o.onerror]
 * @param {RTCIceServer[]} [o.iceServers]  default Google STUN
 * @param {{perMin: number, burst: number}} [o.rate]  the group's per-author message policy (default standard)
 * @param {typeof RTCPeerConnection} [o.rtc]  RTCPeerConnection constructor (tests, NAT simulation); default the global
 * @param {{bot: string, addr: string, sig: string, iat: number, exp: number}} [o.proof]  this player's ownership
 *   proof (../login/proof.js), sent in every hello
 * @param {(member: string, proof: object) => Promise<{ok: boolean, n?: number, t?: string, id?: string, why?: string}>} [o.verify]
 *   checks a peer's proof (proof.js makeVerifier().verify); peers are announced once checked, with p.verified
 */
export async function createNet ({ addr, groupId, key, invite, me: { bot, t }, proof, verify, onerror = (e) => console.error('net:', e), iceServers = STUN, rate = { perMin: 6, burst: 12 }, rtc }) {
  if (!okBot(bot)) throw Error('me.bot must be a bot number')
  if (t != null && !okTraits(t)) throw Error('me.t must be a trait index string like "3,12,14"')
  // entmoot-lite reconnects by itself (backoff 1/2/5/10/30 s) and then delivers what was missed (m.late)
  let reconnected = () => {} // set below, once everything it touches exists
  let replaced = () => {}; let contended = () => {}
  // entmoot-lite: code 'replaced' = another tab of this browser took the key (it stopped for good);
  // code 'contended' = the connection keeps dropping right after connecting, maybe the key is open elsewhere
  // (it keeps reconnecting, slowly)
  const lite = (e) => { if (e?.code === 'replaced') replaced(); else if (e?.code === 'contended') contended(); onerror(e) }
  const g = await join({ addr, groupId, key, invite, onerror: lite, onreconnect: () => reconnected() })
  const id = g.me.entmoot_pubkey
  // signal encryption keys; without WebCrypto X25519/AES-GCM, P2P is off (chat and presence still work)
  let xKey = null; let p2pOff = null
  try {
    xKey = await xPrivate(typeof key === 'string' ? b64d(key) : key)
    await sealSignal({ fromId: id, toId: id, groupId }, {})
  } catch (e) { p2pOff = 'P2P off: this browser has no WebCrypto X25519/AES-GCM to encrypt signals (' + e.message + ')' }
  const seal = (toId, o) => sealSignal({ fromId: id, toId, groupId }, o)
  const unseal = (fromId, text) => unsealSignal({ priv: xKey, fromId, toId: id, groupId }, text)
  const me = { id, bot, t, name: 'Ordibot #' + bot }
  const session = Math.random().toString(36).slice(2, 10)
  const hello = () => ({ bot, t, name: me.name, s: session, ...(proof && { p: proof }) })
  const RTC = rtc || globalThis.RTCPeerConnection
  const RATE_PER_MS = rate.perMin / 60000
  const BURST = rate.burst - 1 // one token of margin against clock drift with the node
  let closed = false

  const handlers = {}
  // Events that happen before anyone listens (peers and chats found while joining) wait in ONE queue, in the
  // order they happened; it is replayed on the microtask after the first on() call, so all handlers attached
  // right after createNet resolves see them in order (e.g. peer(old session), leave(old), peer(new)).
  let early = []
  const deliver = (ev, x) => { for (const fn of handlers[ev] || []) try { fn(x) } catch (e) { onerror(e) } }
  const emit = (ev, x) => {
    if (early) { if (early.length < 1024) early.push([ev, x]); return }
    deliver(ev, x)
  }

  // ---- Entmoot publishing inside the group's per-author budget ---------------------------------
  // The node drops over-budget messages silently, so the client keeps its own bucket and decides.
  let tokens = BURST; let tokAt = Date.now()
  const take = (reserve) => {
    const now = Date.now()
    tokens = Math.min(BURST, tokens + (now - tokAt) * RATE_PER_MS); tokAt = now
    if (tokens - 1 < reserve) return false
    tokens--
    return true
  }
  const publish = (topic, content) => g.publish(topic, content).catch(onerror)
  // signals must not be lost: they wait for a token, and for the node while we are reconnecting
  const signals = []; let pumpTimer = 0
  const pump = () => {
    pumpTimer = 0
    while (signals.length && g.connected && take(0)) { const [topic, content] = signals.shift(); publish(topic, content) }
    if (signals.length && !closed) pumpTimer = setTimeout(pump, g.connected ? Math.ceil((1 - tokens) / RATE_PER_MS) + 50 : 1000)
  }
  let lastHello = 0; let lastPos = 0
  const sendHello = (reserve, extra) => { if (g.connected && take(reserve)) { lastHello = Date.now(); publish('world/hello', JSON.stringify({ ...hello(), ...extra })) } }

  // ---- peers -----------------------------------------------------------------------------------
  /** public: id -> {id, bot, t, name, lastSeen, p2p, rtt}; internal fields s, tries, retryAt, since */
  const peers = new Map()
  const known = new Map() // id -> {bot, name} of everyone ever heard (names for history chats)
  const links = new Map() // id -> {pc, dc, role, sid, open, rseq, timer}
  const unannounced = new Set() // peers found in history while joining; announced once history is read

  /**
   * A member spoke (hello, pos, signal) with info {bot, t, s} at time `at`. via: 'live' (announce
   * and connect), 'signal' (announce; the signal itself drives the link), 'history' (silent).
   */
  const heard = (pid, info, at, via) => {
    if (pid === id || !okBot(info.bot) || typeof info.s !== 'string' || info.s.length > 16) return
    let p = peers.get(pid)
    if (p && p.s !== info.s) {
      // Same key, other session. Live news of a new session (a reload) replaces the old one; history read
      // while joining is older than anything heard live, so it never replaces a live session.
      if (via === 'history' && p.live) return
      leave(pid, via === 'history'); p = null
    }
    if (!known.get(pid)?.verified) known.set(pid, { bot: info.bot, name: 'Ordibot #' + info.bot })
    if (!p) {
      p = { id: pid, bot: info.bot, t: okTraits(info.t) ? info.t : undefined, name: 'Ordibot #' + info.bot, lastSeen: at, p2p: 'none', rtt: null, s: info.s, tries: 0, retryAt: 0, since: Date.now(), proof: info.p, verified: verify ? false : undefined, announced: false }
      peers.set(pid, p)
      if (via === 'history') unannounced.add(pid); else check(p)
    } else if (info.p) {
      // every live hello asks again: the verifier answers from its cache, and checks anew 10 min after the last time
      if (JSON.stringify(info.p) !== JSON.stringify(p.proof)) (p.proof = info.p), (p.recheck = p.checking)
      if (via !== 'history' && p.announced) check(p)
    }
    p.lastSeen = Math.max(p.lastSeen, at)
    if (via !== 'history') p.live = true
    if (via === 'live') maybeConnect(p)
    return p
  }
  const leave = (pid, quiet) => {
    const p = peers.get(pid)
    if (!p) return
    dropLink(pid)
    peers.delete(pid)
    if (!unannounced.delete(pid) && !quiet && p.announced) emit('leave', pid)
  }
  /**
   * Ownership proofs: a peer is announced ('peer') once its proof was checked, with p.verified set (and its bot
   * number, traits and name taken from the proven bot). A later verdict that differs fires 'verify'. Without a
   * verify function every peer is announced at once and p.verified stays undefined.
   */
  const check = (p) => {
    if (!verify) return (p.announced = true), emit('peer', p)
    if (p.checking) return
    p.checking = true
    const proof = p.proof
    Promise.resolve()
      .then(() => (proof ? verify(p.id, proof) : { ok: false, why: 'no ownership proof' }))
      .catch((e) => ({ ok: false, why: 'check failed: ' + e.message }))
      .then((r) => {
        p.checking = false
        if (peers.get(p.id) !== p || closed) return
        const was = [p.verified, p.bot, p.t]
        p.verified = !!r?.ok
        p.proofWhy = p.verified ? undefined : String(r?.why || 'refused')
        if (p.verified) {
          p.insc = r.id
          if (okBot(r.n)) (p.bot = r.n), (p.name = 'Ordibot #' + r.n)
          p.t = okTraits(r.t) ? r.t : undefined
          known.set(p.id, { bot: p.bot, name: p.name, verified: true })
        }
        if (!p.announced) (p.announced = true), emit('peer', p)
        else if (was[0] !== p.verified || was[1] !== p.bot || was[2] !== p.t) emit('verify', p)
        if (p.recheck) (p.recheck = false), check(p)
      })
  }

  // ---- P2P links -------------------------------------------------------------------------------
  // The peer with the smaller id offers; the other answers. One complete offer and one complete answer
  // (ICE gathered first, no trickle) cost one Entmoot message each.
  const dropLink = (pid) => {
    const L = links.get(pid)
    if (!L) return
    links.delete(pid)
    clearTimeout(L.timer)
    try { L.pc.close() } catch {}
    const p = peers.get(pid)
    if (p && p.p2p !== 'failed') p.p2p = 'none'
  }
  const fail = (pid, L, why) => {
    if (L && links.get(pid) !== L) return
    dropLink(pid)
    const p = peers.get(pid)
    if (!p) return
    p.p2p = 'failed'
    p.why = why
    if (!L || L.role === 'offer') p.retryAt = Date.now() + (RETRY_MS[p.tries - 1] ?? Infinity)
  }
  // The smaller id offers. The larger one offers too ("knock") if no offer came KNOCK_MS after it learned of
  // the peer: the peer may have missed our hello (both joined at once: each hello went out before the other
  // subscribed, and after it listed history), and would otherwise only find us at our next heartbeat.
  const maybeConnect = (p) => {
    if (p2pOff) { p.p2p = 'failed'; p.why = p2pOff; return }
    if (closed || links.has(p.id) || p.tries > RETRY_MS.length || Date.now() < p.retryAt) return
    if (!(id < p.id) && (p.offered || Date.now() - p.since < KNOCK_MS)) return
    offer(p).catch((e) => { onerror(e); fail(p.id, links.get(p.id), 'offer: ' + e.message) })
  }
  const newLink = (p, role, sid) => {
    dropLink(p.id)
    const pc = new RTC({ iceServers })
    const L = { pc, dc: null, role, sid, open: false, rseq: -1, timer: 0 }
    links.set(p.id, L)
    p.p2p = 'connecting'
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') fail(p.id, L, 'ice failed') }
    L.timer = setTimeout(() => fail(p.id, L, role === 'offer' ? 'no answer or no route' : 'no channel'), ANSWER_WAIT_MS + ICE_WAIT_MS)
    return L
  }
  const gathered = (pc) => new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const t = setTimeout(resolve, ICE_WAIT_MS)
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve() } }
  })
  const signal = async (p, body) => {
    // the proof rides along: a peer that first learns of us from our offer checks it like a hello's
    const content = await seal(p.id, { ...body, s: session, to: p.s, bot, t, ...(proof && { p: proof }) })
    if (content.length > 8000) throw Error('signal too large for the group policy: ' + content.length + ' bytes')
    signals.push(['world/signal/' + b64url(p.id), content])
    if (!pumpTimer) pump()
  }
  const offer = async (p) => {
    p.tries++
    const L = newLink(p, 'offer', Math.random().toString(36).slice(2, 10))
    wire(p.id, L, L.pc.createDataChannel('w', { ordered: false, maxRetransmits: 0 }))
    await L.pc.setLocalDescription(await L.pc.createOffer())
    await gathered(L.pc)
    if (links.get(p.id) !== L) return
    await signal(p, { type: 'offer', sid: L.sid, sdp: L.pc.localDescription.sdp })
  }
  const answer = async (p, o) => {
    const L = newLink(p, 'answer', o.sid)
    L.pc.ondatachannel = (e) => wire(p.id, L, e.channel)
    await L.pc.setRemoteDescription({ type: 'offer', sdp: o.sdp })
    await L.pc.setLocalDescription(await L.pc.createAnswer())
    await gathered(L.pc)
    if (links.get(p.id) !== L) return
    await signal(p, { type: 'answer', sid: o.sid, sdp: L.pc.localDescription.sdp })
  }
  const onSignal = async (m) => {
    const pid = m.author.entmoot_pubkey
    // missed while we were reconnecting: stale by now (the offerer re-offers once it hears our new hello)
    if (pid === id || m.late || p2pOff) return
    let o
    try { o = await unseal(pid, m.text) } catch { return } // plaintext, not for us, tampered, or forged `from`
    if (o?.to !== session || typeof o.sdp !== 'string' || typeof o.sid !== 'string') return // stale or not for us
    const p = heard(pid, o, Date.now(), 'signal')
    if (!p) return
    if (o.type === 'offer') {
      const L = links.get(pid)
      // both offered at once (a knock crossed our offer): the smaller id's offer wins
      if (L && !L.open && L.role === 'offer' && id < pid) return
      if (L?.open) dropLink(pid) // the offerer restarted the link
      p.offered = true
      p.tries = 0
      await answer(p, o).catch((e) => { onerror(e); fail(pid, links.get(pid), 'answer: ' + e.message) })
    } else if (o.type === 'answer') {
      const L = links.get(pid)
      if (!L || L.role !== 'offer' || L.sid !== o.sid || L.answered) return
      L.answered = true
      await L.pc.setRemoteDescription({ type: 'answer', sdp: o.sdp }).catch((e) => { onerror(e); fail(pid, L, 'answer rejected') })
    }
  }

  // ---- P2P packets (JSON arrays on an unordered, unreliable channel) ---------------------------
  //   [0, seq, t, x, y, z, yaw, anim]  state      [1, ms] ping      [2, ms] pong
  let seq = 0; let latest = null; let lastStateAt = -Infinity; let stateTimer = 0
  const send = (L, a) => { if (L.open && L.dc.readyState === 'open' && L.dc.bufferedAmount < 16384) try { L.dc.send(JSON.stringify(a)) } catch {} }
  /** the selected ICE pair as "local/remote" candidate types (host, srflx, prflx, relay) + protocol */
  const route = async (pc) => {
    const st = [...(await pc.getStats()).values()]
    const pair = st.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded')
    const c = (cid) => st.find((s) => s.id === cid)
    return pair && `${c(pair.localCandidateId)?.candidateType}/${c(pair.remoteCandidateId)?.candidateType} ${c(pair.localCandidateId)?.protocol || ''}`.trim()
  }
  const wire = (pid, L, dc) => {
    L.dc = dc
    dc.onopen = () => {
      if (links.get(pid) !== L) return
      clearTimeout(L.timer)
      L.open = true
      const p = peers.get(pid)
      if (p) { p.p2p = 'open'; p.tries = 0; p.why = undefined; route(L.pc).then((r) => { p.route = r }, () => {}) }
      if (latest) send(L, [0, seq, ...latest])
      send(L, [1, performance.now()])
    }
    dc.onclose = () => { if (links.get(pid) === L) { if (L.open) leave(pid); else fail(pid, L, 'channel closed') } }
    dc.onmessage = (e) => {
      if (links.get(pid) !== L || typeof e.data !== 'string' || e.data.length > 512) return
      const p = peers.get(pid)
      if (!p) return
      let a
      try { a = JSON.parse(e.data) } catch { return }
      if (!Array.isArray(a)) return
      p.lastSeen = Date.now()
      if (a[0] === 0) {
        if (!(a[1] > L.rseq)) return // late or repeated: latest wins
        L.rseq = a[1]
        const s = state(a.slice(2))
        if (s) emit('state', { from: pid, ...s })
      } else if (a[0] === 1 && num(a[1])) send(L, [2, a[1]])
      else if (a[0] === 2 && num(a[1])) p.rtt = Math.round(performance.now() - a[1])
    }
  }
  /** [t, x, y, z, yaw, anim] -> state object, or null if malformed */
  const state = (a) => Array.isArray(a) && a.slice(0, 5).every(num) && okAnim(a[5]) ? { t: a[0], x: a[1], y: a[2], z: a[3], yaw: a[4], anim: a[5] } : null

  const flush = () => {
    stateTimer = 0
    if (!latest || closed) return
    lastStateAt = performance.now()
    seq++
    for (const L of links.values()) send(L, [0, seq, ...latest])
    // fallback for peers we have no channel with (yet): rare world/pos, which doubles as heartbeat
    const now = Date.now()
    const stranded = [...peers.values()].some((p) => !links.get(p.id)?.open && (p.p2p === 'failed' || now - p.since > ANSWER_WAIT_MS + ICE_WAIT_MS))
    if (stranded && g.connected && now - lastPos >= POS_MS && take(RESERVE)) {
      lastPos = lastHello = now
      publish('world/pos', JSON.stringify({ ...hello(), st: latest }))
    }
  }

  // ---- Entmoot traffic -------------------------------------------------------------------------
  let joining = true
  const initial = new Set() // ids of messages handled while history loads (live and history overlap)
  const onMessage = (m, fromHistory) => {
    if (joining) { if (initial.has(m.id)) return; initial.add(m.id) }
    const pid = m.author?.entmoot_pubkey
    const topic = m.topics?.[0] || ''
    // late = stored while we were reconnecting, delivered after the reconnect: treat as of its own time
    const at = fromHistory || m.late ? m.timestamp : Date.now()
    if (topic === 'world/chat') {
      const who = pid === id ? me : known.get(pid)
      if (pid === id && !fromHistory) return
      const verified = !!(peers.get(pid)?.verified || known.get(pid)?.verified)
      emit('chat', { from: pid, text: [...m.text].slice(0, 280).join(''), at: m.timestamp, bot: who?.bot, name: who?.name, ...(verify && pid !== id && { verified }), ...(fromHistory && { history: true }), ...(m.late && { late: true }) })
      return
    }
    if (pid === id || !/^world\/(hello|pos|bye)$/.test(topic)) return
    let o
    try { o = JSON.parse(m.text) } catch { return }
    if (!o || typeof o !== 'object') return
    if (topic === 'world/bye') { if (peers.get(pid)?.s === o.s) leave(pid, fromHistory); return }
    if (m.late && Date.now() - m.timestamp > PEER_TTL_MS) return
    const p = heard(pid, o, at, fromHistory ? 'history' : 'live')
    // a peer that was reconnecting to the node says so in its hello: links that failed meanwhile get new tries
    if (p && o.re === 1 && !links.get(pid)?.open) { p.tries = 0; p.retryAt = 0; if (p.p2p === 'failed') p.p2p = 'none'; maybeConnect(p) }
    if (p && topic === 'world/pos' && !fromHistory && !m.late && !links.get(pid)?.open) {
      const s = state(o.st)
      if (s) emit('state', { from: pid, ...s })
    }
  }
  /** back on the node after a drop: open P2P channels kept; fresh hello; links that died get new tries */
  contended = () => { if (!closed) emit('contended') }
  /** another tab of this browser holds this key now: give everything up (it is that tab's world) */
  replaced = () => {
    if (closed) return
    closed = true
    clearInterval(sweep); clearTimeout(stateTimer); clearTimeout(pumpTimer)
    signals.length = 0
    for (const pid of [...peers.keys()]) leave(pid)
    emit('replaced')
    g.close()
  }
  reconnected = () => {
    if (closed) return
    sendHello(0, { re: 1 })
    for (const p of peers.values()) {
      if (links.get(p.id)?.open) continue
      p.tries = 0; p.retryAt = 0
      if (p.p2p === 'failed') p.p2p = 'none'
      maybeConnect(p)
    }
    if (signals.length && !pumpTimer) pump()
    emit('reconnect')
  }
  g.on('world/+', (m) => onMessage(m, false))
  g.on('world/signal/' + b64url(id), (m) => onSignal(m).catch(onerror))

  for (const m of await g.history('world/#', 64)) onMessage(m, true)
  for (const pid of unannounced) {
    const p = peers.get(pid)
    if (!p) continue
    if (Date.now() - p.lastSeen > FRESH_MS) { peers.delete(pid); continue }
    check(p)
    maybeConnect(p)
  }
  unannounced.clear()
  sendHello(0)

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const L of links.values()) send(L, [1, performance.now()])
    for (const p of [...peers.values()]) {
      const L = links.get(p.id)
      if (L?.open ? now - p.lastSeen > LINK_IDLE_MS : now - p.lastSeen > PEER_TTL_MS) leave(p.id)
      else maybeConnect(p)
    }
    if (now - lastHello >= HEARTBEAT_MS) sendHello(1)
  }, PING_MS)

  const net = {
    me,
    peers,
    /**
     * subscribe: 'peer' (p), 'leave' (id), 'chat' ({from, text, at, bot, name, history?, late?}),
     * 'state' ({from, t, x, y, z, yaw, anim}), 'reconnect' () after the node connection came back,
     * 'contended' () and 'replaced' () (see offlineReason)
     * (chats missed meanwhile arrive first, with late: true). Events from before the first on() call are
     * replayed in order on the next microtask to the handlers attached by then.
     */
    on (ev, fn) {
      if (early && !early.flushing) {
        early.flushing = true
        queueMicrotask(() => {
          // events emitted during the replay (by handlers) queue behind it, still in order
          for (let i = 0; i < early.length; i++) deliver(...early[i])
          early = null
        })
      }
      (handlers[ev] ||= []).push(fn)
      return net
    },
    /** latest-wins movement to every connected peer, at most 15 Hz; never stored on Entmoot */
    sendState ({ t, x, y, z, yaw, anim }) {
      const s = state([t, x, y, z, yaw, anim])
      if (!s) throw Error('sendState: t, x, y, z, yaw must be finite numbers and anim a short string or number')
      latest = [s.t, round(x), round(y), round(z), round(yaw), anim]
      // a call after the period always sends (a late timer must not stretch the period); the timer only
      // carries the last update when calls stop
      const wait = lastStateAt + STATE_MS - performance.now()
      if (wait <= 0) { clearTimeout(stateTimer); flush() } else if (!stateTimer) stateTimer = setTimeout(flush, wait)
    },
    /**
     * publish to world/chat (stored); at most 280 characters; rejects with .code 'rate' when over
     * budget and with .code 'offline' while reconnecting to the node
     */
    async chat (text) {
      text = [...String(text).trim()].slice(0, 280).join('')
      if (!text) return
      if (g.stopped) throw g.stopped
      if (!g.connected) throw Object.assign(Error('reconnecting to the node'), { code: 'offline' })
      if (!take(RESERVE)) throw rateError()
      return g.publish('world/chat', text)
    },
    /** false while the connection to the node is down (P2P channels may still carry movement) */
    get online () { return g.connected },
    /**
     * why net is offline: null (online), 'reconnecting', 'contended' (the key keeps losing its connection: maybe
     * open in another tab/device; still retrying), 'replaced' (another tab of this browser took it) or 'closed'
     */
    /** null, or why P2P is off in this browser (no WebCrypto X25519/AES-GCM to encrypt signals) */
    get p2pOff () { return p2pOff },
    get offlineReason () { return g.stopped ? 'replaced' : closed ? 'closed' : g.connected ? null : g.contended ? 'contended' : 'reconnecting' },
    /** say bye on world/bye (if the budget allows), close every channel and the Entmoot connection */
    async close () {
      if (closed) return
      closed = true
      clearInterval(sweep); clearTimeout(stateTimer); clearTimeout(pumpTimer)
      for (const pid of [...links.keys()]) dropLink(pid)
      if (g.connected && take(0)) await g.publish('world/bye', JSON.stringify({ s: session })).catch(() => {})
      g.close()
    },
    entmoot: g
  }
  joining = false; initial.clear()
  return net
}
