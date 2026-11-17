// Shared by build.mjs and serve.mjs: the world child inscription and the test players' bots.
// The four test bots: number → trait index string (t), as in the Ordibots collection data.
export const BOTS = new Map([
  [1571, '3,12,14,16,42,24,25,37'],
  [375, '3,9,19,30,35'],
  [1170, '1,10,14,18,32,41,38'],
  [2, '38,2,11,13,21,33,26,27,39,43,36'],
].map(([id, t]) => [id, { id, t }]));
export const TEST_BOTS = [1571, 375, 1170, 2]; // p1…p4 in ../keys/players.json (local, gitignored)
// a child names its bot (OB, read by the engine) and swaps itself for the engine (the hangar child's pattern)
export const child = (b, engine) => `<!doctype html><script>OB={t:"${b.t}",id:${b.id}};fetch('/content/${engine}').then(r=>r.ok?r.text():0()).then(h=>{with(document)open(),write(h),close()}).catch(_=>document.write('Load failed'))</script>`;
