/**
 * BrushEngine v17 — Exact 1:1 Port of Original MaskLayer & MaskTool (+ Undo/Redo)
 *
 * Fixes all aspect-ratio stretching and cursor/paint mismatch issues:
 * - Aspect-matched mask canvas (longest side = 512px, width/height === image aspect)
 *   so stamping radius = brushRadius * S * canvas.height draws a mathematically
 *   exact circle matching the screen cursor ring pixel-for-pixel at EVERY aspect
 *   ratio (portrait, landscape, square) and EVERY zoom level!
 * - Sharp (Hard): lighten (#fff) / darken (#000) crisp solid circle.
 * - Soft: 4-stop radial airbrush gradient at 0.12 opacity per stamp for smooth buildup.
 * - Streamline = 0.35 smoothing with 0.4 * r spacing and exact tail completion on release.
 * - Direct GPU Paint-mode rendering (unblurred canvas uploaded to WebGL2 uMask),
 *   and blurred textureSource (maskBlur = 0.008) for silky Play-mode deformation.
 * - Keeps 30-step Undo/Redo + lossless 2-finger pinch-zoom stroke cancellation!
 */

const MASK_SIZE = 512;
const MASK_BLUR = 0.008;

export class BrushEngine {
  constructor(maskSize = MASK_SIZE) {
    this.maskSize = maskSize;
    this.aspect = 1.0;

    // Exact original opaque RGB mask & blurred mask canvases (black = fixed, white = squishy)
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.ctx = this.canvas.getContext('2d', { alpha: false, willReadFrequently: true });

    this.blurCanvas = document.createElement('canvas');
    this.blurCanvas.width = 1;
    this.blurCanvas.height = 1;
    this.blurCtx = this.blurCanvas.getContext('2d', { alpha: false, willReadFrequently: true });

    this.dirty = false;
    this.blurDirty = true;
    this.painted = false;
    this.data = null;

    // Stroke cancellation snapshot (exact original beginStroke / cancelStroke for 2-finger pinch)
    this.preStrokeSnap = null;
    this.preStrokePainted = false;

    // Full Undo / Redo stack
    this.undoStack = [];
    this.redoStack = [];
    this.maxHistory = 30;

    // Exact original MaskTool properties
    this.brushRadius = 0.07; // range 0.01 .. 0.20 (in iso units relative to S = min(1, aspect))
    this.brushType = 'hard'; // 'hard' | 'soft'
    this.erasing = false;
    this.streamline = 0.35;

    // Active stroke state
    this.isDrawing = false;
    this.last = null;
    this.smooth = null;
    this.lastRaw = null;
    this.pendingS = 1;

    this.onHistoryChange = null;
  }

  /** Match mask canvas aspect ratio to image aspect so circles are 100% circular & 1:1 with cursor! */
  setup(aspect) {
    this.aspect = Math.max(0.05, aspect || 1.0);
    const maxS = this.maskSize;
    const w = this.aspect >= 1 ? maxS : Math.max(1, Math.round(maxS * this.aspect));
    const h = this.aspect >= 1 ? Math.max(1, Math.round(maxS / this.aspect)) : maxS;
    this.canvas.width = w;
    this.canvas.height = h;
    this.blurCanvas.width = w;
    this.blurCanvas.height = h;
    this.resetHistory();
    this.clear(false);
  }

  ensureBlur() {
    if (!this.blurDirty) return;
    const { width: w, height: h } = this.canvas;
    const blurPx = Math.max(2, Math.round(Math.max(w, h) * MASK_BLUR));
    const ctx = this.blurCtx;
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.filter = `blur(${blurPx}px)`;
    ctx.drawImage(this.canvas, 0, 0);
    ctx.filter = 'none';
    this.blurDirty = false;
  }

  /** Blurred mask canvas for Play mode WebGL2 uMask texture */
  textureSource() {
    this.ensureBlur();
    return this.blurCanvas;
  }

  invalidate() {
    this.dirty = true;
    this.blurDirty = true;
    this.data = null;
  }

  _emitHistory() {
    if (this.onHistoryChange) {
      this.onHistoryChange(this.undoStack.length > 0, this.redoStack.length > 0);
    }
  }

  _recheckPainted() {
    const img = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    for (let i = 0; i < img.length; i += 16) {
      if (img[i] > 4) {
        this.painted = true;
        return true;
      }
    }
    this.painted = false;
    return false;
  }

  hasAnyPaint() {
    if (!this.painted) return false;
    return this._recheckPainted();
  }

  resetHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.preStrokeSnap = null;
    this._emitHistory();
  }

  clear(recordUndo = true) {
    if (recordUndo && this.hasAnyPaint()) {
      this.undoStack.push({
        img: this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height),
        painted: this.painted,
      });
      if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
      this.redoStack.length = 0;
      this._emitHistory();
    }
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.painted = false;
    this.preStrokeSnap = null;
    this.isDrawing = false;
    this.last = null;
    this.smooth = null;
    this.lastRaw = null;
    this.invalidate();
  }

  /** Fill whole character (or entire opaque image) white cleanly on the aspect-matched canvas */
  fillAll(artworkSource = null, recordUndo = true) {
    if (recordUndo) {
      this.undoStack.push({
        img: this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height),
        painted: this.painted,
      });
      if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
      this.redoStack.length = 0;
      this._emitHistory();
    }

    const { width: w, height: h } = this.canvas;
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    if (artworkSource) {
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      const tctx = tmp.getContext('2d', { willReadFrequently: true });
      tctx.drawImage(artworkSource, 0, 0, w, h);
      const src = tctx.getImageData(0, 0, w, h).data;
      let transparentCount = 0;
      for (let i = 3; i < src.length; i += 16) {
        if (src[i] < 200) transparentCount++;
      }
      if (transparentCount > (w * h / 4) * 0.06) {
        const out = ctx.createImageData(w, h);
        const od = out.data;
        for (let i = 0; i < src.length; i += 4) {
          const v = src[i + 3] > 20 ? 255 : 0;
          od[i] = v;
          od[i + 1] = v;
          od[i + 2] = v;
          od[i + 3] = 255;
        }
        ctx.putImageData(out, 0, 0);
        this.painted = true;
        this.invalidate();
        return;
      }
    }

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    this.painted = true;
    this.invalidate();
  }

  undo() {
    if (this.undoStack.length === 0) return false;
    this.redoStack.push({
      img: this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height),
      painted: this.painted,
    });
    const prev = this.undoStack.pop();
    this.ctx.putImageData(prev.img, 0, 0);
    this.painted = prev.painted;
    this.invalidate();
    this._emitHistory();
    return true;
  }

  redo() {
    if (this.redoStack.length === 0) return false;
    this.undoStack.push({
      img: this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height),
      painted: this.painted,
    });
    const next = this.redoStack.pop();
    this.ctx.putImageData(next.img, 0, 0);
    this.painted = next.painted;
    this.invalidate();
    this._emitHistory();
    return true;
  }

  /** Exact original single circular stamp in UV [0..1] + rIso = brushRadius * S */
  stamp(u, v, rIso, erasing, isSoft = false) {
    const { width: w, height: h } = this.canvas;
    const cx = u * w;
    const cy = v * h;
    const rPx = Math.max(1, rIso * h);
    const ctx = this.ctx;

    if (isSoft) {
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rPx);
      const rgb = erasing ? '0,0,0' : '255,255,255';
      const maxAlpha = 0.12;
      const stops = [
        [0, 1],
        [0.4, 0.65],
        [0.7, 0.3],
        [1, 0],
      ];
      for (let i = 0; i < stops.length; i++) {
        grad.addColorStop(stops[i][0], `rgba(${rgb},${(maxAlpha * stops[i][1]).toFixed(4)})`);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = grad;
      ctx.fillRect(cx - rPx, cy - rPx, rPx * 2, rPx * 2);
    } else {
      ctx.globalCompositeOperation = erasing ? 'darken' : 'lighten';
      ctx.fillStyle = erasing ? '#000' : '#fff';
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = 'source-over';
    if (!erasing) this.painted = true;
    this.invalidate();
  }

  beginStroke() {
    this.preStrokeSnap = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.preStrokePainted = this.painted;
    this.isDrawing = true;
    this.last = null;
    this.smooth = null;
    this.lastRaw = null;
  }

  /** Exact original streamline + equidistant stamping along segment */
  strokeTo(u, v, S) {
    if (!this.isDrawing) return;
    this.lastRaw = { x: u, y: v };
    this.pendingS = S;

    if (!this.smooth) {
      this.smooth = { x: u, y: v };
      this.stamp(u, v, this.brushRadius * S, this.erasing, this.brushType === 'soft');
      this.last = { x: u, y: v };
      return;
    }

    this.smooth.x += (u - this.smooth.x) * this.streamline;
    this.smooth.y += (v - this.smooth.y) * this.streamline;
    this._stampSegment(this.smooth.x, this.smooth.y, S);
  }

  _stampSegment(u, v, S) {
    const rIso = this.brushRadius * S;
    const isSoft = this.brushType === 'soft';
    if (!this.last) {
      this.stamp(u, v, rIso, this.erasing, isSoft);
    } else {
      const du = u - this.last.x;
      const dv = v - this.last.y;
      // Isotropic travel distance ensures uniform spacing horizontally & vertically at all aspect ratios
      const distIso = Math.hypot(du * this.aspect, dv);
      const step = Math.max(rIso * 0.4, 1e-4);
      const steps = Math.min(200, Math.ceil(distIso / step));
      for (let i = 1; i <= steps; i++) {
        this.stamp(
          this.last.x + (du * i) / steps,
          this.last.y + (dv * i) / steps,
          rIso,
          this.erasing,
          isSoft
        );
      }
    }
    this.last = { x: u, y: v };
  }

  endStroke() {
    if (!this.isDrawing) return;
    if (this.lastRaw && this.last) {
      this._stampSegment(this.lastRaw.x, this.lastRaw.y, this.pendingS);
    }
    if (this.preStrokeSnap) {
      this.undoStack.push({ img: this.preStrokeSnap, painted: this.preStrokePainted });
      if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
      this.redoStack.length = 0;
      this.preStrokeSnap = null;
      this._emitHistory();
    }
    if (this.erasing) this._recheckPainted();
    this.isDrawing = false;
    this.last = null;
    this.smooth = null;
    this.lastRaw = null;
  }

  /** Exact original lossless cancelStroke when a 2nd finger starts 2-finger zoom/pan! */
  cancelStroke() {
    if (this.preStrokeSnap) {
      this.ctx.putImageData(this.preStrokeSnap, 0, 0);
      this.painted = this.preStrokePainted;
      this.preStrokeSnap = null;
      this.invalidate();
    }
    this.isDrawing = false;
    this.last = null;
    this.smooth = null;
    this.lastRaw = null;
  }

  /** Fast blurred mask sampler for Play mode physics (u, v in [0, 1]) -> [0..1] */
  sampleBlurred = (u, v) => {
    if (!this.data) {
      this.ensureBlur();
      this.data = this.blurCtx.getImageData(0, 0, this.blurCanvas.width, this.blurCanvas.height);
    }
    const { data, width: w, height: h } = this.data;
    const ix = Math.min(w - 1, Math.max(0, Math.round(u * (w - 1))));
    const iy = Math.min(h - 1, Math.max(0, Math.round(v * (h - 1))));
    return data[(iy * w + ix) * 4] / 255;
  };
}
