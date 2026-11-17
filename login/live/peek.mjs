// Debug helper: open the sandboxed world as login/test/<KEY>.json (an existing member; no proof unless P is set)
// for SEC seconds and print its status line, WORLD fields, console and errors.
//   KEY=fresh-1 SEC=25 node login/live/peek.mjs
import { chromium } from 'playwright'
import { sandbox } from './local.mjs'
import { readFileSync } from 'node:fs'

const W = new URL('../../', import.meta.url).pathname
const key = JSON.parse(readFileSync(W + `login/test/${process.env.KEY || 'fresh-1'}.json`, 'utf8'))
const seed = key.seed ? Buffer.from(key.seed, 'base64').toString('base64url') : key.k
const src = (await sandbox('ordibots-world-login', 'world.html')) + '#' + new URLSearchParams({ k: seed, r: '12,24', ...(process.env.P && { p: process.env.P }) })
const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
const page = await browser.newPage()
page.on('console', (m) => console.log('[console.' + m.type() + ']', m.text().slice(0, 300)))
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('requestfailed', (q) => console.log('[failed]', q.url().slice(0, 120), q.failure()?.errorText))
await page.goto(`file://${W}net/live/wrap.html#${encodeURIComponent(src)}`)
await new Promise((resolve) => setTimeout(resolve, (+process.env.SEC || 25) * 1000))
const f = page.frames().find((f) => f !== page.mainFrame())
console.log(JSON.stringify(await f.evaluate(() => ({ status: document.querySelector('#s')?.textContent, keys: Object.keys(window.WORLD || {}), links: window.WORLD?.links?.() }))))
await browser.close()
