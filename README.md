# Ordibots World

A multiplayer world for Ordibots holders, built to live in **one Bitcoin inscription**. You walk
your own Ordibot around a reef plaza, see the other holders' bots move in real time and chat with them. There is no
game server: the engine is a single self-contained HTML file that runs inside ord's iframe sandbox and CSP, and every
player checks every other player for themselves.

- **Rendering:** WebGPU. The bots are assembled from their on-chain trait models (`/content/<asset id>`) exactly like
  the collection's renderer: glTF, PBR, shadows, bloom. Browsers without WebGPU get a 2D view.
- **Login:** `login.html` connects Xverse, lists the Ordibots the wallet holds and asks for **one BIP-322 message
  signature** (no transaction, no fee). The signed statement binds the bot, the address, the player's per-device
  Entmoot key and the world's group, and expires after 7 days.
- **Ownership:** every player verifies every other player's proof in the browser (`login/proof.js`: BIP-322 simple
  for P2TR and P2WPKH, BIP-340 Schnorr, ECDSA, no dependencies) and checks it against the ord server the page is
  served from: `/r/inscription/<bot>` (current holder), `/r/parents/<bot>` (it is an Ordibot) and `/content/<bot>`
  (its number and traits). Unverified players are hidden unless you turn on "show unverified".
- **Chat and presence:** an [Entmoot](https://github.com/jerryfane/entmoot) group over libp2p WebRTC-direct, through
  [entmoot-lite](https://github.com/jerryfane/entmoot-lite) (vendored as `net/entmoot-lite.js`). The world's bearer
  invite is embedded in the engine, so a new player joins without asking anyone.
- **Movement:** direct WebRTC data channels between players (15 Hz, unordered, latest wins). The offers and answers
  go through the group **encrypted to the recipient** (X25519 + HKDF + AES-GCM, keys derived from the players'
  Entmoot keys), so the public group never shows anyone's IP candidates. Players with no direct path fall back to a
  position every 20 s through the group.

**Nothing is inscribed yet.** Everything here has been tested in ordstudio's sandbox
(the same iframe sandbox and CSP as ord) and against the live Entmoot node.

## Sizes

| File | Raw | Brotli (q11) | What |
| --- | --- | --- | --- |
| `dist-public/world.html` | 88,946 B | **34,630 B** | the engine: renderer, net.js, entmoot-lite, proof verifier, bearer invite (budget 40,960 B) |
| `dist-public/login.html` | 15,371 B | 6,697 B | Xverse login, signs the proof, opens the engine |
| `dist-public/world-dev.html` | 54,026 B | 22,107 B | the engine with a fake network, for local testing |
| `dist-public/bot-NNNN.html` | 206–223 B | | one child per bot: names the bot, then loads the engine |

`dist-public/ordstudio.json` is the inscription manifest: `world.html` is the parent (inscribed with `--compress`,
brotli), each bot page a child.

## Layout

```
world/        the engine: src/ (world.js, render.js, shaders.js, view2d.js, fakenet.js), hangar/ (bot math, glTF
              reader, trait table, from the Ordibots WebGPU renderer), build.mjs, config/, serve.mjs (local fake
              ord server), shot.mjs (headless WebGPU screenshots)
net/          net.js: presence, chat, P2P movement, signal encryption over entmoot-lite. README.md has the protocol.
login/        proof.js (statement + BIP-322 verifier + ord checks), login.js (Xverse), tests with the official
              BIP-322 and BIP-340 vectors. INVITE.md: the bearer invite and its rotation design.
dist-public/  the public build (group "Ordibots World"), byte-for-byte what build.mjs produces
vendor/       entmoot-lite as a git submodule at the commit net/entmoot-lite.js was built from (for the net tests)
```

## Build

Node 22+.

```sh
cd world && npm ci && cd ..
BUILD=public node world/build.mjs     # → dist-public/ (world.html, world-dev.html, login.html, bot-*.html, ordstudio.json)
```

The build reproduces `dist-public/` byte for byte. Each config in `world/config/` names the Entmoot group, the bearer
invite file and the output directory. `config/public.json` uses `config/public-invite.json`, the same invite that ships
inside `world.html`. `config/test.json` (the private test group, the default `BUILD`) expects its invite in
`config/test-invite.json`, which is not in the repo; without it the test build has no embedded invite.
`ENGINE=<inscription id>` points the children at an inscribed engine instead of ordstudio's `local:world`.

## Tests

```sh
git submodule update --init           # entmoot-lite's fake node, used by the net tests
cd net && npm test                    # net.js: presence, chat, P2P, rate budget, reconnect, signal encryption, proofs
cd ../login && npm ci && npm test     # proof.js: BIP-322 / BIP-340 vectors, tampering, ord checks, invites
```

`net/live/` and `login/live/` hold the scripts used against the live node and the ordstudio sandbox (Playwright). They
need local member keys in `keys/`, which are never committed.

## How decentralized is it?

Honest answer: not fully yet.

| Piece | Today | Trust / failure mode |
| --- | --- | --- |
| Engine code | one inscription (planned), immutable | none once inscribed |
| Ownership | each browser verifies BIP-322 proofs itself | **trusts the ord server** it is served from for `/r/inscription`, `/r/parents` and `/content` |
| Chat and presence | Entmoot group | **a single Entmoot node** (`entmootd`) today: if it is down, nobody can join, chat or find peers. Messages are signed by their authors, so the node can drop or delay them but not forge them |
| Peer discovery for P2P | signals through the group, encrypted to the recipient | same single node; it sees who signals whom, not the content |
| NAT traversal | **Google's public STUN** (`stun.l.google.com:19302`) | Google sees the players' public addresses when they connect |
| Relay | **no TURN** | players behind strict NATs can't link directly and see each other move once per 20 s |
| Group admission | bearer invite embedded in the engine (64 uses, rotation designed in `login/INVITE.md`) | once used up or expired, new players need a newer invite |
| Identity key | per-device Ed25519 key, kept in IndexedDB | on ordinals.com any top-level inscription can read it and act as that member until the proof expires; it can't get a wallet signature |

## License

MIT, see [LICENSE](LICENSE). entmoot-lite is MIT as well.
