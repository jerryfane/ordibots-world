// Ordibots World: your Ordibot on a reef plaza with the other players'. Third-person camera, WASD / arrows to walk
// (camera-relative), drag to orbit, wheel / pinch to zoom, Enter to chat. Networking goes through makeNet() (net.js
// in the real build, fakeNet in the dev build) and only its interface: me, peers, on(peer|leave|chat|state),
// sendState, chat.
// Identity: #k=<Entmoot key seed b64url>&p=<ownership proof JSON b64url>[&inv=<newer bearer invite JSON b64url>] from
// login.html, read once and cleared. The proof names the bot (its number and traits come from /content/<bot id>);
// every peer's proof is checked against this ord server (../login/proof.js) and unverified players are hidden unless
// the "show unverified" toggle (or #ghosts) shows them as plain grey ghosts named "unverified". The engine embeds
// a bearer invite (INVITE, from the build); a newer one in #inv wins (login/INVITE.md). v0 test links
// (#k=…&i=<target-bound invite>&b=<bot>) still work, without a proof.
// Test-only hash flags: shot (headless readback), at=x,z,yaw (spawn), cam=az,el,dist, r=perMin,burst (group policy).
// GROUP, ADDR and INVITE come from the build config (world/build.mjs, world/config/*.json)
const Y0 = 11, SPEED = 34, MAX_BOTS = 8, DELAY = 100, BUBBLE = 6000;
const CHAT_BURST = 4, CHAT_EVERY = 20000; // Entmoot allows 6 messages a minute per member; net.js needs the rest
const WORLD = (window.WORLD = { ready: false });
const $ = (s) => document.querySelector(s);
const HASH = new URLSearchParams(location.hash.slice(1));
try {
  history.replaceState(null, '', location.pathname + location.search);
} catch {}
const ub = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const rotZ = (a) => trs(0, [0, 0, Math.sin(a / 2), Math.cos(a / 2)]);
const goodT = (t) => (/^\d{1,2}(,\d{1,2}){0,15}$/.test(t) ? t : DEFAULT_T);

const GHOST_T = '1,4,15,22'; // white body, white head, empty belly, unimpressed face: how unverified players look

async function main() {
  const json = (s) => s && JSON.parse(new TextDecoder().decode(ub(s)));
  const proof = json(HASH.get('p')) || null, V = PROOF.makeVerifier({ group: GROUP });
  let mine = ''; // the state of your own proof, in the status line
  const own = proof
    ? await V.bot(proof.bot).then((b) => ({ bot: b.n ?? 0, t: b.t }), (e) => ((mine = ' · your bot: ' + e.message), { bot: 0, t: DEFAULT_T }))
    : typeof OB == 'object' && OB ? { bot: +OB.id, t: '' + OB.t } : { bot: +HASH.get('b') || 0, t: DEFAULT_T };
  const cv = $('canvas'), shot = HASH.has('shot') && document.body.appendChild(document.createElement('canvas'));
  if (shot) shot.style.cssText = 'z-index:1;pointer-events:none';
  const R = (await createRenderer(cv, shot).catch((e) => console.warn(e))) || view2d(cv);
  WORLD.mode = R.mode;
  R.lost?.then((i) => i.reason != 'destroyed' && status('WebGPU device lost: ' + i.message));

  // ── entities: me and the others (id → ent); a tag (bubble + name) per bot in the overlay
  const ents = new Map();
  const ent = (bot, t, name) => {
    const e = { bot, t: goodT(t), name, x: 0, z: 0, yaw: 0, py: 0, spd: 0, f: 0, bank: 0, bob: 0, snaps: [], off: Infinity, lt: 0, ph: Math.random() * 9 };
    e.el = $('#o').appendChild(document.createElement('div'));
    e.el.className = 'n';
    e.el.innerHTML = '<i hidden></i><b></b>';
    e.el.lastChild.textContent = name;
    return e;
  };
  const me = ent(own.bot, own.t, 'Ordibot #' + own.bot);
  me.me = 1;
  me.el.lastChild.className = 'me';
  // a bot faces +x turned by yaw: heading (cos yaw, -sin yaw). Spawn on a ring facing the plaza's centre.
  const at = (HASH.get('at') || '').split(',').map(Number);
  const a0 = Math.random() * 6.283;
  [me.x, me.z, me.yaw] = at.length == 3 ? at : [Math.cos(a0) * 25, Math.sin(a0) * 25, Math.atan2(Math.sin(a0), -Math.cos(a0))];
  let [az, el, dist] = (HASH.get('cam') || '').split(',').map(Number);
  if (isNaN(dist)) (az = Math.PI - me.yaw), (el = 0.42), (dist = 105); // behind the bot, looking over it
  if (R.mode == '2d') az = Math.PI / 2; // north up: W walks up the screen
  const say = (e, text) => {
    const b = e.el.firstChild;
    (b.textContent = text), (b.hidden = false), (e.until = performance.now() + BUBBLE);
  };
  const log = (name, text) => {
    const l = $('#l'), d = l.appendChild(document.createElement('div'));
    d.innerHTML = '<b></b> <span></span>';
    (d.firstChild.textContent = name + ':'), (d.lastChild.textContent = text);
    while (l.children.length > 6) l.firstChild.remove();
  };
  const status = (s) => ($('#s').textContent = 'Ordibots World · ' + me.name + ' · ' + s + mine);

  // ── network
  let net, sent = { at: 0, due: 0 };
  // a player is shown when verified (or when nothing is verified: the dev build); unverified ones only with the
  // toggle, as ghosts. A changed verdict or bot rebuilds the entity.
  let ghosts = HASH.has('ghosts');
  const refresh = (p) => {
    const ghost = p.verified === false, e = ents.get(p.id);
    if (e && (e.ghost != ghost || e.bot != p.bot)) drop(p.id);
    if (ghost && !ghosts) return drop(p.id);
    if (!ents.has(p.id)) {
      const n = ent(p.bot, ghost ? GHOST_T : p.t, ghost ? 'unverified' : p.name || 'Ordibot #' + p.bot);
      if ((n.ghost = ghost)) n.el.lastChild.className = 'g';
      ents.set(p.id, n);
    }
  };
  const drop = (id) => {
    const e = ents.get(id);
    if (!e) return;
    e.inst?.remove(), e.el.remove(), ents.delete(id);
  };
  // net.online is false while net.js reconnects to the node (open P2P channels keep carrying movement meanwhile).
  // offlineReason 'contended': the key keeps losing its connection (maybe open in another tab or device); net.js
  // keeps retrying and the world stays. 'replaced': another tab of this browser took the key; this page stays idle.
  const mode = () => (net?.online !== false ? 'on' : net.offlineReason);
  let shown;
  const gb = $('#g');
  const online = () => {
    const n = net ? [...net.peers.values()].filter((p) => p.verified === false && p.announced !== false).length : 0;
    (gb.textContent = `${ghosts ? 'hide' : 'show'} unverified (${n})`), (gb.hidden = !n && !ghosts);
    status({ on: `online · ${ents.size + 1} here`, replaced: 'opened in another tab · this one is paused',
      contended: `this key may be open in another tab · ${ents.size + 1} here` }[(shown = mode())] || `reconnecting… · ${ents.size + 1} here`);
  };
  const toggle = () => {
    ghosts = !ghosts;
    for (const p of net?.peers.values() || []) if (p.announced !== false) refresh(p);
    online();
  };
  gb.onclick = toggle;
  // the invite: a v0 target-bound one (#i), else the newest bearer invite of the embedded one and #inv
  const k = HASH.get('k'), invite = HASH.has('i') ? json(HASH.get('i')) : PROOF.pickInvite([INVITE, HASH.has('inv') && json(HASH.get('inv'))], GROUP);
  const [perMin, burst] = (HASH.get('r') || '').split(',').map(Number); // test groups with a looser policy: #r=12,24
  // no key, no player: the world is shown alone (fakeNet needs none)
  status(k || makeNet.dev ? 'connecting…' : 'offline: no player key (log in first)');
  if (k || makeNet.dev) makeNet({
    addr: invite?.allowed_multiaddrs?.[0] || ADDR, groupId: GROUP, key: k && ub(k), invite,
    me: own, proof, verify: (id, p) => V.verify(id, p),
    onerror: (e) => console.warn('net:', e), ...(burst > 0 && { rate: { perMin, burst } }),
  }).then((n) => {
    net = n;
    for (const p of net.peers.values()) if (p.announced !== false) refresh(p);
    net.on('peer', (p) => (refresh(p), online()));
    net.on('verify', (p) => (refresh(p), online()));
    // your own proof, as the others check it
    if (proof && !makeNet.dev) V.verify(net.me.id, proof).then((r) => ((mine = r.ok ? ' · verified' : ' · not verified: ' + r.why), online()));
    else if (!makeNet.dev) mine = ' · no ownership proof (others see you only as a ghost)';
    // net.js queues events that fire before createNet resolves per event type, so a replayed 'leave' can come after
    // the same key's newer 'peer': whoever is still in net.peers stays
    net.on('leave', (id) => net.peers.has(id) || (drop(id), online()));
    net.on('reconnect', online);
    net.on('contended', online);
    net.on('replaced', () => {
      for (const id of [...ents.keys()]) drop(id);
      (box.disabled = true), (box.value = ''), (box.placeholder = 'opened in another tab'), box.blur(), online();
    });
    // history: stored before we joined (log only); late: missed while reconnecting (log, bubble if still fresh)
    net.on('chat', (c) => {
      if (c.from == net.me.id && !c.history) return; // my own were logged when sent
      if (c.verified === false && !ghosts) return; // unverified players are hidden, their chat too
      const e = ents.get(c.from), text = ('' + c.text).slice(0, 280);
      log(c.from == net.me.id ? me.name : c.verified === false ? 'unverified' : e?.name || c.name || 'Ordibot #' + c.bot, text);
      if (e && !c.history && !(c.late && Date.now() - c.at > BUBBLE)) say(e, text);
    });
    net.on('state', (s) => {
      const e = ents.get(s.from), now = Date.now();
      if (!e || !(s.t > e.lt) || ![s.x, s.z, s.yaw].every(isFinite)) return; // late (unordered channel) or junk
      (e.lt = s.t), (WORLD.rx = (WORLD.rx || 0) + 1); // rx: states received (tests measure the rate)
      // sender clock → ours: the smallest delay seen so far, relaxing slowly so clock drift cannot pin it
      e.off = Math.min(e.off + 0.2, now - s.t);
      if (!e.snaps.length) (e.x = s.x), (e.z = s.z), (e.yaw = e.py = s.yaw);
      e.snaps.push({ at: s.t + e.off, x: s.x, z: s.z, yaw: s.yaw, anim: s.anim });
      if (e.snaps.length > 30) e.snaps.shift();
    });
    WORLD.links = () => [...net.peers.values()].map((p) => ({ bot: p.bot, p2p: p.p2p, rtt: p.rtt, verified: p.verified, why: p.proofWhy }));
    WORLD.toggle = toggle;
    WORLD.self = () => ({ id: net.me.id, bot: me.bot, t: me.t, status: $('#s').textContent });
    online();
  }, (e) => status('offline: ' + e.message));

  // ── chat box: Enter focuses it, Enter sends, Esc leaves; a token bucket keeps chat inside the Entmoot budget.
  // No <form>: ord's sandbox (allow-scripts only) blocks form submission.
  const box = $('#c'), note = $('#w'), bucket = { n: CHAT_BURST, at: Date.now() };
  let noteUntil = 0;
  const tell = (s) => ((note.textContent = s), (noteUntil = performance.now() + 4000));
  const refill = () => {
    const now = Date.now();
    bucket.n = Math.min(CHAT_BURST, bucket.n + (now - bucket.at) / CHAT_EVERY);
    bucket.at = now;
    box.className = bucket.n < 1 ? 'x' : '';
  };
  const send = () => {
    const text = box.value.trim().slice(0, 280);
    if (!text) return box.blur();
    if (!net) return tell('not connected');
    refill();
    if (bucket.n < 1) return tell(`slow down · ${Math.ceil((1 - bucket.n) * CHAT_EVERY / 1000)} s`);
    bucket.n--, refill(), (box.disabled = true);
    // the typed text stays in the box until it is sent; a failure leaves it there to retry
    net.chat(text).then(() => {
      say(me, text), log(me.name, text), (box.disabled = false);
      if (box.value.trim().slice(0, 280) == text) (box.value = ''), box.blur();
    }, (e) => {
      (box.disabled = false), box.focus();
      if (e?.code == 'rate') (bucket.n = 0), refill(), tell('slow down');
      else if (e?.code == 'offline') bucket.n++, refill(), tell(net.offlineReason == 'contended' ? 'this key may be open in another tab' : 'reconnecting… · try again shortly');
      else if (e?.code == 'replaced') bucket.n++, (box.disabled = true);
      else tell('not sent: ' + e?.message);
    });
  };
  // a block body on purpose: an on* handler that returns false cancels the key, so `key == 'Enter' && …` ate every letter
  box.onkeydown = (ev) => {
    if (ev.key == 'Enter') ev.preventDefault(), send();
  };
  WORLD.say = (text) => ((box.value = text), send());
  WORLD.others = () => [...ents.values()].map((e) => ({ bot: e.bot, x: +e.x.toFixed(2), z: +e.z.toFixed(2), yaw: +e.yaw.toFixed(3), body: !!e.inst?.ready }));

  // ── input
  const keys = new Set(), ptr = new Map();
  addEventListener('keydown', (e) => {
    if (e.target == box) return e.key == 'Escape' && box.blur();
    if (e.key == 'Enter') return e.preventDefault(), box.focus();
    keys.add(e.code);
    if (/^Arrow/.test(e.code)) e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  const spread = () => { const [a, b] = [...ptr.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  cv.onpointerdown = (e) => (box.blur(), cv.setPointerCapture(e.pointerId), ptr.set(e.pointerId, [e.clientX, e.clientY]));
  cv.onpointerup = cv.onpointercancel = (e) => ptr.delete(e.pointerId);
  cv.onpointermove = (e) => {
    const p = ptr.get(e.pointerId);
    if (!p) return;
    const pinch = ptr.size == 2 && spread(), dx = e.clientX - p[0], dy = e.clientY - p[1];
    (p[0] = e.clientX), (p[1] = e.clientY);
    if (pinch) dist = clamp((dist * pinch) / spread(), 40, 240);
    else if (R.mode != '2d') (az += dx * 0.008), (el = clamp(el + dy * 0.006, 0.05, 1.35));
  };
  cv.addEventListener('wheel', (e) => (e.preventDefault(), (dist = clamp(dist * Math.exp(e.deltaY * 0.001), 40, 240))), { passive: false });
  const key = (...c) => (c.some((x) => keys.has(x)) ? 1 : 0);

  // ── per frame
  let vx = 0, vz = 0, last = performance.now(), frames = 0, tgt = [me.x, Y0 + 10, me.z];
  const move = (dt) => {
    const fw = key('KeyW', 'ArrowUp') - key('KeyS', 'ArrowDown'), sd = key('KeyD', 'ArrowRight') - key('KeyA', 'ArrowLeft');
    let dx = -fw * Math.cos(az) + sd * Math.sin(az), dz = -fw * Math.sin(az) - sd * Math.cos(az);
    const l = Math.hypot(dx, dz) || 1, a = Math.min(1, dt * 7);
    (vx += ((dx / l) * SPEED - vx) * a), (vz += ((dz / l) * SPEED - vz) * a);
    (me.x += vx * dt), (me.z += vz * dt);
    for (const [rx, rz, rr] of ROCKS) {
      const ox = me.x - rx, oz = me.z - rz, d = Math.hypot(ox, oz), m = rr + 7;
      if (d < m && d > 0) (me.x = rx + (ox / d) * m), (me.z = rz + (oz / d) * m);
    }
    const d = Math.hypot(me.x, me.z);
    if (d > 420) (me.x *= 420 / d), (me.z *= 420 / d);
    me.spd = Math.hypot(vx, vz);
    if (me.spd > 3) me.yaw = wrap(me.yaw + wrap(Math.atan2(-vz, vx) - me.yaw) * Math.min(1, dt * 9));
  };
  // the others: replay their states DELAY ms behind, interpolated between the two around that moment
  const follow = (e, dt) => {
    const s = e.snaps, rt = Date.now() - DELAY;
    if (!s.length) return;
    let i = s.length - 1;
    while (i > 0 && s[i].at > rt) i--;
    const a = s[i], b = s[i + 1] || a, f = b == a ? 0 : clamp((rt - a.at) / (b.at - a.at), 0, 1);
    const x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
    const v = (a.anim || b.anim) && dt ? Math.hypot(x - e.x, z - e.z) / dt : 0;
    e.spd += (v - e.spd) * Math.min(1, dt * 8);
    (e.x = x), (e.z = z), (e.yaw = a.yaw + wrap(b.yaw - a.yaw) * f);
    if (rt - s[s.length - 1].at > 1000) s.splice(0, s.length - 1);
  };
  // procedural animation: hover bob (faster when walking), lean into the walk, bank into turns, blink
  const pose = (e, t, dt) => {
    e.f += (clamp(e.spd / SPEED, 0, 1) - e.f) * Math.min(1, dt * 5);
    e.bob = (0.9 + 0.55 * Math.sin(t * 1.25 + e.ph)) * (1 - e.f) + (1.7 + 0.6 * Math.sin(t * 7.5 + e.ph)) * e.f;
    const turn = dt ? wrap(e.yaw - e.py) / dt : 0;
    (e.py = e.yaw), (e.bank += (clamp(turn * 0.07, -0.3, 0.3) - e.bank) * Math.min(1, dt * 6));
    const bp = (t + e.ph) % 4.3;
    e.inst.set(mul(mul(mul(trs([e.x, Y0 + e.bob, e.z]), rotY(e.yaw)), rotZ(-0.2 * e.f)), rotX(e.bank)), bp > 0.18 ? 0 : Math.sin((bp / 0.18) * Math.PI), t);
  };
  const ready = () => (WORLD.ready ||= !!me.inst?.ready);
  const loop = (ms) => {
    const dt = Math.min(0.1, (ms - last) / 1000), t = ms / 1000, all = [me, ...ents.values()];
    last = ms;
    if (document.activeElement != box) move(dt);
    for (const e of ents.values()) follow(e, dt);
    // state out: 15 Hz while moving or turning (a deadline that advances by 1/15 s, so frame timing does not round
    // the rate down), 1 Hz at rest so newcomers see us
    const now = Date.now(), anim = me.spd > 3 ? 1 : 0;
    if (net && net.offlineReason != 'replaced' && ((now >= sent.due && (Math.hypot(me.x - sent.x, me.z - sent.z) > 0.05 || Math.abs(wrap(me.yaw - sent.yaw)) > 0.01 || anim != sent.anim)) || now - sent.at > 1000)) {
      sent = { at: now, due: Math.max(sent.due + 1000 / 15, now - 25), x: me.x, z: me.z, yaw: me.yaw, anim };
      net.sendState({ t: now, x: +me.x.toFixed(2), y: 0, z: +me.z.toFixed(2), yaw: +me.yaw.toFixed(3), anim });
    }
    // at most MAX_BOTS bots get a body; later arrivals get theirs when someone leaves
    let n = all.filter((e) => e.inst).length;
    for (const e of all) if (!e.inst && n < MAX_BOTS) (e.inst = R.bot(e.t)), n++;
    for (const e of all) if (e.inst?.ready) pose(e, t, dt);
    tgt = tgt.map((v, i) => v + ([me.x, Y0 + 10, me.z][i] - v) * Math.min(1, dt * 8));
    const eye = [tgt[0] + dist * Math.cos(el) * Math.cos(az), tgt[1] + dist * Math.sin(el), tgt[2] + dist * Math.cos(el) * Math.sin(az)];
    R.frame(t, eye, tgt, ready, all);
    if (++frames > 2 && !shot) ready();
    for (const e of all) {
      const p = e.inst?.ready && R.project([e.x, Y0 + e.bob + 17, e.z]), b = e.el.firstChild;
      e.el.style.display = p ? '' : 'none';
      if (p) (e.el.style.left = p[0] + 'px'), (e.el.style.top = p[1] + 'px');
      if (!b.hidden && ms > e.until) b.hidden = true;
    }
    if (noteUntil && ms > noteUntil) (note.textContent = ''), (noteUntil = 0);
    if (net && mode() !== shown) online(); // drops and their reasons come without an event
    if (frames % 30 == 0) refill();
    WORLD.bots = all.length;
    WORLD.me = { id: net?.me.id, bot: me.bot, x: me.x, z: me.z, yaw: me.yaw };
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
main().catch((e) => {
  console.error(e);
  document.body.append('Could not start: ' + e.message);
});
