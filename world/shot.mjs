// Headless Chrome + SwiftShader WebGPU screenshots (the host has no GPU), from the hangar's tools/shot.mjs. Prints
// every console message, exception, error log entry and failed/4xx request of the page and all its frames.
//   node shot.mjs <out.png> <url> [--size 1400x700] [--frames N] [--delay ms] [--timeout ms]
//                 [--act js]… [--eval js] [--no-webgpu]
// Waits until N frames (default 1) report window.WORLD.ready, then runs each --act expression in every frame (in
// order, 1.5 s apart; guard on WORLD.me.bot to pick a frame), waits --delay, prints --eval from every frame, shoots.
// Pages are loaded with #shot: the engine copies each finished frame into a 2D canvas (SwiftShader does not
// composite WebGPU canvases into screenshots). Raw CDP contexts, as the children replace their document.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_CORE || 'puppeteer-core');
const [out, url, ...rest] = process.argv.slice(2);
const opt = (k, d) => (rest.includes(k) ? rest[rest.indexOf(k) + 1] : d);
const acts = rest.flatMap((v, i) => (rest[i - 1] === '--act' ? [v] : []));
const [w, h] = opt('--size', '1400x700').split('x').map(Number);
const want = +opt('--frames', 1), delay = +opt('--delay', 2500), timeout = +opt('--timeout', 240000);

const gpuFlags = rest.includes('--no-webgpu') ? ['--disable-features=WebGPU'] : ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader',
  '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--enable-features=Vulkan', '--disable-gpu-watchdog'];
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  // real IP host candidates (as net/live/run.mjs): two players on one host cannot resolve each other's mDNS names
  args: [...gpuFlags, '--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns', `--window-size=${w},${h}`],
});
let bad = 0;
const page = await browser.newPage();
await page.setViewport({ width: w, height: h });
page.on('requestfailed', (r) => (bad++, console.log('[requestfailed]', r.url(), r.failure()?.errorText)));
page.on('response', (r) => r.status() >= 400 && (bad++, console.log('[http]', r.status(), r.url())));

const contexts = new Map(), sessions = [];
const watch = async (s) => {
  const k = sessions.push(s) - 1;
  s.on('Runtime.executionContextCreated', ({ context: c }) => c.auxData?.isDefault && contexts.set(k + ':' + c.auxData.frameId, [s, c.id]));
  s.on('Runtime.executionContextDestroyed', ({ executionContextId: id }) => {
    for (const [f, [ss, c]] of contexts) if (ss === s && c === id) contexts.delete(f);
  });
  s.on('Runtime.consoleAPICalled', (e) => {
    if (e.type === 'error' || e.type === 'assert') bad++;
    console.log(`[console.${e.type}] ${e.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
  });
  s.on('Runtime.exceptionThrown', (e) => (bad++, console.log('[exception]', e.exceptionDetails.exception?.description ?? e.exceptionDetails.text)));
  s.on('Log.entryAdded', ({ entry: e }) => {
    if (e.level === 'error') bad++;
    if (e.level === 'error' || e.level === 'warning') console.log(`[log.${e.level}] ${e.source}: ${e.text}`);
  });
  s.on('sessionattached', (child) => watch(child));
  await s.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
  await s.send('Runtime.enable');
  await s.send('Log.enable');
  await s.send('Runtime.runIfWaitingForDebugger').catch(() => {});
};
await watch(await page.createCDPSession());
const probe = (expression) => Promise.all([...contexts.values()].map(([s, contextId]) =>
  s.send('Runtime.evaluate', { expression, contextId, returnByValue: true }).then((r) => r.result.value, () => null)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t0 = Date.now();
await page.goto(url.includes('#') ? url + '&shot' : url + '#shot', { waitUntil: 'load', timeout });
let n = 0;
while (Date.now() - t0 < timeout && (n = (await probe('!!window.WORLD?.ready')).filter(Boolean).length) < want) await sleep(1000);
if (n < want) bad++, console.log(`[timeout] ${n}/${want} frames ready`);
for (const a of acts) await probe(a), await sleep(1500);
await sleep(delay);
const info = (await probe(opt('--eval', 'window.WORLD && JSON.stringify(window.WORLD)'))).filter(Boolean);
await page.screenshot({ path: out });
console.log(`${out}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${bad} error(s)\n${info.join('\n')}`);
await browser.close();
process.exit(bad ? 1 : 0);
