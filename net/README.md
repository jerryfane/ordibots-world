# net.js: Ordibots World networking

Presence and chat go over the Entmoot group (entmoot-lite, vendored here as `entmoot-lite.js` = `dist/entmoot-lite.js`
of [entmoot-lite](https://github.com/jerryfane/entmoot-lite) e1813a0, also pinned as the `vendor/entmoot-lite`
submodule). Movement goes over direct WebRTC data channels between players, set
up through the group. One ES module, no dependencies besides entmoot-lite. It runs inside ord's sandbox (iframe
`sandbox="allow-scripts"`, ord's CSP).

## Interface

```js
import { createNet } from './net.js'
const net = await createNet({
  addr,            // entmootd multiaddr (webrtc-direct + certhash), e.g. invite.allowed_multiaddrs[0]
  groupId,         // base64 group id
  key,             // Uint8Array(32) Ed25519 seed; never stored
  invite,          // parsed invite JSON, or undefined; used only if the key is not a member yet
  me: { bot, t },  // bot number; t = trait index string such as "3,12,14,16,42,24,25,37" (optional)
  proof,           // optional ownership proof {bot: <inscription id>, addr, sig, iat, exp} (../login/proof.js), sent in every hello
  verify,          // optional (member id, proof) => Promise<{ok, n, t, id, why}>: proof.js makeVerifier({group}).verify
  onerror,         // optional, errors while running (default console.error)
  rate,            // optional { perMin, burst } = the group's per-author policy; default { perMin: 6, burst: 12 }
  iceServers,      // optional, default [{ urls: 'stun:stun.l.google.com:19302' }]
  rtc              // optional RTCPeerConnection constructor (tests, NAT simulation); default the global
})
net.me            // { id, bot, t, name }   id = Entmoot pubkey (base64)
net.peers         // Map<id, { id, bot, t, name, lastSeen, p2p, route, rtt, why, verified, proofWhy, insc }>
net.on('peer', (p) => …)      // p is the peers entry: { id, bot, t, name, lastSeen, verified, … }
net.on('verify', (p) => …)    // a later check of the same session changed p.verified, p.bot or p.t
net.on('leave', (id) => …)
net.on('chat', ({ from, text, at, bot, name, verified, history, late }) => …)
net.on('state', ({ from, t, x, y, z, yaw, anim }) => …)
net.on('reconnect', () => …)            // the node connection dropped and is back
net.sendState({ t, x, y, z, yaw, anim })  // ≤ 15 Hz, latest wins, never stored
await net.chat(text)                      // world/chat; rejects .code 'rate' over budget, 'offline', 'replaced'
net.on('contended', () => …)            // the key keeps losing its connection: maybe open in another tab/device
net.on('replaced', () => …)             // another tab of this browser took this key: net gave up for good
net.online                                // false while the node connection is down (or after 'replaced')
net.offlineReason                         // null | 'reconnecting' | 'contended' | 'replaced' | 'closed'
await net.close()                         // world/bye, closes channels and the node connection
net.entmoot                               // the entmoot-lite group (tests/diagnostics)
```

- **One id everywhere:** `net.me.id`, the keys of `net.peers`, and `from` in 'chat'/'state' are the member's
  Entmoot public key, base64 (`author.entmoot_pubkey`).
- **'peer'** fires once per player session: for live hellos, and for players found in the last 64 stored world
  messages at join who spoke in the last 45 s. A player who reloads (same key, new session) gives 'leave' then 'peer'
  once its new session is heard live. A stored hello from an older session never replaces a session already heard
  live while joining.
- **Ownership (with `verify`):** a peer is announced only once its proof was checked; `'peer'` then carries
  `p.verified` (true/false) and, when true, `p.bot`, `p.t`, `p.name` and `p.insc` from the proven bot (its number and
  traits are read from `/content/<bot id>`), whatever the hello claimed. A peer without a proof is announced with
  `verified: false, proofWhy: 'no ownership proof'`. Every later live hello asks the verifier again (proof.js answers
  from its 10-minute cache, then checks the holder again); a changed verdict, bot or traits fires `'verify'`. A peer
  that leaves before its check ends is never announced. Chats carry the author's `verified`. P2P and movement are
  not gated: hiding is the world's call (`world.js` hides unverified players unless the ghost toggle is on).
  Without `verify`, nothing changes and `p.verified` is undefined.
- **'leave'** fires on `world/bye`, when an open data channel closes or carries nothing for 15 s, or when nothing
  at all (hello, pos, P2P) was heard for 75 s.
- **'chat' does not echo** your own `net.chat()`. At join, stored chats (the last of the 64 world messages) come
  with `history: true`, including your own key's older chats (`from === net.me.id`). `text` is at most 280
  characters; `at` is the author's timestamp (ms). Chats stored while the node connection was down arrive right after
  the reconnect with `late: true`.
- **Reconnect:** entmoot-lite notices a dropped node connection (a failed connection, or no answer to its 15 s
  ping) and dials again by itself, after 1, 2, 5, 10 s, then every 30 s.
  - **Meanwhile:** open P2P channels keep carrying movement; `net.online` is false; `net.chat()` rejects with
    `code: 'offline'`; hellos, `world/pos` and signals wait.
  - **Back online:** net sends a fresh hello with `re: 1`, and every pair without an open channel gets new connection
    tries, on both sides. Then 'reconnect' fires.
- **Early events:** events that happen before the first `on()` call (peers and chats found while joining) wait in
  one queue, in the order they happened, and are replayed on the next microtask to the handlers attached by then.
  So attach handlers right after `createNet` resolves; a reload seen while joining replays as peer(old), leave(old),
  peer(new).
- **Same key elsewhere:** one key is one connection on the node, so a second tab, device or agent with the same key
  takes it over.
  - **Contended (any second session):** after 3 short-lived connections within 60 s, 'contended' fires once and
    `net.offlineReason === 'contended'` while offline ("this key may be open in another tab"). entmoot-lite keeps
    reconnecting, after 60 s and then every 5 min, until a connection lasts 30 s. This can also be a flaky network,
    so it is never a permanent stop; open P2P channels are kept.
  - **Replaced (same browser, positive evidence):** a page that hears, on a BroadcastChannel named from a hash of
    its public key, a NEWER session of its key connect (also while it is reconnecting) gives up for good; the newer
    tab always keeps the key: 'replaced' fires once, `net.online` stays
    false, `net.offlineReason === 'replaced'`, `net.chat()` rejects with `code: 'replaced'`, every peer gets 'leave'
    and P2P channels close. This needs a shared origin: an inscription opened top-level (e.g. on ordinals.com). In
    ord's sandboxed iframe (opaque origin) pages can't hear each other, so there only 'contended' happens.
  - `net.offlineReason` is otherwise `null` (online), `'reconnecting'` or `'closed'`.
- **Pacing:** `sendState` sends whenever a call comes at least 66.7 ms after the last packet, even if the trailing
  timer is still pending, so late timers on a busy page don't lower the rate. The timer only carries the last update
  when calls stop.
- **Validation:** hellos with a non-integer `bot` are ignored; `t` must be ≤ 16 comma-separated integers of ≤ 4
  digits, otherwise it is dropped (`p.t === undefined`). States must be finite numbers with `anim` a string
  (≤ 32 chars), a number or null; anything else is dropped. P2P packets over 512 bytes are dropped.
- `p.p2p`: `'none' | 'connecting' | 'open' | 'failed'`; `p.rtt`: data-channel round trip in ms (ping every 2 s);
  `p.route`: the selected ICE pair, local/remote candidate types + protocol (e.g. `srflx/host udp`);
  `p.why`: the last failure reason.

## Topics and messages

All Entmoot content is UTF-8 JSON. `s` is a random per-page session id (8 chars).

| Topic | Who | Content | Rate |
| --- | --- | --- | --- |
| `world/hello` | everyone | `{bot, t, name, s, p?}` (`p` = ownership proof) | at join, then every 29 s |
| `world/chat` | everyone | plain text, ≤ 280 chars | the caller's |
| `world/signal/<b64url(recipient id)>` | the pair | sealed envelope `{v:1, e, n, c}` of `{type:'offer'\|'answer', sid, sdp, s, to, bot, t, p?, from}` (see Signal encryption) | 1 per side per connection attempt |
| `world/pos` | only when P2P is missing | `{bot, t, name, s, p?, st:[t,x,y,z,yaw,anim]}` | ≤ 1 per 20 s, replaces the heartbeat |
| `world/bye` | everyone | `{s}` | on `close()` |

- **Recipient topic:** `b64url` is base64 with `+/` → `-_` and no padding (Entmoot topics can't hold `+`).
- **`to`:** the recipient's session; signals for an older session are ignored.
- **`sid`:** the offer id that the answer echoes.

## P2P

- **Who offers:** the player with the smaller id offers, as soon as it knows the other one (live hello, or history at
  join). The other player answers.
- **Knock:** the larger id also offers if no offer came 8 s after it learned of the peer. That happens when both
  join at once: each hello goes out before the other has subscribed and after it has listed history, so the smaller
  id would otherwise wait for the next heartbeat (29 s). If both offers cross, the smaller id's offer wins.
- **No trickle:** ICE is gathered fully (≤ 4 s) and the complete SDP is sent in one message, so a connection costs
  one Entmoot message per side.
- **One channel per pair:** `createDataChannel('w', {ordered: false, maxRetransmits: 0})`.
- **Packets** are JSON arrays: `[0, seq, t, x, y, z, yaw, anim]` state (positions rounded to 1 mm; older `seq`
  dropped: latest wins), `[1, ms]` ping, `[2, ms]` pong.
- **sendState** coalesces calls: at most one packet per 66.7 ms, always the latest state, the last call always
  sent. A newly opened channel gets the latest state at once.
- **Retries:** if no channel opens 19 s after the offer (or ICE reports `failed`), the offerer retries after 15 s,
  30 s and 60 s. After that the pair stays on the `world/pos` fallback until one of them reloads.
- **Fallback:** if any peer has no open channel 19 s after it appeared (or failed), `sendState` also publishes
  `world/pos` at most once per 20 s. That message also counts as the heartbeat. Peers without a channel get those
  positions as 'state' events.

## Message budget (group policy)

The node enforces a per-author policy (preset standard: 6 messages/min, burst 12, ≤ 8192 bytes) and silently drops
what goes over. net.js keeps its own token bucket with the same numbers (`rate`, default 6/min, burst 12, minus one
token of margin) and decides what goes out:
- **Signals** (offer/answer) are never refused. They wait in a queue for a token.
- **Heartbeat** keeps 1 token in reserve.
- **chat()** and `world/pos` keep 2 tokens in reserve for hello and signaling. When chat would eat into that,
  `net.chat()` rejects with `code: 'rate'` and nothing is sent.

Standard policy, steady state: heartbeat ≈ 2/min, so chat gets about 3–4/min sustained after an initial burst of
8. The Ordibots test group is set to 12/min burst 24; pass `rate: {perMin: 12, burst: 24}` there.

## Signal encryption

Offers and answers carry the players' IP candidates. The group is meant to be public (readable on entmoot.xyz, all
topics, full history), so every signal is encrypted to its recipient:
- **Keys:** the recipient's Entmoot Ed25519 public key (the topic names it) is mapped to X25519 with the birational
  map u = (1 + y) / (1 − y); our own X25519 key is the first half of SHA-512(our seed), clamped. Each message uses a
  fresh X25519 key pair.
- **Cipher:** ECDH, then HKDF-SHA256 (salt = ephemeral public key ‖ recipient's X25519 key, info =
  `ordibots-world/signal/v1` ‖ 0 ‖ sender id ‖ 0 ‖ recipient id ‖ 0 ‖ group id), then AES-256-GCM with the same info
  as additional data. Envelope: `{v: 1, e: <ephemeral public key>, n: <12-byte nonce>, c: <ciphertext>}`, standard
  base64. Only the recipient can open it; another group, another recipient or any changed byte fails.
- **Sender:** Entmoot's signature on the message authenticates it; the decrypted payload's `from` must equal the
  message's author, so a member can't re-post someone else's envelope as its own.
- **Plaintext signals are refused** (no fallback): a client from before this change can't make P2P links with
  this one; it still has presence and chat, and movement falls back to `world/pos`.
- **No WebCrypto X25519/AES-GCM** (entmoot-lite itself needs X25519, Chrome/Edge 137+, Firefox 130+, Safari 17+, so
  this matters only for a browser that lacks X25519 private-key import or AES-GCM): P2P is off with the reason in
  `net.p2pOff` and in every peer's `p.why`; presence and chat still work, and movement uses `world/pos`.
- What stays readable in the group: hellos (bot, traits, session, ownership proof), chat, `world/pos` positions,
  byes, and who signals whom (topic and author).

## Tests

- `npm test` (`node --test test/*.test.js`): net.js against entmoot-lite's fake node and a fake
  RTCPeerConnection (test/hub.js). entmoot-lite's real `join()` runs unchanged (Noise, multistream, membership,
  history, gossipsub), and a hub relays the gossip between clients. Covers presence (bot, t, names, ids), one
  offer + one answer per pair, the unordered/unreliable channel, 15 Hz latest-wins, chat both ways (no echo,
  history, 280 chars), 3 players + leave, the P2P failure fallback (≤ 1 world/pos per 20 s), the budget (chat
  refused with `rate` at 6/12 and at 12/24), hostile hellos, a stored hello of an old session arriving after the
  live new one, the join race (the larger id knocks), a dropped node connection (P2P keeps flowing, missed chat
  arrives late, fresh hello with `re: 1`, live again), early events replayed in order across types, 15 Hz with
  timers 60 ms late, 'contended' and 'replaced', and signal encryption: stored signals are only envelopes (no SDP,
  candidate or IP; fails without encryption), seal/unseal round trip (and the Ed25519→X25519 map against node's own
  X25519), a wrong recipient, another group or a forged sender can't open it, tampering fails, a plaintext offer gets
  no answer (fails without the refusal), and without the WebCrypto pieces P2P is off with a reason while chat works.
  Needs entmoot-lite's test node: the `vendor/entmoot-lite` submodule (`git submodule update --init`), or env
  `ENTMOOT_LITE=<checkout>`.
- **Live** (`live/`, needs `playwright` installed, an ordstudio sandbox and local member keys in `../keys/`, which are
  never committed):
  - `live.html` runs in the ordstudio sandbox and loads `entmoot-lite.js` and `net.js` as `blob:` modules
    (`#g=<group id>` picks the group; the scripts pass the test group from `world/config/test.json`, or `GROUP`).
  - `live/run.mjs` drives headless Chromium players, each in its own browser process inside
    `<iframe sandbox="allow-scripts">`, against the live node: `SRC=<sandbox src> node live/run.mjs` (env
    `PLAYERS`, `RATE`, `MOVE`, `CHAT10`, `HOLD`).
  - `live/public-proof.mjs` proves a group's signals are ciphertext with exactly 3 uses of its bearer invite (keys
    saved first to `keys/proof-keys-<group>.json`; reruns reuse them as members): two fresh keys link up and chat,
    a third reads the whole `world/#` history and checks every signal is `{v,e,n,c}` and no message on any topic has
    "candidate", "sdp" or an IPv4 address. `MEMBERS=p1,p2,p5` is a dry run with member keys (no invite).
  - `live/admission.mjs` (crash and rejoin with the same key), `live/drop.mjs` (dropped node connection),
    `live/history.mjs` (dump the stored `world/#` messages). Results go to `live/results/` (not committed).

## Limits (v0)

- **Join cost grows with stored history.** At join, net reads the newest 64 `world/#` messages to find peers and
  recent chat. entmoot-lite lists every stored message id of the group first (30-day retention), so join gets
  slower as the group's history grows.
- **No TURN.** Two players behind symmetric or strict NATs (or UDP-blocking firewalls) get no direct path. After the
  retries they stay on `world/pos`: one position per 20 s, so they see each other jump instead of walk.
- **Busy rooms.** A peer whose last hello is not in the newest 64 world messages is found at its next heartbeat
  (≤ 29 s) instead of at once.
- **Node connection gaps.** While the node connection is down (about 1 s after a dropped connection, ≤ 25 s plus the
  backoff after a node restart), only open P2P channels work. Chats from up to 30 s before the drop that were missed
  arrive late; older ones only via history.
- **Reload with the same key: up to ~35 s deaf.** If a page dies without closing (crash, killed tab) and the same key
  joins again, the node delivers nothing live to the new page until the old connection times out (measured
  34.6–35.5 s). After that, entmoot-lite subscribes again and live traffic resumes; chats sent in the gap are in
  history only. Without the resubscribe fix in entmoot-lite the page stayed deaf for its whole session. A
  node-side fix (prefer the newest connection of a peer id) would remove the gap.
- **Signal metadata is public:** the envelopes hide SDPs and IPs, but the group shows who sent a signal to whom
  and when.

## Live results (2026-11-17)

All runs used the live node and the private test group with `rate: {perMin: 12, burst: 24}`, unless noted. Each page
ran inside `<iframe sandbox="allow-scripts">` on the ordstudio sandbox host under ord's CSP. Latency = receiver
clock − sender's `t`; players on one host share a clock.

- **Two players, headless, one host:**
  - **Join:** 186–334 ms. Presence both ways at once; `t` arrived.
  - **P2P:** open 0.26 s after join (route host/host udp, rtt 1–5 ms).
  - **Chat:** both ways in 0.2–0.3 s.
  - **Movement:** 14.7–15.1 Hz received (the caller sends at 60 Hz, net caps at 15). Latency p50 4.1–15 ms, p95
    7–25 ms, max 33 ms over 20–210 s.
  - **Leave:** seen 9–18 ms after `close()`. No errors.
- **A third player in a desktop Chrome on a different network:** the route was srflx/host or prflx/host udp (a
  NAT-mapped path through STUN); join 209–236 ms; presence, chat and P2P both ways at 15.0–15.1 Hz, rtt 1–5 ms.
- **Strict NAT, simulated** (`iceTransportPolicy: 'relay'` and no TURN, so no ICE path):
  - Both sides reported `failed` after 19 s ("no answer or no route" / "no channel").
  - Presence and chat unaffected.
  - Movement fell back to `world/pos`: 3 states in 45 s each way (≤ 1 per 20 s), ~10 ms through the node.
- **10/min chat, rate check:** one player sent 30 chats at one per 6 s (plus hello, heartbeats, signal, bye ≈ 39
  messages in 3.3 min; standard 6/min burst 12 would allow ≈ 32). All 30 were received live and all 30 are stored on
  the node, with none refused locally.
- **Found live and fixed** (both have unit tests that fail without the fix):
  - **Old stored hello:** at join, a stored hello from a key's previous session (< 45 s old) could replace that key's
    live new session. The offer then went to a dead session.
  - **Join race:** when two players joined within the same second, each one's hello could go out before the other
    had subscribed and after it had listed history. The smaller id, the only offerer, then waited up to 29 s for a
    heartbeat. Now the larger id knocks after 8 s.
- **Deaf after a quick reload** (`live/admission.mjs`, `KILL=p2 REJOIN=15`): the node's first gossipsub RPC to the
  rejoined page came 34.6 s after connect, and the page then received nothing live, while its own publishes were
  relayed. With entmoot-lite re-subscribing when the node re-announces its subscriptions, live traffic resumed at
  once after the 35.5 s gap, and P2P opened.
- **Reconnect:**
  - **Node restart** (entmoot-lite's e2e, against a local entmootd): the page came back 20.5 s after the restart,
    and a message stored meanwhile arrived once, late.
  - **Dropped connection on the live node** (`live/drop.mjs`): the player was back in 1.08 s. Its P2P channel stayed
    open: 64 states got through during and after the drop. Chat then arrived live both ways. No errors.
- **Sealed signals, live:** P2P opened 1.06 s after join (host/host), 14.7 Hz both ways, latency p50 2.8/4.6 ms, p95
  6.4/7 ms; a third member reading the history saw every signal as `{v, e, n, c}` only. Older builds still storing
  plaintext offers can't link P2P with this one; with them only movement falls back to `world/pos`.
- **Public group "Ordibots World"** (`live/public-proof.mjs`, 3 bearer uses): two fresh keys joined in 154/128 ms,
  P2P opened (host/host, rtt 2 ms), they chatted both ways and B got A's moves at 15.1 Hz. A third fresh key read the
  group's 9 messages: 3 hello, 2 chat, 2 bye, 2 signal; both signals are `{v,e,n,c}` envelopes and no message on any
  topic contains "candidate", "sdp" or an IPv4 address.
