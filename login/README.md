# Ordibots World login: ownership proved in the world, no external dependency

Bearer invite and rotation: INVITE.md.

## Files
- **`proof.js`** (≈ 18 KB source; bundled into world.html and login.html). It holds:
  - the statement;
  - the BIP-322 simple verifier: P2TR key path (BIP-340 Schnorr) and P2WPKH (BIP-143 + ECDSA, low-S, strict DER), built from bech32/bech32m, RIPEMD-160 and BigInt secp256k1 (verify only);
  - `makeVerifier({group})`, which checks `/r/inscription` (holder), `/r/parents` (Ordibots parent) and `/content` (`t=` traits, `id=` number), with a 10 min cache (30 s after an ord error);
  - `pickInvite`.
- **`login.js`** builds into `../dist/login.html`. It uses the Xverse injected provider:
  - `wallet_connect`, with `getAddresses` as fallback, for the ordinals address;
  - `ord_getInscriptions`, then a parent and holder check on this ord server;
  - a pick list, with a paste-an-id fallback;
  - the per-device Ed25519 key, kept in IndexedDB where the origin has storage;
  - one `signMessage` (BIP322), then a check with the same verifier;
  - the world opens at `/content/<world>#k=…&p=…`.

  It needs no npm wallet bundle.
- **`../net/net.js`** gains `proof` and `verify`:
  - the hello, pos and signal messages carry `p`;
  - `'peer'` fires once the proof is checked, with `verified`, and with the bot and traits from the proven bot;
  - `'verify'` fires when a verdict changes;
  - chats carry `verified`.

  See net/README.md.
- **`../world/src/world.js`**:
  - unverified players and their chats are hidden;
  - a "show unverified (n)" toggle (or `#ghosts`) shows them as plain grey ghosts named "unverified";
  - your own bot and traits come from `/content/<proof.bot>`;
  - the status line shows whether you are verified;
  - the engine embeds the bearer invite, and `#inv` overrides it. v0 links still work.
- **`../world/build.mjs`** bundles proof.js, the invite and login.html.

## Sizes (brotli 11, public build `dist-public/`)
| File | Raw | Brotli | Note |
| --- | --- | --- | --- |
| world.html | 88,946 B | **34,630 B** | proof.js, net.js, entmoot-lite and the bearer invite included; under the 40,960 B budget |
| world-dev.html | 54,026 B | 22,107 B | fake network, for local testing |
| login.html | 15,371 B | 6,697 B | |

## Tests
- **`login/test/proof.test.js`** (`npm test` in login/): 15/15 pass. They cover:
  - the official BIP-322 vectors: 8 simple P2WPKH/P2TR signatures valid, all 36 error vectors rejected, P2WSH/full/P2PKH refused;
  - all BIP-340 verify vectors;
  - RIPEMD-160 and the message hash against references;
  - locally signed throwaway taproot and P2WPKH proofs;
  - tampering: every signature byte, each statement field (member, group, bot, iat, exp), the wrong address or address type, a foreign key over the correct sighash, high-S, expiry, future iat, lifetime;
  - a non-child bot, an address mismatch (including a holder change noticed after the cache), the cache running past expiry, ord down → retry;
  - pickInvite.

  Mutation check: removing low-S, holder, parent, expiry, pubkey-hash binding, checksum, even-R, member-in-statement or cache-expiry each turns a test red.
- **`net/test`** (`npm test` in net/): 25/25 pass, 4 of them in verify.test.js (ownership proofs).
- **`login/live/world.mjs`**: the ordstudio sandbox, two players on the live node, existing member keys only (no bearer use). Nothing is uploaded: `live/local.mjs` serves the build under test (`BUILD`, default `dist`) and answers /r/inscription and /r/parents in the browser. Chat is typed for real (click `#c`, keyboard, Enter) by both players each phase: B's line must reach A only when B is verified, A's line must always reach B. Green on the current build; red on the build before the Xverse wait fix (its chat box cancelled every keystroke). Phases:

  | Phase | B's proof | A's view of B |
  | --- | --- | --- |
  | 1 | bot held by another address | stays hidden; the toggle shows a grey "unverified" ghost |
  | 2 | tampered signature | stays hidden |
  | 3 | valid (the chain answers now name B as holder) | shown as #375, verified |

  Screenshots go to `live/shots/` (not committed). Needs `playwright`, `ORDSTUDIO_API` and local member keys in `../keys/` (never committed).
- **`login/live/toplevel.mjs`**: login.html opened top-level, same local serving. The mock Xverse provider appears 1 s after load, as the real one does. The second login reuses the key and proof from IndexedDB (no signMessage), and the world clears the hash. With no provider, the page is still looking at 1.5 s and says "No Xverse found" after its 4 s wait; framed, it says it needs a top-level page. Green on the current build, red on the build before the fix (it gave up before the provider appeared).

## Where it works
| Step | ordinals.com /content top-level | ordstudio sandbox (iframe) | wallet / marketplace iframe |
| --- | --- | --- | --- |
| Xverse provider | yes (content script runs on top-level pages; manifest 2.12.0 has no all_frames) | no | no |
| /r/ and /content checks | yes (same origin) | yes | yes, if the frame is on an ord server |
| Device key kept | yes: IndexedDB on ordinals.com (shared with every inscription there, see below) | no: new key per login, i.e. a new member and a bearer use | no |
| World with key + proof in hash | yes | yes (tested) | yes, if the hash is passed |

In a frame, login.html says to open the inscription on its own.

## Limits
- **The key can't be non-extractable.** entmoot-lite's `join` takes a raw seed, and the hash handoff needs it raw. On ordinals.com, any top-level inscription can read the IndexedDB seed and act as that Entmoot member until the proof expires (7 days). It can't get a wallet signature.
  - Fix: entmoot-lite accepts a CryptoKey, and the world reads it from IndexedDB when top-level.
- **Every login without storage costs one bearer use.**

## Manual checklist (real Xverse, nothing signed but a message)
Open login.html **in its own tab** (top-level on an ord server, not inside a preview frame). A new origin means a new key and one bearer use.
1. In Chrome with Xverse unlocked, open the login page. Click **Connect Xverse** and approve. Your ordinals bc1p… address appears.
2. Your Ordibots are listed. If none are, paste one Ordibot's inscription id and press Enter. If it says "not an Ordibot held by…", note the id and address.
3. Click a bot. Xverse shows the message (Domain ordibots-world, Group, Member, Bot, Address, Issued/Expires) and asks you to sign. Sign it; there is no fee.
4. The world opens. The status line should read `Ordibot #<yours> · online · … · verified`.
5. Open the same page in a browser profile without Xverse. It should say "No Xverse found".

## Fix 2026-11-17: "No Xverse found" with Xverse installed
Xverse 2.12.0's content script adds `inpage.js` as a `<script src>` only after an async check, so its provider
appears after login.html's own script has run. The page checked once and gave up. It now waits up to 4 s.
Verified with the real Xverse 2.12.0 extension loaded in Chromium: the old page shows "No Xverse found", the new one
shows the Connect button. The mock in live/toplevel.mjs defined the provider before
page scripts (addInitScript), which is why the test missed it.
