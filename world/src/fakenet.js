// Development stand-in for net.js with the same interface. Players are sandboxed iframes on one dev page (dev.html);
// every message goes up to the page with postMessage and the page relays it to the other frames. Alone (no parent
// frame) it is a world of one. Chat follows the real budget (6 a minute, 2 kept back for presence), so the chat box's
// "slow down" path can be tested here too. Needs no key (makeNet.dev).
// FAKENET.drop(ms) simulates losing the node for ms, as net.js reports it: online false, chat rejects 'offline',
// chats from others arrive after the gap with late: true, then 'reconnect'; movement keeps flowing (P2P).
// FAKENET.replace() simulates the key being opened in another tab: 'replaced', for good.
function makeNet({ me }) {
  const id = Math.random().toString(36).slice(2, 10), name = 'Ordibot #' + me.bot, hs = {}, peers = new Map();
  const bucket = { n: 4, at: Date.now() };
  const emit = (ev, x) => (hs[ev] || []).map((f) => f(x));
  let gone = false; // replaced: this page no longer speaks for the key
  const post = (m) => !gone && parent != window && parent.postMessage({ fakenet: 1, from: id, ...m }, '*');
  const hello = (to) => post({ k: 'hello', to, bot: me.bot, t: me.t, name });
  addEventListener('message', (ev) => {
    const m = ev.data;
    if (gone || !m?.fakenet || m.from == id || (m.to && m.to != id)) return;
    const p = peers.get(m.from);
    if (m.k == 'hello') {
      peers.set(m.from, { id: m.from, bot: m.bot, t: m.t, name: m.name, lastSeen: Date.now() });
      if (!p) emit('peer', peers.get(m.from)), m.to || hello(m.from);
    } else if (p) {
      p.lastSeen = Date.now();
      if (m.k == 'state') emit('state', { from: m.from, ...m.s });
      if (m.k == 'chat') {
        const c = { from: m.from, text: m.text, at: m.at, bot: p.bot, name: p.name };
        n.online ? emit('chat', c) : missed.push({ ...c, late: true });
      }
      if (m.k == 'leave') peers.delete(m.from), emit('leave', m.from);
    }
  });
  addEventListener('pagehide', () => post({ k: 'leave' }));
  setInterval(() => {
    hello();
    for (const [pid, p] of peers) if (Date.now() - p.lastSeen > 8000) peers.delete(pid), emit('leave', pid);
  }, 2000);
  hello();
  const missed = [];
  const n = (window.FAKENET = {
    me: { id, bot: me.bot },
    peers,
    online: true,
    on: (ev, f) => (hs[ev] ||= []).push(f),
    sendState: (s) => post({ k: 'state', s }),
    chat: async (text) => {
      if (!n.online) throw Object.assign(Error(n.offlineReason), { code: gone ? 'replaced' : 'offline' });
      const now = Date.now();
      bucket.n = Math.min(4, bucket.n + (now - bucket.at) / 15000);
      bucket.at = now;
      if (bucket.n < 1) throw Object.assign(Error('rate limited'), { code: 'rate' });
      bucket.n--;
      post({ k: 'chat', text: ('' + text).slice(0, 280), at: now });
    },
    drop: (ms) => {
      (n.online = false), (n.offlineReason = 'reconnecting');
      setTimeout(() => ((n.online = true), (n.offlineReason = null), missed.splice(0).map((c) => emit('chat', c)), emit('reconnect')), ms);
    },
    replace: () => {
      (n.online = false), (n.offlineReason = 'replaced'), post({ k: 'leave' }), (gone = true), emit('replaced');
    },
    // contend(ms): the key keeps losing its connection for ms ('contended', retries, the world stays), then is back
    contend: (ms) => {
      (n.online = false), (n.offlineReason = 'contended'), emit('contended');
      setTimeout(() => ((n.online = true), (n.offlineReason = null), missed.splice(0).map((c) => emit('chat', c)), emit('reconnect')), ms);
    },
  });
  return Promise.resolve(n);
}
makeNet.dev = 1;
