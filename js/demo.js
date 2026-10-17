// Generates a synthetic "shoot" entirely in the browser so the app can be tried
// without Google credentials. Each scene has several near-identical takes.

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawScene(ctx, W, H, scene, take, rand) {
  const { hue, people, horizon, sun } = scene;
  const jitter = (n) => (rand() - 0.5) * n;
  const light = 1 + jitter(0.12);

  const sky = ctx.createLinearGradient(0, 0, 0, H * horizon);
  sky.addColorStop(0, `hsl(${hue} 55% ${Math.round(62 * light)}%)`);
  sky.addColorStop(1, `hsl(${(hue + 30) % 360} 60% ${Math.round(82 * light)}%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = `hsl(${(hue + 50) % 360} 90% 85%)`;
  ctx.beginPath();
  ctx.arc(W * sun.x + jitter(6), H * sun.y, H * 0.08, 0, Math.PI * 2);
  ctx.fill();

  const ground = ctx.createLinearGradient(0, H * horizon, 0, H);
  ground.addColorStop(0, `hsl(${(hue + 160) % 360} 30% ${Math.round(38 * light)}%)`);
  ground.addColorStop(1, `hsl(${(hue + 170) % 360} 35% ${Math.round(22 * light)}%)`);
  ctx.fillStyle = ground;
  ctx.fillRect(0, H * horizon, W, H);

  people.forEach((p, i) => {
    const x = W * p.x + jitter(W * 0.012) + take * 2;
    const y = H * horizon + H * 0.05;
    const s = H * p.size;
    ctx.fillStyle = `hsl(${p.shirt} 55% 45%)`;
    ctx.beginPath();
    ctx.roundRect(x - s * 0.45, y - s * 0.1, s * 0.9, s * 1.1, s * 0.25);
    ctx.fill();
    ctx.fillStyle = `hsl(28 45% ${p.skin}%)`;
    ctx.beginPath();
    ctx.arc(x, y - s * 0.38, s * 0.3, 0, Math.PI * 2);
    ctx.fill();
    // eyes — sometimes someone blinks in a take
    const blink = rand() < 0.18 && i === take % people.length;
    ctx.fillStyle = '#222';
    for (const dx of [-0.11, 0.11]) {
      ctx.beginPath();
      if (blink) ctx.fillRect(x + dx * s - s * 0.05, y - s * 0.42, s * 0.1, s * 0.015);
      else ctx.arc(x + dx * s, y - s * 0.42, s * 0.035, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = '#222';
    ctx.lineWidth = s * 0.02;
    ctx.beginPath();
    const smile = rand() < 0.7;
    ctx.arc(x, y - s * (smile ? 0.33 : 0.27), s * 0.1, smile ? 0.15 * Math.PI : 1.15 * Math.PI, smile ? 0.85 * Math.PI : 1.85 * Math.PI);
    ctx.stroke();
  });

  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.font = `${Math.round(H * 0.03)}px system-ui, sans-serif`;
  ctx.fillText(`Scene ${scene.n} · take ${take + 1}`, W * 0.03, H * 0.95);
}

export async function makeDemoPhotos(count = 22) {
  const rand = rng(20261017);
  const W = 1500, H = 1000;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const photos = [];
  let t = Date.parse('2026-09-12T15:00:00');
  let frame = 1001;

  for (let n = 1; n <= count; n++) {
    const scene = {
      n,
      hue: Math.floor(rand() * 360),
      horizon: 0.55 + rand() * 0.15,
      sun: { x: 0.1 + rand() * 0.8, y: 0.12 + rand() * 0.2 },
      people: [],
    };
    const nPeople = 1 + Math.floor(rand() * 4);
    scene.people = Array.from({ length: nPeople }, (_, i) => ({
      x: (i + 1) / (nPeople + 1) + (rand() - 0.5) * 0.08,
      size: 0.22 + rand() * 0.12,
      shirt: Math.floor(rand() * 360),
      skin: 45 + Math.floor(rand() * 30),
    }));
    const takes = rand() < 0.25 ? 1 : 2 + Math.floor(rand() * 5);
    for (let k = 0; k < takes; k++) {
      drawScene(ctx, W, H, scene, k, rand);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
      const url = URL.createObjectURL(blob);
      photos.push({
        id: `demo-${frame}`,
        name: `DSC_${frame}.jpg`,
        path: '',
        time: t,
        width: W,
        height: H,
        thumb: () => url,
      });
      frame++;
      t += 1000 + Math.floor(rand() * 1500);
    }
    t += 60_000 + Math.floor(rand() * 240_000);
  }
  return photos;
}
