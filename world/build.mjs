// Bundles the engine into single self-contained HTML files, writes the test bots' children and the ordstudio
// manifest, and prints sizes.
//   node build.mjs              ../dist/world.html (real net.js from ../net), ../dist/world-dev.html (fakeNet),
//                               ../dist/bot-NNNN.html (children of the engine, alias "world"), ../dist/ordstudio.json
//   node build.mjs --readable   unminified, for debugging
// Build config: which Entmoot group the world and the login page talk to, the node address, the bearer invite the
// engine embeds, and where the files go. One source, several builds:
//   BUILD=test   (default) config/test.json:   the private test group → ../dist/
//   BUILD=public            config/public.json: the public "Ordibots World" group → ../dist-public/
//   CONFIG=<file>           any other config file. Paths in a config are relative to that file.
// Config: {group: base64 group id, addr?: node multiaddr (default: the invite's first allowed address),
//          invite?: bearer invite file (its group_id must be `group`; none if missing), dist: output directory}
// No player keys are ever built in: players get theirs from login.html.
// Env: ENGINE=<inscription id> points the children at an inscribed engine instead of ordstudio's local:world.
//      INVITE=<file> overrides the config's invite. ESBUILD=<path> overrides the esbuild module (default: world/node_modules).
// The bot code (math, glTF reader, trait table) is the Ordibots WebGPU hangar's, vendored in ./hangar/.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { BOTS, TEST_BOTS, child } from './lib.mjs';

const require = createRequire(import.meta.url);
const esbuild = require(process.env.ESBUILD || 'esbuild');

const here = new URL('.', import.meta.url).pathname;
const HANGAR = here + 'hangar/';
const NET = here + '../net/net.js';
const PROOF = here + '../login/proof.js';
const readable = process.argv.includes('--readable');
const src = (f) => readFileSync(f, 'utf8');
const CONFIG = process.env.CONFIG || here + 'config/' + (process.env.BUILD || 'test') + '.json';
const cfg = JSON.parse(src(CONFIG));
const rel = (p) => new URL(p, 'file://' + CONFIG).pathname;
const INVITE = process.env.INVITE || (cfg.invite && rel(cfg.invite));
const DIST = rel(cfg.dist.endsWith('/') ? cfg.dist : cfg.dist + '/');
const inviteJson = INVITE && existsSync(INVITE) ? JSON.parse(src(INVITE)) : null;
if (!/^[A-Za-z0-9+/]{43}=$/.test(cfg.group || '')) throw new Error(CONFIG + ': group must be a base64 group id');
if (inviteJson && inviteJson.group_id !== cfg.group) throw new Error(`${INVITE} is for group ${inviteJson.group_id}, not ${cfg.group}`);
const ADDR = cfg.addr || inviteJson?.allowed_multiaddrs?.[0];
if (!/^\/ip4\/.+\/webrtc-direct\/certhash\/.+\/p2p\/\w+$/.test(ADDR || '')) throw new Error(CONFIG + ': no node address (addr, or an invite with allowed_multiaddrs)');
console.log(`config ${CONFIG}: group ${cfg.group}, invite ${inviteJson ? INVITE : 'none'}, out ${DIST}`);
const WORLD = [HANGAR + 'traits.js', HANGAR + 'math.js', HANGAR + 'gltf.js', here + 'src/shaders.js', here + 'src/render.js', here + 'src/view2d.js'];

// WGSL inside /* wgsl */ `…` literals: drop comments and every space the grammar does not need
const wgsl = (s) => s.replace(/\/\*\s*wgsl\s*\*\/\s*`([^`]*)`/g, (_, code) => '`' + code
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\s+/g, ' ')
  .replace(/\s*([{}()[\],;:=<>+\-*/&|!?.@%^~])\s*/g, '$1')
  .trim() + '`');

const CSS = `html,body{margin:0;height:100%;overflow:hidden;background:#021a26;font:13px/1.35 system-ui,sans-serif;color:#fff}canvas{position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab}#o{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:2}.n{position:absolute;transform:translate(-50%,-100%);display:flex;flex-direction:column;align-items:center;gap:5px}.n b{padding:1px 8px;border-radius:9px;background:#0009;font-weight:600;white-space:nowrap}.n b.me{background:#0a6b78d0}.n i{font-style:normal;max-width:220px;padding:5px 10px;border-radius:11px;background:#fff;color:#123;overflow-wrap:anywhere;position:relative;box-shadow:0 2px 8px #0006}.n i:after{content:'';position:absolute;left:50%;bottom:-6px;margin-left:-6px;border:6px solid transparent;border-bottom:0;border-top-color:#fff}#s{position:fixed;left:10px;top:8px;z-index:2;opacity:.8;text-shadow:0 1px 2px #000}#l{position:fixed;left:10px;bottom:48px;z-index:2;max-width:min(440px,75%);text-shadow:0 1px 2px #000;pointer-events:none}#l b{color:#8ef}#f{position:fixed;left:10px;bottom:10px;z-index:2;display:flex;gap:8px;align-items:center;width:min(440px,calc(100% - 20px))}#c{flex:1;font:inherit;color:#fff;background:#0008;border:1px solid #fff3;border-radius:8px;padding:6px 9px;outline:0}#c:focus{border-color:#8efc}#c.x{opacity:.55}#w{color:#fd9;white-space:nowrap;text-shadow:0 1px 2px #000}`;
const BODY = `<canvas></canvas><div id=o></div><div id=s></div><button id=g hidden></button><div id=l></div><div id=f><input id=c maxlength=280 placeholder="Enter to chat" autocomplete=off><span id=w></span></div>`;
// the "show unverified" toggle and the ghosts' name tags
const CSS_LOGIN = `#g{position:fixed;right:10px;top:6px;z-index:3;font:inherit;color:#fff;background:#0008;border:1px solid #fff3;border-radius:8px;padding:3px 9px;cursor:pointer}.n b.g{background:#5558;color:#ddd;font-weight:400;font-style:italic}`;

// net.js (ES module, imports entmoot-lite) → one IIFE that leaves `NET` in the wrapper's scope; proof.js → `PROOF`
const iife = (f, globalName) => esbuild.buildSync({ entryPoints: [f], bundle: true, format: 'iife', globalName, write: false, target: 'es2022' }).outputFiles[0].text;
const netIife = () => iife(NET, 'NET');
// the bearer invite in the engine (login/INVITE.md): only the fields the join needs
const invite = inviteJson ? JSON.stringify(inviteJson) : 'null';
const shared = () => iife(PROOF, 'PROOF') + `\nconst INVITE = ${invite};\nconst GROUP = ${JSON.stringify(cfg.group)};\nconst ADDR = ${JSON.stringify(ADDR)};`;

const sizes = (name, html) => {
  const raw = Buffer.byteLength(html), gz = gzipSync(html, { level: 9 }).length;
  const br = brotliCompressSync(html, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw } }).length;
  console.log(`${name}${readable ? ' (readable)' : ''}: ${raw} B raw, ${gz} B gzip, ${br} B brotli (target <= 40960 B brotli)`);
  return br;
};
mkdirSync(DIST, { recursive: true });
let over = 0;
for (const [name, net] of [['world.html', existsSync(NET) && netIife() + '\nconst makeNet = NET.createNet;'], ['world-dev.html', src(here + 'src/fakenet.js')]]) {
  if (!net) {
    console.log(`${name}: skipped (no ${NET})`);
    continue;
  }
  let js = '(()=>{' + [net, shared(), ...WORLD.map(src), src(here + 'src/world.js')].join('\n') + '\n})()';
  if (!readable) js = esbuild.transformSync(wgsl(js), { minify: true, target: 'es2022', legalComments: 'none' }).code.trim();
  if (/<\/script/i.test(js)) throw new Error('bundle contains </script');
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Ordibots World</title><style>${CSS}${CSS_LOGIN}</style>${BODY}<script>${js}</script>`;
  writeFileSync(DIST + name, html);
  if (sizes(name, html) > 40960) over = 1;
}
// the login page (../login/login.js + proof.js): opens the engine itself (ENGINE, or ordstudio's local:world)
{
  const define = { __WORLD__: JSON.stringify(process.env.ENGINE || 'local:world'), __GROUP__: JSON.stringify(cfg.group) };
  let js = esbuild.buildSync({ entryPoints: [here + '../login/login.js'], bundle: true, format: 'iife', write: false, target: 'es2022', define, minify: !readable, legalComments: 'none' }).outputFiles[0].text.trim();
  if (/<\/script/i.test(js)) throw new Error('login bundle contains </script');
  const css = `body{margin:0;min-height:100vh;background:#021a26;color:#fff;font:15px/1.45 system-ui,sans-serif;display:flex;align-items:center;justify-content:center}main{max-width:520px;padding:24px}h1{font-size:22px;margin:0 0 12px}button{font:inherit;color:#fff;background:#0a6b78;border:0;border-radius:9px;padding:8px 16px;margin:4px 6px 4px 0;cursor:pointer}button:disabled{opacity:.5}#s{margin:14px 0;min-height:1.4em}#s.x{color:#fd9}#a{font:12px monospace;opacity:.7;word-break:break-all}input{font:13px monospace;width:100%;box-sizing:border-box;color:#fff;background:#0008;border:1px solid #fff3;border-radius:8px;padding:7px 9px}small{opacity:.6}`;
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Ordibots World · log in</title><style>${css}</style><main><h1>Ordibots World</h1><p>Enter the reef as the Ordibot you hold. Your wallet signs one message (no transaction, no fee); every player checks it against this ord server.</p><button id=go hidden>Connect Xverse</button><div id=s></div><div id=a></div><div id=b></div><p id=m hidden><input id=i placeholder="or paste your Ordibot's inscription id, then Enter"></p><small>Nothing leaves your browser except to this ord server, the wallet and the world's Entmoot group.</small></main><script>${js}</script>`;
  writeFileSync(DIST + 'login.html', html);
  sizes('login.html', html);
}
// the test players' children and the ordstudio manifest: the engine is the parent (alias "world"), one child per bot
const files = { 'world.html': { id: null, role: 'parent', as: 'world', compress: 'br' } }; // ord --compress: brotli on chain
for (const id of TEST_BOTS) {
  const name = `bot-${String(id).padStart(4, '0')}.html`, html = child(BOTS.get(id), process.env.ENGINE || 'local:world');
  writeFileSync(DIST + name, html);
  files[name] = { id: null, role: 'child', parent: 'world.html', as: name.slice(0, -5) };
  console.log(`${name}: ${Buffer.byteLength(html)} B`);
}
writeFileSync(DIST + 'ordstudio.json', JSON.stringify({ ordstudio: 1, files }, null, 2) + '\n');
process.exitCode = over;
