/**
 * BrushEngine v11 — Zero-Lag, User-Friendly Spotlight-Reveal Brush Engine
 *
 * Key UX upgrades matching authentic mochi-maker painting feel:
 * 1. Spotlight-Reveal Visualization:
 *    - Unpainted artwork is softly frosted/veiled so it stays easy to see.
 *    - Painting lifts the veil to reveal 100% crisp, bright artwork underneath,
 *      with a subtle rosy tint on painted transparent areas and a clean edge contrast!
 *    - Never buries facial details under heavy opaque pink paint.
 * 2. True 1:1 Zero-Lag Tracking:
 *    - Direct pointer tracking with quadratic midpoint smoothing (zero sluggish drag!).
 *    - Sharp mode (default) uses native vector round strokes (razor-clean & instant).
 *    - Soft mode uses smooth equidistant radial feathering with uniform stroke layer.
 * 3. Screen-Relative Precision Sizing:
 *    - Brush radius adapts naturally to camera zoom, so zooming in automatically gives
 *      finer detail control while keeping a comfortable fingertip size on screen!
 * 4. Instant Stroke Start + Lossless 2-Finger Pinch-Zoom Cancel + Full Undo/Redo.
 */

export class BrushEngine {
  constructor(maskSize = 512) {
    this.maskSize = maskSize;

    // Committed squishy mask (alpha channel = squishy weight 0..255)
    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = maskSize;
    this.maskCanvas.height = maskSize;
    this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true });

    // Temporary uniform-opacity active stroke canvas
    this.strokeCanvas = document.createElement('canvas');
    this.strokeCanvas.width = maskSize;
    this.strokeCanvas.height = maskSize;
    this.strokeCtx = this.strokeCanvas.getContext('2d');

    // Artwork alpha silhouette (used to clip frosted veil cleanly to artwork pixels)
    this.artAlphaCanvas = document.createElement('canvas');
    this.artAlphaCanvas.width = maskSize;
    this.artAlphaCanvas.height = maskSize;
    this.artAlphaCtx = this.artAlphaCanvas.getContext('2d');

    // Offscreen compositing buffers for fast zero-GC Spotlight-Reveal preview
    this.combinedCanvas = document.createElement('canvas');
    this.combinedCanvas.width = maskSize;
    this.combinedCanvas.height = maskSize;
    this.combinedCtx = this.combinedCanvas.getContext('2d');

    this.veilCanvas = document.createElement('canvas');
    this.veilCanvas.width = maskSize;
    this.veilCanvas.height = maskSize;
    this.veilCtx = this.veilCanvas.getContext('2d');

    this.outsideTintCanvas = document.createElement('canvas');
    this.outsideTintCanvas.width = maskSize;
    this.outsideTintCanvas.height = maskSize;
    this.outsideTintCtx = this.outsideTintCanvas.getContext('2d');

    this.previewCanvas = document.createElement('canvas');
    this.previewCanvas.width = maskSize;
    this.previewCanvas.height = maskSize;
    this.previewCtx = this.previewCanvas.getContext('2d');

    this.preStrokeImage = null;
    this.undoStack = [];
    this.redoStack = [];
    this.maxHistory = 30;

    // Tool defaults: Brush + Sharp edge + fingertip-friendly 30px screen radius
    this.tool = 'brush';      // 'brush' | 'eraser'
    this.edge = 'sharp';      // 'sharp' | 'soft'
    this.screenRadius = 30;   // CSS pixels on screen (range 10..76)
    this.activeMaskRadius = 32;

    // Active stroke state (1:1 exact pointer tracking!)
    this.isDrawing = false;
    this.strokeStartTime = 0;
    this.strokeTravelPx = 0;
    this.lastRawX = 0;
    this.lastRawY = 0;
    this.lastMidX = 0;
    this.lastMidY = 0;
    this.lastStampX = 0;
    this.lastStampY = 0;

    // Live cursor & size-slider preview ring (CSS coordinates)
    this.cursor = { visible: false, x: 0, y: 0, screenRadius: 30, isSizePreview: false };

    // Blurred opaque grayscale mask for GPU R8 texture & CPU grab sampling (exact 0.008*size blur)
    this.blurMaskCanvas = document.createElement('canvas');
    this.blurMaskCanvas.width = maskSize;
    this.blurMaskCanvas.height = maskSize;
    this.blurMaskCtx = this.blurMaskCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    this._blurDirty = true;
    this._blurData = null;

    this._lastTheme = 'light';
    this._previewDirty = true;

    this.onHistoryChange = null;
    this.onMaskCommit = null;
  }

  /** Capture artwork alpha so unpainted frosting hugs transparent PNGs cleanly */
  setArtworkSource(imgOrCanvas) {
    const ctx = this.artAlphaCtx;
    const S = this.maskSize;
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(imgOrCanvas, 0, 0, S, S);
    // Keep only alpha mask (solid white everywhere artwork has alpha)
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = 'source-over';
    this._previewDirty = true;
  }

  markPreviewDirty() {
    this._previewDirty = true;
  }

  _pushUndoSnapshot() {
    const snap = this.maskCtx.getImageData(0, 0, this.maskSize, this.maskSize);
    this.undoStack.push(snap);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack.length = 0;
    this._emitHistory();
  }

  _emitHistory() {
    if (this.onHistoryChange) {
      this.onHistoryChange(this.undoStack.length > 0, this.redoStack.length > 0);
    }
  }

  undo() {
    if (this.undoStack.length === 0) return false;
    this.redoStack.push(this.maskCtx.getImageData(0, 0, this.maskSize, this.maskSize));
    this.maskCtx.putImageData(this.undoStack.pop(), 0, 0);
    this._previewDirty = true;
    this._emitHistory();
    this._blurDirty = true; this._blurData = null; if (this.onMaskCommit) this.onMaskCommit(this.getBlurredMaskCanvas());
    return true;
  }

  redo() {
    if (this.redoStack.length === 0) return false;
    this.undoStack.push(this.maskCtx.getImageData(0, 0, this.maskSize, this.maskSize));
    this.maskCtx.putImageData(this.redoStack.pop(), 0, 0);
    this._previewDirty = true;
    this._emitHistory();
    this._blurDirty = true; this._blurData = null; if (this.onMaskCommit) this.onMaskCommit(this.getBlurredMaskCanvas());
    return true;
  }

  clear(recordUndo = true) {
    if (recordUndo) this._pushUndoSnapshot();
    this.maskCtx.clearRect(0, 0, this.maskSize, this.maskSize);
    this.strokeCtx.clearRect(0, 0, this.maskSize, this.maskSize);
    this._previewDirty = true;
    this._blurDirty = true; this._blurData = null; if (this.onMaskCommit) this.onMaskCommit(this.getBlurredMaskCanvas());
  }

  hasAnyPaint() {
    const d = this.maskCtx.getImageData(0, 0, this.maskSize, this.maskSize).data;
    for (let i = 3; i < d.length; i += 32) {
      if (d[i] > 12) return true;
    }
    return false;
  }

  setMaskFromCanvas(srcCanvas, recordUndo = false) {
    if (recordUndo) this._pushUndoSnapshot();
    this.maskCtx.clearRect(0, 0, this.maskSize, this.maskSize);
    this.maskCtx.drawImage(srcCanvas, 0, 0, this.maskSize, this.maskSize);
    this._previewDirty = true;
    this._blurDirty = true; this._blurData = null; if (this.onMaskCommit) this.onMaskCommit(this.getBlurredMaskCanvas());
  }

  resetHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._emitHistory();
  }

  /** Build blurred grayscale mask canvas (black = fixed, white = squishy) matching original maskBlur=0.008 */
  getBlurredMaskCanvas() {
    if (!this._blurDirty) return this.blurMaskCanvas;
    const S = this.maskSize;
    const blurPx = Math.max(2, Math.round(S * 0.008));
    const ctx = this.blurMaskCtx;
    ctx.filter = 'none';
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, S, S);
    ctx.filter = `blur(${blurPx}px)`;
    ctx.drawImage(this.maskCanvas, 0, 0);
    ctx.filter = 'none';
    this._blurDirty = false;
    this._blurData = null;
    return this.blurMaskCanvas;
  }

  sampleBlurred = (u, v) => {
    if (this._blurDirty || !this._blurData) {
      this.getBlurredMaskCanvas();
      this._blurData = this.blurMaskCtx.getImageData(0, 0, this.maskSize, this.maskSize);
    }
    const { data, width, height } = this._blurData;
    const ix = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
    const iy = Math.min(height - 1, Math.max(0, Math.round(v * (height - 1))));
    return data[(iy * width + ix) * 4] / 255;
  };

  uvToMask(u, v) {
    return { x: u * this.maskSize, y: v * this.maskSize };
  }

  worldToMask(wx, wy, hw, hh) {
    const u = (wx / (2 * hw)) + 0.5;
    const v = (wy / (2 * hh)) + 0.5;
    return { x: u * this.maskSize, y: v * this.maskSize };
  }

  /**
   * Begin a stroke immediately (zero lag!) using screen-relative maskRadius.
   * Pre-stroke state is preserved so a quick 2nd finger for Pinch-Zoom cancels losslessly.
   */
  beginStroke(mx, my, maskRadius) {
    this.activeMaskRadius = Math.max(3, Math.min(180, maskRadius));
    this.preStrokeImage = this.maskCtx.getImageData(0, 0, this.maskSize, this.maskSize);
    this.strokeCtx.clearRect(0, 0, this.maskSize, this.maskSize);

    this.isDrawing = true;
    this.strokeStartTime = performance.now();
    this.strokeTravelPx = 0;
    this.lastRawX = mx;
    this.lastRawY = my;
    this.lastMidX = mx;
    this.lastMidY = my;
    this.lastStampX = mx;
    this.lastStampY = my;

    this._stampPoint(mx, my);
    this._previewDirty = true;
  }

  moveStroke(mx, my) {
    if (!this.isDrawing) return;

    const dx = mx - this.lastRawX;
    const dy = my - this.lastRawY;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.35) return;

    this.strokeTravelPx += dist;
    const midX = (this.lastRawX + mx) * 0.5;
    const midY = (this.lastRawY + my) * 0.5;

    if (this.edge === 'sharp') {
      // Crisp, zero-lag native vector quadratic stroke with round caps!
      const ctx = this.strokeCtx;
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = this.activeMaskRadius * 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(this.lastMidX, this.lastMidY);
      ctx.quadraticCurveTo(this.lastRawX, this.lastRawY, midX, midY);
      ctx.stroke();
      ctx.restore();
    } else {
      // Silky soft-feathered equidistant radial stamps along exact quadratic curve
      const step = Math.max(1.5, this.activeMaskRadius * 0.14);
      const chord = Math.hypot(midX - this.lastMidX, midY - this.lastMidY);
      const segs = Math.max(1, Math.ceil(chord / step));
      for (let s = 1; s <= segs; s++) {
        const t = s / segs;
        const omt = 1 - t;
        const qx = omt * omt * this.lastMidX + 2 * omt * t * this.lastRawX + t * t * midX;
        const qy = omt * omt * this.lastMidY + 2 * omt * t * this.lastRawY + t * t * midY;
        if (Math.hypot(qx - this.lastStampX, qy - this.lastStampY) >= step * 0.72) {
          this._stampSoft(qx, qy);
          this.lastStampX = qx;
          this.lastStampY = qy;
        }
      }
    }

    this.lastRawX = mx;
    this.lastRawY = my;
    this.lastMidX = midX;
    this.lastMidY = midY;
    this._previewDirty = true;
  }

  endStroke() {
    if (!this.isDrawing) return;

    // Finish final half-segment right up to exact release coordinate (zero tail cut-off!)
    if (this.edge === 'sharp') {
      const ctx = this.strokeCtx;
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = this.activeMaskRadius * 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(this.lastMidX, this.lastMidY);
      ctx.lineTo(this.lastRawX, this.lastRawY);
      ctx.stroke();
      ctx.restore();
    } else if (Math.hypot(this.lastRawX - this.lastStampX, this.lastRawY - this.lastStampY) > 1.0) {
      this._stampSoft(this.lastRawX, this.lastRawY);
    }

    this.isDrawing = false;

    if (this.preStrokeImage) {
      this.undoStack.push(this.preStrokeImage);
      if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
      this.redoStack.length = 0;
      this.preStrokeImage = null;
      this._emitHistory();
    }

    this.maskCtx.save();
    this.maskCtx.globalCompositeOperation = this.tool === 'eraser' ? 'destination-out' : 'source-over';
    this.maskCtx.drawImage(this.strokeCanvas, 0, 0);
    this.maskCtx.restore();
    this.strokeCtx.clearRect(0, 0, this.maskSize, this.maskSize);
    this._previewDirty = true;

    this._blurDirty = true; this._blurData = null; if (this.onMaskCommit) this.onMaskCommit(this.getBlurredMaskCanvas());
  }

  /** Cancel an active stroke losslessly (used when a 2nd finger initiates Pinch-Zoom!) */
  cancelStroke() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    this.strokeCtx.clearRect(0, 0, this.maskSize, this.maskSize);
    this.preStrokeImage = null;
    this._previewDirty = true;
  }

  /** Returns true if current stroke just started and looks like the first finger of a 2-finger pinch */
  shouldCancelForPinch() {
    if (!this.isDrawing) return false;
    const elapsed = performance.now() - this.strokeStartTime;
    return elapsed < 170 && this.strokeTravelPx < 22;
  }

  _stampPoint(x, y) {
    if (this.edge === 'sharp') {
      const ctx = this.strokeCtx;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, this.activeMaskRadius, 0, Math.PI * 2);
      ctx.fill();
    } else {
      this._stampSoft(x, y);
    }
  }

  _stampSoft(x, y) {
    const ctx = this.strokeCtx;
    const r = this.activeMaskRadius;
    const grad = ctx.createRadialGradient(x, y, r * 0.20, x, y, r);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.65, 'rgba(255, 255, 255, 0.72)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Build the Spotlight-Reveal preview canvas:
   * - Unpainted artwork pixels: gently frosted with a warm pastel wash (light) or soft dim veil (dark)
   * - Painted artwork pixels: 100% vivid, crystal-clear original artwork shines through!
   * - Painted transparent background pixels: soft rose-pink cloud so you always see overpainting.
   */
  getPreviewCanvas(theme = 'light') {
    if (!this._previewDirty && this._lastTheme === theme) {
      return this.previewCanvas;
    }
    this._lastTheme = theme;

    const S = this.maskSize;

    // 1. Combined current squishy mask (committed mask + live stroke)
    const cctx = this.combinedCtx;
    cctx.clearRect(0, 0, S, S);
    cctx.globalCompositeOperation = 'source-over';
    cctx.drawImage(this.maskCanvas, 0, 0);
    if (this.isDrawing) {
      cctx.globalCompositeOperation = this.tool === 'eraser' ? 'destination-out' : 'source-over';
      cctx.drawImage(this.strokeCanvas, 0, 0);
    }
    cctx.globalCompositeOperation = 'source-over';

    // 2. Frosted Veil over UNPAINTED artwork pixels (lifted wherever painted!)
    const vctx = this.veilCtx;
    vctx.clearRect(0, 0, S, S);
    vctx.globalCompositeOperation = 'source-over';
    vctx.drawImage(this.artAlphaCanvas, 0, 0);
    vctx.globalCompositeOperation = 'source-in';
    vctx.fillStyle = theme === 'dark'
      ? 'rgba(23, 21, 31, 0.62)'
      : 'rgba(255, 245, 248, 0.64)';
    vctx.fillRect(0, 0, S, S);
    // Punch out painted squishy areas so original bright artwork shines through!
    vctx.globalCompositeOperation = 'destination-out';
    vctx.drawImage(this.combinedCanvas, 0, 0);
    vctx.globalCompositeOperation = 'source-over';

    // 3. Soft Rose-Pink Tint ONLY on painted pixels OUTSIDE the artwork silhouette
    const octx = this.outsideTintCtx;
    octx.clearRect(0, 0, S, S);
    octx.globalCompositeOperation = 'source-over';
    octx.drawImage(this.combinedCanvas, 0, 0);
    octx.globalCompositeOperation = 'destination-out';
    octx.drawImage(this.artAlphaCanvas, 0, 0);
    octx.globalCompositeOperation = 'source-in';
    octx.fillStyle = theme === 'dark'
      ? 'rgba(244, 123, 162, 0.34)'
      : 'rgba(242, 132, 164, 0.28)';
    octx.fillRect(0, 0, S, S);
    octx.globalCompositeOperation = 'source-over';

    // 4. Composite final overlay cleanly into previewCanvas
    const pctx = this.previewCtx;
    pctx.clearRect(0, 0, S, S);
    pctx.drawImage(this.veilCanvas, 0, 0);
    pctx.drawImage(this.outsideTintCanvas, 0, 0);

    this._previewDirty = false;
    return this.previewCanvas;
  }
}
