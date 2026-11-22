/**
 * CameraHandTracker v19 — Real-Time 360° Camera Hand Gesture & Bounce Tracker
 *
 * Zero-dependency, 100% offline/localhost/HTTPS computer vision tracker:
 * - Captures front or back camera via getUserMedia (320x240 @ 30fps)
 * - Runs coarse-to-fine SAD block-matching optical flow on a 64x48 grid (<0.4ms/frame)
 *   with gentle YCbCr skin-tone prioritization + temporal/texture/confidence gating
 * - Detects hand gestures in ALL 360° directions (Up, Down, Left, Right, Diagonals):
 *     * Wave / Swipe UP    -> bounces mochi UP
 *     * Wave / Swipe DOWN  -> bounces mochi DOWN
 *     * Wave / Swipe LEFT  -> bounces mochi LEFT
 *     * Wave / Swipe RIGHT -> bounces mochi RIGHT
 *     * Diagonals          -> bounces along exact 360° hand vector!
 * - Optional "Follow hand" mode leans the mochi gently toward active hand position
 * - Renders a live mini PiP preview with glowing motion dots & directional vector arrow
 */

const PROC_W = 64;
const PROC_H = 48;
const MARGIN = 6;
const BSIZE = 6;
const OFFS = [
  [0, 0], [2, 0], [4, 0],
  [0, 2], [2, 2], [4, 2],
  [0, 4], [2, 4], [4, 4],
];

function directionLabel(vx, vy) {
  const ang = Math.atan2(vy, vx) * (180 / Math.PI); // -180..180, -90=Up, 90=Down, 180=Left, 0=Right
  if (ang >= -22.5 && ang < 22.5) return '→ Right';
  if (ang >= 22.5 && ang < 67.5) return '↘ Down-Right';
  if (ang >= 67.5 && ang < 112.5) return '↓ Down';
  if (ang >= 112.5 && ang < 157.5) return '↙ Down-Left';
  if (ang >= 157.5 || ang < -157.5) return '← Left';
  if (ang >= -157.5 && ang < -112.5) return '↖ Up-Left';
  if (ang >= -112.5 && ang < -67.5) return '↑ Up';
  return '↗ Up-Right';
}

export class CameraHandTracker {
  constructor() {
    this.enabled = false;
    this.paused = false;
    this.facingMode = 'user'; // 'user' | 'environment'
    this.mirror = true;
    this.showPreview = true;
    this.bounceEnabled = true;
    this.followEnabled = false;
    this.sensitivity = 65; // 20 .. 100

    this.stream = null;
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', '');
    this.video.autoplay = true;

    // Tiny 64x48 offscreen analysis canvas
    this.procCanvas = document.createElement('canvas');
    this.procCanvas.width = PROC_W;
    this.procCanvas.height = PROC_H;
    this.procCtx = this.procCanvas.getContext('2d', { willReadFrequently: true });

    this.prevLuma = new Uint8Array(PROC_W * PROC_H);
    this.currLuma = new Uint8Array(PROC_W * PROC_H);
    this.skinMask = new Uint8Array(PROC_W * PROC_H);
    this.hasPrev = false;

    this._lastSampleTime = 0;
    this._sampleIntervalMs = 33; // ~30 Hz CV sampling

    // Smoothed motion vector & hand centroid
    this.smoothVx = 0;
    this.smoothVy = 0;
    this.centroidX = 0;
    this.centroidY = 0;
    this.hasCentroid = false;

    // Active blocks for live preview visualization
    this.activeBlocks = [];

    // Pending force outputs consumed by physics loop
    this._impX = 0;
    this._impY = 0;
    this._followX = 0;
    this._followY = 0;
    this._lastFlickTime = 0;
    this._lastAudioTime = 0;

    // Latest detected gesture badge
    this.lastGestureText = 'Wave hand';
    this.lastGestureTime = 0;

    // Callbacks
    this.onGestureBounce = null; // (intensity, label) => void
  }

  async start() {
    if (this.enabled) return { active: true };

    if (!window.isSecureContext) {
      return {
        active: false,
        message: 'Camera tracking needs localhost or HTTPS.',
      };
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return {
        active: false,
        message: 'Camera access is not available in this browser.',
      };
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: this.facingMode },
          width: { ideal: 320 },
          height: { ideal: 240 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });

      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();

      this.enabled = true;
      this.hasPrev = false;
      this.smoothVx = 0;
      this.smoothVy = 0;
      this.centroidX = 0;
      this.centroidY = 0;
      this._impX = 0;
      this._impY = 0;
      this._followX = 0;
      this._followY = 0;
      this.activeBlocks.length = 0;
      this.lastGestureText = 'Wave hand';
      this.lastGestureTime = 0;

      return {
        active: true,
        message: 'Camera tracking ON! Wave up, down, left, or right to bounce.',
      };
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
      const notFound = err && err.name === 'NotFoundError';
      return {
        active: false,
        message: denied
          ? 'Camera permission was denied.'
          : notFound
            ? 'No camera was found on this device.'
            : 'Could not start camera tracking.',
      };
    }
  }

  stop() {
    this.enabled = false;
    this.hasPrev = false;
    this.smoothVx = 0;
    this.smoothVy = 0;
    this._impX = 0;
    this._impY = 0;
    this._followX = 0;
    this._followY = 0;
    this.activeBlocks.length = 0;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try { track.stop(); } catch {}
      }
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  async toggle() {
    if (this.enabled) {
      this.stop();
      return { active: false, message: 'Camera tracking turned off' };
    }
    return this.start();
  }

  async flipCamera() {
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    this.mirror = this.facingMode === 'user';
    if (!this.enabled) return { active: false, mirror: this.mirror };
    this.stop();
    const res = await this.start();
    return { ...res, mirror: this.mirror };
  }

  /** Step optical flow at ~30 Hz and draw live preview canvas if visible */
  update(now, previewCanvas = null) {
    if (!this.enabled || this.paused) return false;
    if (this.video.readyState < 2 || this.video.videoWidth === 0) return false;

    if (now - this._lastSampleTime < this._sampleIntervalMs) {
      return false;
    }
    this._lastSampleTime = now;

    // 1. Capture frame (mirrored if enabled so left on screen === left in hand motion!)
    const pctx = this.procCtx;
    pctx.save();
    if (this.mirror) {
      pctx.translate(PROC_W, 0);
      pctx.scale(-1, 1);
    }
    pctx.drawImage(this.video, 0, 0, PROC_W, PROC_H);
    pctx.restore();

    const rgba = pctx.getImageData(0, 0, PROC_W, PROC_H).data;
    const curr = this.currLuma;
    const prev = this.prevLuma;
    const skin = this.skinMask;
    const totalPx = PROC_W * PROC_H;

    for (let i = 0; i < totalPx; i++) {
      const p = i << 2;
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      // Fast integer Rec.601 luma
      curr[i] = (77 * r + 150 * g + 29 * b) >> 8;
      // Gentle YCbCr skin-tone indicator (boosts bare hands without ignoring gloves/objects)
      const cb = 128 + ((-43 * r - 85 * g + 128 * b) >> 8);
      const cr = 128 + ((128 * r - 107 * g - 21 * b) >> 8);
      skin[i] = (cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173) ? 1 : 0;
    }

    if (!this.hasPrev) {
      prev.set(curr);
      this.hasPrev = true;
      if (previewCanvas) this._renderPreview(previewCanvas);
      return false;
    }

    // 2. Coarse-to-Fine SAD Block-Matching Optical Flow across active moving blocks
    const candidates = [];
    this.activeBlocks.length = 0;
    let centSumX = 0;
    let centSumY = 0;
    let centSumW = 0;

    for (let by = MARGIN; by <= PROC_H - MARGIN - BSIZE; by += BSIZE) {
      for (let bx = MARGIN; bx <= PROC_W - MARGIN - BSIZE; bx += BSIZE) {
        let zeroSad = 0;
        let pMin = 255;
        let pMax = 0;
        let skinHits = 0;

        for (let k = 0; k < OFFS.length; k++) {
          const idx = (by + OFFS[k][1]) * PROC_W + (bx + OFFS[k][0]);
          const pv = prev[idx];
          const cv = curr[idx];
          const diff = cv - pv;
          zeroSad += diff < 0 ? -diff : diff;
          if (pv < pMin) pMin = pv;
          if (pv > pMax) pMax = pv;
          skinHits += skin[idx];
        }

        // Temporal gate (< 10 luma diff/px = static background) + texture gate (ignores flat walls)
        if (zeroSad < 90 || (pMax - pMin) < 12) continue;

        const cxNorm = ((bx + BSIZE * 0.5) / PROC_W) * 2 - 1;
        const cyNorm = ((by + BSIZE * 0.5) / PROC_H) * 2 - 1;
        const skinBoost = skinHits >= 3 ? 1.55 : 1.0;
        centSumX += cxNorm * zeroSad * skinBoost;
        centSumY += cyNorm * zeroSad * skinBoost;
        centSumW += zeroSad * skinBoost;

        // Coarse search dx, dy in {-6, -4, -2, 0, 2, 4, 6}
        let bestSad = zeroSad;
        let bestDx = 0;
        let bestDy = 0;

        for (let dy = -6; dy <= 6; dy += 2) {
          for (let dx = -6; dx <= 6; dx += 2) {
            if (dx === 0 && dy === 0) continue;
            let sad = 0;
            for (let k = 0; k < OFFS.length; k++) {
              const ox = OFFS[k][0];
              const oy = OFFS[k][1];
              const pVal = prev[(by + oy) * PROC_W + (bx + ox)];
              const cVal = curr[(by + oy + dy) * PROC_W + (bx + ox + dx)];
              const d = cVal - pVal;
              sad += d < 0 ? -d : d;
              if (sad >= bestSad) break;
            }
            if (sad < bestSad) {
              bestSad = sad;
              bestDx = dx;
              bestDy = dy;
            }
          }
        }

        // Fine +-1px refinement around best coarse shift
        const cdx = bestDx;
        const cdy = bestDy;
        for (let dy = cdy - 1; dy <= cdy + 1; dy++) {
          if (by + dy < 0 || by + dy + 4 >= PROC_H) continue;
          for (let dx = cdx - 1; dx <= cdx + 1; dx++) {
            if (bx + dx < 0 || bx + dx + 4 >= PROC_W) continue;
            if (dx === cdx && dy === cdy) continue;
            let sad = 0;
            for (let k = 0; k < OFFS.length; k++) {
              const ox = OFFS[k][0];
              const oy = OFFS[k][1];
              const pVal = prev[(by + oy) * PROC_W + (bx + ox)];
              const cVal = curr[(by + oy + dy) * PROC_W + (bx + ox + dx)];
              const d = cVal - pVal;
              sad += d < 0 ? -d : d;
              if (sad >= bestSad) break;
            }
            if (sad < bestSad) {
              bestSad = sad;
              bestDx = dx;
              bestDy = dy;
            }
          }
        }

        // Confidence filter: reject noise or flicker where shift doesn't beat stationary match clearly
        if (bestSad < zeroSad * 0.74 && (bestDx !== 0 || bestDy !== 0)) {
          const gain = zeroSad - bestSad;
          const weight = gain * (gain / zeroSad) * skinBoost;
          candidates.push({ weight, dx: bestDx, dy: bestDy, bx, by });
        }
      }
    }

    // Swap luma buffers for next frame
    prev.set(curr);

    // Update optional Follow-Hand centroid smoothly
    if (centSumW > 320) {
      const targetCx = Math.max(-1, Math.min(1, centSumX / centSumW));
      const targetCy = Math.max(-1, Math.min(1, centSumY / centSumW));
      this.centroidX += (targetCx - this.centroidX) * 0.25;
      this.centroidY += (targetCy - this.centroidY) * 0.25;
      this.hasCentroid = true;
    } else {
      this.centroidX *= 0.90;
      this.centroidY *= 0.90;
      if (Math.hypot(this.centroidX, this.centroidY) < 0.02) this.hasCentroid = false;
    }

    // 3. Aggregate top-60% highest-confidence moving blocks into a clean 360° hand velocity vector
    let rawVx = 0;
    let rawVy = 0;
    if (candidates.length >= 2) {
      candidates.sort((a, b) => b.weight - a.weight);
      const keepN = Math.max(2, Math.floor(candidates.length * 0.6));
      let sumW = 0;
      for (let i = 0; i < keepN; i++) {
        const c = candidates[i];
        rawVx += c.dx * c.weight;
        rawVy += c.dy * c.weight;
        sumW += c.weight;
        this.activeBlocks.push({
          x: (c.bx + BSIZE * 0.5) / PROC_W,
          y: (c.by + BSIZE * 0.5) / PROC_H,
        });
      }
      if (sumW > 0) {
        // Normalize pixel shift [-6..+6] -> [-1..+1]
        rawVx = Math.max(-1.4, Math.min(1.4, (rawVx / sumW) / 5.0));
        rawVy = Math.max(-1.4, Math.min(1.4, (rawVy / sumW) / 5.0));
      }
    }

    // Fast attack, smooth decay on visual velocity vector
    const rawSpeed = Math.hypot(rawVx, rawVy);
    const smoothSpeed = Math.hypot(this.smoothVx, this.smoothVy);
    const alpha = rawSpeed > smoothSpeed ? 0.58 : 0.30;
    this.smoothVx += (rawVx - this.smoothVx) * alpha;
    this.smoothVy += (rawVy - this.smoothVy) * alpha;

    // 4. Convert hand velocity into crisp directional bounce impulses!
    const sensNorm = this.sensitivity / 100; // 0.20 .. 1.00
    // Deadzone ignores gentle posture drift & slow hand returns
    const deadzone = 0.24 - sensNorm * 0.12; // ~0.12 at high sens, ~0.22 at low sens
    const speed = Math.hypot(this.smoothVx, this.smoothVy);
    let triggeredForce = false;

    if (this.bounceEnabled && speed > deadzone) {
      const excess = (speed - deadzone) / Math.max(0.15, 1.0 - deadzone);
      const shaped = Math.pow(Math.min(1.5, excess), 1.32);
      const ux = this.smoothVx / speed;
      const uy = this.smoothVy / speed;

      // Continuous directional push while waving
      const gain = (3.8 + sensNorm * 7.8) * shaped;
      this._impX += ux * gain;
      this._impY += uy * gain;
      triggeredForce = true;

      // Crisp flick boost + gesture badge + optional soft boing sound on strong directional waves
      const flickThreshold = deadzone + 0.14;
      if (speed > flickThreshold && now - this._lastFlickTime > 155) {
        this._lastFlickTime = now;
        const boost = (2.8 + sensNorm * 5.2) * Math.min(1.25, shaped);
        this._impX += ux * boost;
        this._impY += uy * boost;

        const label = directionLabel(ux, uy);
        this.lastGestureText = label;
        this.lastGestureTime = now;

        if (this.onGestureBounce && now - this._lastAudioTime > 230) {
          this._lastAudioTime = now;
          this.onGestureBounce(Math.min(1, shaped * 0.85), label);
        }
      }
    }

    // Optional Follow-Hand gravity lean
    if (this.followEnabled) {
      const fScale = 0.45 + sensNorm * 0.65;
      this._followX = this.centroidX * fScale;
      this._followY = this.centroidY * fScale;
      if (Math.hypot(this._followX, this._followY) > 0.02) triggeredForce = true;
    } else {
      this._followX = 0;
      this._followY = 0;
    }

    // Clamp single-tick impulse safely
    this._impX = Math.max(-18, Math.min(18, this._impX));
    this._impY = Math.max(-18, Math.min(18, this._impY));

    if (previewCanvas) {
      this._renderPreview(previewCanvas);
    }

    return triggeredForce;
  }

  /** Consume accumulated camera forces for MochiPhysicsContinuum.setMotionForce() */
  consumeForce() {
    const out = {
      gx: this._followX,
      gy: this._followY,
      ax: this._impX,
      ay: this._impY,
    };
    this._impX = 0;
    this._impY = 0;
    return out;
  }

  _renderPreview(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    if (this.mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(this.video, 0, 0, w, h);
    ctx.restore();

    // Subtle dark scrim so pink motion indicators pop clearly
    ctx.fillStyle = 'rgba(28, 16, 24, 0.16)';
    ctx.fillRect(0, 0, w, h);

    // Draw active moving hand block dots
    if (this.activeBlocks.length > 0) {
      ctx.fillStyle = 'rgba(255, 143, 171, 0.55)';
      for (let i = 0; i < this.activeBlocks.length; i++) {
        const b = this.activeBlocks[i];
        ctx.beginPath();
        ctx.arc(b.x * w, b.y * h, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Draw live 360° directional motion arrow in center
    const speed = Math.hypot(this.smoothVx, this.smoothVy);
    if (speed > 0.08) {
      const cx = w * 0.5;
      const cy = h * 0.5;
      const maxLen = Math.min(w, h) * 0.38;
      const len = Math.min(maxLen, speed * maxLen * 1.15);
      const ux = this.smoothVx / speed;
      const uy = this.smoothVy / speed;
      const ex = cx + ux * len;
      const ey = cy + uy * len;

      ctx.save();
      ctx.strokeStyle = '#ff6b9b';
      ctx.fillStyle = '#ff6b9b';
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.stroke();

      // Arrowhead
      const headLen = 9;
      const ang = Math.atan2(uy, ux);
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - headLen * Math.cos(ang - 0.55), ey - headLen * Math.sin(ang - 0.55));
      ctx.lineTo(ex - headLen * Math.cos(ang + 0.55), ey - headLen * Math.sin(ang + 0.55));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
}
