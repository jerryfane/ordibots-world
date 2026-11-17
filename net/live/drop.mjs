// Live: a page's connection to the node drops (the page closes its own transport) and net comes back on its
// own. p1 and p2 join, P2P opens, p2 moves; then p2's Entmoot transport is closed. Checked: p2 reconnects
// ('reconnect' event), its P2P channel to p1 stays open and movement keeps flowing, and afterwards chat works
// live both ways.
//   SRC=<sandbox src of live.html> node live/drop.mjs
import { chromium } from 'playwright'
import { GROUP } from './test-group.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const here = new URL('.', import.meta.url).pathname
const players = JSON.parse(readFileSync(new URL('../../keys/players.json', import.meta.url), 'utf8'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const t0 = Date.now()
const log = (...a) => console.log(new Date().toISOString().slice(11, 23) + 'Z', ((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a)
const P = {}
const out = { started: new Date().toISOString(), steps: [] }
const step = (name, data) => { out.steps.push({ name, at: new Date().toISOString(), ...data }); log(name, JSON.stringify(data)) }

async function launch (n) {
  const p = players[n]
  const q = new URLSearchParams({ k: Buffer.from(p.seed, 'base64').toString('base64url'), b: String(p.bot), r: '12,24', g: GROUP })
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
  const page = await browser.newPage()
  await page.goto(`file://${here}wrap.html#${encodeURIComponent(process.env.SRC + '#' + q)}`)
  let fr
  for (let i = 0; i < 100 && !fr; i++) { fr = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith('https://')); if (!fr) await sleep(100) }
  await fr.waitForFunction(() => window.T?.phase && T.phase !== 'joining', null, { timeout: 60000 })
  P[n] = { browser, fr, ev: (fn, a) => fr.evaluate(fn, a) }
  await P[n].ev(() => { T.reconnects = []; T.net.on('reconnect', () => T.reconnects.push(Date.now())) })
}
const waitFor = async (n, fn, arg, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await P[n].ev(fn, arg)) return true
  return false
}

try {
  await launch('p1'); await launch('p2')
  const id = { p1: players.p1.pub, p2: players.p2.pub }
  step('p2p open', { ok: await waitFor('p1', (i) => T.net.peers.get(i)?.p2p === 'open', id.p2, 30000) && await waitFor('p2', (i) => T.net.peers.get(i)?.p2p === 'open', id.p1, 30000) })
  const moving = P.p2.ev(() => T.move(30, 25))
  await sleep(3000)
  const before = await P.p1.ev((i) => T.recv[i]?.n || 0, id.p2)
  const tDrop = Date.now()
  await P.p2.ev(() => T.net.entmoot.conn.close())
  step('p2 transport closed', { online: await P.p2.ev(() => T.net.online) })
  const back = await waitFor('p2', () => T.reconnects.length > 0 && T.net.online, null, 30000)
  step('p2 reconnected', { ok: back, ms: (await P.p2.ev(() => T.reconnects[0])) - tDrop, errors: await P.p2.ev(() => T.errors) })
  await sleep(3000)
  const after = await P.p1.ev((i) => T.recv[i]?.n || 0, id.p2)
  step('movement p2 -> p1 across the drop (P2P)', { statesDuringAndAfter: after - before, p2p: await P.p1.ev((i) => T.net.peers.get(i)?.p2p, id.p2) })
  const stamp = Date.now().toString(36)
  step('chat send', { p1: await P.p1.ev((s) => T.chat(s), 'after drop p1 ' + stamp), p2: await P.p2.ev((s) => T.chat(s), 'after drop p2 ' + stamp) })
  step('chat p1 -> p2 live', { ok: await waitFor('p2', (s) => T.chats.some((c) => c.text === s && !c.history && !c.late), 'after drop p1 ' + stamp, 15000) })
  step('chat p2 -> p1 live', { ok: await waitFor('p1', (s) => T.chats.some((c) => c.text === s && !c.history), 'after drop p2 ' + stamp, 15000) })
  await moving
  step('errors', { p1: await P.p1.ev(() => T.errors), p2: await P.p2.ev(() => T.errors) })
} catch (e) {
  step('FAILED', { error: String(e?.stack || e) })
} finally {
  for (const n of Object.keys(P)) { await P[n].ev(() => T.close?.()).catch(() => {}); await P[n].browser.close().catch(() => {}) }
  mkdirSync(here + 'results', { recursive: true })
  writeFileSync(here + `results/drop-${out.started.replace(/[:.]/g, '-')}.json`, JSON.stringify(out, null, 1))
}
