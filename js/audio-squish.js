/**
 * SquishAudio — Procedural Web Audio API "puni / mofu" squish SFX with Volume slider
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
      this.playPuni(0.6, true);
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

  playPuni(intensity = 0.6, rising = true) {
    if (!this.enabled || this.volume <= 0.005) return;
    this._ensureContext();
    if (!this.ctx) return;

    const now = this.ctx.currentTime;
    if (now - this.lastPuniTime < 0.07) return;
    this.lastPuniTime = now;

    const vol = Math.min(0.32, (0.08 + intensity * 0.20) * this.volume);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();

    osc.type = 'sine';
    const f0 = rising ? 205 + intensity * 65 : 330 + intensity * 80;
    const f1 = rising ? 375 + intensity * 110 : 175 + intensity * 35;
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f1, now + 0.11);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(820, now);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(now);
    osc.stop(now + 0.15);
  }
}
