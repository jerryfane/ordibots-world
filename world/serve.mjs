// Local test server: a fake ord server for the world engine and its children, plus a page that runs players side by
// side in sandboxed frames (ord's iframe sandbox + its --csp-origin CSP on every /content/ response).
//   node serve.mjs              http://localhost:8791/two.html  (dev engine, fakeNet relayed by the page)
// Env: PORT (8791), ASSETS (directory of trait models named by inscription id; default ../assets/, not in the repo:
//      fetch them from /content/<asset id> on any ord server, ids in hangar/traits.js).
// Routes:
//   /two.html?bots=1571,375[&real][&invite]   one frame per bot. Default: the dev engine (fakeNet; this page relays
//        its messages between the frames). &real: the real engine, frame i plays test player p(i+1) from ../keys
//        (localhost only; &invite adds the player's single-use invite, needed only on a key's first join).
//        The page's own #hash (#shot, #cam=…) is passed on to every frame; ?h0=…&h1=… add per-frame hash options.
//   /play/p1[?invite][&dev]   one player full-window: redirects to its child with #k=…&i=…&b=… (real engine)
//   /content/<engine id>      dist/world.html; /content/<dev engine id> dist/world-dev.html (re-read per request)
//   /content/<child id>       a world child for a test bot (OB={t,id}, then fetches the engine)
//   /content/<asset id>       a trait model from $ASSETS
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { BOTS, child } from './lib.mjs';

const PORT = +(process.env.PORT ?? 8791);
const here = new URL('.', import.meta.url).pathname;
const ASSETS = (process.env.ASSETS || here + '../assets').replace(/\/?$/, '/'), DIST = here + '../dist/', KEYS = here + '../keys/';
const sha = (s) => createHash('sha256').update(s).digest('hex') + 'i0';
const ENGINE = { real: sha('ordibots-world:engine'), dev: sha('ordibots-world:engine-dev') };
const childId = (kind, id) => sha(`ordibots-world:child:${kind}:${id}`);
const children = new Map();
for (const kind of ['real', 'dev']) for (const b of BOTS.values()) children.set(childId(kind, b.id), [b, kind]);

const csp = (o) => `default-src ${o}/content/ ${o}/r/ 'unsafe-eval' 'unsafe-inline' data: blob:`;
const send = (res, status, body, type, extra = {}) => {
  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', 'cache-control': 'no-store', ...extra });
  res.end(body);
};
const html = (req, res, body) => send(res, 200, body, 'text/html;charset=utf-8', { 'content-security-policy': csp(`http://${req.headers.host}`) });
const b64url = (s) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// test player pN → its bot and identity hash (never leaves localhost: the server listens on localhost only)
const player = (p, invite) => {
  const pl = JSON.parse(readFileSync(KEYS + 'players.json', 'utf8'))[p];
  if (!pl) return null;
  let h = `k=${b64url(pl.seed)}&b=${pl.bot}&r=12,24`; // r: the test group's per-author policy (12/min, burst 24)
  if (invite && existsSync(`${KEYS}invite-${p}.json`)) h += '&i=' + b64url(Buffer.from(readFileSync(`${KEYS}invite-${p}.json`, 'utf8').trim()).toString('base64'));
  return { bot: pl.bot, hash: h };
};

const TWO = (frames) => `<!doctype html><meta charset=utf-8><title>Ordibots World · ${frames.length} players</title>
<style>html,body{margin:0;height:100%;background:#000}body{display:flex;gap:4px}iframe{flex:1;height:100%;border:0}</style>
${frames.map((f) => `<iframe sandbox=allow-scripts data-src="${f}"></iframe>`).join('')}
<script>
// fakeNet relay: whatever one frame posts goes to every other frame. Frames start one after another so their WebGPU
// devices do not all compile at once.
const fr = [...document.querySelectorAll('iframe')];
onmessage = (e) => e.data?.fakenet && fr.forEach((f) => f.contentWindow != e.source && f.contentWindow.postMessage(e.data, '*'));
fr.forEach((f, i) => setTimeout(() => (f.src = f.dataset.src + (location.hash ? '&' + location.hash.slice(1) : '')), i * 400));
</script>`;

createServer((req, res) => {
  const url = new URL(req.url, 'http://x'), q = url.searchParams;
  const p = decodeURIComponent(url.pathname);
  let m;
  if (p === '/') return send(res, 302, '', 'text/plain', { location: '/two.html' });
  if (p === '/favicon.ico') return send(res, 204, '', 'text/plain');
  if (p === '/two.html') {
    const bots = (q.get('bots') || '1571,375').split(',').map(Number).filter((i) => BOTS.has(i)), real = q.has('real');
    const frames = bots.map((id, i) => {
      const pl = real && player('p' + (i + 1), q.has('invite'));
      const b = pl ? BOTS.get(pl.bot) : BOTS.get(id);
      return `/content/${childId(real ? 'real' : 'dev', b.id)}#${pl ? pl.hash : 'b=' + b.id}${q.get('h' + i) ? '&' + q.get('h' + i) : ''}`;
    });
    return send(res, 200, TWO(frames), 'text/html;charset=utf-8');
  }
  if ((m = p.match(/^\/play\/(p\d)$/))) {
    const pl = player(m[1], q.has('invite'));
    if (!pl) return send(res, 404, 'no such player', 'text/plain');
    return send(res, 302, '', 'text/plain', { location: `/content/${childId(q.has('dev') ? 'dev' : 'real', pl.bot)}#${pl.hash}` });
  }
  if ((m = p.match(/^\/content\/(.+)$/))) {
    const id = m[1];
    if (id === ENGINE.real) return html(req, res, readFileSync(DIST + 'world.html'));
    if (id === ENGINE.dev) return html(req, res, readFileSync(DIST + 'world-dev.html'));
    if (children.has(id)) {
      const [b, kind] = children.get(id);
      return html(req, res, child(b, ENGINE[kind]));
    }
    if (/^[0-9a-f]{64}i\d+$/.test(id) && existsSync(ASSETS + id)) {
      const body = readFileSync(ASSETS + id);
      return send(res, 200, body, body.toString('latin1', 0, 4) === 'glTF' ? 'model/gltf-binary' : 'model/gltf+json');
    }
  }
  send(res, 404, 'not found', 'text/plain');
}).listen(PORT, 'localhost', () => console.log(`http://localhost:${PORT}/two.html`));
