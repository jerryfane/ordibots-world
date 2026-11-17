// Dump the group's stored world/# messages (as the node serves them) through one member key, in the sandbox.
//   SRC=<sandbox src of live.html> PLAYER=p1 FROM=<ISO time> TO=<ISO time> node live/history.mjs
import { chromium } from 'playwright'
import { GROUP } from './test-group.mjs'
import { readFileSync } from 'node:fs'

const here = new URL('.', import.meta.url).pathname
const players = JSON.parse(readFileSync(new URL('../../keys/players.json', import.meta.url), 'utf8'))
const who = Object.fromEntries(Object.entries(players).map(([k, p]) => [p.pub, k]))
const me = players[process.env.PLAYER || 'p1']
const from = Date.parse(process.env.FROM || 0); const to = Date.parse(process.env.TO || '2100-01-01')
const q = new URLSearchParams({ k: Buffer.from(me.seed, 'base64').toString('base64url'), b: String(me.bot), r: '12,24', g: GROUP })
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.goto(`file://${here}wrap.html#${encodeURIComponent(process.env.SRC + '#' + q)}`)
  let fr
  for (let i = 0; i < 100 && !fr; i++) { fr = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith('https://')); if (!fr) await new Promise((resolve) => setTimeout(resolve, 100)) }
  await fr.waitForFunction(() => window.T?.phase && T.phase !== 'joining', null, { timeout: 60000 })
  const rows = await fr.evaluate(async () => {
    const ids = []
    const h = await T.net.entmoot.history('world/#', 1000)
    for (const m of h) {
      let o = {}; try { o = JSON.parse(m.text) } catch { o = { text: m.text } }
      ids.push({ ts: m.timestamp, rh: m.roster_head?.slice(0, 8), keys: Object.keys(o).sort().join(','), clear: /candidate|sdp|\d+\.\d+\.\d+\.\d+/.test(m.text), a: m.author.entmoot_pubkey, topic: m.topics[0], s: o.s, to: o.to, type: o.type, sid: o.sid, text: o.text?.slice(0, 40), id: m.id.slice(0, 8) })
    }
    await T.net.close()
    return ids
  })
  for (const r of rows) {
    if (r.ts < from || r.ts > to) continue
    console.log(new Date(r.ts).toISOString().slice(11, 23), (who[r.a] || r.a.slice(0, 8)).padEnd(4), r.topic.padEnd(22).slice(0, 22), r.s || '', r.type || '', r.to ? 'to=' + r.to : '', r.sid ? 'sid=' + r.sid : '', 'head=' + r.rh, r.topic.startsWith('world/signal/') ? `keys=${r.keys} ${r.clear ? 'CLEAR-TEXT' : 'sealed'}` : '', r.text ? JSON.stringify(r.text) : '', r.id)
  }
  console.log('total stored world/# messages:', rows.length)
} finally { await browser.close() }
