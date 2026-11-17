// Repro for "a player gets no live messages": who hears whom, live. EARLY players join first and settle;
// then the JOIN players start together (a first-time key uses its invite-pN.json). KILL=pN crashes that
// player's browser 5 s later and starts it again after REJOIN s (same key: the reload case). Everyone chats at
// +8 s and +40 s; at +60 s each player reports which players it saw (live 'peer') and whose chats arrived
// live, and the node's stored history is listed with full message ids.
//   SRC=<sandbox src of live.html> EARLY=p1 JOIN=p2 KILL=p2 REJOIN=15 node live/admission.mjs
// LITE=<project file>: load that entmoot-lite build instead (one with timing marks logs per-page timelines).
import { chromium } from 'playwright'
import { GROUP } from './test-group.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const here = new URL('.', import.meta.url).pathname
const KEYS = new URL('../../keys/', import.meta.url).pathname
const players = JSON.parse(readFileSync(KEYS + 'players.json', 'utf8'))
const name = Object.fromEntries(Object.entries(players).map(([k, p]) => [p.pub, k]))
const EARLY = (process.env.EARLY || 'p1').split(',').filter(Boolean)
const JOIN = (process.env.JOIN || 'p2,p5').split(',').filter(Boolean)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const t0 = Date.now()
const log = (...a) => console.log(new Date().toISOString().slice(11, 23) + 'Z', ((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a)
const P = {}

async function launch (n) {
  const p = players[n]
  const q = new URLSearchParams({ k: Buffer.from(p.seed, 'base64').toString('base64url'), b: String(p.bot), r: '12,24', g: GROUP })
  if (process.env.LITE) q.set('lite', process.env.LITE)
  let inv = null; try { inv = readFileSync(KEYS + `invite-${n}.json`, 'utf8') } catch {}
  if (inv) q.set('i', Buffer.from(JSON.stringify(JSON.parse(inv))).toString('base64url'))
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
  const page = await browser.newPage()
  await page.goto(`file://${here}wrap.html#${encodeURIComponent(process.env.SRC + '#' + q)}`)
  let fr
  for (let i = 0; i < 100 && !fr; i++) { fr = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith('https://')); if (!fr) await sleep(100) }
  P[n] = { browser, fr }
  await fr.waitForFunction(() => window.T?.phase && T.phase !== 'joining', null, { timeout: 90000 })
  const r = await fr.evaluate(() => ({ phase: T.phase, joinMs: T.joinMs, errors: T.errors, member: !!T.net }))
  log('joined', n, JSON.stringify(r), inv ? '(invite available)' : '')
}
const report = async (n) => P[n].fr.evaluate(() => ({
  peers: T.peerEvents.map((p) => p.id),
  chats: T.chats.filter((c) => !c.history).map((c) => [c.from, c.text]),
  p2p: [...T.net.peers.values()].map((p) => [p.id, p.p2p, p.why || '']),
  me: T.net.entmoot.me,
  marks: T.marks,
  errors: T.errors
}))
const out = { started: new Date().toISOString(), EARLY, JOIN, players: {} }
// KILL=p2: after everyone joined, crash p2's browser (no bye, no close: the node keeps the old connection
// until it times out), wait REJOIN seconds, start p2 again (same key = same libp2p peer id), then measure.
const KILL = process.env.KILL; const REJOIN = Number(process.env.REJOIN || 15)
try {
  await Promise.all(EARLY.map(launch))
  if (EARLY.length) await sleep(5000)
  let tj = Date.now()
  await Promise.all(JOIN.map(launch))
  log('all joined; join spread', Date.now() - tj, 'ms')
  if (KILL) {
    await sleep(5000)
    await (await P[KILL].browser.newBrowserCDPSession()).send('Browser.crash').catch(() => {}) // whole browser dies: no clean WebRTC close
    log('crashed', KILL, '; rejoining in', REJOIN, 's')
    await sleep(REJOIN * 1000)
    tj = Date.now()
    await launch(KILL)
  }
  const all = [...EARLY, ...JOIN]
  await sleep(8000)
  await Promise.all(all.map((n) => P[n].fr.evaluate((s) => T.chat(s), `adm1 from ${n}`)))
  log('chat 1 sent')
  await sleep(32000)
  await Promise.all(all.map((n) => P[n].fr.evaluate((s) => T.chat(s), `adm2 from ${n}`)))
  log('chat 2 sent')
  await sleep(20000)
  for (const n of all) {
    const r = await report(n)
    out.players[n] = r
    log(n, 'peer id', r.me.peer_id, 'member id', r.me.member_id, 'pubkey', r.me.entmoot_pubkey)
    // timing marks (LITE builds with marks): connection steps, node RPCs that carry more than IHAVE, live messages
    for (const { ev, at, ...d } of r.marks || []) {
      if (ev === 'rpc' && !d.subs && !d.pub && !d.graft && !d.prune) continue
      if (ev === 'live-msg') d.author = name[d.author] || d.author?.slice(0, 8)
      log(`  ${n} ${new Date(at).toISOString().slice(11, 23)}Z ${ev} ${JSON.stringify(d)}`)
    }
    const others = all.filter((m) => m !== n)
    const saw = others.map((m) => {
      const id = players[m].pub
      const chats = r.chats.filter(([f]) => f === id).length
      const link = r.p2p.find(([pid]) => pid === id)
      return `${m}:${r.peers.includes(id) ? 'peer' : 'NO-peer'},chats=${chats}/2,${link ? link[1] : 'unknown'}`
    })
    log(n.padEnd(3), 'hears', saw.join('  '), r.errors.length ? 'errors=' + JSON.stringify(r.errors) : '')
  }
  // what the node stored (any player's history), with full ids for the node's debug log
  const anyone = all[0]
  const stored = await P[anyone].fr.evaluate(async (since) => (await T.net.entmoot.history('world/#', 200)).filter((m) => m.timestamp >= since - 1000).map((m) => ({ at: new Date(m.timestamp).toISOString(), author: m.author.entmoot_pubkey, member: m.author.member_id, topic: m.topics[0], id: m.id, text: m.text.slice(0, 40) })), tj)
  out.stored = stored
  for (const m of stored) log('stored', m.at, (name[m.author] || m.author.slice(0, 8)).padEnd(3), m.topic.padEnd(24), m.id, m.topic.includes('chat') ? JSON.stringify(m.text) : '')
  log('ids', JSON.stringify(Object.fromEntries(all.map((n) => [n, players[n].pub]))), 'member ids:', JSON.stringify(Object.fromEntries(stored.map((m) => [name[m.author] || m.author, m.member]))))
} catch (e) {
  log('FAILED', e?.stack || e)
} finally {
  for (const n of Object.keys(P)) { await P[n].fr.evaluate(() => T.close?.()).catch(() => {}); await P[n].browser.close().catch(() => {}) }
  mkdirSync(here + 'results', { recursive: true })
  writeFileSync(here + `results/admission-${out.started.replace(/[:.]/g, '-')}.json`, JSON.stringify({ ...out, names: name }, null, 1))
}
