// World login test in the ordstudio sandbox (project ordibots-world-login, local mode = ord's iframe sandbox + CSP),
// against the live Entmoot node. Nothing is uploaded: the build under test (BUILD, default dist) and the chain answers
// for /r/inscription and /r/parents are served in the browser (local.mjs). The wallets are throwaway taproot keys made
// here (never funded, never on chain). No bearer-invite use: A and B are existing members (login-a, fresh-1).
//   A: enters the world with login/test/login-a.json and a fresh proof; holder of Ordibot #1571.
//   B: opens the world with login/test/fresh-1.json and a proof for Ordibot #375: phase 1 the bot is held by another
//      address, phase 2 a tampered signature, phase 3 a good proof once the chain says B holds it (a new page each).
// Chat is typed for real (click #c, keyboard, Enter) by both players every phase: B's line must reach A's log only
// when B is verified, A's line must always reach B's log, and each sender's own log must show its line.
// Every phase prints what A and B see. Screenshots go to login/live/shots/.
//   node login/live/world.mjs                                   current build (dist)
//   BUILD=<older dist dir> node login/live/world.mjs            an older build
import { chromium } from 'playwright'
import { GROUP } from '../../net/live/test-group.mjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { serveLocal, sandbox as sbx, BUILD } from './local.mjs'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire(new URL('../package.json', import.meta.url))
const { Signer } = require('bip322-js')
const { secp256k1, schnorr } = await import(new URL('../node_modules/@noble/curves/secp256k1.js', import.meta.url))
const { bech32m } = await import(new URL('../node_modules/@scure/base/index.js', import.meta.url))
const { statement, PARENT } = await import(new URL('../proof.js', import.meta.url))

const W = new URL('../../', import.meta.url).pathname
const L = W + 'login/'
const PROJECT = 'ordibots-world-login'
// GROUP: the group the build under test (BUILD) talks to, from ../../net/live/test-group.mjs
const BOT_A = '26b0d110a22b5ec1f7543288648a278be0f953767180249481ab2377957cce6fi726' // Ordibot #1571
const BOT_B = 'aab64b2ae34a78ef56a8d704f15aeb67272b8f97cfe8889eb15a45785ea2cc0bi375' // Ordibot #375
const NOT_BOT = 'ab'.repeat(32) + 'i0'
mkdirSync(L + 'live/shots', { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const t0 = Date.now()
const log = (step, data) => console.log(JSON.stringify({ step, s: +((Date.now() - t0) / 1000).toFixed(1), ...data }))

// ── throwaway wallets (BIP-86 key path taproot)
const h = (...b) => createHash('sha256').update(Buffer.concat(b)).digest()
const wif = (k) => {
  const b = Buffer.concat([Buffer.from([0x80]), k, Buffer.from([1])]); const c = h(h(b)).subarray(0, 4)
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let n = BigInt('0x' + Buffer.concat([b, c]).toString('hex')); let s = ''
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n }
  return s
}
const taproot = (k) => {
  const P = schnorr.getPublicKey(k); const t = h(Buffer.from('TapTweak'))
  const Q = secp256k1.Point.fromHex('02' + Buffer.from(P).toString('hex')).add(secp256k1.Point.BASE.multiply(BigInt('0x' + h(t, t, P).toString('hex'))))
  return bech32m.encode('bc', [1, ...bech32m.toWords(Q.toBytes(true).subarray(1))])
}
const wallet = () => { const k = randomBytes(32); return { k, addr: taproot(k), sign: (m) => Signer.sign(wif(k), taproot(k), m) } }
const A = wallet(); const B = wallet(); const X = wallet()

// ── the chain as the overrides would answer it (read on every request), sandbox sessions
const chain = { holders: {}, children: { [BOT_A]: true, [BOT_B]: true, [NOT_BOT]: false } }
const holderB = (addr) => Object.assign(chain.holders, { [BOT_A]: A.addr, [BOT_B]: addr, [NOT_BOT]: A.addr })
const sandbox = (target) => sbx(PROJECT, target)
const u = (b) => Buffer.from(b).toString('base64url')

// ── players: each its own browser process, its page in <iframe sandbox="allow-scripts"> (net/live/wrap.html)
const open = async (name, src, init) => {
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 640 } })
  const hits = await serveLocal(ctx, () => chain)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)))
  if (init) await init(page)
  await page.goto(`file://${W}net/live/wrap.html#${encodeURIComponent(src)}`)
  const frame = async () => {
    for (let i = 0; i < 100; i++) { const f = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith('https://')); if (f) return f; await sleep(100) }
    throw Error(name + ': no frame')
  }
  return { name, browser, page, errors, frame, hits, ev: async (fn, a) => (await frame()).evaluate(fn, a) }
}
const until = async (p, fn, arg, ms = 30000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await p.ev(fn, arg).catch(() => null)
    if (v) return v
    if (Date.now() > end) return null
    await sleep(300)
  }
}
const view = (p) => p.ev(() => window.WORLD?.links && { me: WORLD.self(), links: WORLD.links(), others: WORLD.others(), log: document.querySelector('#l').innerText, toggle: document.querySelector('#g').hidden ? null : document.querySelector('#g').textContent })

// ── A: login.html with a mock Xverse (the page talks JSON-RPC to it exactly as to the real provider)
const loginA = async () => {
  const keyFile = L + 'test/login-a.json'
  if (existsSync(keyFile)) {
    // an earlier run already logged A in: the same world key (already a group member), a fresh proof
    const saved = JSON.parse(readFileSync(keyFile, 'utf8'))
    const iat = Math.floor(Date.now() / 1000); const exp = iat + 7 * 86400
    const proof = { bot: BOT_A, addr: A.addr, iat, exp, sig: A.sign(statement({ group: GROUP, member: saved.pub, bot: BOT_A, addr: A.addr, iat, exp })) }
    log('A: reusing world key from ' + keyFile, { member: saved.pub })
    return open('A', (await sandbox('world.html')) + '#' + new URLSearchParams({ k: saved.k, p: u(JSON.stringify(proof)), r: '12,24' }))
  }
  // a new device key joins the group and spends a bearer-invite use: only on purpose
  if (process.env.NEW_MEMBER !== '1') throw Error(keyFile + ' is missing: a login through login.html would make a new group member (a bearer-invite use). Set NEW_MEMBER=1 only with approval.')
  const calls = []
  const p = await open('A', await sandbox('login.html'), async (page) => {
    await page.exposeBinding('__wallet', async (_, method, params) => {
      calls.push(method)
      if (method === 'wallet_connect') return { result: { id: 'x', addresses: [{ address: 'bc1qpayment', purpose: 'payment' }, { address: A.addr, purpose: 'ordinals', addressType: 'p2tr' }] } }
      if (method === 'ord_getInscriptions') {
        const i = (inscriptionId, contentType, contentLength) => ({ inscriptionId, address: A.addr, contentType, contentLength: String(contentLength) })
        return { result: { total: 4, offset: 0, limit: 60, inscriptions: [i(NOT_BOT, 'text/html;charset=utf-8', 170), i('cd'.repeat(32) + 'i0', 'image/png', 9000), i(BOT_B, 'text/html;charset=utf-8', 161), i(BOT_A, 'text/html;charset=utf-8', 172)] } }
      }
      if (method === 'signMessage') {
        if (params.address !== A.addr || params.protocol !== 'BIP322') return { error: { code: -32602, message: 'bad params' } }
        log('A: wallet asked to sign', { message: params.message })
        return { result: { signature: A.sign(params.message), address: A.addr, protocol: 'BIP322', messageHash: '' } }
      }
      return { error: { code: -32601, message: 'method not found' } }
    })
    // what Xverse's inpage.js provides, in every frame (the real one only reaches top-level pages)
    // what Xverse's inpage.js provides, in every frame (the real one only reaches top-level pages); late, as Xverse is
    await page.addInitScript(() => setTimeout(() => { window.XverseProviders = { BitcoinProvider: { request: (m, p) => window.__wallet(m, p).then((r) => ({ jsonrpc: '2.0', id: 1, ...r })) } } }, 1000))
  })
  let worldUrl = null
  p.page.on('framenavigated', (f) => { if (/local:world#/.test(f.url())) worldUrl = f.url() })
  await until(p, () => !document.querySelector('#go').hidden)
  await p.ev(() => document.querySelector('#go').click())
  const listed = await until(p, () => document.querySelector('#b').children.length && /Pick/.test(document.querySelector('#s').textContent) && [...document.querySelectorAll('#b button')].map((b) => b.textContent))
  log('A: login page listed', { bots: listed, status: await p.ev(() => document.querySelector('#s').textContent), wallet: calls })
  await p.page.screenshot({ path: L + 'live/shots/login-list.png' })
  await p.ev(() => document.querySelector('#b button').click())
  for (let i = 0; i < 100 && !worldUrl; i++) await sleep(100)
  if (!worldUrl) throw Error('A: login did not open the world: ' + (await p.ev(() => document.querySelector('#s').textContent).catch((e) => e.message)))
  const hp = new URLSearchParams(new URL(worldUrl).hash.slice(1))
  const proof = JSON.parse(Buffer.from(hp.get('p'), 'base64url'))
  const seed = Buffer.from(hp.get('k'), 'base64url')
  const pub = Buffer.from((await crypto.subtle.exportKey('jwk', await crypto.subtle.importKey('pkcs8', Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), 'Ed25519', true, ['sign']))).x, 'base64url').toString('base64')
  writeFileSync(keyFile, JSON.stringify({ k: hp.get('k'), pub, made: new Date().toISOString(), note: 'throwaway world key made by login.html in the sandbox' }), { mode: 0o600 })
  log('A: login opened the world', { url: worldUrl.replace(/#.*/, '#k=<seed>&p=…'), proof: { ...proof, sig: proof.sig.slice(0, 12) + '…' }, member: pub, wallet: calls })
  return p
}

const pubOf = async (seedB64) => Buffer.from((await crypto.subtle.exportKey('jwk', await crypto.subtle.importKey('pkcs8', Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedB64, 'base64')]), 'Ed25519', true, ['sign']))).x, 'base64url').toString('base64')
const openB = async (phase, tamper) => {
  const iat = Math.floor(Date.now() / 1000); const exp = iat + 7 * 86400
  const fresh = JSON.parse(readFileSync(L + 'test/fresh-1.json', 'utf8'))
  const member = await pubOf(fresh.seed)
  let sig = B.sign(statement({ group: GROUP, member, bot: BOT_B, addr: B.addr, iat, exp }))
  if (tamper) { const b = Buffer.from(sig, 'base64'); b[10] ^= 1; sig = b.toString('base64') }
  const proof = { bot: BOT_B, addr: B.addr, sig, iat, exp }
  const src = (await sandbox('world.html')) + '#' + new URLSearchParams({ k: u(Buffer.from(fresh.seed, 'base64')), p: u(JSON.stringify(proof)), r: '12,24' })
  const p = await open('B', src)
  return { p, member }
}

let pa, pb
const results = {}
try {
  holderB(X.addr) // phase 1: bot #375 is held by someone else (X), not by B
  log('build', { BUILD })
  log('wallets', { A: A.addr, B: B.addr, X: X.addr })
  pa = await loginA()
  const aJoined = await until(pa, () => window.WORLD?.self && /online/.test(WORLD.self().status) && WORLD.self(), null, 60000)
  log('A: in the world', aJoined)

  const phase = async (name, tamper, expectB) => {
    const { p, member } = await openB(name, tamper)
    pb = p
    const bJoined = await until(pb, () => window.WORLD?.self && /online/.test(WORLD.self().status) && WORLD.self(), null, 60000)
    log(name + ' B: in the world', bJoined)
    // both checked each other (hello at join; the later joiner's hello reaches the earlier one live)
    const aSeesB = await until(pa, (bot) => WORLD.links().find((l) => l.bot === bot && l.verified !== undefined) && WORLD.links(), 375, 45000)
    const bSeesA = await until(pb, () => WORLD.links().find((l) => l.verified === true) && WORLD.links(), null, 45000)
    await sleep(1500)
    // real typing: click the chat box, type, Enter (the way a player does it)
    const typeChat = async (p, text) => {
      await (await p.frame()).click('#c')
      await p.page.keyboard.type(text, { delay: 10 })
      await p.page.keyboard.press('Enter')
    }
    const inLog = (p, text, ms) => until(p, (t) => document.querySelector('#l').innerText.includes(t), text, ms)
    const tagB = 'typed by B ' + Date.now().toString(36); const tagA = 'typed by A ' + Date.now().toString(36)
    await typeChat(pb, tagB)
    const bSent = !!(await inLog(pb, tagB, 8000)) // B's own log shows it once net.chat() resolved
    await typeChat(pa, tagA)
    const aSent = !!(await inLog(pa, tagA, 8000))
    const bGotA = !!(await inLog(pb, tagA, 10000))
    const aGotB = !!(await inLog(pa, tagB, expectB ? 10000 : 3000))
    const chat = { bSent, aSent, bGotA, aGotB, chatBox: { A: await pa.ev(() => document.querySelector('#c').value), B: await pb.ev(() => document.querySelector('#c').value) } }
    const chatOk = bSent && aSent && bGotA && aGotB === expectB
    const va = await view(pa); const vb = await view(pb)
    log(name + ': A sees', va)
    log(name + ': B sees', vb)
    await pa.page.screenshot({ path: L + `live/shots/${name}-A.png` })
    const shownToA = va.others.length === 1
    const seenOk = expectB ? shownToA && va.links.some((l) => l.verified === true && l.bot === 375) : !shownToA && va.links.some((l) => l.verified === false)
    results[name] = { ok: seenOk && chatOk, seenOk, chatOk, chat, aSeesB: !!aSeesB, bSeesA: !!bSeesA, bVerifiedByA: va.links.map((l) => l.verified), why: va.links.map((l) => l.why), aShown: va.others.length, bShowsA: vb.others.map((o) => o.bot), bStatus: vb.me.status, servedLocally: { A: { ...pa.hits }, B: { ...pb.hits } } }
    if (!expectB) {
      // the toggle shows B as a grey ghost named "unverified"
      await pa.ev(() => WORLD.toggle())
      await sleep(800)
      const g = await view(pa)
      await pa.page.screenshot({ path: L + `live/shots/${name}-A-ghosts.png` })
      results[name].ghosts = { shown: g.others.length, toggle: g.toggle, tag: await pa.ev(() => [...document.querySelectorAll('.n b.g')].map((b) => b.textContent)) }
      await pa.ev(() => WORLD.toggle())
    }
    await pb.page.screenshot({ path: L + `live/shots/${name}-B.png` })
    await pb.browser.close(); pb = null
    log(name + ' result', results[name])
  }
  await phase('phase1-held-by-another', false, false)
  await sleep(2000)
  await phase('phase2-tampered-signature', true, false)
  holderB(B.addr) // phase 3: the chain now says B holds #375
  await sleep(1000)
  await phase('phase3-valid', false, true)
  log('A errors', { errors: pa.errors.slice(0, 10) })
} catch (e) {
  log('error', { message: e.stack })
} finally {
  if (pb) await pb.browser.close()
  if (pa) await pa.browser.close()
  log('served locally', { BUILD })
  const ok = Object.keys(results).length === 3 && Object.values(results).every((r) => r.ok)
  log('done', { ok, results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.ok])) })
  process.exit(ok ? 0 : 1)
}
