# Bearer invite in the world: join test and rotation design (2026-11-17)

## Live test: a fresh key joins with the bearer invite (done)

`login/live/bearer.mjs`, run from headless Chromium, each player in `<iframe sandbox="allow-scripts">` on the ordstudio
sandbox host (`live.html` + `net.js` + vendored entmoot-lite e1813a0, unchanged).
- **Players:** a fresh throwaway key (made for this test, never a member before) with the test group's bearer
  invite; an existing member on the other side.
- **Run 1, 2026-11-17:**
  - the fresh key joined in 219 ms: dial, membership read with the bearer capability, `membership-push` of the join
    record, roster re-read shows the key.
  - History read: 64 `world/#` messages, 18 of them chats.
  - Chat arrived in 0.26 s each way. Presence worked both ways. No errors.
- **Run 2:** the same key joined again in 182 ms as a member. The invite isn't pushed again, because entmoot-lite
  only uses it when the roster lacks the key.
- **Uses:** 1 bearer use. entmoot-lite needed no change: its join path has no target check on the client, and the
  node accepts `IsOpenInvite()` capabilities on the same membership-push path.

## Rotation: v1 design (only the hook is built)

The invite inside the engine inscription can't be changed later, so the engine has to accept a newer one. Here are the
three options:

| Option | How the page finds the newest | Who can publish | Verdict |
| --- | --- | --- | --- |
| In the group | read a topic after joining | any admin | **No.** Reading needs a capability, so once the embedded invite expires or is used up, a new player can't read the group to find the new invite. It only helps players who are already members, and they don't need it. |
| Child inscription | `/r/children/<parent>/inscriptions/<page>`, then the last page, then `/content/<id>` | the holder of the parent | Works, but finding the newest child means paging (100 per page). |
| **Sat reinscription** | `/r/sat/<S>/at/-1` → `{id}`, then `/content/<id>` | the holder of sat S | **Chosen.** It's two fixed recursive calls, needs no paging, and every ord server answers them. |

**v1:**
1. **Before the engine:** inscribe `invite-world.json` (the bearer invite JSON). Its sat `S` is the config sat. The
   engine embeds `S` and that invite's JSON as the fallback.
2. **Rotation:** to rotate (a new nonce, a later expiry, a revoked or used-up invite), the owner reinscribes sat `S`
   with the new invite JSON (`ord wallet inscribe --reinscribe`). The engine never changes.
3. **At start:** the page collects the candidates: the embedded invite, the newest inscription on `S`, and optionally
   one passed in the login hash (`inv=`). It keeps those that:
   - parse;
   - have `group_id` equal to the world's group;
   - have no target (`TargetPublicKey` empty);
   - haven't expired.

   It then uses the one with the latest `issued_at_ms`. Because the candidates are only ever compared, a fetch that
   fails or returns junk leaves the embedded invite in use.
4. **Security:** whoever holds sat `S` can publish a candidate, but the node accepts only invites signed by the founder
   or a delegated admin. So a foreign or forged invite only fails the join, and the page falls back to the next
   candidate. Two settings keep the risk bounded:
   - Keep `S` in the owner's cold wallet.
   - Give the embedded invite a long expiry and a generous `max_uses`. Each identity costs roster space on every
     node, and the world's ownership proof decides who is *shown*; membership doesn't.

**Built now:**
- `pickInvite(candidates, groupId, now)` in `login/proof.js`.
- The engine calls it on [embedded, hash `inv`].

**Not built yet:** fetching `/r/sat/<S>/at/-1`. It's a single extra candidate once `S` exists, after the config
inscription.
