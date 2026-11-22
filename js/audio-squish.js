/**
 * SquishAudio v16 — Exact 1:1 Original Mochi Web Audio Synthesizer
 *
 * - Grab:    sine 185 -> 130 Hz (90ms) + 500 Hz lowpass white noise cushion puff (60ms)
 * - Release: sine 240 -> 165 Hz (300ms) amplitude-modulated at the exact visual
 *            wobble frequency (`releaseFreq` Hz) so audio & visual wobble match 1:1!
 */

export class SquishAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true; // Active by default (unlocks cleanly on first touch, toggleable anytime)
    this.volume = 0.70;  // Exact original default volume (0.7)
  }

  _ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    if (this.master) {
      this.master.gain.value = this.enabled ? this.volume : 0;
    }
    return this.ctx;
  }

  unlock() {
    const ctx = this._ensure();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      // ignore
    }
  }

  setVolume(norm) {
    this.volume = Math.max(0, Math.min(1, norm));
    if (this.volume > 0 && !this.enabled) {
      this.enabled = true;
    } else if (this.volume === 0) {
      this.enabled = false;
    }
    if (this.master) {
      this.master.gain.value = this.enabled ? this.volume : 0;
    }
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.enabled) {
      if (this.volume < 0.05) this.volume = 0.70;
      this._ensure();
      this.playGrab();
    } else if (this.master) {
      this.master.gain.value = 0;
    }
    return this.enabled;
  }

  _noiseSource(ctx, durSec) {
    const len = Math.ceil(ctx.sampleRate * durSec);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  /** Exact original grab sound: soft sine dip + filtered cushion noise puff */
  playGrab() {
    if (!this.enabled || this.volume <= 0.005) return;
    const ctx = this._ensure();
    if (!ctx) return;

    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(185, t);
    osc.frequency.exponentialRampToValueAtTime(130, t + 0.09);

    const g1 = ctx.createGain();
    g1.gain.setValueAtTime(0, t);
    g1.gain.linearRampToValueAtTime(0.30, t + 0.008);
    g1.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(g1).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.14);

    const noise = this._noiseSource(ctx, 0.06);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.10, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    noise.connect(lp).connect(g2).connect(this.master);
    noise.start(t);
  }

  /** Exact original release wobble sound synced to releaseFreq (Hz)! */
  playRelease(intensity, releaseFreq = 9.0) {
    if (!this.enabled || this.volume <= 0.005 || intensity < 0.05) return;
    const ctx = this._ensure();
    if (!ctx) return;

    const t = ctx.currentTime;
    const peakGain = 0.12 + 0.30 * Math.min(1, intensity);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(240, t);
    osc.frequency.exponentialRampToValueAtTime(165, t + 0.30);

    const env = ctx.createGain();
    env.gain.setValueAtTime(peakGain, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + 0.40);

    const am = ctx.createGain();
    am.gain.setValueAtTime(1.0, t);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = Math.max(2, releaseFreq);
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.5;
    lfo.connect(lfoDepth).connect(am.gain);

    osc.connect(env).connect(am).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.45);
    lfo.start(t);
    lfo.stop(t + 0.45);
  }
}
