// login.html opened TOP-LEVEL (as on ordinals.com/content/<id>: a real origin with storage, ord's CSP). Nothing is
// uploaded: the build under test (BUILD, default dist) and the chain answers come from local.mjs. Cases:
//   late-provider: the mock Xverse provider appears 1 s after the page starts, as the real one does (its content
//     script injects inpage.js asynchronously). Logs in twice in one browser profile: the second time the per-device
//     key and the proof come from IndexedDB (no signMessage); the world reads and clears the hash.
//   no-provider: no provider ever: the page keeps looking (no verdict at 1.5 s), then says "No Xverse found".
//   framed: the page inside <iframe sandbox="allow-scripts">, no provider: it says it needs a top-level page.
// The worlds this opens can't join the group (no RTCPeerConnection), so no bearer-invite use.
//   node login/live/toplevel.mjs                                   current build (dist)
//   BUILD=<older dist dir> node login/live/toplevel.mjs            an older build
import { chromium } from 'playwright'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { serveLocal, sandbox, BUILD } from './local.mjs'
const require = createRequire(new URL('../package.json', import.meta.url))
const { Signer } = require('bip322-js')
const { secp256k1, schnorr } = await import(new URL('../node_modules/@noble/curves/secp256k1.js', import.meta.url))
const { bech32m } = await import(new URL('../node_modules/@scure/base/index.js', import.meta.url))

const PROJECT = 'ordibots-world-login'
const BOT = '26b0d110a22b5ec1f7543288648a278be0f953767180249481ab2377957cce6fi726'
const PROVIDER_LATE_MS = 1000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (step, data) => console.log(JSON.stringify({ step, ...data }))
const h = (...b) => createHash('sha256').update(Buffer.concat(b)).digest()
const k = randomBytes(32)
const P = schnorr.getPublicKey(k); const tt = h(Buffer.from('TapTweak'))
const ADDR = bech32m.encode('bc', [1, ...bech32m.toWords(secp256k1.Point.fromHex('02' + Buffer.from(P).toString('hex')).add(secp256k1.Point.BASE.multiply(BigInt('0x' + h(tt, tt, P).toString('hex')))).toBytes(true).subarray(1))])
const wif = (() => {
  const b = Buffer.concat([Buffer.from([0x80]), k, Buffer.from([1])]); const c = h(h(b)).subarray(0, 4)
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let n = BigInt('0x' + Buffer.concat([b, c]).toString('hex')); let s = ''
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n }
  return s
})()
const chain = { holders: { [BOT]: ADDR }, children: { [BOT]: true } }

const browser = await chromium.launch()
const cases = {}
const run = async (name, fn) => {
  try {
    const r = await fn()
    cases[name] = r
  } catch (e) {
    cases[name] = { ok: false, error: e.message.split('\n')[0] }
  }
  log(name, cases[name])
}
// one context per case; the world a login opens must not join the group (it would be a new member)
const context = async () => {
  const ctx = await browser.newContext()
  const hits = await serveLocal(ctx, () => chain)
  await ctx.addInitScript(() => { if (/local:world/.test(location.pathname)) delete window.RTCPeerConnection })
  return { ctx, hits }
}
log('build', { BUILD })
// the same sandbox origin for all cases (one session): the IndexedDB is the origin's, as ordinals.com's would be
const url = await sandbox(PROJECT, 'login.html')

try {
  await run('late-provider', async () => {
    const { ctx, hits } = await context()
    const calls = []
    await ctx.exposeBinding('__wallet', async (_, method, params) => {
      calls.push(method)
      if (method === 'wallet_connect') return { result: { addresses: [{ address: ADDR, purpose: 'ordinals' }] } }
      if (method === 'ord_getInscriptions') return { result: { total: 1, inscriptions: [{ inscriptionId: BOT, address: ADDR, contentType: 'text/html;charset=utf-8', contentLength: '172' }] } }
      if (method === 'signMessage') return { result: { signature: Signer.sign(wif, ADDR, params.message), address: ADDR, protocol: 'BIP322' } }
      return { error: { code: -32601, message: 'method not found' } }
    })
    // the provider shows up late, top-level only, like Xverse's
    await ctx.addInitScript((ms) => {
      if (window === window.top) setTimeout(() => { window.XverseProviders = { BitcoinProvider: { request: (m, p) => window.__wallet(m, p).then((r) => ({ jsonrpc: '2.0', id: 1, ...r })) } } }, ms)
    }, PROVIDER_LATE_MS)
    const login = async (n) => {
      const page = await ctx.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(url)
      try {
        await page.click('#go', { timeout: 10000 })
      } catch {
        throw Error(`login ${n}: no Connect button 10 s after load; status: "${await page.textContent('#s')}"`)
      }
      await page.waitForSelector('#b button', { timeout: 20000 })
      const from = calls.length
      let worldUrl = null
      page.on('framenavigated', (f) => { if (f === page.mainFrame() && /local:world#/.test(f.url())) worldUrl = f.url() })
      await page.click('#b button')
      for (let i = 0; i < 200 && !worldUrl; i++) await sleep(100)
      if (!worldUrl) throw Error('login ' + n + ' did not open the world: ' + (await page.textContent('#s').catch((e) => e.message)))
      const hp = new URLSearchParams(new URL(worldUrl).hash.slice(1))
      const r = { k: hp.get('k'), p: JSON.parse(Buffer.from(hp.get('p'), 'base64url')), walletCalls: calls.slice(from), errors }
      await sleep(1500) // the world reads and clears the hash
      r.hashAfter = new URL(page.url()).hash
      await page.close()
      return r
    }
    const a = await login(1); const b = await login(2)
    const reuse = a.k === b.k && a.p.sig === b.p.sig && !b.walletCalls.includes('signMessage') && a.walletCalls.includes('signMessage')
    return { ok: reuse && a.hashAfter === '' && !a.errors.length && !b.errors.length, reusedKeyAndProof: reuse, walletCallsAfterPick: [a.walletCalls, b.walletCalls], hashCleared: a.hashAfter === '', errors: [...a.errors, ...b.errors], servedLocally: hits }
  })

  await run('no-provider', async () => {
    const { ctx, hits } = await context()
    const page = await ctx.newPage()
    const t = Date.now()
    await page.goto(url)
    await sleep(1500 - (Date.now() - t))
    const at1500 = await page.textContent('#s')
    await page.waitForFunction(() => /No Xverse found/.test(document.querySelector('#s').textContent), null, { timeout: 8000 }).catch(() => {})
    const final = await page.textContent('#s')
    const afterMs = Date.now() - t
    // still looking at 1.5 s (the wait is 4 s), the verdict after the wait
    return { ok: !/No Xverse found/.test(at1500) && /No Xverse found/.test(final) && afterMs >= 3500, at1500, final, verdictAfterMs: afterMs, servedLocally: hits }
  })

  await run('framed', async () => {
    const { ctx, hits } = await context()
    const page = await ctx.newPage()
    await page.setContent(`<iframe sandbox="allow-scripts" src="${url}" style="width:600px;height:300px"></iframe>`)
    let f
    for (let i = 0; i < 50 && !f; i++) { f = page.frames().find((x) => x !== page.mainFrame() && x.url().startsWith('https://')); if (!f) await sleep(100) }
    await f.waitForFunction(() => /inside a frame/.test(document.querySelector('#s')?.textContent), null, { timeout: 8000 }).catch(() => {})
    const final = await f.textContent('#s')
    return { ok: /inside a frame/.test(final), final, servedLocally: hits }
  })
} finally {
  await browser.close()
  const ok = Object.values(cases).length === 3 && Object.values(cases).every((c) => c.ok)
  log('done', { ok, cases: Object.fromEntries(Object.entries(cases).map(([n, c]) => [n, c.ok])) })
  process.exit(ok ? 0 : 1)
}
