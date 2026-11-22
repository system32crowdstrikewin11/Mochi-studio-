/**
 * MochiPhysicsContinuum v16 — Exact 1:1 Analytic GPU Mochi Physics Engine
 *
 * Exact physics model matching the original mochi-maker engine:
 * - Up to 8 simultaneous multi-touch grabs, each driven by a 2nd-order damped
 *   harmonic oscillator (substepped at 240 Hz):
 *     * Held:     omega = 80 rad/s, zeta = 0.85, target = lmax * tanh(|d| / lmax)
 *     * Released: omega = 2*PI*releaseFreq (default 9 Hz!), zeta = releaseZeta (default 0.19)
 * - Dynamic radius growth: radiusEff = radius * S * (1 + 0.35 * min(1, |pull| / lmax))
 * - 60ms grab ease-in baked into per-grab strength alongside painted mask weight
 * - 3-iteration fixed-point inverse mapping (`invert`) so grabbing a wobbling or
 *   already-stretched cheek grabs the exact artwork pixel under your finger
 * - Quintic smootherstep falloff + ring(t) = 6.75 * t * (1 - t)^2 cheek bulge
 * - Seamless optional Phone Motion Sensor spring (tilt gravity + shake jiggle)
 *   that produces exactly (0, 0) when sensors are off!
 */

export const PHYSICS_CFG = {
  maxGrabs: 8,
  dragOmega: 80,
  dragZeta: 0.85,
  grabEaseMs: 60,
  radiusGrow: 0.35,
  substep: 1 / 240,
  maxDt: 1 / 30,
  settlePos: 0.001,
  settleVel: 0.01,
  alphaSampleMaxSide: 1024,
};

export const lerp = (a, b, t) => a + (b - a) * t;

/** Exact original Softness [0..1] -> Physics parameter mapping */
export function paramsFromSoftness(s) {
  return {
    radius: 0.22,
    stretch: lerp(0.44, 0.66, s),
    releaseFreq: lerp(12, 6, s),
    releaseZeta: lerp(0.28, 0.10, s),
    bulge: 0.10,
  };
}

/** Exact original Wobbles slider [0..1] <-> releaseZeta [0.35..0.10] mapping */
export function zetaFromWobble(w) {
  return lerp(0.35, 0.10, w);
}

export function wobbleFromZeta(z) {
  return Math.min(1, Math.max(0, (0.35 - z) / 0.25));
}

export const PRESETS = {
  real: {
    name: 'Original Mochi',
    softness: 0.50,
    ...paramsFromSoftness(0.50),
    motion: 58,
  },
  daifuku: {
    name: 'Soft Daifuku',
    softness: 0.90,
    radius: 0.26,
    stretch: 0.72,
    releaseFreq: 6.6,
    releaseZeta: 0.12,
    bulge: 0.14,
    motion: 74,
  },
  flan: {
    name: 'Jiggly Flan',
    softness: 0.75,
    radius: 0.24,
    stretch: 0.62,
    releaseFreq: 8.5,
    releaseZeta: 0.10,
    bulge: 0.16,
    motion: 82,
  },
  firm: {
    name: 'Firm Dough',
    softness: 0.10,
    radius: 0.18,
    stretch: 0.44,
    releaseFreq: 11.4,
    releaseZeta: 0.28,
    bulge: 0.06,
    motion: 40,
  },
};

function springStep(pos, vel, tx, ty, omega, zeta, dt) {
  const ax = omega * omega * (tx - pos.x) - 2 * zeta * omega * vel.x;
  const ay = omega * omega * (ty - pos.y) - 2 * zeta * omega * vel.y;
  vel.x += ax * dt;
  vel.y += ay * dt;
  pos.x += vel.x * dt;
  pos.y += vel.y * dt;
}

function falloff(t) {
  const s = 1 - t;
  return s * s * s * (6 * t * t + 3 * t + 1);
}

function ring(t) {
  return 6.75 * t * (1 - t) * (1 - t);
}

export class MochiPhysicsContinuum {
  constructor() {
    this.grabs = [];
    this.aspect = 1.0;
    this.maskEnabled = false;

    // Pixel samplers (u, v in [0, 1]) -> [0..1]
    this.maskSample = () => 1;
    this.alphaSample = () => 1;

    // Pre-allocated GPU uniform arrays (zero GC per frame)
    this.grabA = new Float32Array(PHYSICS_CFG.maxGrabs * 4);
    this.grabPull = new Float32Array(PHYSICS_CFG.maxGrabs * 2);

    // Physics parameters (exact original defaults at softness = 0.5)
    this.softness = 0.5;
    this.params = { ...PRESETS.real };

    // Dedicated whole-body Motion Sensor harmonic spring (tilt gravity + shake jiggle)
    this.motionPull = { x: 0, y: 0 };
    this.motionVel = { x: 0, y: 0 };
    this.motionGravity = { x: 0, y: 0 };
  }

  get S() {
    return Math.min(1, this.aspect);
  }

  lmax() {
    return this.params.stretch * this.params.radius * this.S;
  }

  radiusEff(grab) {
    const base = this.params.radius * this.S;
    const pullLen = Math.hypot(grab.pull.x, grab.pull.y);
    const lm = Math.max(1e-5, this.lmax());
    return base * (1 + PHYSICS_CFG.radiusGrow * Math.min(1, pullLen / lm));
  }

  strengthOf(grab) {
    return Math.min(1, (grab.ease * 1000) / PHYSICS_CFG.grabEaseMs) * grab.weight;
  }

  setAspect(aspect) {
    this.aspect = aspect;
    this.resetPose();
  }

  updateArtworkAlphaSampler(imgOrCanvas) {
    const srcW = imgOrCanvas.naturalWidth || imgOrCanvas.width || 512;
    const srcH = imgOrCanvas.naturalHeight || imgOrCanvas.height || 512;
    const scale = Math.min(1, PHYSICS_CFG.alphaSampleMaxSide / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(imgOrCanvas, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    this.alphaSample = (u, v) => {
      const ix = Math.min(w - 1, Math.max(0, Math.round(u * (w - 1))));
      const iy = Math.min(h - 1, Math.max(0, Math.round(v * (h - 1))));
      return data[(iy * w + ix) * 4 + 3] / 255;
    };
  }

  setSoftness(s) {
    this.softness = Math.max(0, Math.min(1, s));
    const next = paramsFromSoftness(this.softness);
    Object.assign(this.params, next);
  }

  setParams(partial) {
    Object.assign(this.params, partial);
  }

  applyPreset(key) {
    const p = PRESETS[key];
    if (!p) return;
    this.softness = p.softness;
    this.params = { ...p };
  }

  resetPose() {
    this.grabs.length = 0;
    this.motionPull.x = 0;
    this.motionPull.y = 0;
    this.motionVel.x = 0;
    this.motionVel.y = 0;
  }

  /** Exact CPU mirror of vertex shader displacementAt(u, v) for inverse grab picking */
  displacementAt(u, v) {
    const isoX = u * this.aspect;
    const isoY = v;
    let dxSum = 0;
    let dySum = 0;
    let wSum = 0;
    const bulge = this.params.bulge;

    for (let i = 0; i < this.grabs.length; i++) {
      const g = this.grabs[i];
      const str = this.strengthOf(g);
      if (str <= 0) continue;
      const rx = isoX - g.anchor.x;
      const ry = isoY - g.anchor.y;
      const d = Math.hypot(rx, ry);
      const rEff = this.radiusEff(g);
      const t = Math.min(1, d / rEff);
      const w = falloff(t) * str;
      const pullLen = Math.hypot(g.pull.x, g.pull.y);
      const dirX = d > 1e-5 ? rx / d : 0;
      const dirY = d > 1e-5 ? ry / d : 0;
      const rVal = ring(t);
      dxSum += w * g.pull.x + bulge * pullLen * rVal * dirX * str;
      dySum += w * g.pull.y + bulge * pullLen * rVal * dirY * str;
      wSum += w;
    }

    const m = this.maskEnabled ? this.maskSample(u, v) : 1;
    const norm = m / Math.max(1, wSum);
    return {
      x: dxSum * norm + this.motionPull.x * m,
      y: dySum * norm + this.motionPull.y * m,
    };
  }

  /** 3-iteration fixed-point inversion from deformed iso -> rest UV [0, 1] */
  invert(isoX, isoY) {
    let u = isoX / this.aspect;
    let v = isoY;
    for (let iter = 0; iter < 3; iter++) {
      const disp = this.displacementAt(u, v);
      u = (isoX - disp.x) / this.aspect;
      v = isoY - disp.y;
    }
    return { x: u, y: v };
  }

  /** Try grabbing at isotropic point (isoX, isoY). Returns grab object or null if outside artwork/mask. */
  tryGrab(pointerId, isoX, isoY) {
    if (this.grabs.length >= PHYSICS_CFG.maxGrabs) {
      const idx = this.grabs.findIndex((g) => g.released);
      if (idx < 0) return null;
      this.grabs.splice(idx, 1);
    }

    const uv = this.invert(isoX, isoY);
    if (uv.x < 0 || uv.x > 1 || uv.y < 0 || uv.y > 1) return null;
    if (this.alphaSample(uv.x, uv.y) < 0.05) return null;

    const weight = this.maskEnabled ? this.maskSample(uv.x, uv.y) : 1;
    if (weight < 0.05) return null;

    const grab = {
      pointerId,
      anchor: { x: uv.x * this.aspect, y: uv.y },
      pointer: { x: isoX, y: isoY },
      pull: { x: 0, y: 0 },
      vel: { x: 0, y: 0 },
      ease: 0,
      weight,
      released: false,
    };
    this.grabs.push(grab);
    return grab;
  }

  move(pointerId, isoX, isoY) {
    const g = this.grabs.find((item) => item.pointerId === pointerId && !item.released);
    if (g) {
      g.pointer.x = isoX;
      g.pointer.y = isoY;
    }
  }

  release(pointerId) {
    const g = this.grabs.find((item) => item.pointerId === pointerId && !item.released);
    if (!g) return null;
    g.released = true;
    return g;
  }

  releaseAllActive() {
    for (let i = 0; i < this.grabs.length; i++) {
      if (!this.grabs[i].released) this.grabs[i].released = true;
    }
  }

  intensityOf(grab) {
    if (!grab) return 0;
    return Math.min(1, Math.hypot(grab.pull.x, grab.pull.y) / Math.max(1e-5, this.lmax()));
  }

  /** Optional Phone Motion Sensors (Tilt gravity + Shake jiggle) */
  setMotionForce(gx, gy, ax = 0, ay = 0) {
    const sens = (this.params.motion ?? 58) / 100;
    const maxTiltDisp = this.lmax() * (0.35 + sens * 0.65);
    this.motionGravity.x = gx * maxTiltDisp;
    this.motionGravity.y = gy * maxTiltDisp;
    if (Math.abs(ax) > 1e-4 || Math.abs(ay) > 1e-4) {
      const impScale = (0.16 + sens * 0.28) * this.S;
      this.motionVel.x += ax * impScale;
      this.motionVel.y += ay * impScale;
    }
  }

  triggerJiggle(strength = 1.0) {
    const dir = Math.random() < 0.5 ? 1 : -1;
    const imp = (1.6 + this.softness * 1.4) * this.S * strength;
    this.motionVel.x += dir * imp;
    this.motionVel.y += 0.45 * imp;
  }

  step(dtRaw) {
    const dt = Math.min(Math.max(dtRaw, 0), PHYSICS_CFG.maxDt);
    if (dt <= 0) return;

    const omegaRel = 2 * Math.PI * this.params.releaseFreq;
    const zetaRel = this.params.releaseZeta;
    const lm = Math.max(1e-5, this.lmax());
    const settlePos = PHYSICS_CFG.settlePos * this.S;
    const settleVel = PHYSICS_CFG.settleVel * this.S;
    const substeps = Math.max(1, Math.ceil(dt / PHYSICS_CFG.substep));
    const h = dt / substeps;

    // 1. Exact original per-grab damped harmonic spring integration
    for (let i = this.grabs.length - 1; i >= 0; i--) {
      const g = this.grabs[i];
      g.ease += dt;

      let tx = 0;
      let ty = 0;
      if (!g.released) {
        const dx = g.pointer.x - g.anchor.x;
        const dy = g.pointer.y - g.anchor.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 1e-9) {
          const eff = lm * Math.tanh(dist / lm);
          tx = (dx / dist) * eff;
          ty = (dy / dist) * eff;
        }
      }

      const omega = g.released ? omegaRel : PHYSICS_CFG.dragOmega;
      const zeta = g.released ? zetaRel : PHYSICS_CFG.dragZeta;
      for (let s = 0; s < substeps; s++) {
        springStep(g.pull, g.vel, tx, ty, omega, zeta, h);
      }

      if (
        g.released &&
        Math.hypot(g.pull.x, g.pull.y) < settlePos &&
        Math.hypot(g.vel.x, g.vel.y) < settleVel
      ) {
        this.grabs.splice(i, 1);
      }
    }

    // 2. Optional Motion Sensor whole-body spring (zero when idle & sensors off)
    const hasMotionTarget = Math.abs(this.motionGravity.x) > 1e-5 || Math.abs(this.motionGravity.y) > 1e-5;
    const hasMotionEnergy =
      Math.hypot(this.motionPull.x, this.motionPull.y) > 1e-5 ||
      Math.hypot(this.motionVel.x, this.motionVel.y) > 1e-4;

    if (hasMotionTarget || hasMotionEnergy) {
      // Softly clamp motion target with tanh so extreme tilt stays cute & bounded
      const mgDist = Math.hypot(this.motionGravity.x, this.motionGravity.y);
      let mtx = 0;
      let mty = 0;
      if (mgDist > 1e-9) {
        const mLim = lm * 0.95;
        const eff = mLim * Math.tanh(mgDist / mLim);
        mtx = (this.motionGravity.x / mgDist) * eff;
        mty = (this.motionGravity.y / mgDist) * eff;
      }
      // Slightly gentler whole-body frequency (~0.75x) so shaking feels plump & cohesive
      const mOmega = omegaRel * 0.78;
      for (let s = 0; s < substeps; s++) {
        springStep(this.motionPull, this.motionVel, mtx, mty, mOmega, zetaRel, h);
      }
      if (
        !hasMotionTarget &&
        Math.hypot(this.motionPull.x, this.motionPull.y) < settlePos * 0.5 &&
        Math.hypot(this.motionVel.x, this.motionVel.y) < settleVel * 0.5
      ) {
        this.motionPull.x = 0;
        this.motionPull.y = 0;
        this.motionVel.x = 0;
        this.motionVel.y = 0;
      }
    }
  }

  get active() {
    return (
      this.grabs.length > 0 ||
      Math.hypot(this.motionPull.x, this.motionPull.y) > 1e-5 ||
      Math.hypot(this.motionVel.x, this.motionVel.y) > 1e-4
    );
  }

  fillUniforms() {
    const count = Math.min(this.grabs.length, PHYSICS_CFG.maxGrabs);
    for (let i = 0; i < count; i++) {
      const g = this.grabs[i];
      this.grabA[i * 4] = g.anchor.x;
      this.grabA[i * 4 + 1] = g.anchor.y;
      this.grabA[i * 4 + 2] = this.radiusEff(g);
      this.grabA[i * 4 + 3] = this.strengthOf(g);
      this.grabPull[i * 2] = g.pull.x;
      this.grabPull[i * 2 + 1] = g.pull.y;
    }
    return {
      grabCount: count,
      grabA: this.grabA,
      grabPull: this.grabPull,
      bulge: this.params.bulge,
      motionX: this.motionPull.x,
      motionY: this.motionPull.y,
      maskEnabled: this.maskEnabled,
    };
  }
}
