// Shared by world.mjs and toplevel.mjs: run a LOCAL build inside the ordstudio sandbox without uploading anything.
// Pages still load from the sandbox host (its origin, its CSP headers), but in the browser context:
//   /content/local:world, /content/local:login → <BUILD>/world.html, <BUILD>/login.html (BUILD env, default dist)
//   /r/inscription/<id>, /r/parents/<id>       → answered from chain() (what chain overrides would say)
// Everything else goes to the sandbox as usual. hits counts what was served locally.
import { readFileSync } from 'node:fs'

const W = new URL('../../', import.meta.url).pathname
export const BUILD = W + (process.env.BUILD || 'dist').replace(/\/$/, '') + '/'
const FILES = { world: 'world.html', login: 'login.html' }

/**
 * @param {import('playwright').BrowserContext} ctx
 * @param {() => {holders: Record<string, string>, children: Record<string, boolean>}} chain  read on every request
 */
export async function serveLocal (ctx, chain) {
  const hits = { world: 0, login: 0, r: 0 }
  const json = (o) => ({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' }, body: JSON.stringify(o) })
  await ctx.route((url) => /\.sbx\./.test(url.hostname) && /^\/(content\/local:(world|login)|r\/(inscription|parents)\/)/.test(url.pathname), async (route) => {
    const p = new URL(route.request().url()).pathname
    let m
    if ((m = p.match(/^\/content\/local:(world|login)$/))) {
      hits[m[1]]++
      const resp = await route.fetch() // the sandbox's own headers (CSP), our body
      return route.fulfill({ response: resp, body: readFileSync(BUILD + FILES[m[1]], 'utf8') })
    }
    const { holders, children } = chain()
    hits.r++
    if ((m = p.match(/^\/r\/inscription\/(\w+)$/)) && m[1] in holders) return route.fulfill(json({ id: m[1], address: holders[m[1]] }))
    if ((m = p.match(/^\/r\/parents\/(\w+)$/)) && m[1] in children) {
      const { PARENT } = await import(new URL('../proof.js', import.meta.url))
      return route.fulfill(json({ ids: children[m[1]] ? [PARENT] : [], more: false, page_index: 0 }))
    }
    return route.continue()
  })
  return hits
}

export const sandbox = async (project, target) => {
  // ORDSTUDIO_API: the ordstudio API base that hands out sandbox sessions (e.g. http://127.0.0.1:<port>/ordstudio/api)
  if (!process.env.ORDSTUDIO_API) throw Error('ORDSTUDIO_API=<ordstudio API base> required')
  const r = await fetch(process.env.ORDSTUDIO_API + '/sandbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, mode: 'local', target, probe: false }) })
  return (await r.json()).src
}
