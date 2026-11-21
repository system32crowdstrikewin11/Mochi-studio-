/**
 * SquishAudio v15 — Organic Tactile Mochi "Bup / Boing" Web Audio Synthesizer
 *
 * Replaces flat pure-sine whistles with warm, percussive mochi sound design:
 * - Touch/Grab: short muted low-mid "bup" cushion pop (135 -> 225 Hz)
 * - Snap-Back Release: stretch-scaled bouncy "boing-boing" with warm resonance
 *   and pitch-wobble matching the visual elastic rebound!
 */

export class SquishAudio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.volume = 0.55; // 0..1
    this.lastPuniTime = 0;
  }

  setVolume(norm) {
    this.volume = Math.max(0, Math.min(1, norm));
    if (this.volume > 0 && !this.enabled) {
      this.enabled = true;
    } else if (this.volume === 0) {
      this.enabled = false;
    }
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.enabled) {
      if (this.volume < 0.05) this.volume = 0.55;
      this._ensureContext();
      this.playPuni(0.55, false);
    }
    return this.enabled;
  }

  _ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  playPuni(intensity = 0.5, isGrab = true) {
    if (!this.enabled || this.volume <= 0.005) return;
    this._ensureContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    if (now - this.lastPuniTime < 0.055) return;
    this.lastPuniTime = now;

    const clamped = Math.max(0.08, Math.min(1.0, intensity));

    if (isGrab) {
      // Soft muted low-mid "bup" cushion touch
      const vol = Math.min(0.24, (0.09 + clamped * 0.12) * this.volume);
      const osc = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(132 + clamped * 28, now);
      osc.frequency.exponentialRampToValueAtTime(215 + clamped * 45, now + 0.055);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(460, now);
      filter.Q.setValueAtTime(1.8, now);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(vol, now + 0.009);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.072);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + 0.08);
      return;
    }

    // Crisp elastic "boing-boing" snap-back scaled by actual pull stretch!
    if (clamped < 0.14) return; // skip boing on tiny zero-stretch tap

    const vol = Math.min(0.32, (0.09 + clamped * 0.22) * this.volume);
    const osc = this.ctx.createOscillator();
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();

    const baseF = 165 + clamped * 45;
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(baseF * 1.48, now);
    osc.frequency.exponentialRampToValueAtTime(baseF * 0.88, now + 0.075);
    osc.frequency.exponentialRampToValueAtTime(baseF * 1.12, now + 0.145);
    osc.frequency.exponentialRampToValueAtTime(baseF * 0.96, now + 0.21);

    // Subtle elastic wobble vibrato (~15 Hz) decaying with the bounce
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(15.5, now);
    lfoGain.gain.setValueAtTime(22 * clamped, now);
    lfoGain.gain.exponentialRampToValueAtTime(1.5, now + 0.22);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(520 + clamped * 260, now);
    filter.Q.setValueAtTime(2.6, now);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.010);
    gain.gain.exponentialRampToValueAtTime(vol * 0.42, now + 0.095);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.23);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    lfo.start(now);
    osc.stop(now + 0.25);
    lfo.stop(now + 0.25);
  }
}
