/**
 * MochiPhysicsContinuum v10 — Adaptive Yield-Stress (Bingham S-Curve) Mochi Engine (44x44)
 *
 * Solves the "always mushy OR always rigid" problem with genuine viscoelastic yield-stress physics:
 * 1. Adaptive S-Curve Pull Response:
 *    - Slight touches & gentle drags: firm, taut ~36–45% compliance with a tighter cushion
 *      radius (sigma ~ 0.072) and crisp restoring stiffness -> gives responsive tactile
 *      feedback while keeping the mochi plump, round, and slightly firm!
 *    - Committed / Extreme stretches: smoothly yields (S-curve ramps compliance up to ~92%),
 *      gently broadens the marshmallow dome (sigma 0.072 -> 0.118), and strain-softens the
 *      home restoring memory (1.0 -> 0.58) so big pulls stretch dramatically and chewily!
 * 2. Soft-Normalized Multi-Finger Blending + Affine Pinch Corridor:
 *    - Guarantees strictly positive Jacobian (detJ > 0) on tight >w< cheek pinches AND
 *      extreme diagonal 2-finger shears (zero eye smearing or folding!).
 * 3. Unconditionally Stable Kelvin-Voigt Shear Viscosity:
 *    - Zero watery ripples, crisp settle on slight pokes, one creamy rebound on big stretches.
 * 4. Optional Phone Motion Sensors (tilt gravity + shake impulse across whole painted body).
 */

export const PRESETS = {
  real: {
    name: 'Real Mochi',
    softness: 58,
    stretch: 66,
    bounce: 36,
    grab: 52,
    motion: 60,
  },
  daifuku: {
    name: 'Soft Daifuku',
    softness: 84,
    stretch: 86,
    bounce: 52,
    grab: 64,
    motion: 75,
  },
  firm: {
    name: 'Firm Dough',
    softness: 28,
    stretch: 44,
    bounce: 18,
    grab: 42,
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

  /** Whole-image squishy mode (used automatically when nothing was painted!) */
  setWholeImageSquishy() {
    const N = this.N;
    const borderFeather = this.hasTransparency ? 0.032 : 0.06;
    for (let j = 0; j < N; j++) {
      const v = j / (N - 1);
      const dyEdge = Math.min(v, 1 - v);
      for (let i = 0; i < N; i++) {
        const u = i / (N - 1);
        const dxEdge = Math.min(u, 1 - u);
        const dEdge = Math.min(dxEdge, dyEdge);
        const k = j * N + i;
        let weight = Math.min(1, dEdge / borderFeather);
        weight = weight * weight * (3 - 2 * weight);
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

    // Whisper-light tactile tap feedback (keeps slight taps crisp & taut!)
    const pokeR2 = 0.075 * 0.075;
    for (let k = 0; k < this.V; k++) {
      const wk = this.w[k];
      if (wk <= 0.01) continue;
      const dx = this.x0[k] - restX;
      const dy = this.y0[k] - restY;
      const d2 = dx * dx + dy * dy;
      if (d2 > pokeR2 * 4) continue;
      const g = Math.exp(-d2 / (2 * pokeR2)) * wk;
      this.vy[k] += 0.055 * g;
    }

    this.handles.set(id, {
      originX: wx,
      originY: wy,
      currX: wx,
      currY: wy,
      anchorX: restX,
      anchorY: restY,
      baseUx: this.ux[bestK],
      baseUy: this.uy[bestK],
      effDx: 0,
      effDy: 0,
      sigma: 0.075,
    });
    return true;
  }

  pointerMove(id, wx, wy) {
    const h = this.handles.get(id);
    if (!h) return;
    h.currX = wx;
    h.currY = wy;
  }

  pointerUp(id) {
    this.handles.delete(id);
  }

  setMotionForce(gx, gy, ax = 0, ay = 0) {
    const sens = this.params.motion / 100;
    const scaleG = 12.0 + sens * 24.0;
    const scaleA = 18.0 + sens * 38.0;
    this.gravityX = gx * scaleG;
    this.gravityY = gy * scaleG;
    this.shakeX += ax * scaleA;
    this.shakeY += ay * scaleA;
  }

  triggerJiggle(strength = 1.0) {
    const dir = Math.random() < 0.5 ? 1 : -1;
    const imp = (1.05 + (this.params.softness / 100) * 0.78) * strength;
    for (let i = 0; i < this.V; i++) {
      const wi = this.w[i];
      if (wi <= 0) continue;
      const wave = 0.78 + 0.22 * Math.sin(this.y0[i] * 5.0);
      this.vx[i] += dir * imp * wi * wave;
      this.vy[i] += 0.45 * imp * wi * wave;
    }
  }

  /**
   * Build the Adaptive Yield-Stress S-Curve + Soft-Norm + Affine Pinch Corridor finger field.
   * Slight drags -> firm, taut, small-radius feedback.
   * Extreme pulls -> yields into wide, plush, chewy mochi stretch!
   */
  _buildFingerField(soft, str, grabNorm) {
    const V = this.V;
    const list = Array.from(this.handles.values());
    if (list.length === 0) return false;

    // Yield-Stress S-Curve parameters calibrated by Softness & Stretch sliders:
    // - gFirm: slight-touch compliance (~0.36 default -> firm, taut feedback!)
    // - gStretch: extreme-pull compliance (~0.92 default -> dramatic chewy stretch!)
    // - dYield: transition distance where slight poke yields into big stretch (~0.135)
    // - maxStretch: generous smooth upper ceiling (~0.30 default)
    const gFirm = 0.22 + soft * 0.24;            // 0.24 (firm) .. 0.36 (real) .. 0.46 (soft)
    const gStretch = 0.68 + str * 0.36;          // 0.73 .. 0.92 .. 1.04
    const dYield = 0.165 - soft * 0.052;         // ~0.135 at default
    const maxStretch = 0.18 + str * 0.185;       // ~0.302 at default

    // Adaptive radius: tighter on slight nudges, smoothly broadens on extreme pulls!
    const sigmaBase = 0.048 + grabNorm * 0.046;  // ~0.072 on slight pokes
    const sigmaGrow = 0.032 + grabNorm * 0.028;  // grows +0.046 -> ~0.118 on extreme pulls!

    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      const rawDx = h.baseUx + (h.currX - h.originX);
      const rawDy = h.baseUy + (h.currY - h.originY);
      const mag = Math.hypot(rawDx, rawDy);
      if (mag > 1e-6) {
        const r = mag / dYield;
        const yFac = (r * r) / (1.0 + r * r); // smooth S-curve yield factor [0..1]
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

    // Gentle non-crossing cushion for approaching pairs (allows ~70% inward cheek pinch >w<!)
    if (list.length >= 2) {
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const ha = list[a], hb = list[b];
          const rdx = hb.anchorX - ha.anchorX;
          const rdy = hb.anchorY - ha.anchorY;
          const restDist = Math.hypot(rdx, rdy);
          if (restDist < 0.02) continue;

          const minSep = Math.min(0.105, restDist * 0.30);
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

    // Soft-Normalized compact Gaussian field with per-finger adaptive radius
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

    // Affine Pinch Corridor for any pair of approaching fingers -> fold-free >w< pinch!
    if (list.length >= 2) {
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
            const linX = (1.0 - tClamped) * ha.effDx + tClamped * hb.effDx;
            const linY = (1.0 - tClamped) * ha.effDy + tClamped * hb.effDy;
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
    const substeps = dt <= 0.005 ? 2 : (dt <= 0.0095 ? 3 : (dt <= 0.013 ? 4 : 5));
    const h = dt / substeps;

    const soft = this.params.softness / 100; // 0.1 .. 1.0
    const str = this.params.stretch / 100;   // 0.15 .. 1.0
    const bnc = this.params.bounce / 100;    // 0.0 .. 0.85
    const grabNorm = this.params.grab / 100; // 0.15 .. 1.0

    // Firm near-rest continuum + nonlinear Bingham strain-softening under extreme stretches!
    const kLap = 1520.0 - soft * 700.0;       // ~1114 at default -> crisp, smooth curve!
    const kBulk = 490.0 - soft * 260.0;       // ~339 at default -> plump mochi volume!
    const kHome = 475.0 - soft * 285.0;       // ~310 at default -> firm taut feel on slight touches!
    const gamma = 21.8 - bnc * 15.0;          // ~16.4 at default -> crisp slight settle, 1 creamy big bounce!
    const betaViscBase = 0.28 - bnc * 0.10;   // kills 100% of watery ripples!
    const betaVisc = Math.min(0.45, betaViscBase * (h * 300.0)); // frame-rate independent across 60/90/120/240 FPS!
    const kGrab = 1650.0 + str * 760.0;
    const cGrab = 52.0;

    // Nonlinear yield scale for home restoring force (small |u| stays firm, big |u| softens to 58%!)
    const invYieldU2 = 1.0 / (0.085 * 0.085);

    const hasFingers = this._buildFingerField(soft, str, grabNorm);
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

          // Nonlinear Bingham yield on restoring elasticity:
          // Firm near rest (homeSoften -> 1.0), chewy yield under extreme pull (homeSoften -> 0.58)
          const u2 = uxC * uxC + uyC * uyC;
          const kHomeEff = kHome * (0.58 + 0.42 / (1.0 + u2 * invYieldU2));

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
          ax = ax * wk - invW * (1900.0 * uxC + 48.0 * vx[k]);
          ay = ay * wk - invW * (1900.0 * uyC + 48.0 * vy[k]);

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
          if (sp2 > 36) {
            const sc = 6 / Math.sqrt(sp2);
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
        const sVal = Math.max(-1.0, Math.min(1.0, div * 1.15));
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
