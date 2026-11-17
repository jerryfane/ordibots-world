// Ordibots World login (login.html): Xverse → ordinals address → held Ordibots (children of the Ordibots parent, held
// at that address on this ord server) → pick one → per-device Entmoot key → one BIP-322 signMessage → the world, with
// key + proof in the URL hash (the world reads and clears it). No dependency: the wallet is reached through the
// provider Xverse injects into top-level pages (window.XverseProviders.BitcoinProvider, sats-connect's JSON-RPC
// methods). Built into ../dist/login.html by build.mjs (WORLD = the world's /content path).
import { statement, makeVerifier } from './proof.js';

const GROUP = __GROUP__; // the world's Entmoot group, from the build config (world/build.mjs)
const DAYS = 7; // proof lifetime: the world needs a new signature after this
const REUSE = 86400; // s: a stored proof with more than a day left is reused (no new signature)
const HASH = new URLSearchParams(location.hash.slice(1));
const WORLD = '/content/' + (/^[\w:.-]+$/.test(HASH.get('w') || '') ? HASH.get('w') : __WORLD__);
const V = makeVerifier({ group: GROUP });
const $ = (s) => document.querySelector(s);
const b64 = (b) => btoa(String.fromCharCode(...b));
const b64url = (b) => b64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const say = (s, cls = '') => (($('#s').textContent = s), ($('#s').className = cls));
const el = (tag, text, attrs = {}) => Object.assign(document.createElement(tag), { textContent: text, ...attrs });

// ── wallet: JSON-RPC over the injected provider
const provider = () => window.XverseProviders?.BitcoinProvider || window.BitcoinProvider;
const call = async (method, params) => {
  const r = await provider().request(method, params);
  if (r?.error) throw Object.assign(Error(r.error.message || method + ' failed'), { code: r.error.code });
  if (!r || !('result' in r)) throw Error(method + ': unexpected wallet answer');
  return r.result;
};
const ordinalsAddress = async () => {
  const message = 'Ordibots World: log in with your Ordibot';
  let r;
  try {
    r = await call('wallet_connect', { addresses: ['ordinals'], message });
  } catch (e) {
    if (e.code != -32601) throw e; // older wallets: no wallet_connect
    r = await call('getAddresses', { purposes: ['ordinals'], message });
  }
  const a = (r.addresses || []).find((x) => x.purpose == 'ordinals');
  if (!a) throw Error('the wallet gave no ordinals address');
  return a.address;
};
/** the wallet's inscriptions at addr that this ord server confirms: children of the Ordibots parent, held by addr */
const heldBots = async (addr, found) => {
  const list = [];
  for (let offset = 0; offset < 5000; offset += 60) {
    const r = await call('ord_getInscriptions', { offset, limit: 60 });
    list.push(...(r.inscriptions || []));
    if (!r.inscriptions?.length || offset + 60 >= r.total) break;
  }
  // a bot is a ≤ 200-byte HTML inscription (165–178 B): skip what is clearly something else before asking the ord
  // server (fields the wallet leaves out or formats differently do not exclude)
  const cands = list.filter((i) => (!i.address || i.address == addr) && !(i.contentType && !/html/.test(i.contentType)) && !(parseInt(i.contentLength) > 200));
  let next = 0;
  const work = async () => {
    for (let i; (i = cands[next++]); ) {
      const b = await isMine(i.inscriptionId, addr).catch(() => null);
      if (b) found(b);
    }
  };
  await Promise.all([work(), work(), work(), work()]);
  return cands.length;
};
const isMine = async (id, addr) => {
  if (!(await V.child(id))) return null;
  const r = await fetch('/r/inscription/' + id).then((r) => (r.ok ? r.json() : null));
  return r?.address == addr ? V.bot(id) : null;
};

// ── the per-device Entmoot key: IndexedDB when this origin has storage (top-level ordinals.com); none in a sandbox
const PKCS8 = Uint8Array.of(48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32);
const pubOf = async (seed) => {
  const k = await crypto.subtle.importKey('pkcs8', new Uint8Array([...PKCS8, ...seed]), 'Ed25519', true, ['sign']);
  const x = (await crypto.subtle.exportKey('jwk', k)).x;
  return b64(Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
};
const store = async (key, value) => {
  const db = await new Promise((res, rej) => {
    const q = indexedDB.open('ordibots-world', 1);
    (q.onupgradeneeded = () => q.result.createObjectStore('kv')), (q.onsuccess = () => res(q.result)), (q.onerror = () => rej(q.error));
  });
  return new Promise((res, rej) => {
    const s = db.transaction('kv', value === undefined ? 'readonly' : 'readwrite').objectStore('kv'), q = value === undefined ? s.get(key) : s.put(value, key);
    (q.onsuccess = () => res(q.result)), (q.onerror = () => rej(q.error));
  });
};
let kept = true; // false: no storage here, the key lives for this page only
const deviceKey = async () => {
  let k = await store('key').catch(() => ((kept = false), null));
  if (!(k?.seed?.length == 32)) {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    k = { seed, pub: await pubOf(seed), made: Date.now() };
    if (kept) await store('key', k).catch(() => (kept = false));
  }
  return k;
};

// ── the page
// Xverse injects its provider late: its content script adds inpage.js as a <script src> after an async check, so
// the provider can appear after this page's own script has run. Wait for it a few seconds before giving up.
const waitProvider = async (ms = 4000) => {
  for (const end = Date.now() + ms; !provider() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
  return provider();
};
async function main() {
  say('Looking for Xverse…');
  const W = await waitProvider();
  if (!W) {
    const framed = window.top !== window;
    say(framed
      ? 'No wallet here: this page runs inside a frame (ord preview, a wallet or a marketplace), and Xverse only reaches top-level pages. Open this inscription on its own: /content/<id> on ordinals.com.'
      : 'No Xverse found. Install the Xverse extension (or open this page in the Xverse app browser) and reload.', 'x');
    return;
  }
  say('');
  const go = $('#go');
  go.hidden = false;
  go.onclick = async () => {
    go.disabled = true;
    try {
      say('Connecting to Xverse…');
      const addr = await ordinalsAddress();
      $('#a').textContent = addr;
      say('Looking for your Ordibots…');
      const list = $('#b');
      list.textContent = '';
      const pick = (b) => {
        const n = list.appendChild(el('button', 'Ordibot #' + (b.n ?? '?'), { title: b.id }));
        n.onclick = () => enter(addr, b).catch((e) => say(e.message, 'x'));
      };
      const n = await heldBots(addr, pick).catch((e) => {
        say('The wallet could not list inscriptions (' + e.message + '). Paste your Ordibot\'s inscription id instead.', 'x');
        return -1;
      });
      if (n >= 0) say(list.children.length ? 'Pick the Ordibot you enter with.' : 'No Ordibot at ' + addr + ' (checked ' + n + ' candidates). Paste an inscription id if yours is elsewhere in this wallet.', list.children.length ? '' : 'x');
      $('#m').hidden = false;
      $('#i').onkeydown = async (ev) => {
        if (ev.key != 'Enter') return;
        const id = $('#i').value.trim();
        const b = /^[0-9a-f]{64}i\d+$/.test(id) && (await isMine(id, addr).catch(() => null));
        b ? enter(addr, b).catch((e) => say(e.message, 'x')) : say(id + ' is not an Ordibot held by ' + addr + ' on this ord server.', 'x');
      };
    } catch (e) {
      say(e.code == 4001 || /reject|cancel/i.test(e.message) ? 'Cancelled in the wallet.' : e.message, 'x');
    } finally {
      go.disabled = false;
    }
  };
}

async function enter(addr, b) {
  const key = await deviceKey(), now = Math.floor(Date.now() / 1000);
  const saved = kept && (await store('proof:' + b.id).catch(() => null));
  let proof = saved?.addr == addr && saved.member == key.pub && saved.exp - now > REUSE ? saved.proof : null;
  if (!proof) {
    say('Sign the login message in Xverse (it proves you hold Ordibot #' + b.n + '; no transaction, no fee).');
    const iat = now, exp = now + DAYS * 86400;
    const message = statement({ group: GROUP, member: key.pub, bot: b.id, addr, iat, exp });
    const r = await call('signMessage', { address: addr, message, protocol: 'BIP322' });
    proof = { bot: b.id, addr, sig: r.signature, iat, exp };
  }
  // the same check every other player will make
  const v = await V.verify(key.pub, proof);
  if (!v.ok) throw Error('The proof does not verify: ' + v.why);
  if (kept && proof !== saved?.proof) await store('proof:' + b.id, { addr, member: key.pub, exp: proof.exp, proof }).catch(() => {});
  say(kept ? 'Entering the world…' : 'Entering the world… (this page cannot keep your world key: next time you come back as a new member)');
  location.href = WORLD + '#' + new URLSearchParams({ k: b64url(key.seed), p: b64url(new TextEncoder().encode(JSON.stringify(proof))) });
}

main();
