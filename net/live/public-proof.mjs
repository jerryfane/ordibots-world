// Proof on a (public) group that signals are ciphertext, spending exactly 3 uses of its bearer invite:
//   A and B (fresh keys) join, link up (P2P open) and chat both ways; then C (fresh key) joins, reads the group's
//   whole world/# history and checks: every world/signal/* message is only a {v,e,n,c} envelope, and no message
//   on any topic (hello, chat, pos, bye, signal) contains "candidate", "sdp" or an IPv4 address.
//   SRC=<sandbox src of live.html> GROUP=<base64 group id> INVITE=<bearer invite file> [RATE=6,12] node live/public-proof.mjs
// The three seeds are written to ../../keys/proof-keys-<group prefix>.json (0600) BEFORE they are used, so a rerun
// reuses them as members and spends no more invite uses. The result goes to results/public-proof-<time>.json.
import { chromium } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'

const here = new URL('.', import.meta.url).pathname
const { SRC, GROUP } = process.env
// MEMBERS=p1,p2,p5: a dry run with existing member keys from players.json (no invite, no uses)
const MEMBERS = process.env.MEMBERS?.split(',')
const INVITE = MEMBERS ? null : JSON.parse(readFileSync(process.env.INVITE, 'utf8'))
if (!SRC || !GROUP || !(INVITE || MEMBERS)) throw Error('SRC, GROUP and INVITE (or MEMBERS) required')
if (INVITE && INVITE.group_id !== GROUP) throw Error('the invite is for ' + INVITE.group_id)
const RATE = process.env.RATE || '6,12'
const tag = createHash('sha256').update(GROUP).digest('hex').slice(0, 8)
const KEYS = new URL(`../../keys/proof-keys-${tag}.json`, import.meta.url).pathname
let keys
if (MEMBERS) {
  const pl = JSON.parse(readFileSync(new URL('../../keys/players.json', import.meta.url), 'utf8'))
  keys = Object.fromEntries(['A', 'B', 'C'].map((n, i) => [n, { seed: Buffer.from(pl[MEMBERS[i]].seed, 'base64').toString('base64url'), bot: pl[MEMBERS[i]].bot, used: true }]))
} else if (existsSync(KEYS)) keys = JSON.parse(readFileSync(KEYS, 'utf8'))
else {
  keys = { group: GROUP, A: { seed: randomBytes(32).toString('base64url'), bot: 1571, used: false }, B: { seed: randomBytes(32).toString('base64url'), bot: 375, used: false }, C: { seed: randomBytes(32).toString('base64url'), bot: 2, used: false } }
  writeFileSync(KEYS, JSON.stringify(keys, null, 1)); chmodSync(KEYS, 0o600)
}
const saveKeys = () => MEMBERS || writeFileSync(KEYS, JSON.stringify(keys, null, 1))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const t0 = Date.now()
const out = { started: new Date().toISOString(), group: GROUP, keysFile: KEYS, inviteUses: 0, steps: [] }
const step = (name, data) => { const s = { name, at: new Date().toISOString(), ...data }; out.steps.push(s); console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), JSON.stringify(s).slice(0, 600)) }

const P = {}
async function launch (n) {
  const k = keys[n]
  const q = new URLSearchParams({ k: k.seed, b: String(k.bot), r: RATE, g: GROUP })
  // the invite only for a key that has never joined: one use per key, never more
  if (!k.used) { q.set('i', Buffer.from(JSON.stringify(INVITE)).toString('base64url')); k.used = true; saveKeys(); out.inviteUses++ }
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
  const page = await browser.newPage()
  const errs = []
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  await page.goto(`file://${here}wrap.html#${encodeURIComponent(SRC + '#' + q)}`)
  let fr
  for (let i = 0; i < 100 && !fr; i++) { fr = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith('https://')); if (!fr) await sleep(100) }
  P[n] = { browser, fr, errs, ev: (fn, a) => fr.evaluate(fn, a) }
  await fr.waitForFunction(() => window.T?.phase && T.phase !== 'joining', null, { timeout: 90000 })
  const r = await P[n].ev(() => ({ phase: T.phase, joinMs: T.joinMs, errors: T.errors, id: T.net?.me.id }))
  step('join ' + n, r)
  if (r.phase !== 'joined') throw Error(n + ' did not join: ' + r.errors.join('; '))
  return r.id
}
const waitFor = async (n, fn, arg, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (await P[n].ev(fn, arg).catch(() => false)) return true
  return false
}

let ok = false
try {
  const a = await launch('A'); const b = await launch('B')
  step('presence', { A: await waitFor('A', (id) => T.net.peers.has(id), b, 60000), B: await waitFor('B', (id) => T.net.peers.has(id), a, 60000) })
  const p2p = { A: await waitFor('A', (id) => T.net.peers.get(id)?.p2p === 'open', b, 60000), B: await waitFor('B', (id) => T.net.peers.get(id)?.p2p === 'open', a, 60000) }
  step('p2p open', { ...p2p, peers: await P.A.ev(() => T.stats().peers) })
  const stamp = Date.now().toString(36)
  step('chat send', { A: await P.A.ev((s) => T.chat(s), 'hello from A ' + stamp), B: await P.B.ev((s) => T.chat(s), 'hello from B ' + stamp) })
  const chat = { AtoB: await waitFor('B', (s) => T.chats.some((c) => c.text === s && !c.history), 'hello from A ' + stamp, 20000), BtoA: await waitFor('A', (s) => T.chats.some((c) => c.text === s && !c.history), 'hello from B ' + stamp, 20000) }
  step('chat both ways', chat)
  await P.A.ev(() => T.move(30, 8)); // a few seconds of movement over P2P
  step('movement', { recvByB: await P.B.ev(() => T.stats(6).recv) })
  for (const n of ['A', 'B']) { await P[n].ev(() => T.close()).catch(() => {}); await P[n].browser.close() }
  delete P.A; delete P.B

  await launch('C')
  const audit = await P.C.ev(async () => {
    const all = await T.net.entmoot.history('world/#', 100000)
    const bad = /candidate|sdp|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/i
    const rows = all.map((m) => ({ id: m.id, at: m.timestamp, author: m.author.entmoot_pubkey, topic: m.topics[0], text: m.text }))
    const signals = rows.filter((r) => r.topic.startsWith('world/signal/'))
    const notEnvelope = signals.filter((r) => { try { const o = JSON.parse(r.text); return Object.keys(o).sort().join(',') !== 'c,e,n,v' || o.v !== 1 } catch { return true } })
    const leaks = rows.filter((r) => bad.test(r.text)).map((r) => ({ topic: r.topic, author: r.author.slice(0, 8), match: r.text.match(bad)[0], excerpt: r.text.slice(0, 120) }))
    const byTopic = {}
    for (const r of rows) { const t = r.topic.startsWith('world/signal/') ? 'world/signal/*' : r.topic; byTopic[t] = (byTopic[t] || 0) + 1 }
    return { messages: rows.length, byTopic, signalIds: signals.map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), topic: r.topic, author: r.author })), signals: signals.length, envelopes: signals.length - notEnvelope.length, notEnvelope: notEnvelope.map((r) => ({ topic: r.topic, excerpt: r.text.slice(0, 120) })), leaks, sampleSignal: signals[0]?.text.slice(0, 200) }
  })
  step('history audit by C', audit)
  ok = p2p.A && p2p.B && chat.AtoB && chat.BtoA && audit.signals > 0 && audit.notEnvelope.length === 0 && audit.leaks.length === 0
} catch (e) {
  step('FAILED', { error: String(e?.stack || e) })
} finally {
  for (const n of Object.keys(P)) { await P[n].ev(() => T.close?.()).catch(() => {}); await P[n].browser.close().catch(() => {}) }
  out.ok = ok
  out.errors = Object.fromEntries(Object.entries(P).map(([n, p]) => [n, p.errs]))
  mkdirSync(here + 'results', { recursive: true })
  const file = here + `results/public-proof-${out.started.replace(/[:.]/g, '-')}.json`
  writeFileSync(file, JSON.stringify(out, null, 1))
  console.log('ok:', ok, 'invite uses:', out.inviteUses, 'result:', file)
}
