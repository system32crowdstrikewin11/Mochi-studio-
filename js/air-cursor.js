/**
 * AirCursorController v22 — Dual-Mode Site-Wide Hand-Tracked Air Cursor
 *
 * Works seamlessly with BOTH tracking engines:
 * 1. AI Hands (`mode: 'pinch'`):
 *    - Thumb + Index Pinch & Hold = Long-Press Grab & Pull (2 hands simultaneously!),
 *      Mid-Air Paint strokes, Range Slider scrubbing, or Settings scrolling.
 *    - Quick Pinch = Click any button, tab, sample, preset, or checkbox.
 * 2. Fast Flow (`mode: 'dwell'` — 100% offline & 0ms startup!):
 *    - Hover & Hold Still (~0.42s) fills the tactile pink progress ring:
 *      * On Buttons / Tabs / Checkboxes -> fires a clean Click!
 *      * On Mochi Character / Paint Canvas / Range Slider -> locks Long-Press Grab!
 *        Moving your hand now pulls & stretches that exact spot (or paints / scrubs)!
 *    - Hold Still again (~0.52s) while grabbed fills a crisp white/mint release ring
 *      and snaps back with full mochi bounce + wobble audio!
 */

const CLICK_COOLDOWN_MS = 320;
const DWELL_LOCK_MS = 420;
const DWELL_RELEASE_MS = 520;
const DWELL_REARM_MS = 700;
const DWELL_STILL_RADIUS_PX = 18;
const DRAG_DEADZONE_PX = 6;

export class AirCursorController {
  constructor(canvas, hooks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hooks = hooks;

    this.enabled = true;
    this.cssW = 1;
    this.cssH = 1;
    this.dpr = 1;
    this._hasDrawn = false;

    this._hoveredEl = null;
    this._ripples = [];

    this._slots = [0, 1].map((slot) => ({
      slot,
      mode: 'idle', // 'idle' | 'play-grab' | 'paint' | 'ui-press' | 'slider' | 'scroll'
      inputMode: 'pinch', // 'pinch' | 'dwell'
      targetEl: null,
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
      scrollStartTop: 0,
      lastClickMs: 0,
      moved: false,

      // Fast Flow Dwell-Lock / Dwell-Release state
      dwellAnchorX: 0,
      dwellAnchorY: 0,
      dwellStartMs: 0,
      dwellProgress: 0,     // 0..1 lock progress
      releaseProgress: 0,   // 0..1 release countdown progress while grabbed
      dwellRearmUntil: 0,
      dwellStatus: '',
    }));

    this.resize();
  }

  resize() {
    this.cssW = Math.max(1, window.innerWidth);
    this.cssH = Math.max(1, window.innerHeight);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.cssW * this.dpr);
    const h = Math.round(this.cssH * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  _setHovered(el) {
    if (this._hoveredEl === el) return;
    if (this._hoveredEl) this._hoveredEl.classList.remove('air-hover');
    this._hoveredEl = el;
    if (this._hoveredEl) this._hoveredEl.classList.add('air-hover');
  }

  _spawnRipple(x, y, color = '#ff5a8d') {
    this._ripples.push({ x, y, r: 8, maxR: 34, alpha: 0.72, color });
  }

  _hitTest(x, y) {
    const raw = document.elementFromPoint(x, y);
    if (!raw) return { kind: 'none', el: null };

    if (raw.matches && raw.matches('input[type="range"]')) {
      return { kind: 'slider', el: raw };
    }
    const rowSlider = raw.closest && raw.closest('.size-slider-col, .row-slider, .custom-fps-row');
    if (rowSlider) {
      const slider = rowSlider.querySelector('input[type="range"]');
      if (slider) {
        const sr = slider.getBoundingClientRect();
        if (x >= sr.left - 14 && x <= sr.right + 14 && y >= sr.top - 16 && y <= sr.bottom + 16) {
          return { kind: 'slider', el: slider };
        }
      }
    }

    const clickable = raw.closest && raw.closest('button:not(:disabled), a[href], label, input[type="checkbox"]');
    if (clickable) {
      return { kind: 'click', el: clickable };
    }

    if (raw === this.hooks.glCanvas) {
      return { kind: 'canvas', el: raw };
    }

    if (raw.id === 'settingsBackdrop' || raw.id === 'previewModal') {
      return { kind: 'click', el: raw };
    }

    const sheet = raw.closest && raw.closest('.settings-sheet, .preview-card');
    if (sheet && sheet.scrollHeight > sheet.clientHeight + 4) {
      return { kind: 'scroll', el: sheet };
    }

    return { kind: 'none', el: null };
  }

  _scrubSlider(slider, clientX) {
    const rect = slider.getBoundingClientRect();
    if (rect.width <= 2) return;
    const min = parseFloat(slider.min);
    const max = parseFloat(slider.max);
    const step = parseFloat(slider.step);
    const lo = Number.isFinite(min) ? min : 0;
    const hi = Number.isFinite(max) ? max : 100;
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    let val = lo + t * (hi - lo);
    if (Number.isFinite(step) && step > 0) {
      val = Math.round((val - lo) / step) * step + lo;
      val = Math.max(lo, Math.min(hi, val));
    }
    const strVal = Number.isFinite(step) && step < 1 ? val.toFixed(4) : String(Math.round(val));
    if (slider.value !== strVal) {
      slider.value = strVal;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  _resetDwell(st) {
    st.dwellStartMs = 0;
    st.dwellProgress = 0;
    st.releaseProgress = 0;
  }

  _endSlot(st, now, cx, cy, allowClick) {
    if (st.mode === 'play-grab') {
      this.hooks.onPlayGrabEnd(st.slot);
      this._spawnRipple(cx, cy, '#ff8fab');
    } else if (st.mode === 'paint') {
      this.hooks.onPaintEnd();
    } else if (st.mode === 'slider' && st.targetEl) {
      st.targetEl.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (st.mode === 'ui-press' && allowClick && st.targetEl) {
      if (now - st.lastClickMs >= CLICK_COOLDOWN_MS) {
        st.lastClickMs = now;
        const target = st.targetEl;
        const r = target.getBoundingClientRect();
        const pad = 26;
        if (cx >= r.left - pad && cx <= r.right + pad && cy >= r.top - pad && cy <= r.bottom + pad) {
          this._spawnRipple(cx, cy, '#ff4f86');
          target.click();
        }
      }
    }

    st.mode = 'idle';
    st.targetEl = null;
    st.moved = false;
    this._resetDwell(st);
  }

  resetAll() {
    this._setHovered(null);
    const now = performance.now();
    for (const st of this._slots) {
      if (st.mode !== 'idle') {
        this._endSlot(st, now, st.lastX, st.lastY, false);
      } else {
        this._resetDwell(st);
      }
      st.dwellStatus = '';
    }
    if (this._hasDrawn) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._hasDrawn = false;
    }
  }

  isAnyHandBusy() {
    return this._slots[0].mode !== 'idle' || this._slots[1].mode !== 'idle';
  }

  getStatusBadge() {
    const s0 = this._slots[0];
    if (s0.inputMode === 'dwell' && s0.mode !== 'idle') {
      if (s0.mode === 'play-grab') return '✊ Pull!';
      if (s0.mode === 'paint') return '🖌 Paint!';
      if (s0.mode === 'slider') return '↔ Scrub';
    }
    return '';
  }

  _updateDwellSlot(st, now, cx, cy, hit, step) {
    // 1. If currently locked into a drag/grab/paint/slider:
    if (st.mode !== 'idle') {
      st.dwellProgress = 1;
      if (st.mode === 'play-grab') {
        this.hooks.onPlayGrabMove(st.slot, cx, cy);
      } else if (st.mode === 'paint') {
        this.hooks.onPaintMove(cx, cy);
      } else if (st.mode === 'slider' && st.targetEl) {
        this._scrubSlider(st.targetEl, cx);
      } else if (st.mode === 'scroll' && st.targetEl) {
        st.targetEl.scrollTop = st.scrollStartTop - (cy - st.startY) * 1.45;
      }

      // Check if user paused hand steady to release!
      const distFromAnchor = Math.hypot(cx - st.dwellAnchorX, cy - st.dwellAnchorY);
      if (distFromAnchor > DWELL_STILL_RADIUS_PX) {
        st.dwellAnchorX = cx;
        st.dwellAnchorY = cy;
        st.dwellStartMs = now;
        st.releaseProgress = 0;
        st.moved = true;
      } else {
        if (st.dwellStartMs === 0) {
          st.dwellStartMs = now;
          st.dwellAnchorX = cx;
          st.dwellAnchorY = cy;
        }
        const elapsed = now - st.dwellStartMs;
        // Wait 140ms before starting release arc so quick pauses mid-stretch feel natural
        if (elapsed > 140) {
          st.releaseProgress = Math.min(1, (elapsed - 140) / DWELL_RELEASE_MS);
          if (st.releaseProgress >= 1) {
            st.dwellRearmUntil = now + DWELL_REARM_MS;
            this._endSlot(st, now, cx, cy, false);
          }
        } else {
          st.releaseProgress = 0;
        }
      }
      return;
    }

    // 2. IDLE state in Dwell mode: check if hovering over something actionable
    const canInteract =
      hit.kind === 'click' ||
      hit.kind === 'slider' ||
      hit.kind === 'scroll' ||
      (hit.kind === 'canvas' && (step === 'play' || step === 'paint') &&
        (step !== 'play' || !this.hooks.canPlayGrabAt || this.hooks.canPlayGrabAt(cx, cy)));

    if (!canInteract) {
      this._resetDwell(st);
      return;
    }

    // Re-arm immediately if user moved away from last click/release point
    const distFromAnchor = Math.hypot(cx - st.dwellAnchorX, cy - st.dwellAnchorY);
    if (distFromAnchor > DWELL_STILL_RADIUS_PX) {
      st.dwellAnchorX = cx;
      st.dwellAnchorY = cy;
      st.dwellStartMs = now;
      st.dwellProgress = 0;
      if (now < st.dwellRearmUntil && distFromAnchor > DWELL_STILL_RADIUS_PX * 1.8) {
        st.dwellRearmUntil = 0;
      }
      return;
    }

    if (now < st.dwellRearmUntil) {
      st.dwellProgress = 0;
      st.dwellStartMs = now;
      return;
    }

    if (st.dwellStartMs === 0) {
      st.dwellStartMs = now;
      st.dwellAnchorX = cx;
      st.dwellAnchorY = cy;
      return;
    }

    const elapsed = now - st.dwellStartMs;
    st.dwellProgress = Math.min(1, elapsed / DWELL_LOCK_MS);

    if (st.dwellProgress >= 1) {
      st.startX = cx;
      st.startY = cy;
      st.moved = false;
      st.dwellAnchorX = cx;
      st.dwellAnchorY = cy;
      st.dwellStartMs = now;
      st.releaseProgress = 0;

      if (hit.kind === 'click') {
        st.dwellRearmUntil = now + DWELL_REARM_MS;
        this._resetDwell(st);
        this._spawnRipple(cx, cy, '#ff4f86');
        hit.el.click();
      } else if (hit.kind === 'canvas' && step === 'play') {
        const grabbed = this.hooks.onPlayGrabStart(st.slot, cx, cy);
        if (grabbed) {
          st.mode = 'play-grab';
          st.targetEl = hit.el;
          this._spawnRipple(cx, cy, '#ff4f86');
        } else {
          st.dwellRearmUntil = now + 350;
          this._resetDwell(st);
        }
      } else if (hit.kind === 'canvas' && step === 'paint') {
        st.mode = 'paint';
        st.targetEl = hit.el;
        this.hooks.onPaintStart(cx, cy);
        this._spawnRipple(cx, cy, '#ff6b9b');
      } else if (hit.kind === 'slider') {
        st.mode = 'slider';
        st.targetEl = hit.el;
        this._scrubSlider(hit.el, cx);
        this._spawnRipple(cx, cy, '#ff4f86');
      } else if (hit.kind === 'scroll') {
        st.mode = 'scroll';
        st.targetEl = hit.el;
        st.scrollStartTop = hit.el.scrollTop;
      }
    }
  }

  update(now, cursors) {
    if (!this.enabled) {
      this.resetAll();
      return;
    }

    const bySlot = [null, null];
    for (let i = 0; i < cursors.length; i++) {
      const c = cursors[i];
      if (c && (c.id === 0 || c.id === 1)) bySlot[c.id] = c;
    }

    const step = this.hooks.getStep();
    let hoveredCandidate = null;

    for (let s = 0; s < 2; s++) {
      const st = this._slots[s];
      const hc = bySlot[s];

      if (!hc) {
        if (st.mode !== 'idle') {
          this._endSlot(st, now, st.lastX, st.lastY, false);
        } else {
          this._resetDwell(st);
        }
        continue;
      }

      const cx = hc.x * this.cssW;
      const cy = hc.y * this.cssH;
      st.lastX = cx;
      st.lastY = cy;
      st.inputMode = hc.mode === 'dwell' ? 'dwell' : 'pinch';

      const hit = this._hitTest(cx, cy);

      if (s === 0) {
        if (hit.kind === 'click' || hit.kind === 'slider') {
          hoveredCandidate = hit.el;
        }
        if (step === 'paint' && hit.kind === 'canvas' && st.mode === 'idle') {
          this.hooks.onPaintHover(cx, cy);
        }
      }

      // ---- FAST FLOW DWELL-LOCK MODE ----
      if (st.inputMode === 'dwell') {
        if (s === 0) {
          this._updateDwellSlot(st, now, cx, cy, hit, step);
        }
        continue;
      }

      // ---- AI HANDS PINCH MODE ----
      if (hc.pinching) {
        if (st.mode === 'idle') {
          st.startX = cx;
          st.startY = cy;
          st.moved = false;

          if (hit.kind === 'canvas' && step === 'play') {
            const grabbed = this.hooks.onPlayGrabStart(s, cx, cy);
            if (grabbed) {
              st.mode = 'play-grab';
              st.targetEl = hit.el;
              this._spawnRipple(cx, cy, '#ff4f86');
            }
          } else if (s === 0 && hit.kind === 'canvas' && step === 'paint') {
            st.mode = 'paint';
            st.targetEl = hit.el;
            this.hooks.onPaintStart(cx, cy);
            this._spawnRipple(cx, cy, '#ff6b9b');
          } else if (s === 0 && hit.kind === 'slider') {
            st.mode = 'slider';
            st.targetEl = hit.el;
            this._scrubSlider(hit.el, cx);
          } else if (s === 0 && hit.kind === 'click') {
            st.mode = 'ui-press';
            st.targetEl = hit.el;
          } else if (s === 0 && hit.kind === 'scroll') {
            st.mode = 'scroll';
            st.targetEl = hit.el;
            st.scrollStartTop = hit.el.scrollTop;
          }
        } else {
          if (!st.moved && Math.hypot(cx - st.startX, cy - st.startY) > DRAG_DEADZONE_PX) {
            st.moved = true;
          }
          if (st.mode === 'play-grab') {
            this.hooks.onPlayGrabMove(s, cx, cy);
          } else if (st.mode === 'paint') {
            this.hooks.onPaintMove(cx, cy);
          } else if (st.mode === 'slider' && st.targetEl) {
            this._scrubSlider(st.targetEl, cx);
          } else if (st.mode === 'scroll' && st.targetEl) {
            st.targetEl.scrollTop = st.scrollStartTop - (cy - st.startY) * 1.45;
          }
        }
      } else if (st.mode !== 'idle') {
        this._endSlot(st, now, cx, cy, true);
      }
    }

    this._setHovered(hoveredCandidate);
    this._render(bySlot);
  }

  _render(bySlot) {
    const anyCursor = Boolean(bySlot[0] || bySlot[1]);
    const anyRipple = this._ripples.length > 0;

    if (!anyCursor && !anyRipple) {
      if (this._hasDrawn) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this._hasDrawn = false;
      }
      return;
    }

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    this._hasDrawn = true;

    for (let i = this._ripples.length - 1; i >= 0; i--) {
      const rp = this._ripples[i];
      rp.r += 1.9;
      rp.alpha *= 0.88;
      if (rp.alpha < 0.03 || rp.r > rp.maxR) {
        this._ripples.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, rp.r, 0, Math.PI * 2);
      ctx.strokeStyle = rp.color;
      ctx.globalAlpha = rp.alpha;
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.restore();
    }

    const twoHands = Boolean(bySlot[0] && bySlot[1]);
    for (let s = 0; s < 2; s++) {
      const hc = bySlot[s];
      if (!hc) continue;
      const st = this._slots[s];
      const x = hc.x * this.cssW;
      const y = hc.y * this.cssH;

      const isDwell = st.inputMode === 'dwell';
      const locked = isDwell ? st.mode !== 'idle' : Boolean(hc.pinching);
      const prog = isDwell ? st.dwellProgress : Math.max(0, Math.min(1, hc.pinchProgress || 0));
      const relProg = isDwell ? st.releaseProgress : 0;

      // Elastic dashed pull tether while pulling a cheek!
      if (st.mode === 'play-grab') {
        const dist = Math.hypot(x - st.startX, y - st.startY);
        if (dist > 6) {
          ctx.save();
          ctx.beginPath();
          ctx.setLineDash([5, 5]);
          ctx.moveTo(st.startX, st.startY);
          ctx.lineTo(x, y);
          ctx.strokeStyle = 'rgba(255, 79, 134, 0.65)';
          ctx.lineWidth = 2.2;
          ctx.lineCap = 'round';
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.beginPath();
          ctx.arc(st.startX, st.startY, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 79, 134, 0.72)';
          ctx.fill();
          ctx.restore();
        }
      }

      const outerR = locked ? 13.5 : (20 - prog * 5.5);
      ctx.save();

      ctx.shadowColor = locked ? 'rgba(255, 79, 134, 0.45)' : 'rgba(242, 132, 164, 0.30)';
      ctx.shadowBlur = locked ? 14 : 8;

      ctx.beginPath();
      ctx.arc(x, y, outerR, 0, Math.PI * 2);
      ctx.fillStyle = locked
        ? 'rgba(255, 79, 134, 0.30)'
        : (st.mode === 'idle' && s === 0 && this._hoveredEl
          ? 'rgba(242, 132, 164, 0.24)'
          : 'rgba(255, 255, 255, 0.22)');
      ctx.fill();

      ctx.lineWidth = locked ? 2.8 : 1.8;
      ctx.strokeStyle = locked ? '#ff4f86' : 'rgba(235, 107, 146, 0.72)';
      ctx.stroke();

      // Pinch-closeness or Dwell-lock progress arc (pink, fills clockwise)
      if (!locked && prog > 0.06) {
        ctx.beginPath();
        ctx.arc(x, y, outerR + 3.2, -Math.PI * 0.5, -Math.PI * 0.5 + prog * Math.PI * 2);
        ctx.strokeStyle = '#ff4f86';
        ctx.lineWidth = 2.8;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      // Fast Flow Dwell-Release countdown arc (crisp mint/white, fills when holding still to release!)
      if (locked && relProg > 0.04) {
        ctx.beginPath();
        ctx.arc(x, y, outerR + 4.2, -Math.PI * 0.5, -Math.PI * 0.5 + relProg * Math.PI * 2);
        ctx.strokeStyle = '#38d9a9';
        ctx.lineWidth = 3.0;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      // Center precision dot
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(x, y, locked ? 5.2 : 3.4, 0, Math.PI * 2);
      ctx.fillStyle = locked ? '#ff4f86' : '#ffffff';
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = '#ff4f86';
      ctx.stroke();

      if (twoHands) {
        ctx.font = '800 10px system-ui, -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(74, 58, 64, 0.85)';
        ctx.beginPath();
        ctx.roundRect(x - 10, y - outerR - 17, 20, 14, 7);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(String(s + 1), x, y - outerR - 10);
      }

      ctx.restore();
    }
  }
}
