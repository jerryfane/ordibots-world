// Live test of net.js: headless Chromium players, each in its own browser process, each page inside
// <iframe sandbox="allow-scripts"> on the ordstudio sandbox host (ord's CSP), against the live entmootd.
//
//   SRC=<sandbox src of live.html> node live/run.mjs
// Env: PLAYERS (p1,p2)  RATE ("12,24": the group's per-author policy for net's bucket)
//      CHAT10 (minutes of chat at 10/min from the first player, 0)  HOLD (seconds to stay online at the end
//      moving, for an outside player in another browser, 0)  MOVE (seconds of movement measurement, 20)
import { chromium } from 'playwright'
import { GROUP } from './test-group.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const here = new URL('.', import.meta.url).pathname
const KEYS = new URL('../../keys/', import.meta.url).pathname
const SRC = process.env.SRC
if (!SRC) throw Error('SRC=<sandbox src of live.html> required')
const NAMES = (process.env.PLAYERS || 'p1,p2').split(',')
const RATE = process.env.RATE || '12,24'
const CHAT10 = Number(process.env.CHAT10 || 0)
const HOLD = Number(process.env.HOLD || 0)
const MOVE = Number(process.env.MOVE || 20)
const NAT = (process.env.NAT || '').split(',') // players whose ICE is blocked (no route): P2P must fail and fall back
const TRAITS = { p1: '3,12,14,16,42,24,25,37' }

const players = JSON.parse(readFileSync(KEYS + 'players.json', 'utf8'))
const b64url = (b) => Buffer.from(b).toString('base64url')
const invite = (n) => { try { return readFileSync(KEYS + `invite-${n}.json`) } catch { return null } }
const hash = (n) => {
  const p = players[n]
  const q = new URLSearchParams({ k: b64url(Buffer.from(p.seed, 'base64')), b: String(p.bot), r: RATE, g: GROUP })
  const inv = invite(n); if (inv) q.set('i', b64url(JSON.stringify(JSON.parse(inv))))
  if (TRAITS[n]) q.set('t', TRAITS[n])
  if (NAT.includes(n)) q.set('nat', 'blocked')
  return q.toString()
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const t0 = Date.now()
const out = { started: new Date().toISOString(), rate: RATE, steps: [] }
const step = (name, data) => { const s = { name, s: Math.round((Date.now() - t0) / 100) / 10, ...data }; out.steps.push(s); console.log(JSON.stringify(s)) }

const P = {}
async function launch (n) {
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
  const page = await browser.newPage()
  const errs = []
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  page.on('pageerror', (e) => errs.push(String(e)))
  await page.goto(`file://${here}wrap.html#${encodeURIComponent(SRC + '#' + hash(n))}`)
  let fr
  for (let i = 0; i < 100 && !fr; i++) { fr = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith('https://')); if (!fr) await sleep(100) }
  P[n] = { browser, page, fr, errs, ev: (fn, a) => fr.evaluate(fn, a) }
}
const waitFor = async (n, fn, arg, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await P[n].ev(fn, arg).catch(() => null)
    if (v) return v
    if (Date.now() > end) return null
    await sleep(250)
  }
}

try {
  await Promise.all(NAMES.map(launch))
  // 1. join
  const joined = await Promise.all(NAMES.map((n) => waitFor(n, () => (window.T?.phase !== 'joining') && window.T?.phase, null, 90000)))
  for (const [i, n] of NAMES.entries()) step('join ' + n, { phase: joined[i], joinMs: await P[n].ev(() => T.joinMs), errors: await P[n].ev(() => T.errors) })
  if (joined.some((x) => x !== 'joined')) throw Error('join failed')
  const ids = Object.fromEntries(await Promise.all(NAMES.map(async (n) => [n, await P[n].ev(() => T.net.me.id)])))

  // 2. presence: everyone sees everyone (hello / history)
  let t = Date.now()
  for (const n of NAMES) {
    const others = NAMES.filter((m) => m !== n).map((m) => ids[m])
    const ok = await waitFor(n, (o) => o.every((id) => T.net.peers.has(id)), others, 60000)
    step('presence ' + n, { ok: !!ok, ms: Date.now() - t, peerEvents: await P[n].ev(() => T.peerEvents.map((p) => ({ bot: p.bot, t: p.t, name: p.name }))) })
  }

  // 3. P2P channels open (or, with NAT, fail and leave the pair on world/pos)
  t = Date.now()
  const want = NAT[0] ? 'failed' : 'open'
  for (const n of NAMES) {
    const others = NAMES.filter((m) => m !== n).map((m) => ids[m])
    const ok = await waitFor(n, ([o, w]) => o.every((id) => T.net.peers.get(id)?.p2p === w), [others, want], 60000)
    step('p2p ' + want + ' ' + n, { ok: !!ok, ms: Date.now() - t, peers: (await P[n].ev(() => T.stats().peers)) })
  }

  // 4. chat both ways
  const stamp = Date.now().toString(36)
  for (const n of NAMES) step('chat send ' + n, await P[n].ev((s) => T.chat(s), `hello from ${n} ${stamp}`))
  for (const n of NAMES) {
    const want = NAMES.filter((m) => m !== n).map((m) => `hello from ${m} ${stamp}`)
    const ok = await waitFor(n, (w) => w.every((x) => T.chats.some((c) => c.text === x && !c.history)), want, 30000)
    step('chat recv ' + n, { ok: !!ok, chats: (await P[n].ev(() => T.chats.filter((c) => !c.history).map((c) => c.name + ': ' + c.text))) })
  }

  // 5. movement over P2P: everyone moves (caller at 60 Hz, net caps at 15 Hz), measure at the receivers
  for (const n of NAMES) await P[n].ev(() => T.resetRecv())
  await Promise.all(NAMES.map((n) => P[n].ev((s) => T.move(60, s), MOVE)))
  for (const n of NAMES) step('state ' + n, { recv: await P[n].ev((s) => T.stats(s).recv, MOVE - 2), peers: await P[n].ev(() => T.stats().peers) })

  // 6. sustained chat at 10/min (the test group's policy is 12/min burst 24): no drops
  if (CHAT10 > 0) {
    const [a, ...rest] = NAMES
    const sent = []
    const total = Math.round(CHAT10 * 10)
    const moving = Promise.all(NAMES.map((n) => P[n].ev((s) => T.move(30, s), CHAT10 * 60 + 10)))
    for (let i = 0; i < total; i++) {
      const text = `rate ${stamp} ${i + 1}/${total}`
      const r = await P[a].ev((s) => T.chat(s), text)
      sent.push({ text, ...r })
      if (i < total - 1) await sleep(6000)
    }
    await sleep(5000)
    for (const n of rest) {
      const got = await P[n].ev((s) => T.chats.filter((c) => c.text.startsWith(s)).map((c) => c.text), `rate ${stamp} `)
      // stored = accepted by the node's policy (it drops over-budget messages before storing/relaying)
      const stored = await P[n].ev((s) => T.net.entmoot.history('world/chat', 64).then((h) => h.filter((m) => m.text.startsWith(s)).length), `rate ${stamp} `)
      step('chat10 ' + n, { sent: sent.filter((s) => s.id).length, refusedLocally: sent.filter((s) => s.error).length, received: got.length, storedOnNode: stored, missing: sent.filter((s) => s.id && !got.includes(s.text)).map((s) => s.text) })
    }
    await moving
  }

  // 7. hold for an outside player (another browser); everyone keeps moving
  if (HOLD > 0) {
    step('hold', { seconds: HOLD })
    const end = Date.now() + HOLD * 1000
    const moving = Promise.all(NAMES.map((n) => P[n].ev((s) => T.move(30, s), HOLD)))
    while (Date.now() < end) {
      await sleep(15000)
      const s = await P[NAMES[0]].ev(() => T.stats(10))
      console.log(JSON.stringify({ hold: Math.round((end - Date.now()) / 1000), peers: s.peers, recv: s.recv, chats: s.chats.filter((c) => !c.history).slice(-3) }))
    }
    await moving
    for (const n of NAMES) step('hold end ' + n, await P[n].ev(() => T.stats(10)))
  }

  // 8. leave: the last player closes, the others see 'leave'
  if (NAMES.length > 1) {
    const last = NAMES.at(-1)
    t = Date.now()
    await P[last].ev(() => T.close())
    for (const n of NAMES.slice(0, -1)) {
      const ok = await waitFor(n, (id) => T.leaves.includes(id), ids[last], 30000)
      step('leave seen by ' + n, { ok: !!ok, ms: Date.now() - t })
    }
  }
  for (const n of NAMES) step('errors ' + n, { net: await P[n].ev(() => T.errors), console: P[n].errs.slice(0, 10) })
} catch (e) {
  step('FAILED', { error: String(e?.stack || e) })
  for (const n of Object.keys(P)) step('log ' + n, { log: await P[n].ev(() => T.log.slice(-30)).catch(() => null), console: P[n].errs.slice(0, 10) })
} finally {
  for (const n of Object.keys(P)) { await P[n].ev(() => T.close?.()).catch(() => {}); await P[n].browser.close() }
  mkdirSync(here + 'results', { recursive: true })
  writeFileSync(here + `results/${out.started.replace(/[:.]/g, '-')}.json`, JSON.stringify(out, null, 1))
}
