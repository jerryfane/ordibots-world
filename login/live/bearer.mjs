// Live test of the Entmoot BEARER (open) invite: a fresh throwaway key joins the Ordibots test group from a sandboxed
// iframe (ordstudio sandbox host, ord's CSP) using keys/invite-open-bearer.json, then publishes, receives and reads
// history. p1 (already a member) is the other side.
//   SRC=<sandbox src of live.html> KEY=<name> node login/live/bearer.mjs
// KEY names a seed file in login/test/ (created on first use, 0600); reusing it costs no further invite use.
import { chromium } from 'playwright'
import { GROUP } from '../../net/live/test-group.mjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const W = new URL('../../', import.meta.url).pathname
const SRC = process.env.SRC
const KEY = process.env.KEY || 'fresh-1'
if (!SRC) throw Error('SRC=<sandbox src of live.html>')
mkdirSync(W + 'login/test', { recursive: true, mode: 0o700 })
const keyFile = W + `login/test/${KEY}.json`
if (!existsSync(keyFile)) {
  // a new key spends a bearer-invite use: only on purpose
  if (process.env.NEW_MEMBER !== '1') throw Error(keyFile + ' is missing: a new key would spend a bearer-invite use. Set NEW_MEMBER=1 only with approval.')
  writeFileSync(keyFile, JSON.stringify({ seed: randomBytes(32).toString('base64'), made: new Date().toISOString(), note: 'throwaway test key' }), { mode: 0o600 })
}
const fresh = JSON.parse(readFileSync(keyFile, 'utf8'))
const players = JSON.parse(readFileSync(W + 'keys/players.json', 'utf8'))
const bearer = JSON.parse(readFileSync(W + 'keys/invite-open-bearer.json', 'utf8'))
const u = (b) => Buffer.from(b).toString('base64url')
const hashOf = (seed, bot, invite) => {
  const q = new URLSearchParams({ k: u(Buffer.from(seed, 'base64')), b: String(bot), r: '12,24', g: GROUP })
  if (invite) q.set('i', u(JSON.stringify(invite)))
  return q.toString()
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const t0 = Date.now()
const log = (name, data) => console.log(JSON.stringify({ step: name, at: new Date().toISOString(), s: (Date.now() - t0) / 1000, ...data }))

const pages = {}
const launch = async (n, hash) => {
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
  const page = await browser.newPage()
  await page.goto(`file://${W}net/live/wrap.html#${encodeURIComponent(SRC + '#' + hash)}`)
  let fr
  for (let i = 0; i < 100 && !fr; i++) { fr = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith('https://')); if (!fr) await sleep(100) }
  pages[n] = { browser, ev: (fn, a) => fr.evaluate(fn, a) }
}
const until = async (n, fn, arg, ms) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await pages[n].ev(fn, arg).catch(() => null)
    if (v) return v
    if (Date.now() > end) return null
    await sleep(250)
  }
}

let ok = false
try {
  await Promise.all([launch('p1', hashOf(players.p1.seed, players.p1.bot)), launch('fresh', hashOf(fresh.seed, 0, bearer))])
  for (const n of ['p1', 'fresh']) {
    const ph = await until(n, () => T.phase !== 'joining' && T.phase, null, 90000)
    log('join ' + n, { phase: ph, joinMs: await pages[n].ev(() => T.joinMs), id: await pages[n].ev(() => T.net?.me.id), errors: await pages[n].ev(() => T.errors) })
    if (ph !== 'joined') throw Error(n + ' did not join')
  }
  const ids = { p1: await pages.p1.ev(() => T.net.me.id), fresh: await pages.fresh.ev(() => T.net.me.id) }
  // history: the stored world messages the fresh member could read while joining, and a direct history call
  log('history fresh', await pages.fresh.ev(async () => ({ historyChats: T.chats.filter((c) => c.history).length, worldMsgs: (await T.net.entmoot.history('world/#', 64)).length })))
  const tag = Date.now().toString(36)
  log('chat fresh', await pages.fresh.ev((t) => T.chat('bearer-invite test from a fresh key ' + t), tag))
  const got1 = await until('p1', ([id, t]) => T.chats.find((c) => c.from === id && c.text.endsWith(t)), [ids.fresh, tag], 30000)
  log('p1 received', { ok: !!got1 })
  log('chat p1', await pages.p1.ev((t) => T.chat('reply to the fresh key ' + t), tag))
  const got2 = await until('fresh', ([id, t]) => T.chats.find((c) => c.from === id && c.text.endsWith(t)), [ids.p1, tag], 30000)
  log('fresh received', { ok: !!got2 })
  const seen = await until('fresh', (id) => T.net.peers.has(id), ids.p1, 30000)
  log('presence', { freshSeesP1: !!seen, p1SeesFresh: !!(await pages.p1.ev((id) => T.net.peers.has(id), ids.fresh)) })
  ok = !!(got1 && got2)
} catch (e) {
  log('error', { message: e.message })
} finally {
  for (const n of Object.keys(pages)) { await pages[n].ev(() => T.close?.()).catch(() => {}); await pages[n].browser.close() }
  log('done', { ok })
  process.exit(ok ? 0 : 1)
}
