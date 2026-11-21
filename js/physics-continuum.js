/**
 * MochiPhysicsContinuum v15 — Snappy Crisp-Rebound Viscoelastic Mochi Engine (44x44)
 *
 * Key upgrades fixing the "too smooth / sluggish syrup" feel:
 * 1. Crisp ~5.5 Hz Natural Elastic Frequency + Lively Underdamped Snap-Back:
 *    - Scaled restoring memory (kHome) and cohesive skin (kLap) up proportionally
 *      while keeping spatial screening length tight (zero eye smearing!).
 *    - Lowered internal shear syrup (betaVisc ~ 0.09) so releasing a pulled ear or
 *      cheek snaps back briskly past rest in ~80ms with 2-3 clean mochi wobbles
 *      (-39% -> +15% -> -5.5% -> settle), instead of gliding back like slow molasses.
 * 2. Direct, Zero-Sluggishness Finger Response (tau = 6ms):
 *    - Replaces v14's heavy 26ms low-pass lag so ear & cheek pulls respond immediately
 *      and stretch cleanly even when zoomed in 2x–3x.
 * 3. Adaptive CFL-Safe Substepping (450 Hz internal physics clock):
 *    - Guarantees 100% numerical stability (CFL < 0.35) across every slider combo
 *      and recording framerate (45–240 FPS).
 */

export const PRESETS = {
  real: {
    name: 'Real Mochi',
    softness: 52,
    grab: 52,
    stretch: 56,
    wobbleSpeed: 54,
    wobbles: 56,
    puffiness: 52,
    yieldFirmness: 52,
    motion: 58,
  },
  daifuku: {
    name: 'Soft Daifuku',
    softness: 80,
    grab: 62,
    stretch: 82,
    wobbleSpeed: 46,
    wobbles: 68,
    puffiness: 72,
    yieldFirmness: 36,
    motion: 74,
  },
  flan: {
    name: 'Jiggly Flan',
    softness: 72,
    grab: 56,
    stretch: 68,
    wobbleSpeed: 64,
    wobbles: 88,
    puffiness: 76,
    yieldFirmness: 28,
    motion: 82,
  },
  firm: {
    name: 'Firm Dough',
    softness: 26,
    grab: 44,
    stretch: 38,
    wobbleSpeed: 56,
    wobbles: 20,
    puffiness: 32,
    yieldFirmness: 78,
    motion: 40,
  },
};

export class MochiPhysicsContinuum {
  constructor(gridN = 44) {
    this.N = gridN;
    this.V = gridN * gridN;
    this.aspect = 1.0;
    this.hw = 0.5;
    this.hh = 0.5;

    // Rest coordinates
    this.x0 = new Float32Array(this.V);
    this.y0 = new Float32Array(this.V);

    // Displacement & velocity fields
    this.ux = new Float32Array(this.V);
    this.uy = new Float32Array(this.V);
    this.vx = new Float32Array(this.V);
    this.vy = new Float32Array(this.V);
    this.vxTmp = new Float32Array(this.V);
    this.vyTmp = new Float32Array(this.V);

    // Pre-allocated per-frame finger-field buffers (zero GC per frame!)
    this.sumG = new Float32Array(this.V);
    this.gripW = new Float32Array(this.V);
    this.forceTx = new Float32Array(this.V);
    this.forceTy = new Float32Array(this.V);

    // GPU buffers
    this.uv = new Float32Array(this.V * 2);
    this.posInterleaved = new Float32Array(this.V * 2);
    this.strain = new Float32Array(this.V);
    this.indices = this._buildRenderIndices();

    // Mobility weight [0..1] & raw artwork alpha for hit-testing
    this.w = new Float32Array(this.V);
    this.artHit = new Float32Array(this.V);
    this.hasTransparency = false;

    // Active multi-touch handles: Map<pointerId, Handle>
    this.handles = new Map();

    // External phone motion sensor forces
    this.gravityX = 0;
    this.gravityY = 0;
    this.shakeX = 0;
    this.shakeY = 0;

    this.peakStrain = 0;
    this.params = { ...PRESETS.real };
    this._rebuildGeometry(1.0);
  }

  _buildRenderIndices() {
    const N = this.N;
    const idx = new Uint16Array((N - 1) * (N - 1) * 6);
    let p = 0;
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i;
        const b = a + 1;
        const c = a + N;
        const d = c + 1;
        idx[p++] = a; idx[p++] = b; idx[p++] = d;
        idx[p++] = a; idx[p++] = d; idx[p++] = c;
      }
    }
    return idx;
  }

  _rebuildGeometry(aspect) {
    this.aspect = aspect;
    const N = this.N;
    this.hw = aspect >= 1 ? 0.5 : 0.5 * aspect;
    this.hh = aspect >= 1 ? 0.5 / aspect : 0.5;

    for (let j = 0; j < N; j++) {
      const v = j / (N - 1);
      const y = (v - 0.5) * 2 * this.hh;
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1);
        const x = (u - 0.5) * 2 * this.hw;
        const k = j * N + i;
        this.x0[k] = x;
        this.y0[k] = y;
        this.ux[k] = 0;
        this.uy[k] = 0;
        this.vx[k] = 0;
        this.vy[k] = 0;
        this.uv[k * 2] = u;
        this.uv[k * 2 + 1] = v;
        this.strain[k] = 0;
      }
    }
    this._packPositions();
  }

  setAspect(aspect) {
    if (Math.abs(aspect - this.aspect) > 0.002) {
      this._rebuildGeometry(aspect);
    } else {
      this.resetPose();
    }
  }

  updateArtworkHitMask(imgOrCanvas) {
    const N = this.N;
    const tmp = document.createElement('canvas');
    tmp.width = N;
    tmp.height = N;
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(imgOrCanvas, 0, 0, N, N);
    const data = ctx.getImageData(0, 0, N, N).data;
    let transparentVerts = 0;
    for (let i = 0; i < this.V; i++) {
      const a = data[i * 4 + 3] / 255;
      this.artHit[i] = a;
      if (a < 0.2) transparentVerts++;
    }
    this.hasTransparency = transparentVerts > this.V * 0.06;
  }

  /** Whole-image squishy mode with soft ground-shadow anchoring on transparent artworks */
  setWholeImageSquishy() {
    const N = this.N;
    const borderFeather = this.hasTransparency ? 0.032 : 0.06;
    for (let j = 0; j < N; j++) {
      const v = j / (N - 1);
      const dyEdge = Math.min(v, 1 - v);
      let bottomGround = 1.0;
      if (this.hasTransparency && v > 0.76) {
        const t = Math.min(1, (v - 0.76) / 0.18);
        bottomGround = 1.0 - t * 0.58;
      }
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1);
        const dxEdge = Math.min(u, 1 - u);
        const dEdge = Math.min(dxEdge, dyEdge);
        const k = j * N + i;
        let weight = Math.min(1, dEdge / borderFeather);
        weight = weight * weight * (3 - 2 * weight) * bottomGround;
        this.w[k] = weight;
        if (weight === 0) {
          this.ux[k] = 0; this.uy[k] = 0;
          this.vx[k] = 0; this.vy[k] = 0;
        }
      }
    }
  }

  updateMaskFromCanvas(maskCanvas) {
    const N = this.N;
    const tmp = document.createElement('canvas');
    tmp.width = N;
    tmp.height = N;
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(maskCanvas, 0, 0, N, N);
    const data = ctx.getImageData(0, 0, N, N).data;

    const raw = new Float32Array(this.V);
    let maxAlpha = 0;
    for (let i = 0; i < this.V; i++) {
      const a = data[i * 4 + 3] / 255;
      raw[i] = a;
      if (a > maxAlpha) maxAlpha = a;
    }

    const buf = new Float32Array(this.V);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const l = raw[j * N + Math.max(0, i - 1)];
        const c = raw[j * N + i];
        const r = raw[j * N + Math.min(N - 1, i + 1)];
        buf[j * N + i] = 0.20 * l + 0.60 * c + 0.20 * r;
      }
    }
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const u = buf[Math.max(0, j - 1) * N + i];
        const c = buf[j * N + i];
        const d = buf[Math.min(N - 1, j + 1) * N + i];
        raw[j * N + i] = 0.20 * u + 0.60 * c + 0.20 * d;
      }
    }

    for (let i = 0; i < this.V; i++) {
      const val = raw[i] < 0.015 ? 0 : Math.min(1, raw[i]);
      this.w[i] = val;
      if (val === 0) {
        this.ux[i] = 0; this.uy[i] = 0;
        this.vx[i] = 0; this.vy[i] = 0;
      }
    }
    return maxAlpha > 0.02;
  }

  _findNearestSquishyVertex(wx, wy, maxRadius = 0.075) {
    const pad = maxRadius + 0.02;
    if (wx < -this.hw - pad || wx > this.hw + pad || wy < -this.hh - pad || wy > this.hh + pad) {
      return -1;
    }
    let bestD2 = maxRadius * maxRadius;
    let bestK = -1;
    for (let k = 0; k < this.V; k++) {
      if (this.w[k] <= 0.05 || this.artHit[k] <= 0.08) continue;
      const dx = (this.x0[k] + this.ux[k]) - wx;
      const dy = (this.y0[k] + this.uy[k]) - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestK = k;
      }
    }
    return bestK;
  }

  setParams(partial) {
    Object.assign(this.params, partial);
  }

  applyPreset(key) {
    if (PRESETS[key]) {
      this.params = { ...PRESETS[key] };
    }
  }

  resetPose() {
    this.handles.clear();
    this.ux.fill(0);
    this.uy.fill(0);
    this.vx.fill(0);
    this.vy.fill(0);
    this.strain.fill(0);
    this.peakStrain = 0;
    this._packPositions();
  }

  pointerDown(id, wx, wy) {
    const bestK = this._findNearestSquishyVertex(wx, wy, 0.075);
    if (bestK === -1) return false;

    const restX = this.x0[bestK];
    const restY = this.y0[bestK];

    // Crisp subtle tactile touchdown cue
    const pokeR2 = 0.078 * 0.078;
    const pokeAmp = 0.032 + (this.params.softness / 100) * 0.038;
    for (let k = 0; k < this.V; k++) {
      const wk = this.w[k];
      if (wk <= 0.01) continue;
      const dx = this.x0[k] - restX;
      const dy = this.y0[k] - restY;
      const d2 = dx * dx + dy * dy;
      if (d2 > pokeR2 * 4) continue;
      const g = Math.exp(-d2 / (2 * pokeR2)) * wk;
      this.vy[k] += pokeAmp * g;
    }

    this.handles.set(id, {
      originX: wx,
      originY: wy,
      currX: wx,
      currY: wy,
      smoothX: wx,
      smoothY: wy,
      anchorX: restX,
      anchorY: restY,
      baseUx: this.ux[bestK],
      baseUy: this.uy[bestK],
      effDx: 0,
      effDy: 0,
      sigma: 0.085,
    });
    return true;
  }

  pointerMove(id, wx, wy) {
    const h = this.handles.get(id);
    if (!h) return;
    h.currX = wx;
    h.currY = wy;
  }

  /** Returns normalized [0..1] stretch intensity of a handle right before releasing (for tactile audio!) */
  getHandlePullIntensity(id) {
    const h = this.handles.get(id);
    if (!h) return 0;
    const stretch = Math.hypot(h.effDx, h.effDy);
    return Math.min(1, stretch / 0.14);
  }

  pointerUp(id) {
    this.handles.delete(id);
  }

  setMotionForce(gx, gy, ax = 0, ay = 0) {
    const sens = this.params.motion / 100;
    const scaleG = 18.0 + sens * 40.0;
    const scaleA = 26.0 + sens * 55.0;
    this.gravityX = gx * scaleG;
    this.gravityY = gy * scaleG;
    this.shakeX += ax * scaleA;
    this.shakeY += ay * scaleA;
  }

  triggerJiggle(strength = 1.0) {
    const dir = Math.random() < 0.5 ? 1 : -1;
    const imp = (1.35 + (this.params.softness / 100) * 1.0) * strength;
    for (let i = 0; i < this.V; i++) {
      const wi = this.w[i];
      if (wi <= 0) continue;
      const wave = 0.78 + 0.22 * Math.sin(this.y0[i] * 5.0);
      this.vx[i] += dir * imp * wi * wave;
      this.vy[i] += 0.55 * imp * wi * wave;
    }
  }

  /**
   * Build the Direct Adaptive Yield-Stress + Soft-Norm + Affine Pinch Corridor finger field.
   * Uses crisp 6ms micro-jitter smoothing (zero syrupy lag!).
   */
  _buildFingerField(dt, soft, grab, str, puff, firm) {
    const V = this.V;
    const list = Array.from(this.handles.values());
    if (list.length === 0) return false;

    const fingerEase = 1.0 - Math.exp(-dt / 0.006);

    // Adaptive Yield-Stress S-Curve:
    // Slight nudges stay controlled & firm; ear/cheek pulls stretch generously even when zoomed in!
    const gFirm = Math.min(0.62, 0.20 + (1.0 - firm) * 0.26 + soft * 0.14);
    const gStretch = Math.max(gFirm + 0.14, 0.56 + str * 0.42 + soft * 0.10);
    const dYield = Math.max(0.065, 0.085 + firm * 0.065 - soft * 0.020);
    const maxStretch = 0.145 + str * 0.155 + soft * 0.045;

    const sigmaBase = 0.056 + grab * 0.052 + puff * 0.008;
    const sigmaGrow = 0.022 + grab * 0.024;

    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      h.smoothX += (h.currX - h.smoothX) * fingerEase;
      h.smoothY += (h.currY - h.smoothY) * fingerEase;

      const rawDx = h.baseUx + (h.smoothX - h.originX);
      const rawDy = h.baseUy + (h.smoothY - h.originY);
      const mag = Math.hypot(rawDx, rawDy);
      if (mag > 1e-6) {
        const r = mag / dYield;
        const yFac = (r * r) / (1.0 + r * r);
        const gain = gFirm + (gStretch - gFirm) * yFac;
        const rawOut = mag * gain;
        const eff = maxStretch * Math.tanh(rawOut / maxStretch);
        const scale = eff / mag;
        h.effDx = rawDx * scale;
        h.effDy = rawDy * scale;
        h.sigma = sigmaBase + sigmaGrow * yFac;
      } else {
        h.effDx = 0;
        h.effDy = 0;
        h.sigma = sigmaBase;
      }
    }

    // Gentle non-crossing cushion for approaching pairs
    if (list.length >= 2) {
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const ha = list[a], hb = list[b];
          const rdx = hb.anchorX - ha.anchorX;
          const rdy = hb.anchorY - ha.anchorY;
          const restDist = Math.hypot(rdx, rdy);
          if (restDist < 0.02) continue;

          const minSep = Math.min(0.11, restDist * 0.34);
          const ax = ha.anchorX + ha.effDx, ay = ha.anchorY + ha.effDy;
          const bx = hb.anchorX + hb.effDx, by = hb.anchorY + hb.effDy;
          const cdx = bx - ax, cdy = by - ay;
          const currDist = Math.hypot(cdx, cdy);

          if (currDist < minSep || (cdx * rdx + cdy * rdy) < 0) {
            const nx = rdx / restDist;
            const ny = rdy / restDist;
            const midX = 0.5 * (ax + bx);
            const midY = 0.5 * (ay + by);
            const half = 0.5 * minSep;
            ha.effDx = (midX - half * nx) - ha.anchorX;
            ha.effDy = (midY - half * ny) - ha.anchorY;
            hb.effDx = (midX + half * nx) - hb.anchorX;
            hb.effDy = (midY + half * ny) - hb.anchorY;
          }
        }
      }
    }

    // Soft-Normalized compact Gaussian field
    const sumG = this.sumG;
    const gripW = this.gripW;
    const forceTx = this.forceTx;
    const forceTy = this.forceTy;
    sumG.fill(0);
    forceTx.fill(0);
    forceTy.fill(0);

    const x0 = this.x0, y0 = this.y0, w = this.w;

    for (let hi = 0; hi < list.length; hi++) {
      const h = list[hi];
      const ax = h.anchorX, ay = h.anchorY;
      const tx = h.effDx, ty = h.effDy;
      const sig = h.sigma;
      const inv2Sig2 = 1.0 / (2 * sig * sig);
      const cutoff = sig * 3.0;
      const cutR2 = cutoff * cutoff;
      const invCut2 = 1.0 / cutR2;

      for (let k = 0; k < V; k++) {
        if (w[k] <= 0.01) continue;
        const dx = x0[k] - ax;
        const dy = y0[k] - ay;
        const d2 = dx * dx + dy * dy;
        if (d2 >= cutR2) continue;
        const win = 1.0 - d2 * invCut2;
        const g = Math.exp(-d2 * inv2Sig2) * (win * win);
        sumG[k] += g;
        forceTx[k] += g * tx;
        forceTy[k] += g * ty;
      }
    }

    for (let k = 0; k < V; k++) {
      const sg = sumG[k];
      if (sg <= 0) {
        gripW[k] = 0;
        continue;
      }
      if (sg > 1.0) {
        const inv = 1.0 / sg;
        gripW[k] = 1.0;
        forceTx[k] *= inv;
        forceTy[k] *= inv;
      } else {
        gripW[k] = sg;
      }
    }

    // Affine Pinch Corridor for approaching pairs -> fold-free >w< pinch + plump Puffiness bulge
    if (list.length >= 2) {
      const puffBulge = puff * 0.28;
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const ha = list[a], hb = list[b];
          const rdx = hb.anchorX - ha.anchorX;
          const rdy = hb.anchorY - ha.anchorY;
          const rdist = Math.hypot(rdx, rdy);
          if (rdist < 0.03 || rdist > 0.68) continue;

          const nx = rdx / rdist;
          const ny = rdy / rdist;
          const relApp = (ha.effDx - hb.effDx) * nx + (ha.effDy - hb.effDy) * ny;
          if (relApp <= 0.012) continue;

          const appGain = Math.min(1.0, (relApp - 0.012) / 0.042);
          const corrSig = 0.5 * (ha.sigma + hb.sigma) * 1.15;
          const inv2CorrSig2 = 1.0 / (2 * corrSig * corrSig);
          const maxPerp2 = (corrSig * 3.2) * (corrSig * 3.2);
          const invRdist = 1.0 / rdist;
          const px = -ny, py = nx;
          const squishAmt = Math.min(0.20, relApp);

          for (let k = 0; k < V; k++) {
            if (w[k] <= 0.01) continue;
            const vx = x0[k] - ha.anchorX;
            const vy = y0[k] - ha.anchorY;
            const proj = vx * nx + vy * ny;
            const perp = -vx * ny + vy * nx;
            const endDist = proj < 0 ? -proj : (proj > rdist ? proj - rdist : 0);
            const dist2 = perp * perp + endDist * endDist;
            if (dist2 > maxPerp2) continue;

            const c = appGain * Math.exp(-dist2 * inv2CorrSig2);
            if (c < 0.01) continue;

            const tClamped = proj <= 0 ? 0 : (proj >= rdist ? 1 : proj * invRdist);
            const bulgeMag = puffBulge * squishAmt * (perp / (corrSig + Math.abs(perp)));
            const linX = (1.0 - tClamped) * ha.effDx + tClamped * hb.effDx + px * bulgeMag;
            const linY = (1.0 - tClamped) * ha.effDy + tClamped * hb.effDy + py * bulgeMag;
            const omc = 1.0 - c;
            const c2 = c * c;

            gripW[k] = omc * gripW[k] + c2;
            forceTx[k] = omc * forceTx[k] + c2 * linX;
            forceTy[k] = omc * forceTy[k] + c2 * linY;
          }
        }
      }
    }

    return true;
  }

  step(dtRaw) {
    const dt = Math.max(1 / 480, Math.min(dtRaw, 1 / 45));
    // Adaptive ~450 Hz internal physics clock -> 100% CFL-safe across 45–240 FPS!
    const substeps = Math.max(2, Math.ceil(dt * 450.0));
    const h = dt / substeps;

    const soft = this.params.softness / 100;       // 0.10 .. 1.00
    const grab = this.params.grab / 100;           // 0.15 .. 1.00
    const str = this.params.stretch / 100;         // 0.15 .. 1.00
    const spd = this.params.wobbleSpeed / 100;     // 0.15 .. 1.00
    const wob = this.params.wobbles / 100;         // 0.00 .. 0.95
    const puff = this.params.puffiness / 100;      // 0.00 .. 1.00
    const firm = this.params.yieldFirmness / 100;  // 0.00 .. 1.00

    // Frequency scale from Wobble Speed: 0.48x (dreamy slow) .. 1.60x (ultra snappy)
    const freqMul = 0.48 + spd * 1.12;
    const omegaScale = Math.sqrt(freqMul);

    // Snappy ~5.5 Hz elastic mochi continuum (crisp 80ms snap-back + 2-3 lively wobbles!)
    const kLap = (3250.0 - soft * 1100.0) * freqMul;
    const kBulk = (180.0 + puff * 920.0) * (1.08 - soft * 0.28) * freqMul;
    const kHome = (1450.0 - soft * 650.0) * freqMul;

    // Lively elastic damping (wob=0 dead dough, wob=56 crisp mochi boing, wob=95 long jiggly flan)
    const gamma = (38.0 - wob * 35.2) * omegaScale;
    // Light shear viscosity: eliminates mesh noise WITHOUT turning snap-back into syrup!
    const betaViscBase = 0.13 - wob * 0.075;
    const betaVisc = Math.min(0.35, betaViscBase * (h * 450.0));

    // Direct, crisp finger tether balanced against kLap & kHome
    const kGrab = (1850.0 + str * 1750.0 + soft * 650.0) * (0.72 + 0.34 * freqMul);
    const cGrab = 52.0 * omegaScale;

    const yieldFloor = 1.0 - (0.14 + firm * 0.22);
    const yieldSpan = 1.0 - yieldFloor;
    const invYieldU2 = 1.0 / (0.085 * 0.085);

    const hasFingers = this._buildFingerField(dt, soft, grab, str, puff, firm);
    const damp = Math.exp(-gamma * h);

    const N = this.N;
    const ux = this.ux, uy = this.uy;
    const vx = this.vx, vy = this.vy;
    const vxTmp = this.vxTmp, vyTmp = this.vyTmp;
    const w = this.w;
    const gripW = this.gripW, forceTx = this.forceTx, forceTy = this.forceTy;

    const extFx = this.gravityX + this.shakeX;
    const extFy = this.gravityY + this.shakeY;
    const shakeDecay = Math.pow(0.68, dt * 60.0);
    this.shakeX *= shakeDecay;
    this.shakeY *= shakeDecay;

    for (let s = 0; s < substeps; s++) {
      for (let j = 0; j < N; j++) {
        const jU = j > 0 ? j - 1 : 0;
        const jD = j < N - 1 ? j + 1 : N - 1;
        const row = j * N, rowU = jU * N, rowD = jD * N;

        for (let i = 0; i < N; i++) {
          const k = row + i;
          const wk = w[k];
          if (wk === 0) {
            vx[k] = 0; vy[k] = 0;
            continue;
          }

          const iL = i > 0 ? i - 1 : 0;
          const iR = i < N - 1 ? i + 1 : N - 1;

          const uxC = ux[k], uyC = uy[k];
          const uxL = ux[row + iL], uxR = ux[row + iR];
          const uxU = ux[rowU + i], uxD = ux[rowD + i];
          const uyL = uy[row + iL], uyR = uy[row + iR];
          const uyU = uy[rowU + i], uyD = uy[rowD + i];

          const lapX = uxL + uxR + uxU + uxD - 4.0 * uxC;
          const lapY = uyL + uyR + uyU + uyD - 4.0 * uyC;

          const d2xX = uxL + uxR - 2.0 * uxC;
          const d2yY = uyU + uyD - 2.0 * uyC;
          const d2xyY = 0.25 * (uy[rowD + iR] - uy[rowD + iL] - uy[rowU + iR] + uy[rowU + iL]);
          const d2xyX = 0.25 * (ux[rowD + iR] - ux[rowD + iL] - ux[rowU + iR] + ux[rowU + iL]);

          const u2 = uxC * uxC + uyC * uyC;
          const kHomeEff = kHome * (yieldFloor + yieldSpan / (1.0 + u2 * invYieldU2));

          let ax = kLap * lapX + kBulk * (d2xX + d2xyY) - kHomeEff * uxC + extFx;
          let ay = kLap * lapY + kBulk * (d2xyX + d2yY) - kHomeEff * uyC + extFy;

          if (hasFingers) {
            const gw = gripW[k];
            if (gw > 0) {
              ax += kGrab * (forceTx[k] - gw * uxC) - cGrab * gw * vx[k];
              ay += kGrab * (forceTy[k] - gw * uyC) - cGrab * gw * vy[k];
            }
          }

          const invW = 1.0 - wk;
          ax = ax * wk - invW * (2400.0 * uxC + 54.0 * vx[k]);
          ay = ay * wk - invW * (2400.0 * uyC + 54.0 * vy[k]);

          vxTmp[k] = vx[k] + h * ax;
          vyTmp[k] = vy[k] + h * ay;
        }
      }

      for (let j = 0; j < N; j++) {
        const jU = j > 0 ? j - 1 : 0;
        const jD = j < N - 1 ? j + 1 : N - 1;
        const row = j * N, rowU = jU * N, rowD = jD * N;
        for (let i = 0; i < N; i++) {
          const k = row + i;
          const wk = w[k];
          if (wk === 0) {
            vx[k] = 0; vy[k] = 0;
            continue;
          }
          const iL = i > 0 ? i - 1 : 0;
          const iR = i < N - 1 ? i + 1 : N - 1;

          const avgVx = 0.25 * (vxTmp[row + iL] + vxTmp[row + iR] + vxTmp[rowU + i] + vxTmp[rowD + i]);
          const avgVy = 0.25 * (vyTmp[row + iL] + vyTmp[row + iR] + vyTmp[rowU + i] + vyTmp[rowD + i]);

          let nvx = (vxTmp[k] + betaVisc * wk * (avgVx - vxTmp[k])) * damp;
          let nvy = (vyTmp[k] + betaVisc * wk * (avgVy - vyTmp[k])) * damp;

          const sp2 = nvx * nvx + nvy * nvy;
          if (sp2 > 64) {
            const sc = 8 / Math.sqrt(sp2);
            nvx *= sc; nvy *= sc;
          }

          vx[k] = nvx;
          vy[k] = nvy;
          ux[k] += h * nvx;
          uy[k] += h * nvy;
        }
      }
    }

    this._updateStrainAndPack();
  }

  _updateStrainAndPack() {
    const N = this.N;
    const ux = this.ux, uy = this.uy;
    const x0 = this.x0, y0 = this.y0;
    const strain = this.strain;
    const out = this.posInterleaved;
    const inv2Dx = (N - 1) * 0.5;
    const puffScale = 0.85 + (this.params.puffiness / 100) * 0.60;
    let maxS = 0;

    for (let j = 0; j < N; j++) {
      const jU = j > 0 ? j - 1 : 0;
      const jD = j < N - 1 ? j + 1 : N - 1;
      const row = j * N, rowU = jU * N, rowD = jD * N;
      for (let i = 0; i < N; i++) {
        const k = row + i;
        out[k * 2] = x0[k] + ux[k];
        out[k * 2 + 1] = y0[k] + uy[k];

        const iL = i > 0 ? i - 1 : 0;
        const iR = i < N - 1 ? i + 1 : N - 1;
        const div = (ux[row + iR] - ux[row + iL] + uy[rowD + i] - uy[rowU + i]) * inv2Dx;
        const sVal = Math.max(-1.0, Math.min(1.0, div * puffScale));
        strain[k] = sVal;
        const absS = Math.abs(sVal);
        if (absS > maxS) maxS = absS;
      }
    }
    this.peakStrain = maxS;
  }

  _packPositions() {
    const out = this.posInterleaved;
    for (let i = 0; i < this.V; i++) {
      out[i * 2] = this.x0[i] + this.ux[i];
      out[i * 2 + 1] = this.y0[i] + this.uy[i];
    }
  }
}
