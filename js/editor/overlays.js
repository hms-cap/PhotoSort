// Drawings and text, positioned relative to the final (cropped) frame.

export const FONTS = [
  { id: 'sans', label: 'Sans', css: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif' },
  { id: 'serif', label: 'Serif', css: 'Georgia, "Times New Roman", serif' },
  { id: 'script', label: 'Script', css: '"Brush Script MT", "Segoe Script", "Snell Roundhand", cursive' },
  { id: 'mono', label: 'Mono', css: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  { id: 'display', label: 'Display', css: 'Impact, "Arial Black", "Helvetica Neue", sans-serif' },
];
const fontCss = (id) => (FONTS.find((f) => f.id === id) || FONTS[0]).css;

export function drawStrokes(ctx, strokes, ow, oh) {
  const long = Math.max(ow, oh);
  for (const s of strokes) {
    if (!s.pts?.length) continue;
    ctx.save();
    ctx.globalAlpha = s.alpha ?? 1;
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
    ctx.lineWidth = Math.max(1, s.size * long);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const P = s.pts.map(([x, y]) => [x * ow, y * oh]);
    ctx.beginPath();
    if (P.length === 1) {
      ctx.arc(P[0][0], P[0][1], ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(P[0][0], P[0][1]);
      for (let i = 1; i < P.length - 1; i++) {
        const mx = (P[i][0] + P[i + 1][0]) / 2, my = (P[i][1] + P[i + 1][1]) / 2;
        ctx.quadraticCurveTo(P[i][0], P[i][1], mx, my);
      }
      const L = P.at(-1);
      ctx.lineTo(L[0], L[1]);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function textLayout(ctx, t, ow, oh) {
  const long = Math.max(ow, oh);
  const px = Math.max(4, t.size * long);
  ctx.font = `${t.italic ? 'italic ' : ''}${t.weight || 700} ${px}px ${fontCss(t.font)}`;
  const lines = String(t.text || ' ').split('\n');
  const lh = px * 1.18;
  const widths = lines.map((l) => ctx.measureText(l || ' ').width);
  const tw = Math.max(...widths), th = lh * lines.length;
  const pad = t.bg ? px * 0.35 : px * 0.1;
  const cx = t.x * ow, cy = t.y * oh;
  return { px, lines, lh, widths, tw, th, pad, cx, cy,
    box: { x: cx - tw / 2 - pad, y: cy - th / 2 - pad, w: tw + pad * 2, h: th + pad * 2 } };
}

export function textBox(ctx, t, ow, oh) {
  return textLayout(ctx, t, ow, oh).box;
}

export function drawTexts(ctx, texts, ow, oh) {
  for (const t of texts) {
    if (!t.text) continue;
    ctx.save();
    const L = textLayout(ctx, t, ow, oh);
    if (t.bg) {
      ctx.fillStyle = t.bg;
      roundRect(ctx, L.box.x, L.box.y, L.box.w, L.box.h, L.px * 0.25);
      ctx.fill();
    }
    ctx.fillStyle = t.color || '#fff';
    ctx.textBaseline = 'middle';
    if (t.shadow) { ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = L.px * 0.18; ctx.shadowOffsetY = L.px * 0.05; }
    if (t.outline) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1, L.px * 0.09);
      ctx.strokeStyle = t.outline;
    }
    L.lines.forEach((line, i) => {
      const y = L.cy - L.th / 2 + L.lh * (i + 0.5);
      let x;
      const align = t.align || 'center';
      if (align === 'left') { ctx.textAlign = 'left'; x = L.cx - L.tw / 2; }
      else if (align === 'right') { ctx.textAlign = 'right'; x = L.cx + L.tw / 2; }
      else { ctx.textAlign = 'center'; x = L.cx; }
      if (t.outline) ctx.strokeText(line, x, y);
      ctx.fillText(line, x, y);
    });
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
