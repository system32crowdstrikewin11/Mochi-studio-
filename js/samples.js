/**
 * Procedural Mochi Samples + Smart Foreground Auto-Masking
 * Renders crisp 1024x1024 transparent artworks + pre-painted squishy masks!
 */

const ART_SIZE = 1024;

function makeCanvas(size = ART_SIZE) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

function buildMochiBear() {
  const art = makeCanvas();
  const ctx = art.getContext('2d');
  const cx = 512, cy = 532;

  // Soft pastel ground shadow
  const shGrad = ctx.createRadialGradient(cx, 782, 20, cx, 782, 245);
  shGrad.addColorStop(0, 'rgba(244, 210, 200, 0.48)');
  shGrad.addColorStop(1, 'rgba(244, 210, 200, 0)');
  ctx.fillStyle = shGrad;
  ctx.beginPath();
  ctx.ellipse(cx, 782, 240, 36, 0, 0, Math.PI * 2);
  ctx.fill();

  // Ears
  const drawEar = (ex, ey) => {
    ctx.fillStyle = '#fffaf0';
    ctx.beginPath();
    ctx.arc(ex, ey, 68, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffc9d9';
    ctx.beginPath();
    ctx.arc(ex, ey + 6, 36, 0, Math.PI * 2);
    ctx.fill();
  };
  drawEar(368, 294);
  drawEar(656, 294);

  // Plump mochi body
  const bodyGrad = ctx.createRadialGradient(452, 400, 40, cx, cy, 340);
  bodyGrad.addColorStop(0, '#ffffff');
  bodyGrad.addColorStop(0.68, '#fffaf0');
  bodyGrad.addColorStop(1, '#f9f0e4');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.ellipse(cx, cy, 312, 258, 0, 0, Math.PI * 2);
  ctx.fill();

  // Soft gloss highlight
  ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.beginPath();
  ctx.ellipse(446, 382, 74, 30, -0.25, 0, Math.PI * 2);
  ctx.fill();

  // Rosy blush cheeks
  const drawBlush = (bx, by) => {
    const g = ctx.createRadialGradient(bx, by, 8, bx, by, 84);
    g.addColorStop(0, 'rgba(255, 134, 168, 0.78)');
    g.addColorStop(0.6, 'rgba(255, 162, 188, 0.36)');
    g.addColorStop(1, 'rgba(255, 162, 188, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(bx, by, 86, 64, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  drawBlush(346, 560);
  drawBlush(678, 560);

  // Peaceful closed eyes
  ctx.strokeStyle = '#533935';
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(415, 506, 34, 0.18 * Math.PI, 0.82 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(609, 506, 34, 0.18 * Math.PI, 0.82 * Math.PI);
  ctx.stroke();

  // Cute 'w' mouth
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(476, 550);
  ctx.quadraticCurveTo(494, 578, 512, 554);
  ctx.quadraticCurveTo(530, 578, 548, 550);
  ctx.stroke();

  const mask = autoMaskFromArtwork(art, 512, { anchorBottom: true });
  return { art, mask };
}

function buildMochiCat() {
  const art = makeCanvas();
  const ctx = art.getContext('2d');
  const cx = 512, cy = 548;

  ctx.fillStyle = 'rgba(215, 175, 185, 0.30)';
  ctx.beginPath();
  ctx.ellipse(cx, 782, 240, 34, 0, 0, Math.PI * 2);
  ctx.fill();

  const drawCatEar = (sign) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = '#fffaf4';
    ctx.strokeStyle = '#5a433e';
    ctx.lineWidth = 14;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(sign * 105, -182);
    ctx.quadraticCurveTo(sign * 205, -315, sign * 255, -245);
    ctx.quadraticCurveTo(sign * 275, -165, sign * 240, -90);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffbdd0';
    ctx.beginPath();
    ctx.moveTo(sign * 138, -166);
    ctx.quadraticCurveTo(sign * 200, -250, sign * 228, -210);
    ctx.quadraticCurveTo(sign * 238, -160, sign * 214, -112);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  drawCatEar(-1);
  drawCatEar(1);

  const bg = ctx.createRadialGradient(460, 420, 40, cx, cy, 340);
  bg.addColorStop(0, '#ffffff');
  bg.addColorStop(0.75, '#fff8f0');
  bg.addColorStop(1, '#f5e7dc');
  ctx.fillStyle = bg;
  ctx.strokeStyle = '#5a433e';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.ellipse(cx, cy, 312, 224, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = '#dfb598';
  ctx.lineWidth = 13;
  ctx.lineCap = 'round';
  for (const dx of [-32, 0, 32]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx, 336);
    ctx.lineTo(cx + dx, 392);
    ctx.stroke();
  }

  for (const bx of [320, 704]) {
    const g = ctx.createRadialGradient(bx, 588, 10, bx, 588, 86);
    g.addColorStop(0, 'rgba(255, 118, 158, 0.78)');
    g.addColorStop(1, 'rgba(255, 118, 158, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(bx, 588, 88, 60, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const ex of [396, 628]) {
    ctx.fillStyle = '#47302c';
    ctx.beginPath();
    ctx.ellipse(ex, 520, 26, 33, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(ex - 8, 507, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ex + 9, 528, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#f28da8';
  ctx.beginPath();
  ctx.ellipse(cx, 558, 12, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#47302c';
  ctx.lineWidth = 11;
  ctx.beginPath();
  ctx.moveTo(476, 582);
  ctx.quadraticCurveTo(494, 608, 512, 584);
  ctx.quadraticCurveTo(530, 608, 548, 582);
  ctx.stroke();

  const mask = autoMaskFromArtwork(art, 512, { anchorBottom: true });
  return { art, mask };
}

function buildPudding() {
  const art = makeCanvas();
  const ctx = art.getContext('2d');
  const cx = 512;

  ctx.fillStyle = '#f2f5fa';
  ctx.strokeStyle = '#d7dfe9';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.ellipse(cx, 760, 340, 88, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  const custGrad = ctx.createLinearGradient(0, 340, 0, 740);
  custGrad.addColorStop(0, '#fff2a6');
  custGrad.addColorStop(0.5, '#ffe074');
  custGrad.addColorStop(1, '#f8c34c');
  ctx.fillStyle = custGrad;
  ctx.beginPath();
  ctx.moveTo(310, 390);
  ctx.quadraticCurveTo(cx, 330, 714, 390);
  ctx.lineTo(790, 700);
  ctx.quadraticCurveTo(cx, 795, 234, 700);
  ctx.closePath();
  ctx.fill();

  const carGrad = ctx.createLinearGradient(0, 310, 0, 500);
  carGrad.addColorStop(0, '#964720');
  carGrad.addColorStop(1, '#61250b');
  ctx.fillStyle = carGrad;
  ctx.beginPath();
  ctx.moveTo(310, 405);
  ctx.quadraticCurveTo(cx, 315, 714, 405);
  ctx.quadraticCurveTo(735, 455, 695, 470);
  ctx.quadraticCurveTo(660, 480, 645, 445);
  ctx.quadraticCurveTo(610, 520, 565, 478);
  ctx.quadraticCurveTo(512, 430, 470, 495);
  ctx.quadraticCurveTo(425, 515, 395, 455);
  ctx.quadraticCurveTo(350, 485, 310, 405);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, 332, 54, 0, Math.PI * 2);
  ctx.arc(cx - 42, 348, 34, 0, Math.PI * 2);
  ctx.arc(cx + 42, 348, 34, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#e83856';
  ctx.beginPath();
  ctx.arc(cx + 8, 286, 36, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.beginPath();
  ctx.arc(cx - 4, 274, 11, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#5a321a';
  ctx.beginPath();
  ctx.arc(430, 590, 17, 0, Math.PI * 2);
  ctx.arc(594, 590, 17, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = '#5a321a';
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, 608, 22, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  for (const bx of [366, 658]) {
    ctx.fillStyle = 'rgba(255, 110, 130, 0.45)';
    ctx.beginPath();
    ctx.ellipse(bx, 614, 42, 24, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  const mask = makeCanvas(512);
  const mctx = mask.getContext('2d');
  const g = mctx.createRadialGradient(256, 250, 30, 256, 260, 210);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.95)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  mctx.fillStyle = g;
  mctx.beginPath();
  mctx.ellipse(256, 248, 185, 155, 0, 0, Math.PI * 2);
  mctx.fill();
  mctx.globalCompositeOperation = 'destination-out';
  const bot = mctx.createLinearGradient(0, 345, 0, 410);
  bot.addColorStop(0, 'rgba(0,0,0,0)');
  bot.addColorStop(1, 'rgba(0,0,0,1)');
  mctx.fillStyle = bot;
  mctx.fillRect(0, 340, 512, 180);

  return { art, mask };
}

function buildBunny() {
  const art = makeCanvas();
  const ctx = art.getContext('2d');
  const cx = 512, cy = 590;

  ctx.fillStyle = 'rgba(185, 145, 205, 0.26)';
  ctx.beginPath();
  ctx.ellipse(cx, 816, 230, 34, 0, 0, Math.PI * 2);
  ctx.fill();

  const drawBunnyEar = (sign) => {
    ctx.save();
    ctx.translate(cx + sign * 96, 360);
    ctx.rotate(sign * 0.24);
    ctx.fillStyle = '#fff5fb';
    ctx.strokeStyle = '#6c4d63';
    ctx.lineWidth = 13;
    ctx.beginPath();
    ctx.ellipse(0, -105, 58, 165, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffc5e1';
    ctx.beginPath();
    ctx.ellipse(0, -100, 30, 118, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  drawBunnyEar(-1);
  drawBunnyEar(1);

  const grad = ctx.createRadialGradient(455, 480, 40, cx, cy, 310);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.7, '#fff2fa');
  grad.addColorStop(1, '#f6dced');
  ctx.fillStyle = grad;
  ctx.strokeStyle = '#6c4d63';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.ellipse(cx, cy, 290, 224, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  for (const bx of [332, 692]) {
    const g = ctx.createRadialGradient(bx, 628, 10, bx, 628, 84);
    g.addColorStop(0, 'rgba(255, 126, 178, 0.78)');
    g.addColorStop(1, 'rgba(255, 126, 178, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(bx, 628, 86, 58, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const ex of [404, 620]) {
    ctx.fillStyle = '#53354a';
    ctx.beginPath();
    ctx.ellipse(ex, 566, 24, 30, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(ex - 7, 554, 9, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = '#53354a';
  ctx.lineWidth = 11;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, 594);
  ctx.lineTo(cx, 624);
  ctx.moveTo(cx - 26, 634);
  ctx.quadraticCurveTo(cx - 12, 646, cx, 624);
  ctx.quadraticCurveTo(cx + 12, 646, cx + 26, 634);
  ctx.stroke();

  const mask = autoMaskFromArtwork(art, 512, { anchorBottom: true });
  return { art, mask };
}

/** Smart Foreground Auto-Masking with gentle ground-shadow anchoring */
export function autoMaskFromArtwork(imgOrCanvas, size = 512, opts = {}) {
  const anchorBottom = opts.anchorBottom !== false;
  const src = makeCanvas(size);
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(imgOrCanvas, 0, 0, size, size);
  const d = sctx.getImageData(0, 0, size, size).data;

  let transparentCount = 0;
  for (let i = 3; i < d.length; i += 16) {
    if (d[i] < 200) transparentCount++;
  }
  const hasAlpha = transparentCount > (size * size / 4) * 0.08;

  const corners = [0, (size - 1) * 4, (size - 1) * size * 4, (size * size - 1) * 4];
  let bgR = 0, bgG = 0, bgB = 0;
  for (const idx of corners) {
    bgR += d[idx]; bgG += d[idx + 1]; bgB += d[idx + 2];
  }
  bgR /= 4; bgG /= 4; bgB /= 4;

  const out = makeCanvas(size);
  const octx = out.getContext('2d');
  const outImg = octx.createImageData(size, size);
  const od = outImg.data;

  let fgCount = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let m = 0;
      if (hasAlpha) {
        m = d[i + 3] > 28 ? 255 : 0;
      } else {
        const dist = Math.hypot(d[i] - bgR, d[i + 1] - bgG, d[i + 2] - bgB);
        m = dist > 26 ? 255 : 0;
      }
      if (m > 0) fgCount++;
      od[i] = 255; od[i + 1] = 255; od[i + 2] = 255; od[i + 3] = m;
    }
  }
  octx.putImageData(outImg, 0, 0);

  if (fgCount < size * size * 0.04 || fgCount > size * size * 0.90) {
    octx.clearRect(0, 0, size, size);
    const g = octx.createRadialGradient(size * 0.5, size * 0.5, size * 0.1, size * 0.5, size * 0.5, size * 0.44);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.82, 'rgba(255,255,255,0.96)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    octx.fillStyle = g;
    octx.fillRect(0, 0, size, size);
    return out;
  }

  const soft = makeCanvas(size);
  const fctx = soft.getContext('2d');
  fctx.filter = 'blur(16px)';
  fctx.drawImage(out, 0, 0);
  fctx.filter = 'blur(7px)';
  fctx.drawImage(out, 0, 0);
  fctx.filter = 'none';

  if (anchorBottom) {
    // Keep ground shadow calm while keeping body 100% plump & squishy
    fctx.globalCompositeOperation = 'destination-out';
    const bGrad = fctx.createLinearGradient(0, size * 0.74, 0, size * 0.90);
    bGrad.addColorStop(0, 'rgba(0,0,0,0)');
    bGrad.addColorStop(1, 'rgba(0,0,0,0.86)');
    fctx.fillStyle = bGrad;
    fctx.fillRect(0, size * 0.72, size, size * 0.28);
    fctx.globalCompositeOperation = 'source-over';
  }

  return soft;
}

/** Full-image paint mask when user explicitly taps "All squishy" in Paint mode */
export function fullSquishyMask(imgOrCanvas, size = 512) {
  const src = makeCanvas(size);
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(imgOrCanvas, 0, 0, size, size);
  const d = sctx.getImageData(0, 0, size, size).data;

  let transparentCount = 0;
  for (let i = 3; i < d.length; i += 16) {
    if (d[i] < 200) transparentCount++;
  }
  const hasAlpha = transparentCount > (size * size / 4) * 0.06;

  const out = makeCanvas(size);
  const octx = out.getContext('2d');
  if (hasAlpha) {
    const outImg = octx.createImageData(size, size);
    const od = outImg.data;
    for (let i = 0; i < d.length; i += 4) {
      od[i] = 255; od[i + 1] = 255; od[i + 2] = 255;
      od[i + 3] = d[i + 3] > 20 ? 255 : 0;
    }
    octx.putImageData(outImg, 0, 0);
    const soft = makeCanvas(size);
    const fctx = soft.getContext('2d');
    fctx.filter = 'blur(8px)';
    fctx.drawImage(out, 0, 0);
    fctx.filter = 'none';
    return soft;
  }
  // Opaque image: fill entire interior cleanly (leaving a tiny 4% outer margin)
  const pad = Math.round(size * 0.04);
  octx.fillStyle = '#ffffff';
  octx.fillRect(pad, pad, size - pad * 2, size - pad * 2);
  return out;
}

const CACHE = {};
export function getSample(key) {
  if (!CACHE[key]) {
    if (key === 'bear') CACHE[key] = buildMochiBear();
    else if (key === 'cat') CACHE[key] = buildMochiCat();
    else if (key === 'pudding') CACHE[key] = buildPudding();
    else CACHE[key] = buildBunny();
  }
  return CACHE[key];
}
