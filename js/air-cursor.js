/**
 * AirCursorController v21 — Full Site-Wide Hand-Tracked Air Cursor
 *
 * Turns hand tracking into an actual site-wide cursor with tactile feedback:
 * - Play Mode Canvas: Pinch & Hold (long press) grabs the exact spot under the
 *   cursor and moving your hand pulls/stretches it (up to 2 hands simultaneously!).
 *   Releasing the pinch snaps it back with full mochi bounce + wobble audio.
 * - Paint Mode Canvas: Hover moves the live brush cursor; Pinch & Hold paints
 *   or erases directly on the squishy mask with full Undo/Redo support.
 * - Site-Wide UI: Hover highlights buttons, tabs, checkboxes, presets & sliders.
 *   Quick Pinch clicks controls; Pinch & Drag on any range slider scrubs its value
 *   smoothly; Pinch & Drag on the Settings sheet scrolls vertically.
 */

const CLICK_COOLDOWN_MS = 320;
const DRAG_DEADZONE_PX = 6;

export class AirCursorController {
  constructor(canvas, hooks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hooks = hooks; // { getStep, glCanvas, onPlayGrabStart, onPlayGrabMove, onPlayGrabEnd, onPaintHover, onPaintStart, onPaintMove, onPaintEnd }

    this.enabled = true;
    this.cssW = 1;
    this.cssH = 1;
    this.dpr = 1;
    this._hasDrawn = false;

    this._hoveredEl = null;
    this._ripples = []; // { x, y, r, alpha, color }

    // Per-hand interaction state (slots 0 and 1)
    this._slots = [0, 1].map((slot) => ({
      slot,
      mode: 'idle', // 'idle' | 'play-grab' | 'paint' | 'ui-press' | 'slider' | 'scroll'
      targetEl: null,
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
      scrollStartTop: 0,
      lastClickMs: 0,
      moved: false,
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
    if (this._hoveredEl) {
      this._hoveredEl.classList.remove('air-hover');
    }
    this._hoveredEl = el;
    if (this._hoveredEl) {
      this._hoveredEl.classList.add('air-hover');
    }
  }

  _spawnRipple(x, y, color = '#ff5a8d') {
    this._ripples.push({ x, y, r: 8, maxR: 34, alpha: 0.72, color });
  }

  /** Identify the interactive element (or canvas / slider / scrollable sheet) at viewport (x, y) */
  _hitTest(x, y) {
    const raw = document.elementFromPoint(x, y);
    if (!raw) return { kind: 'none', el: null };

    // 1. Range slider (either directly or inside its label container)
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

    // 2. Clickable UI controls (buttons, checkboxes, labels, links)
    const clickable = raw.closest && raw.closest('button:not(:disabled), a[href], label, input[type="checkbox"]');
    if (clickable) {
      return { kind: 'click', el: clickable };
    }

    // 3. Stage WebGL canvas (for Play cheek pull or Paint brush strokes)
    if (raw === this.hooks.glCanvas) {
      return { kind: 'canvas', el: raw };
    }

    // 4. Backdrop dismiss (Settings / Preview modal backdrop)
    if (raw.id === 'settingsBackdrop' || raw.id === 'previewModal') {
      return { kind: 'click', el: raw };
    }

    // 5. Scrollable Settings sheet background
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
        // Ensure we're still reasonably close to the element we pressed
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
  }

  resetAll() {
    this._setHovered(null);
    const now = performance.now();
    for (const st of this._slots) {
      if (st.mode !== 'idle') {
        this._endSlot(st, now, st.lastX, st.lastY, false);
      }
    }
    if (this._hasDrawn) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._hasDrawn = false;
    }
  }

  /** Returns true if any hand is currently pinching or interacting with the site */
  isAnyHandBusy() {
    return this._slots[0].mode !== 'idle' || this._slots[1].mode !== 'idle';
  }

  /**
   * Called every rAF with live hand cursors from CameraHandTracker:
   * cursors: [{ id, x, y, pinching, pinchProgress }] where x, y are [0..1] viewport coordinates
   */
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
        }
        continue;
      }

      const cx = hc.x * this.cssW;
      const cy = hc.y * this.cssH;
      st.lastX = cx;
      st.lastY = cy;

      const hit = this._hitTest(cx, cy);

      // Hover state (primary hand slot 0 drives UI hover & Paint brush cursor preview)
      if (s === 0) {
        if (hit.kind === 'click' || hit.kind === 'slider') {
          hoveredCandidate = hit.el;
        }
        if (step === 'paint' && hit.kind === 'canvas' && st.mode === 'idle') {
          this.hooks.onPaintHover(cx, cy);
        }
      }

      // ---- STATE TRANSITIONS ----
      if (hc.pinching) {
        if (st.mode === 'idle') {
          // Rising edge of Pinch = Long-press / Pointer Down!
          st.startX = cx;
          st.startY = cy;
          st.moved = false;

          if (hit.kind === 'canvas' && step === 'play') {
            // Both hands can grab & pull cheeks simultaneously!
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
          // Sustained Pinch = Long-press Drag!
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
        // Falling edge of Pinch = Release!
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

    // 1. Render expanding click / grab ripples
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

    // 2. Render each active Air Cursor + elastic pull tether + pinch-closeness arc
    const twoHands = Boolean(bySlot[0] && bySlot[1]);
    for (let s = 0; s < 2; s++) {
      const hc = bySlot[s];
      if (!hc) continue;
      const st = this._slots[s];
      const x = hc.x * this.cssW;
      const y = hc.y * this.cssH;
      const prog = Math.max(0, Math.min(1, hc.pinchProgress || 0));
      const pinching = hc.pinching;

      // Elastic tether line while long-press pulling a cheek on Play canvas!
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

          // Anchor origin dot
          ctx.beginPath();
          ctx.arc(st.startX, st.startY, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 79, 134, 0.72)';
          ctx.fill();
          ctx.restore();
        }
      }

      // Outer ring contracts smoothly as thumb & index approach pinch
      const outerR = pinching ? 13 : (20 - prog * 6);
      ctx.save();

      // Soft drop shadow glow
      ctx.shadowColor = pinching ? 'rgba(255, 79, 134, 0.45)' : 'rgba(242, 132, 164, 0.30)';
      ctx.shadowBlur = pinching ? 14 : 8;

      // Translucent halo fill
      ctx.beginPath();
      ctx.arc(x, y, outerR, 0, Math.PI * 2);
      ctx.fillStyle = pinching
        ? 'rgba(255, 79, 134, 0.30)'
        : (st.mode === 'idle' && s === 0 && this._hoveredEl
          ? 'rgba(242, 132, 164, 0.24)'
          : 'rgba(255, 255, 255, 0.22)');
      ctx.fill();

      // Crisp base ring
      ctx.lineWidth = pinching ? 2.8 : 1.8;
      ctx.strokeStyle = pinching ? '#ff4f86' : 'rgba(235, 107, 146, 0.72)';
      ctx.stroke();

      // Tactile Pinch-Closeness Progress Arc (fills up to 360° right before pinch locks!)
      if (!pinching && prog > 0.08) {
        ctx.beginPath();
        ctx.arc(x, y, outerR + 3, -Math.PI * 0.5, -Math.PI * 0.5 + prog * Math.PI * 2);
        ctx.strokeStyle = '#ff4f86';
        ctx.lineWidth = 2.6;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      // Center precision dot
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(x, y, pinching ? 5.2 : 3.4, 0, Math.PI * 2);
      ctx.fillStyle = pinching ? '#ff4f86' : '#ffffff';
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = '#ff4f86';
      ctx.stroke();

      // Hand number pill when both hands are on screen
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
