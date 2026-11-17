// Test doubles for net.js in node:test:
//   hub(): an in-memory Entmoot group served by one entmoot-lite fake node per client (its real join()
//          runs unmodified: Noise, multistream, membership, history, gossipsub), relaying every
//          published message to the other clients and keeping them as the group's stored history.
//   FakeRTC: an RTCPeerConnection double for the player-to-player channels (offer/answer through net's
//          signals; the channel opens once the offerer applies the answer; `FakeRTC.block` fails ICE).
// entmoot-lite's own test node and wire helpers: the vendor/entmoot-lite submodule (the commit net/entmoot-lite.js was
// built from), or ENTMOOT_LITE=<checkout>
const LITE = process.env.ENTMOOT_LITE || new URL('../../vendor/entmoot-lite', import.meta.url).pathname
const { fakeNode } = await import(LITE + '/test/fake-node.js')
const { pb, unpb } = await import(LITE + '/src/pb.js')
const { dec, lp, b64 } = await import(LITE + '/src/util.js')
const { createNet } = await import('../net.js')

export const GROUP = b64(new Uint8Array(32).fill(7))
const CP = b64(new Uint8Array(32).fill(8))
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const until = async (fn, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) if (fn()) return true
  throw Error('timed out: ' + fn)
}
export function hub () {
  const stored = [] // every message any client published, in order
  const clients = []
  // while a client's connection is down the node has nowhere to send its gossip: lost (it is in history)
  const deliver = (c, bytes) => c.down ? undefined : c.stream ? c.stream.write(bytes) : c.queue.push(bytes)
  return {
    stored,
    /**
     * join one more client; resolves with its net (createNet options merged in). Live gossip reaches
     * the client from its first history request on (net subscribes before reading history), and
     * `historyGate` (a promise) holds the history answers back, so live messages can overtake them.
     * `miss(m)`: messages this client never gets, live or from history (a hello lost in a join race).
     */
    async add (opts, { historyGate, miss = () => false } = {}) {
      const node = fakeNode()
      node.handlers['/entmoot/membership/1'] = (req) => ({
        version: 1, request_id: req.request_id, group_id: GROUP, canonical: CP, canonical_sequence: 0, complete: true, records: [],
        checkpoints: [{ id: CP, sequence: 0, timestamp: 1000, members: [] }]
      })
      const c = { node, queue: [], stream: null, miss }
      // the node's gossip stream to the client, opened on each connection (again after a reconnect)
      const openLive = () => {
        if (c.on === node.pc) return
        c.on = node.pc; c.stream = null; c.down = false
        node.pc.openToClient('/meshsub/1.1.0').then((st) => { c.stream = st; for (const b of c.queue.splice(0)) st.write(b) })
      }
      /**
       * the client's current connection to its node fails; net's entmoot-lite dials again after 1 s.
       * Only the client added last can reconnect (fake-node's RTCPeerConnection global is its node's).
       */
      c.drop = () => { c.down = true; c.stream = null; node.pc.connectionState = 'failed'; node.pc.onconnectionstatechange() }
      node.handlers['/entmoot/history/2'] = async (req) => {
        openLive()
        if (req.mode === 'list') {
          const ids = stored.filter((m) => !miss(m)).map((m) => m.id)
          await historyGate
          return { version: 2, request_id: req.request_id, ids }
        }
        return { version: 2, request_id: req.request_id, messages: stored.filter((m) => req.ids.includes(m.id)) }
      }
      node.raw['/meshsub/1.1.0'] = async (s) => {
        for (;;) {
          const rpc = await s.lp()
          const pubs = unpb(rpc)[2] || []
          if (!pubs.length) continue
          for (const raw of pubs) {
            const m = JSON.parse(dec(unpb(raw)[2][0]))
            stored.push(m)
            const only = lp(pb([[2, raw]]))
            for (const o of clients) if (o !== c && !o.miss(m)) deliver(o, only)
          }
        }
      }
      clients.push(c)
      const net = await createNet({ addr: node.addr, groupId: GROUP, rtc: FakeRTC, ...opts })
      c.net = net
      return net
    },
    /** topics of stored messages */
    topics: () => stored.map((m) => m.topics[0]),
    /** from now on, `net` never gets messages matching fn (live or from history) */
    lose (net, fn) { clients.find((c) => c.net === net).miss = fn },
    /** drop `net`'s connection to its node (see c.drop) */
    drop (net) { clients.find((c) => c.net === net).drop() }
  }
}

function dcPair () {
  const mk = () => ({
    readyState: 'connecting',
    bufferedAmount: 0,
    sent: 0,
    send (d) {
      if (this.readyState !== 'open') throw Error('InvalidStateError')
      this.sent++
      if (FakeRTC.drop && Math.random() < FakeRTC.drop) return
      queueMicrotask(() => this.peer.readyState === 'open' && this.peer.onmessage?.({ data: d }))
    },
    close () {
      for (const c of [this, this.peer]) {
        if (c.readyState === 'closed') continue
        c.readyState = 'closed'
        queueMicrotask(() => c.onclose?.())
      }
    }
  })
  const a = mk(); const b = mk(); a.peer = b; b.peer = a
  return [a, b]
}

export class FakeRTC {
  static all = new Map()
  static n = 0
  static block = false
  static drop = 0
  constructor (cfg) {
    this.cfg = cfg
    this.name = 'pc' + ++FakeRTC.n
    FakeRTC.all.set(this.name, this)
    this.connectionState = 'new'
    this.iceGatheringState = 'new'
    this.channels = []
  }

  createDataChannel (label, init) { const [a, b] = dcPair(); a.label = label; a.init = init; this.channels.push(a); a.other = b; return a }
  // like a real SDP, it carries an ICE candidate with an IP address (signals must never show it in the clear)
  async createOffer () { return { type: 'offer', sdp: 'fake ' + this.name + ' a=candidate:1 1 udp 2122260223 192.168.17.23 54321 typ host' } }
  async createAnswer () { return { type: 'answer', sdp: 'fake ' + this.name + ' a=candidate:1 1 udp 2122260223 10.9.8.7 40000 typ host' } }
  async setLocalDescription (d) {
    this.localDescription = d
    setTimeout(() => { this.iceGatheringState = 'complete'; this.onicegatheringstatechange?.() }, 1)
  }

  async setRemoteDescription (d) {
    this.remoteDescription = d
    const remote = FakeRTC.all.get(d.sdp.split(' ')[1])
    if (d.type !== 'answer') return
    setTimeout(() => {
      if (FakeRTC.block || !remote || this.connectionState === 'closed' || remote.connectionState === 'closed') {
        this.connectionState = 'failed'; this.onconnectionstatechange?.()
        if (remote) { remote.connectionState = 'failed'; remote.onconnectionstatechange?.() }
        return
      }
      for (const pc of [this, remote]) { pc.connectionState = 'connected'; pc.onconnectionstatechange?.() }
      for (const a of this.channels) {
        const b = a.other
        remote.channels.push(b)
        remote.ondatachannel?.({ channel: b })
        setTimeout(() => { for (const c of [a, b]) { c.readyState = 'open'; c.onopen?.() } })
      }
    }, 2)
  }

  close () {
    this.connectionState = 'closed'
    for (const c of this.channels) c.close()
  }
}
