// No WebGPU: the same world from above on a 2D canvas (north up), bots as dots in their background colour with a
// heading tick. Same shape as the WebGPU renderer: { bot(t), frame(t, eye, target, onShot, ents), project(p) }.
function view2d(cv) {
  const g = cv.getContext('2d');
  let k = 1, c = [0, 0], W = 1, H = 1;
  const P = (x, z) => [W / 2 + (x - c[0]) * k, H / 2 + (z - c[1]) * k];
  const dot = (x, z, r) => {
    const [px, py] = P(x, z);
    g.beginPath(), g.arc(px, py, r * k, 0, 7), g.fill();
    return [px, py];
  };
  return {
    mode: '2d',
    bot: (t) => ({ bg: botTraits(t).bg, ready: true, visible: true, set() {}, remove() {} }),
    project: (p) => [...P(p[0], p[2])].map((v, i) => v - i * 9 * k),
    frame: (t, eye, tgt, onShot, ents) => {
      const r = Math.min(devicePixelRatio, 2);
      (W = cv.clientWidth), (H = cv.clientHeight), (k = Math.min(W, H) / 260), (c = [tgt[0], tgt[2]]);
      if (cv.width != Math.round(W * r)) (cv.width = Math.round(W * r)), (cv.height = Math.round(H * r));
      g.setTransform(r, 0, 0, r, 0, 0);
      g.fillStyle = '#5d5543', g.fillRect(0, 0, W, H);
      g.fillStyle = '#6c634d', dot(0, 0, 64);
      g.fillStyle = '#5ee';
      for (let i = 0; i < 48; i++) (g.globalAlpha = 0.55 + 0.45 * Math.sin(t * 1.7 + i * 1.3)), dot(Math.cos(i * 0.1309) * 70, Math.sin(i * 0.1309) * 70, 1.1);
      g.globalAlpha = 1, g.fillStyle = '#3c3b38';
      for (const [x, z, rr] of ROCKS) dot(x, z, rr);
      for (const e of ents)
        if (e.inst) {
          g.fillStyle = '#' + e.inst.bg.toString(16).padStart(6, '0');
          const [x, y] = dot(e.x, e.z, 6);
          g.strokeStyle = '#fff', g.lineWidth = e.me ? 3 : 1.5, g.stroke();
          g.beginPath(), g.moveTo(x, y), g.lineTo(x + Math.cos(e.yaw) * 10 * k, y - Math.sin(e.yaw) * 10 * k), g.stroke();
        }
      const v = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
      v.addColorStop(0, '#0a5a6a22'), v.addColorStop(1, '#021a26cc');
      g.fillStyle = v, g.fillRect(0, 0, W, H);
      onShot();
    },
  };
}
