// net.js ownership proofs: the hello carries the player's proof, peers are announced once their proof was checked
// ('peer' with p.verified, bot/traits/name from the proven bot), a changed verdict fires 'verify'.
// The verify function here is a stand-in for login/proof.js (tested on its own in login/test).
import test from 'node:test'
import assert from 'node:assert/strict'
import { hub, until, sleep } from './hub.js'

const key = () => crypto.getRandomValues(new Uint8Array(32))
const collect = (net) => {
  const ev = { peer: [], leave: [], chat: [], verify: [] }
  for (const k of Object.keys(ev)) net.on(k, (x) => ev[k].push(x))
  return ev
}
const BOT = '26b0d110a22b5ec1f7543288648a278be0f953767180249481ab2377957cce6fi726'
const good = { bot: BOT, addr: 'bc1pgood', sig: 'good', iat: 1, exp: 2 }
const bad = { bot: BOT, addr: 'bc1pbad', sig: 'bad', iat: 1, exp: 2 }
/** a verifier that accepts sig 'good' (while `holds` says so) as Ordibot #1571; records its calls */
const verifier = (holds = () => true) => {
  const calls = []
  const verify = async (member, p) => {
    calls.push([member, p.sig])
    await sleep(20) // the ord server answers a bit later
    if (p.sig !== 'good') return { ok: false, why: 'invalid signature' }
    if (!holds()) return { ok: false, why: 'the bot is held by another address now' }
    return { ok: true, id: p.bot, n: 1571, t: '3,12,14,16,42,24,25,37', addr: p.addr, exp: p.exp }
  }
  return { verify, calls }
}

test('hello carries the proof; a peer is announced only after its check, verified or not, with the proven bot', async () => {
  const h = hub()
  const va = verifier(); const vb = verifier()
  // A claims bot 7 in its hello but proves 1571: the proof wins. B's proof is bad.
  const A = await h.add({ key: key(), me: { bot: 7, t: '1,4' }, proof: good, verify: va.verify }); const ea = collect(A)
  const B = await h.add({ key: key(), me: { bot: 375 }, proof: bad, verify: vb.verify }); const eb = collect(B)
  await until(() => ea.peer.length && eb.peer.length)
  const hello = h.stored.find((m) => m.topics[0] === 'world/hello' && m.author.entmoot_pubkey === A.me.id)
  assert.deepEqual(JSON.parse(Buffer.from(hello.content, 'base64').toString()).p, good)
  const pa = eb.peer[0]; const pb = ea.peer[0]
  assert.equal(pa.id, A.me.id); assert.equal(pa.verified, true)
  assert.equal(pa.bot, 1571); assert.equal(pa.t, '3,12,14,16,42,24,25,37'); assert.equal(pa.name, 'Ordibot #1571'); assert.equal(pa.insc, BOT)
  assert.equal(pb.id, B.me.id); assert.equal(pb.verified, false); assert.equal(pb.proofWhy, 'invalid signature')
  assert.deepEqual(vb.calls[0], [A.me.id, 'good'], 'checked against the hello author, the Entmoot member key')
  // chat carries the author's verdict
  await A.chat('from the holder'); await B.chat('from the faker')
  await until(() => ea.chat.length && eb.chat.length)
  assert.equal(eb.chat[0].verified, true); assert.equal(ea.chat[0].verified, false)
  await A.close(); await B.close()
  await until(() => ea.leave.length + eb.leave.length >= 1)
})

test('no proof at all: announced as unverified; without a verify function nothing changes (verified undefined)', async () => {
  const h = hub()
  const v = verifier()
  const A = await h.add({ key: key(), me: { bot: 1 }, verify: v.verify }); const ea = collect(A)
  const B = await h.add({ key: key(), me: { bot: 2 } }); const eb = collect(B)
  await until(() => ea.peer.length && eb.peer.length)
  assert.equal(ea.peer[0].verified, false); assert.equal(ea.peer[0].proofWhy, 'no ownership proof')
  assert.equal(eb.peer[0].verified, undefined); assert.equal(eb.peer[0].bot, 1)
  await A.close(); await B.close()
})

test('a later hello is checked again: the bot changed hands → "verify" with verified false', async () => {
  const h = hub()
  let holds = true
  const v = verifier(() => holds)
  const A = await h.add({ key: key(), me: { bot: 1 }, verify: v.verify }); const ea = collect(A)
  const B = await h.add({ key: key(), me: { bot: 2 }, proof: good }) // added last: it can reconnect
  await until(() => ea.peer.length)
  assert.equal(ea.peer[0].verified, true)
  holds = false
  h.drop(B) // B reconnects and says hello again (re: 1)
  await until(() => ea.verify.length, 8000)
  assert.equal(ea.verify[0].id, B.me.id); assert.equal(ea.verify[0].verified, false)
  assert.match(ea.verify[0].proofWhy, /another address/)
  assert.equal(ea.peer.length, 1, 'no second peer event')
  await A.close(); await B.close()
})

test('a peer that leaves before its check ends is never announced (no peer, no leave)', async () => {
  const h = hub()
  const slow = async () => { await sleep(400); return { ok: true, n: 1, t: '1', id: BOT } }
  const A = await h.add({ key: key(), me: { bot: 1 }, verify: slow }); const ea = collect(A)
  const B = await h.add({ key: key(), me: { bot: 2 }, proof: good })
  await until(() => A.peers.has(B.me.id))
  await B.close()
  await sleep(600)
  assert.deepEqual([ea.peer.length, ea.leave.length], [0, 0])
  await A.close()
})
