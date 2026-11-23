/**
 * CameraHandTracker v22 — Ultra-Smooth, Granular Dual-Engine Hand Tracking + Air Cursor
 *
 * Engine 1 (AI Hands — Default, lazy-loaded):
 *   - MediaPipe 21-Landmark HandLandmarker (GPU w/ CPU fallback, up to 2 hands)
 *   - Ergonomic active-zone mapping + anti-drift pinch stabilization + 1-Euro filter
 *   - Air Cursor (Pinch & Hold to pull cheeks / paint / scrub sliders; Quick Pinch to click)
 *   - Continuous 360° open-hand wave bounce
 *
 * Engine 2 (Fast Flow — 0ms instant startup & 100% offline):
 *   - 3-Level Illumination-Invariant Sub-Pixel Pyramid Lucas-Kanade (24x18 -> 48x36 -> 96x72)
 *   - Precomputed spatial gradients (Ix, Iy), global auto-exposure shift cancellation,
 *     Shi-Tomasi min-eigenvalue gating, and Huber-reweighted median consensus
 *   - Tracks micro-bobs (0.03 px/frame) up to blistering fast flicks (±22 px/frame)!
 *   - Persistent Hybrid Hand Tracker (Optical Flow prediction + Adaptive Background/Skin/Motion
 *     Salience + 2-Step Local Gaussian Mean-Shift + 1-Euro filter) powering full site-wide
 *     Air Cursor (Hold-to-Grab & Click) even with zero AI downloads!
 */

const MEDIAPIPE_ESM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const MEDIAPIPE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MEDIAPIPE_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

// 3-Level Sub-Pixel Pyramid dimensions (Fine -> Coarse -> Tiny)
const FW = 96;
const FH = 72;
const CW = 48;
const CH = 36;
const TW = 24;
const TH = 18;

// ============================================================================
// Adaptive 1-Euro Low-Pass Filter (Zero jitter when still, zero lag when fast!)
// ============================================================================
class OneEuroFilter {
  constructor(minCutoff = 1.6, beta = 0.08, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = 0;
    this.dxPrev = 0;
    this.initialized = false;
  }

  reset() {
    this.initialized = false;
    this.xPrev = 0;
    this.dxPrev = 0;
  }

  _alpha(cutoff, dt) {
    const tau = 1.0 / (2.0 * Math.PI * Math.max(0.05, cutoff));
    return 1.0 / (1.0 + tau / Math.max(1e-4, dt));
  }

  filter(x, dt) {
    if (!this.initialized) {
      this.xPrev = x;
      this.dxPrev = 0;
      this.initialized = true;
      return x;
    }
    const safeDt = Math.max(0.004, Math.min(0.12, dt));
    const dx = (x - this.xPrev) / safeDt;
    const aD = this._alpha(this.dCutoff, safeDt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const aX = this._alpha(cutoff, safeDt);
    const xHat = aX * x + (1 - aX) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    return xHat;
  }
}

class OneEuro2D {
  constructor(minCutoff = 1.6, beta = 0.08, dCutoff = 1.0) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff);
  }
  setParams(minCutoff, beta) {
    this.fx.minCutoff = minCutoff;
    this.fy.minCutoff = minCutoff;
    this.fx.beta = beta;
    this.fy.beta = beta;
  }
  reset() {
    this.fx.reset();
    this.fy.reset();
  }
  filter(x, y, dt) {
    return { x: this.fx.filter(x, dt), y: this.fy.filter(y, dt) };
  }
}

function directionLabel(vx, vy) {
  const ang = Math.atan2(vy, vx) * (180 / Math.PI);
  if (ang >= -22.5 && ang < 22.5) return '→ Right';
  if (ang >= 22.5 && ang < 67.5) return '↘ Down-Right';
  if (ang >= 67.5 && ang < 112.5) return '↓ Down';
  if (ang >= 112.5 && ang < 157.5) return '↙ Down-Left';
  if (ang >= 157.5 || ang < -157.5) return '← Left';
  if (ang >= -157.5 && ang < -112.5) return '↖ Up-Left';
  if (ang >= -112.5 && ang < -67.5) return '↑ Up';
  return '↗ Up-Right';
}

// ============================================================================
// 3-Level Sub-Pixel Pyramid Lucas-Kanade Helpers (Zero-Allocation Hot Path!)
// ============================================================================
function smoothBox(src, tmp, dst, w, h) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    tmp[row] = src[row];
    for (let x = 1; x < w - 1; x++) {
      tmp[row + x] = (src[row + x - 1] + 2 * src[row + x] + src[row + x + 1]) * 0.25;
    }
    tmp[row + w - 1] = src[row + w - 1];
  }
  for (let x = 0; x < w; x++) {
    dst[x] = tmp[x];
    dst[(h - 1) * w + x] = tmp[(h - 1) * w + x];
  }
  for (let y = 1; y < h - 1; y++) {
    const r0 = (y - 1) * w;
    const r1 = y * w;
    const r2 = (y + 1) * w;
    for (let x = 0; x < w; x++) {
      dst[r1 + x] = (tmp[r0 + x] + 2 * tmp[r1 + x] + tmp[r2 + x]) * 0.25;
    }
  }
}

function downsample2x(src, dst, sw, sh) {
  const dw = sw >> 1;
  const dh = sh >> 1;
  for (let y = 0; y < dh; y++) {
    const r0 = (y << 1) * sw;
    const r1 = r0 + sw;
    const dr = y * dw;
    for (let x = 0; x < dw; x++) {
      const sx = x << 1;
      dst[dr + x] = (src[r0 + sx] + src[r0 + sx + 1] + src[r1 + sx] + src[r1 + sx + 1]) * 0.25;
    }
  }
}

function computeGradients(img, ixOut, iyOut, w, h) {
  // Border zeros
  for (let x = 0; x < w; x++) {
    ixOut[x] = 0; iyOut[x] = 0;
    const lastRow = (h - 1) * w + x;
    ixOut[lastRow] = 0; iyOut[lastRow] = 0;
  }
  for (let y = 1; y < h - 1; y++) {
    const r0 = (y - 1) * w;
    const r1 = y * w;
    const r2 = (y + 1) * w;
    ixOut[r1] = 0; iyOut[r1] = 0;
    ixOut[r1 + w - 1] = 0; iyOut[r1 + w - 1] = 0;
    for (let x = 1; x < w - 1; x++) {
      ixOut[r1 + x] = 0.5 * (img[r1 + x + 1] - img[r1 + x - 1]);
      iyOut[r1 + x] = 0.5 * (img[r2 + x] - img[r0 + x]);
    }
  }
}

function sampleBilinear(img, w, h, x, y) {
  const cx = x < 0 ? 0 : (x > w - 1.001 ? w - 1.001 : x);
  const cy = y < 0 ? 0 : (y > h - 1.001 ? h - 1.001 : y);
  const x0 = cx | 0;
  const y0 = cy | 0;
  const fx = cx - x0;
  const fy = cy - y0;
  const idx = y0 * w + x0;
  const v00 = img[idx];
  const v10 = img[idx + 1];
  const v01 = img[idx + w];
  const v11 = img[idx + w + 1];
  return (v00 + (v10 - v00) * fx) * (1 - fy) + (v01 + (v11 - v01) * fx) * fy;
}

function medianOf(arr) {
  const copy = arr.slice().sort((a, b) => a - b);
  const mid = copy.length >> 1;
  return copy.length & 1 ? copy[mid] : 0.5 * (copy[mid - 1] + copy[mid]);
}

export class CameraHandTracker {
  constructor() {
    this.enabled = false;
    this.paused = false;
    this.facingMode = 'user'; // 'user' | 'environment'
    this.mirror = true;
    this.showPreview = true;
    this.bounceEnabled = true;
    this.airCursorEnabled = true;
    this.allowWaveBounce = true;
    this.followEnabled = false;
    this.sensitivity = 68;    // 20 .. 100
    this.smoothness = 55;     // 0 .. 100 (tunes 1-Euro filter live!)

    // External grab lock notification (e.g. Fast Flow dwell-grab active in AirCursorController)
    this._externalGrabActive = false;
    this._externalReleaseGraceUntil = 0;

    // Engine selection: 'ai' (MediaPipe 21-landmark w/ instant Fast Flow fallback) | 'flow' (Fast Flow only)
    this.preferredEngine = 'ai';
    this.activeEngine = 'flow';
    this.aiStatus = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'
    this._handLandmarker = null;
    this._aiLoadPromise = null;

    // Camera media
    this.stream = null;
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', '');
    this.video.autoplay = true;

    // Native camera frame synchronization
    this._vfcId = 0;
    this._hasNewVideoFrame = false;
    this._lastVideoTime = -1;
    this._lastProcessMs = 0;

    // Pre-allocated 3-Level Pyramid Lucas-Kanade & Hand Segmentation Buffers (zero GC!)
    this.procCanvas = document.createElement('canvas');
    this.procCanvas.width = FW;
    this.procCanvas.height = FH;
    this.procCtx = this.procCanvas.getContext('2d', { willReadFrequently: true });

    // Fine 96x72
    this._rawFine = new Float32Array(FW * FH);
    this._tmpFine = new Float32Array(FW * FH);
    this._prevFine = new Float32Array(FW * FH);
    this._currFine = new Float32Array(FW * FH);
    this._ixFine = new Float32Array(FW * FH);
    this._iyFine = new Float32Array(FW * FH);
    this._skinFine = new Uint8Array(FW * FH);
    this._bgFine = new Float32Array(FW * FH);
    this._heatFine = new Float32Array(FW * FH);
    this._salFine = new Float32Array(FW * FH);

    // Coarse 48x36
    this._rawCoarse = new Float32Array(CW * CH);
    this._tmpCoarse = new Float32Array(CW * CH);
    this._prevCoarse = new Float32Array(CW * CH);
    this._currCoarse = new Float32Array(CW * CH);
    this._ixCoarse = new Float32Array(CW * CH);
    this._iyCoarse = new Float32Array(CW * CH);

    // Tiny 24x18
    this._rawTiny = new Float32Array(TW * TH);
    this._tmpTiny = new Float32Array(TW * TH);
    this._prevTiny = new Float32Array(TW * TH);
    this._currTiny = new Float32Array(TW * TH);
    this._ixTiny = new Float32Array(TW * TH);
    this._iyTiny = new Float32Array(TW * TH);

    this._hasPrevFlow = false;
    this._hasBg = false;

    // Adaptive 1-Euro filters for Fast Flow
    this._flowVelFilter = new OneEuro2D(2.4, 0.16, 1.2);
    this._flowCursorFilter = new OneEuro2D(2.2, 0.14, 1.2);
    this._centroidFilter = new OneEuro2D(1.8, 0.08, 1.0);

    // Persistent Fast Flow Hand Tracker state
    this._flowHand = {
      present: false,
      rawX: 0.5,       // [0..1] in camera space
      rawY: 0.5,
      cursorX: 0.5,    // [0..1] in viewport space (after active-zone + 1-Euro)
      cursorY: 0.5,
      lastSeenMs: 0,
      lastActiveMs: 0,
      confidence: 0,
    };

    // Per-hand tracked states (up to 2 hands in AI mode)
    this._hands = [0, 1].map((slot) => ({
      slot,
      present: false,
      palmFilter: new OneEuro2D(2.0, 0.12, 1.2),
      pinchFilter: new OneEuro2D(2.4, 0.16, 1.2),
      velFilter: new OneEuro2D(2.6, 0.14, 1.2),
      prevPalmX: 0,
      prevPalmY: 0,
      hasPrevPalm: false,
      palmX: 0.5,
      palmY: 0.5,
      pinchX: 0.5,
      pinchY: 0.5,
      pinching: false,
      pinchProgress: 0,
      releaseGraceUntil: 0,
      vx: 0,
      vy: 0,
      landmarks: null,
    }));

    // Visualization & output state
    this.smoothVx = 0;
    this.smoothVy = 0;
    this.activeBlocks = []; // [{ x, y, u, v }] for PiP flow needle rendering
    this.handCursors = [];  // [{ id, x, y, mode, pinching, pinchProgress }]

    // Continuous forces consumed at full display/physics FPS
    this._leadGx = 0;
    this._leadGy = 0;
    this._followGx = 0;
    this._followGy = 0;
    this._impX = 0;
    this._impY = 0;

    this._lastAudioTime = 0;
    this.lastGestureText = 'Wave hand';
    this.lastGestureTime = 0;

    // Callbacks
    this.onGestureBounce = null; // (intensity, label) => void
    this.onEngineChange = null;  // (engine, statusMsg) => void
    this.onPinchEnd = null;      // (handId) => void

    this._applySmoothness();
  }

  /** Called from main loop so Fast Flow knows when a Dwell-Grab is holding a cheek/slider */
  setExternalGrabActive(active, now = performance.now()) {
    if (this._externalGrabActive && !active) {
      this._externalReleaseGraceUntil = now + 280;
    }
    this._externalGrabActive = Boolean(active);
  }

  setSmoothness(val) {
    this.smoothness = Math.max(0, Math.min(100, Number(val) || 55));
    this._applySmoothness();
  }

  _applySmoothness() {
    const s = this.smoothness / 100;
    const minCut = 4.2 - s * 3.1; // 4.2 Hz -> 1.1 Hz
    const beta = 0.24 - s * 0.17; // 0.24 -> 0.07
    this._flowVelFilter.setParams(minCut * 1.15, beta);
    this._flowCursorFilter.setParams(minCut * 1.1, beta * 1.25);
    this._centroidFilter.setParams(minCut, beta * 0.8);
    for (const h of this._hands) {
      h.palmFilter.setParams(minCut, beta);
      h.pinchFilter.setParams(minCut * 1.25, beta * 1.3);
      h.velFilter.setParams(minCut * 1.2, beta);
    }
  }

  _resetFlowTracker() {
    this._hasPrevFlow = false;
    this._hasBg = false;
    this._heatFine.fill(0);
    this._flowVelFilter.reset();
    this._flowCursorFilter.reset();
    this._centroidFilter.reset();
    this._flowHand.present = false;
    this._flowHand.confidence = 0;
    this._flowHand.rawX = 0.5;
    this._flowHand.rawY = 0.5;
    this._flowHand.cursorX = 0.5;
    this._flowHand.cursorY = 0.5;
    this.activeBlocks.length = 0;
    this.handCursors.length = 0;
  }

  setPreferredEngine(mode) {
    this.preferredEngine = mode === 'flow' ? 'flow' : 'ai';
    if (!this.enabled) return;
    if (this.preferredEngine === 'flow') {
      this._releaseAllPinches();
      this.activeEngine = 'flow';
      this._resetFlowTracker();
      if (this.onEngineChange) {
        this.onEngineChange(
          'flow',
          this.airCursorEnabled
            ? 'Fast Flow active! Move hand to aim, hold still briefly to grab/click, or wave to bounce.'
            : 'Fast Flow optical flow active! Wave in any 360° direction.'
        );
      }
    } else if (this._handLandmarker) {
      this.activeEngine = 'ai';
      this._resetHandStates();
      if (this.onEngineChange) this.onEngineChange('ai', 'AI 21-Point Hand Tracking active!');
    } else {
      this._ensureAIModelLoaded();
    }
  }

  getEngineBadge() {
    if (this.activeEngine === 'ai') return 'AI';
    if (this.preferredEngine === 'ai' && this.aiStatus === 'loading') return 'AI…';
    return 'Flow';
  }

  async _ensureAIModelLoaded() {
    if (this._handLandmarker) {
      this.aiStatus = 'ready';
      if (this.enabled && this.preferredEngine === 'ai') {
        this.activeEngine = 'ai';
        this._resetHandStates();
      }
      return true;
    }
    if (this._aiLoadPromise) return this._aiLoadPromise;

    this.aiStatus = 'loading';
    if (this.onEngineChange) this.onEngineChange(this.activeEngine, null);

    this._aiLoadPromise = (async () => {
      try {
        const mp = await import(/* @vite-ignore */ MEDIAPIPE_ESM);
        const vision = await mp.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
        let landmarker = null;
        for (const delegate of ['GPU', 'CPU']) {
          try {
            landmarker = await mp.HandLandmarker.createFromOptions(vision, {
              baseOptions: { modelAssetPath: MEDIAPIPE_MODEL, delegate },
              runningMode: 'VIDEO',
              numHands: 2,
              minHandDetectionConfidence: 0.48,
              minHandPresenceConfidence: 0.45,
              minTrackingConfidence: 0.45,
            });
            break;
          } catch {
            // try next delegate
          }
        }
        if (!landmarker) throw new Error('HandLandmarker unavailable');

        this._handLandmarker = landmarker;
        this.aiStatus = 'ready';
        if (this.enabled && this.preferredEngine === 'ai') {
          this.activeEngine = 'ai';
          this._resetHandStates();
          if (this.onEngineChange) {
            this.onEngineChange('ai', 'AI 21-Point Hand Tracking ready! Pinch to pull/click or wave to bounce.');
          }
        }
        return true;
      } catch {
        this.aiStatus = 'failed';
        this.activeEngine = 'flow';
        if (this.onEngineChange) {
          this.onEngineChange('flow', 'Using Fast Flow offline tracking + Air Cursor!');
        }
        return false;
      } finally {
        this._aiLoadPromise = null;
      }
    })();

    return this._aiLoadPromise;
  }

  _resetHandStates() {
    this._releaseAllPinches();
    this.handCursors.length = 0;
    for (const h of this._hands) {
      h.present = false;
      h.hasPrevPalm = false;
      h.pinching = false;
      h.pinchProgress = 0;
      h.releaseGraceUntil = 0;
      h.vx = 0;
      h.vy = 0;
      h.landmarks = null;
      h.palmFilter.reset();
      h.pinchFilter.reset();
      h.velFilter.reset();
    }
  }

  _releaseAllPinches() {
    for (const h of this._hands) {
      if (h.pinching) {
        h.pinching = false;
        h.pinchProgress = 0;
        h.releaseGraceUntil = 0;
        if (this.onPinchEnd) this.onPinchEnd(h.slot);
      }
    }
  }

  _scheduleVideoFrameHook() {
    if (!this.enabled) return;
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this._vfcId = this.video.requestVideoFrameCallback(() => {
        this._hasNewVideoFrame = true;
        if (this.enabled) this._scheduleVideoFrameHook();
      });
    }
  }

  async start() {
    if (this.enabled) return { active: true };

    if (!window.isSecureContext) {
      return {
        active: false,
        message: 'Camera tracking needs localhost or HTTPS.',
      };
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return {
        active: false,
        message: 'Camera access is not available in this browser.',
      };
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: this.facingMode },
          width: { ideal: 480 },
          height: { ideal: 360 },
          frameRate: { ideal: 60, min: 24 },
        },
        audio: false,
      });

      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();

      this.enabled = true;
      this._hasNewVideoFrame = true;
      this._lastVideoTime = -1;
      this._lastProcessMs = 0;
      this._resetFlowTracker();
      this._resetHandStates();

      this.smoothVx = 0;
      this.smoothVy = 0;
      this._leadGx = 0;
      this._leadGy = 0;
      this._followGx = 0;
      this._followGy = 0;
      this._impX = 0;
      this._impY = 0;
      this.lastGestureText = 'Wave hand';
      this.lastGestureTime = 0;

      this._scheduleVideoFrameHook();

      if (this.preferredEngine === 'ai') {
        if (this._handLandmarker) {
          this.activeEngine = 'ai';
          return {
            active: true,
            message: 'AI Hand Tracking ON! Pinch to pull/click or wave to bounce.',
          };
        }
        this.activeEngine = 'flow';
        this._ensureAIModelLoaded();
        return {
          active: true,
          message: 'Fast Flow active immediately while 21-point AI model loads...',
        };
      }

      this.activeEngine = 'flow';
      return {
        active: true,
        message: this.airCursorEnabled
          ? 'Fast Flow + Air Cursor ON! Aim & hold still briefly to grab/click, or wave to bounce.'
          : 'Fast Flow Tracking ON! Wave in any direction to bounce.',
      };
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
      const notFound = err && err.name === 'NotFoundError';
      return {
        active: false,
        message: denied
          ? 'Camera permission was denied.'
          : notFound
            ? 'No camera was found on this device.'
            : 'Could not start camera tracking.',
      };
    }
  }

  stop() {
    this._releaseAllPinches();
    this.enabled = false;
    this._resetFlowTracker();
    if (this._vfcId && typeof this.video.cancelVideoFrameCallback === 'function') {
      try { this.video.cancelVideoFrameCallback(this._vfcId); } catch {}
    }
    this._vfcId = 0;
    this.smoothVx = 0;
    this.smoothVy = 0;
    this._leadGx = 0;
    this._leadGy = 0;
    this._followGx = 0;
    this._followGy = 0;
    this._impX = 0;
    this._impY = 0;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try { track.stop(); } catch {}
      }
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  async toggle() {
    if (this.enabled) {
      this.stop();
      return { active: false, message: 'Camera tracking turned off' };
    }
    return this.start();
  }

  async flipCamera() {
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
    this.mirror = this.facingMode === 'user';
    if (!this.enabled) return { active: false, mirror: this.mirror };
    this.stop();
    const res = await this.start();
    return { ...res, mirror: this.mirror };
  }

  update(now, previewCanvas = null) {
    if (!this.enabled || this.paused) {
      this._releaseAllPinches();
      this.handCursors.length = 0;
      return false;
    }
    if (this.video.readyState < 2 || this.video.videoWidth === 0) return false;

    const hasRvfc = typeof this.video.requestVideoFrameCallback === 'function';
    const videoTimeChanged = this.video.currentTime !== this._lastVideoTime;
    const isFreshFrame = hasRvfc ? this._hasNewVideoFrame : videoTimeChanged;

    if (!isFreshFrame) {
      this._leadGx *= 0.92;
      this._leadGy *= 0.92;
      return Math.hypot(this._leadGx, this._leadGy) > 0.004 || Math.hypot(this._followGx, this._followGy) > 0.004;
    }

    this._hasNewVideoFrame = false;
    this._lastVideoTime = this.video.currentTime;

    const dt = this._lastProcessMs > 0
      ? Math.max(0.008, Math.min(0.08, (now - this._lastProcessMs) / 1000))
      : 1 / 30;
    this._lastProcessMs = now;

    let active = false;
    if (this.activeEngine === 'ai' && this._handLandmarker) {
      active = this._updateAIHands(now, dt);
    } else {
      active = this._updateFastFlow(now, dt);
    }

    if (previewCanvas) {
      this._renderPreview(previewCanvas);
    }
    return active;
  }

  _mapActiveZone(nx, ny) {
    const u = (nx - 0.13) / 0.74;
    const v = (ny - 0.11) / 0.76;
    return {
      x: Math.max(0.005, Math.min(0.995, u)),
      y: Math.max(0.005, Math.min(0.995, v)),
    };
  }

  // ==========================================================================
  // ENGINE 1: MediaPipe 21-Landmark AI Hand Tracking (Pinch Air Cursor + Wave)
  // ==========================================================================
  _updateAIHands(now, dt) {
    let result = null;
    try {
      result = this._handLandmarker.detectForVideo(this.video, now);
    } catch {
      this.activeEngine = 'flow';
      this._resetFlowTracker();
      this._releaseAllPinches();
      return false;
    }

    const detected = (result && result.landmarks) ? result.landmarks : [];
    const sensNorm = this.sensitivity / 100;

    const rawHands = detected.map((lms) => {
      const mapX = (x) => (this.mirror ? 1.0 - x : x);
      const palmX = mapX((lms[0].x + lms[5].x + lms[9].x + lms[13].x + lms[17].x) * 0.2);
      const palmY = (lms[0].y + lms[5].y + lms[9].y + lms[13].y + lms[17].y) * 0.2;
      const thumbX = mapX(lms[4].x);
      const thumbY = lms[4].y;
      const indexX = mapX(lms[8].x);
      const indexY = lms[8].y;
      const indexMcpX = mapX(lms[5].x);
      const indexMcpY = lms[5].y;
      const wristX = mapX(lms[0].x);
      const wristY = lms[0].y;
      const midX = mapX(lms[9].x);
      const midY = lms[9].y;
      const palmSize = Math.max(0.05, Math.hypot(midX - wristX, midY - wristY));
      const pinchRatio = Math.hypot(indexX - thumbX, indexY - thumbY) / palmSize;

      const pinchMidX = (thumbX + indexX) * 0.5;
      const pinchMidY = (thumbY + indexY) * 0.5;
      const aimRawX = pinchMidX * 0.65 + indexMcpX * 0.35;
      const aimRawY = pinchMidY * 0.65 + indexMcpY * 0.35;
      const mappedAim = this._mapActiveZone(aimRawX, aimRawY);

      return {
        lms,
        palmX,
        palmY,
        cursorX: mappedAim.x,
        cursorY: mappedAim.y,
        pinchRatio,
      };
    });

    const assigned = [null, null];
    if (rawHands.length === 1) {
      const d0 = this._hands[0].present ? Math.hypot(rawHands[0].palmX - this._hands[0].palmX, rawHands[0].palmY - this._hands[0].palmY) : 0.01;
      const d1 = this._hands[1].present ? Math.hypot(rawHands[0].palmX - this._hands[1].palmX, rawHands[0].palmY - this._hands[1].palmY) : 99;
      assigned[d0 <= d1 ? 0 : 1] = rawHands[0];
    } else if (rawHands.length >= 2) {
      const costSame =
        Math.hypot(rawHands[0].palmX - this._hands[0].palmX, rawHands[0].palmY - this._hands[0].palmY) +
        Math.hypot(rawHands[1].palmX - this._hands[1].palmX, rawHands[1].palmY - this._hands[1].palmY);
      const costSwap =
        Math.hypot(rawHands[1].palmX - this._hands[0].palmX, rawHands[1].palmY - this._hands[0].palmY) +
        Math.hypot(rawHands[0].palmX - this._hands[1].palmX, rawHands[0].palmY - this._hands[1].palmY);
      if (costSame <= costSwap) {
        assigned[0] = rawHands[0];
        assigned[1] = rawHands[1];
      } else {
        assigned[0] = rawHands[1];
        assigned[1] = rawHands[0];
      }
    }

    let waveVxSum = 0;
    let waveVySum = 0;
    let waveHandCount = 0;
    let centSumX = 0;
    let centSumY = 0;
    let presentCount = 0;
    let anyPinching = false;

    this.handCursors.length = 0;

    for (let s = 0; s < 2; s++) {
      const h = this._hands[s];
      const raw = assigned[s];
      if (!raw) {
        if (h.pinching) {
          h.pinching = false;
          h.releaseGraceUntil = now + 240;
          if (this.onPinchEnd) this.onPinchEnd(h.slot);
        }
        h.present = false;
        h.hasPrevPalm = false;
        h.landmarks = null;
        h.pinchProgress = 0;
        h.vx *= 0.7;
        h.vy *= 0.7;
        continue;
      }

      h.present = true;
      h.landmarks = raw.lms;
      presentCount++;

      const prog = Math.max(0, Math.min(1, (0.68 - raw.pinchRatio) / (0.68 - 0.35)));
      h.pinchProgress = prog;

      const sNorm = this.smoothness / 100;
      const baseCut = (4.2 - sNorm * 3.1) * 1.25;
      const baseBeta = (0.24 - sNorm * 0.17) * 1.3;
      if (!h.pinching && prog > 0.52) {
        h.pinchFilter.setParams(Math.max(0.75, baseCut * 0.48), baseBeta * 0.45);
      } else {
        h.pinchFilter.setParams(baseCut, baseBeta);
      }

      const fp = h.palmFilter.filter(raw.palmX, raw.palmY, dt);
      const fCursor = h.pinchFilter.filter(raw.cursorX, raw.cursorY, dt);
      h.palmX = fp.x;
      h.palmY = fp.y;
      h.pinchX = fCursor.x;
      h.pinchY = fCursor.y;

      centSumX += (fp.x * 2 - 1);
      centSumY += (fp.y * 2 - 1);

      let rawVx = 0;
      let rawVy = 0;
      if (h.hasPrevPalm) {
        rawVx = (fp.x - h.prevPalmX) / dt;
        rawVy = (fp.y - h.prevPalmY) / dt;
      }
      h.prevPalmX = fp.x;
      h.prevPalmY = fp.y;
      h.hasPrevPalm = true;

      const fv = h.velFilter.filter(rawVx, rawVy, dt);
      h.vx = Math.max(-4.0, Math.min(4.0, fv.x));
      h.vy = Math.max(-4.0, Math.min(4.0, fv.y));

      if (this.airCursorEnabled) {
        const wasPinching = h.pinching;
        if (!wasPinching && raw.pinchRatio < 0.35) {
          h.pinching = true;
          this.lastGestureText = '👌 Pinch';
          this.lastGestureTime = now;
        } else if (wasPinching && raw.pinchRatio > 0.48) {
          h.pinching = false;
          h.releaseGraceUntil = now + 240;
        }

        this.handCursors.push({
          id: h.slot,
          x: h.pinchX,
          y: h.pinchY,
          mode: 'pinch',
          pinching: h.pinching,
          pinchProgress: h.pinchProgress,
        });
      } else if (h.pinching) {
        h.pinching = false;
        h.releaseGraceUntil = now + 240;
      }

      if (h.pinching) {
        anyPinching = true;
      } else if (now > h.releaseGraceUntil) {
        waveVxSum += h.vx;
        waveVySum += h.vy;
        waveHandCount++;
      }
    }

    if (this.allowWaveBounce && waveHandCount > 0) {
      const vx = waveVxSum / waveHandCount;
      const vy = waveVySum / waveHandCount;
      this.smoothVx = vx * 0.55;
      this.smoothVy = vy * 0.55;
      return this._applyContinuousWavePhysics(vx, vy, dt, now, sensNorm, true, presentCount, centSumX, centSumY, anyPinching);
    }

    this.smoothVx *= 0.72;
    this.smoothVy *= 0.72;
    this._leadGx *= 0.80;
    this._leadGy *= 0.80;
    this._followGx *= 0.85;
    this._followGy *= 0.85;
    return anyPinching;
  }

  // ==========================================================================
  // ENGINE 2: 3-Level Illumination-Invariant Sub-Pixel Pyramid Lucas-Kanade
  //           + Persistent Hybrid Hand Tracker (Flow + Mean-Shift Air Cursor!)
  // ==========================================================================
  _lkLevel(prev, curr, ixImg, iyImg, w, h, initU, initV, gridStep, winR, iters, maxDisp, minTdiff, lumaShift, collectBlocks) {
    const margin = winR + 2;
    const vecs = [];
    let centSumX = 0;
    let centSumY = 0;
    let centSumW = 0;

    for (let cy = margin; cy < h - margin; cy += gridStep) {
      for (let cx = margin; cx < w - margin; cx += gridStep) {
        let tdiff = 0;
        let skinHits = 0;
        for (let dy = -winR; dy <= winR; dy += 2) {
          const row = (cy + dy) * w;
          for (let dx = -winR; dx <= winR; dx += 2) {
            const idx = row + cx + dx;
            const d = (curr[idx] - lumaShift) - prev[idx];
            tdiff += d < 0 ? -d : d;
            if (collectBlocks) skinHits += this._skinFine[idx];
          }
        }
        if (tdiff < minTdiff) continue;

        const skinBoost = collectBlocks && skinHits >= 4 ? 1.6 : 1.0;
        if (collectBlocks) {
          centSumX += (cx / w) * tdiff * skinBoost;
          centSumY += (cy / h) * tdiff * skinBoost;
          centSumW += tdiff * skinBoost;
        }

        // Fast structure tensor using precomputed gradients (zero extra neighbor reads!)
        let gxx = 0, gxy = 0, gyy = 0;
        for (let dy = -winR; dy <= winR; dy += 2) {
          const row = (cy + dy) * w;
          for (let dx = -winR; dx <= winR; dx += 2) {
            const idx = row + cx + dx;
            const ix = ixImg[idx];
            const iy = iyImg[idx];
            gxx += ix * ix;
            gxy += ix * iy;
            gyy += iy * iy;
          }
        }

        const det = gxx * gyy - gxy * gxy;
        const trace = gxx + gyy;
        if (trace < 28.0 || det < 1e-3) continue;
        const disc = Math.max(0, (gxx - gyy) * (gxx - gyy) + 4 * gxy * gxy);
        if (0.5 * (trace - Math.sqrt(disc)) < 7.0) continue;

        const invDet = 1.0 / det;
        let u = initU;
        let v = initV;

        for (let it = 0; it < iters; it++) {
          let bx = 0, by = 0;
          for (let dy = -winR; dy <= winR; dy += 2) {
            const py = cy + dy;
            const row = py * w;
            for (let dx = -winR; dx <= winR; dx += 2) {
              const px = cx + dx;
              const idx = row + px;
              const dtVal = (sampleBilinear(curr, w, h, px + u, py + v) - lumaShift) - prev[idx];
              bx += ixImg[idx] * dtVal;
              by += iyImg[idx] * dtVal;
            }
          }
          const du = -(gyy * bx - gxy * by) * invDet;
          const dv = -(-gxy * bx + gxx * by) * invDet;
          u += du;
          v += dv;
          if (u * u + v * v > maxDisp * maxDisp || du * du + dv * dv < 1e-4) break;
        }

        const mag = Math.hypot(u, v);
        if (mag > maxDisp || mag < 0.025) continue;

        let resAfter = 0;
        for (let dy = -winR; dy <= winR; dy += 2) {
          const py = cy + dy;
          const row = py * w;
          for (let dx = -winR; dx <= winR; dx += 2) {
            const px = cx + dx;
            const d = (sampleBilinear(curr, w, h, px + u, py + v) - lumaShift) - prev[row + px];
            resAfter += d < 0 ? -d : d;
          }
        }

        if (resAfter < tdiff * 0.78) {
          const gain = tdiff - resAfter;
          vecs.push({ weight: gain * (gain / tdiff) * skinBoost, u, v, cx, cy });
        }
      }
    }

    if (vecs.length < 2) {
      return { u: 0, v: 0, vecs, centSumX, centSumY, centSumW };
    }

    // Huber-reweighted median consensus — kills shadow/hair outliers cleanly!
    const us = vecs.map((v) => v.u);
    const vs = vecs.map((v) => v.v);
    const medU = medianOf(us);
    const medV = medianOf(vs);

    let sw = 0, su = 0, sv = 0, smag = 0;
    for (let i = 0; i < vecs.length; i++) {
      const c = vecs[i];
      const dist = Math.hypot(c.u - medU, c.v - medV);
      const hw = c.weight / (1.0 + (dist / 1.8) * (dist / 1.8));
      sw += hw;
      su += hw * c.u;
      sv += hw * c.v;
      smag += hw * Math.hypot(c.u, c.v);
      if (collectBlocks && dist < 3.6) {
        this.activeBlocks.push({ x: c.cx / w, y: c.cy / h, u: c.u, v: c.v });
      }
    }

    if (sw <= 1e-6) {
      return { u: 0, v: 0, vecs, centSumX, centSumY, centSumW };
    }
    const ux = su / sw;
    const uy = sv / sw;
    const coherence = Math.hypot(ux, uy) / Math.max(1e-5, smag / sw);
    if (coherence < 0.46) {
      return { u: 0, v: 0, vecs, centSumX, centSumY, centSumW };
    }
    return { u: ux, v: uy, vecs, centSumX, centSumY, centSumW };
  }

  _updateFlowHandCursor(now, dt, fine, lumaShift) {
    const fh = this._flowHand;
    const nPx = FW * FH;
    const curr = this._currFine;
    const prev = this._prevFine;
    const bg = this._bgFine;
    const heat = this._heatFine;
    const skin = this._skinFine;
    const sal = this._salFine;

    // 1. Update adaptive background model + per-pixel motion heat + salience map
    let movedPx = 0;
    for (let i = 0; i < nPx; i++) {
      const diffPrev = Math.abs((curr[i] - lumaShift) - prev[i]);
      if (diffPrev > 9.0) {
        movedPx++;
        heat[i] = Math.min(80, heat[i] * 0.72 + diffPrev * 1.45);
      } else {
        heat[i] *= 0.86;
      }
      // Adapt background ONLY on quiet pixels so a paused hand stays bright in foreground!
      if (diffPrev < 5.5 && heat[i] < 4.0) {
        bg[i] = bg[i] * 0.985 + curr[i] * 0.015;
      }
      const fgDiff = Math.abs(curr[i] - bg[i]);
      const fgSignal = fgDiff > 13.0 ? (fgDiff - 13.0) : 0;
      const skinMul = skin[i] ? 1.85 : 0.75;
      sal[i] = (fgSignal * 0.85 + heat[i] * 1.35) * skinMul;
    }

    // If camera itself was bumped/moved (>58% of pixels changed at once), rapidly re-learn background
    if (movedPx > nPx * 0.58) {
      for (let i = 0; i < nPx; i++) {
        bg[i] = bg[i] * 0.5 + curr[i] * 0.5;
      }
    }

    // 2. Acquire hand on first coherent motion (or strong foreground-skin peak)
    const hasFlowMotion = fine.vecs.length >= 2 && (Math.abs(fine.u) > 0.04 || Math.abs(fine.v) > 0.04);

    if (!fh.present) {
      if (hasFlowMotion) {
        // Seed directly at the moving hand blocks!
        let sx = 0, sy = 0, sw = 0;
        for (let i = 0; i < fine.vecs.length; i++) {
          const c = fine.vecs[i];
          sx += (c.cx / FW) * c.weight;
          sy += (c.cy / FH) * c.weight;
          sw += c.weight;
        }
        if (sw > 0) {
          fh.rawX = sx / sw;
          fh.rawY = sy / sw;
          fh.present = true;
          fh.lastSeenMs = now;
          fh.lastActiveMs = now;
          fh.confidence = 1.0;
          this._flowCursorFilter.reset();
        }
      } else {
        // Fallback: check for a clear foreground+skin hand held up in the active frame
        let bestS = 0, bestX = 0.5, bestY = 0.5;
        for (let gy = 8; gy < FH - 8; gy += 6) {
          for (let gx = 8; gx < FW - 8; gx += 6) {
            let local = 0;
            for (let dy = -4; dy <= 4; dy += 2) {
              const row = (gy + dy) * FW;
              for (let dx = -4; dx <= 4; dx += 2) {
                local += sal[row + gx + dx];
              }
            }
            if (local > bestS) {
              bestS = local;
              bestX = gx / FW;
              bestY = gy / FH;
            }
          }
        }
        if (bestS > 520) {
          fh.rawX = bestX;
          fh.rawY = bestY;
          fh.present = true;
          fh.lastSeenMs = now;
          fh.lastActiveMs = now;
          fh.confidence = 0.8;
          this._flowCursorFilter.reset();
        }
      }
    } else {
      // 3. Hybrid Tracking: Sub-pixel Optical Flow Prediction + 2-Step Local Gaussian Mean-Shift!
      let predU = 0;
      let predV = 0;
      let localFlowW = 0;

      if (hasFlowMotion) {
        const hxPx = fh.rawX * FW;
        const hyPx = fh.rawY * FH;
        const localR = 26;
        for (let i = 0; i < fine.vecs.length; i++) {
          const c = fine.vecs[i];
          const d = Math.hypot(c.cx - hxPx, c.cy - hyPx);
          if (d < localR) {
            const w = c.weight * (1.0 - d / localR);
            predU += c.u * w;
            predV += c.v * w;
            localFlowW += w;
          }
        }
        if (localFlowW > 0) {
          predU /= localFlowW;
          predV /= localFlowW;
        } else if (Math.hypot(fine.u, fine.v) > 1.2) {
          // Fast wave moved outside localR in 1 frame — follow consensus flow!
          predU = fine.u;
          predV = fine.v;
        }
      }

      // Advance by exact sub-pixel optical flow displacement!
      fh.rawX = Math.max(0.04, Math.min(0.96, fh.rawX + predU / FW));
      fh.rawY = Math.max(0.04, Math.min(0.96, fh.rawY + predV / FH));

      // 2-step local Gaussian Mean-Shift on salience map to keep centered & prevent drift!
      let localEnergy = 0;
      const winR = 14;
      const inv2Sig2 = 1.0 / (2.0 * 7.5 * 7.5);
      for (let iter = 0; iter < 2; iter++) {
        const cx = Math.round(fh.rawX * FW);
        const cy = Math.round(fh.rawY * FH);
        let mx = 0, my = 0, mw = 0;
        const y0 = Math.max(2, cy - winR);
        const y1 = Math.min(FH - 3, cy + winR);
        const x0 = Math.max(2, cx - winR);
        const x1 = Math.min(FW - 3, cx + winR);

        for (let y = y0; y <= y1; y += 2) {
          const dy = y - cy;
          const row = y * FW;
          for (let x = x0; x <= x1; x += 2) {
            const sVal = sal[row + x];
            if (sVal <= 2.0) continue;
            const dx = x - cx;
            const gw = sVal * Math.exp(-(dx * dx + dy * dy) * inv2Sig2);
            mx += x * gw;
            my += y * gw;
            mw += gw;
          }
        }

        if (iter === 0) localEnergy = mw;
        if (mw > 45) {
          const targetX = (mx / mw) / FW;
          const targetY = (my / mw) / FH;
          // Gentle snap when moving (flow dominates!), firmer lock when still!
          const pull = localFlowW > 0 ? 0.20 : 0.28;
          fh.rawX += (targetX - fh.rawX) * pull;
          fh.rawY += (targetY - fh.rawY) * pull;
        }
      }

      if (localEnergy > 80 || localFlowW > 0) {
        fh.lastSeenMs = now;
        if (localFlowW > 0) fh.lastActiveMs = now;
        fh.confidence = Math.min(1, fh.confidence + 0.15);
      } else {
        fh.confidence *= 0.92;
      }

      // If hand leaves frame completely (no foreground/skin salience for > 1.8s), drop cursor cleanly
      if (now - fh.lastSeenMs > 1800) {
        fh.present = false;
        fh.confidence = 0;
      }
    }

    if (fh.present && this.airCursorEnabled) {
      const mapped = this._mapActiveZone(fh.rawX, fh.rawY);
      const filtered = this._flowCursorFilter.filter(mapped.x, mapped.y, dt);
      fh.cursorX = filtered.x;
      fh.cursorY = filtered.y;

      this.handCursors.push({
        id: 0,
        x: fh.cursorX,
        y: fh.cursorY,
        mode: 'dwell',
        pinching: false,
        pinchProgress: 0,
      });
    }
  }

  _updateFastFlow(now, dt) {
    this.handCursors.length = 0;
    const pctx = this.procCtx;
    pctx.save();
    if (this.mirror) {
      pctx.translate(FW, 0);
      pctx.scale(-1, 1);
    }
    pctx.drawImage(this.video, 0, 0, FW, FH);
    pctx.restore();

    const rgba = pctx.getImageData(0, 0, FW, FH).data;
    const rawFine = this._rawFine;
    const skin = this._skinFine;
    const nPx = FW * FH;
    let sumCurr = 0;

    for (let i = 0; i < nPx; i++) {
      const p = i << 2;
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      const yVal = (77 * r + 150 * g + 29 * b) * (1 / 256);
      rawFine[i] = yVal;
      sumCurr += yVal;
      const cb = 128 + ((-43 * r - 85 * g + 128 * b) >> 8);
      const cr = 128 + ((128 * r - 107 * g - 21 * b) >> 8);
      skin[i] = (cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173) ? 1 : 0;
    }

    // Build 3-level smoothed Gaussian pyramid (96x72 -> 48x36 -> 24x18)
    smoothBox(rawFine, this._tmpFine, this._currFine, FW, FH);
    downsample2x(this._currFine, this._rawCoarse, FW, FH);
    smoothBox(this._rawCoarse, this._tmpCoarse, this._currCoarse, CW, CH);
    downsample2x(this._currCoarse, this._rawTiny, CW, CH);
    smoothBox(this._rawTiny, this._tmpTiny, this._currTiny, TW, TH);

    if (!this._hasBg) {
      this._bgFine.set(this._currFine);
      this._hasBg = true;
    }

    if (!this._hasPrevFlow) {
      this._prevFine.set(this._currFine);
      this._prevCoarse.set(this._currCoarse);
      this._prevTiny.set(this._currTiny);
      this._hasPrevFlow = true;
      return false;
    }

    // Global auto-exposure shift cancellation!
    let sumPrev = 0;
    const prevFine = this._prevFine;
    for (let i = 0; i < nPx; i++) sumPrev += prevFine[i];
    const lumaShift = (sumCurr - sumPrev) / nPx;

    // Precompute spatial gradients once per pyramid level
    computeGradients(this._prevTiny, this._ixTiny, this._iyTiny, TW, TH);
    computeGradients(this._prevCoarse, this._ixCoarse, this._iyCoarse, CW, CH);
    computeGradients(this._prevFine, this._ixFine, this._iyFine, FW, FH);

    this.activeBlocks.length = 0;
    const tiny = this._lkLevel(
      this._prevTiny, this._currTiny, this._ixTiny, this._iyTiny, TW, TH,
      0, 0, 3, 2, 3, 5.5, 10.0, lumaShift, false
    );
    const coarse = this._lkLevel(
      this._prevCoarse, this._currCoarse, this._ixCoarse, this._iyCoarse, CW, CH,
      tiny.u * 2.0, tiny.v * 2.0, 5, 3, 3, 11.0, 16.0, lumaShift, false
    );
    const fine = this._lkLevel(
      this._prevFine, this._currFine, this._ixFine, this._iyFine, FW, FH,
      coarse.u * 2.0, coarse.v * 2.0, 6, 4, 3, 22.0, 24.0, lumaShift, true
    );

    // Update persistent Fast Flow Hand Cursor (before overwriting prevFine!)
    this._updateFlowHandCursor(now, dt, fine, lumaShift);

    this._prevFine.set(this._currFine);
    this._prevCoarse.set(this._currCoarse);
    this._prevTiny.set(this._currTiny);

    // Convert fine sub-pixel displacement -> normalized screen-widths / second
    const rawVx = (fine.u / FW) / dt;
    const rawVy = (fine.v / FH) / dt;
    const fv = this._flowVelFilter.filter(rawVx, rawVy, dt);
    const vx = Math.max(-4.5, Math.min(4.5, fv.x));
    const vy = Math.max(-4.5, Math.min(4.5, fv.y));
    this.smoothVx = vx * 0.55;
    this.smoothVy = vy * 0.55;

    // Mute wave-bounce while a Fast Flow Air Cursor Dwell-Grab is actively pulling a cheek!
    if (!this.allowWaveBounce || this._externalGrabActive || now < this._externalReleaseGraceUntil) {
      this._leadGx *= 0.80;
      this._leadGy *= 0.80;
      this._followGx *= 0.85;
      this._followGy *= 0.85;
      return this._externalGrabActive;
    }

    let centX = 0;
    let centY = 0;
    let hasCent = 0;
    if (this._flowHand.present) {
      centX = this._flowHand.rawX * 2 - 1;
      centY = this._flowHand.rawY * 2 - 1;
      hasCent = 1;
    } else if (fine.centSumW > 380) {
      const fc = this._centroidFilter.filter(
        Math.max(-1, Math.min(1, (fine.centSumX / fine.centSumW) * 2 - 1)),
        Math.max(-1, Math.min(1, (fine.centSumY / fine.centSumW) * 2 - 1)),
        dt
      );
      centX = fc.x;
      centY = fc.y;
      hasCent = 1;
    }

    return this._applyContinuousWavePhysics(vx, vy, dt, now, this.sensitivity / 100, false, hasCent, centX, centY, false);
  }

  // ==========================================================================
  // Unified Silky-Smooth Continuous 360° Wave Coupling (No Steppy Cooldowns!)
  // ==========================================================================
  _applyContinuousWavePhysics(vx, vy, dt, now, sensNorm, isAI, presentCount, centSumX, centSumY, anyPinching) {
    // Higher wave deadzone when Air Cursor is active so calm aiming stays rock steady, while brisk waves still bounce!
    const deadzone = this.airCursorEnabled
      ? (isAI ? (0.42 - sensNorm * 0.14) : (0.46 - sensNorm * 0.16))
      : (isAI ? (0.10 - sensNorm * 0.05) : (0.11 - sensNorm * 0.05));
    const speed = Math.hypot(vx, vy);
    let active = anyPinching;

    if (this.bounceEnabled && speed > deadzone) {
      const excess = speed - deadzone;
      const ux = vx / speed;
      const uy = vy / speed;

      const leadMag = Math.min(1.15, excess * (0.38 + sensNorm * 0.55));
      this._leadGx += (ux * leadMag - this._leadGx) * 0.45;
      this._leadGy += (uy * leadMag - this._leadGy) * 0.45;

      const shaped = Math.pow(Math.min(2.6, excess), 1.22);
      const gain = (165 + sensNorm * 240) * dt * shaped;
      this._impX += ux * gain;
      this._impY += uy * gain;
      active = true;

      if (excess > 0.22) {
        const label = directionLabel(ux, uy);
        this.lastGestureText = label;
        this.lastGestureTime = now;

        if (this.onGestureBounce && excess > 0.55 && now - this._lastAudioTime > 240) {
          this._lastAudioTime = now;
          this.onGestureBounce(Math.min(1, (excess - 0.35) * 0.55), label);
        }
      }
    } else {
      this._leadGx *= 0.80;
      this._leadGy *= 0.80;
    }

    if (this.followEnabled && presentCount > 0) {
      const fScale = 0.48 + sensNorm * 0.62;
      const tx = (centSumX / presentCount) * fScale;
      const ty = (centSumY / presentCount) * fScale;
      this._followGx += (tx - this._followGx) * 0.30;
      this._followGy += (ty - this._followGy) * 0.30;
      active = true;
    } else {
      this._followGx *= 0.86;
      this._followGy *= 0.86;
    }

    this._impX = Math.max(-18, Math.min(18, this._impX));
    this._impY = Math.max(-18, Math.min(18, this._impY));

    return active || Math.hypot(this._leadGx, this._leadGy) > 0.005;
  }

  consumeForce() {
    const out = {
      gx: Math.max(-1.4, Math.min(1.4, this._leadGx + this._followGx)),
      gy: Math.max(-1.4, Math.min(1.4, this._leadGy + this._followGy)),
      ax: this._impX,
      ay: this._impY,
    };
    this._impX = 0;
    this._impY = 0;
    return out;
  }

  _renderPreview(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    if (this.mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(this.video, 0, 0, w, h);
    ctx.restore();

    ctx.fillStyle = 'rgba(28, 16, 24, 0.16)';
    ctx.fillRect(0, 0, w, h);

    if (this.activeEngine === 'ai') {
      for (const hand of this._hands) {
        if (!hand.present || !hand.landmarks) continue;
        const lms = hand.landmarks;
        const mx = (x) => (this.mirror ? 1.0 - x : x) * w;
        const my = (y) => y * h;

        ctx.save();
        ctx.strokeStyle = hand.pinching ? '#ff4f86' : 'rgba(255, 165, 192, 0.90)';
        ctx.lineWidth = 1.8;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < HAND_CONNECTIONS.length; i++) {
          const [a, b] = HAND_CONNECTIONS[i];
          ctx.moveTo(mx(lms[a].x), my(lms[a].y));
          ctx.lineTo(mx(lms[b].x), my(lms[b].y));
        }
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < lms.length; i++) {
          ctx.beginPath();
          ctx.arc(mx(lms[i].x), my(lms[i].y), i === 4 || i === 8 ? 2.8 : 1.7, 0, Math.PI * 2);
          ctx.fill();
        }

        if (hand.pinching) {
          ctx.beginPath();
          ctx.arc((mx(lms[4].x) + mx(lms[8].x)) * 0.5, (my(lms[4].y) + my(lms[8].y)) * 0.5, 7, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 79, 134, 0.45)';
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.restore();
      }
    } else {
      // Fast Flow: draw sub-pixel directional flow needles + persistent hand reticle!
      if (this.activeBlocks.length > 0) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 150, 185, 0.78)';
        ctx.lineWidth = 1.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < this.activeBlocks.length; i++) {
          const b = this.activeBlocks[i];
          const bx = b.x * w;
          const by = b.y * h;
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + b.u * 1.9, by + b.v * 1.9);
        }
        ctx.stroke();
        ctx.restore();
      }

      if (this._flowHand.present) {
        const hx = this._flowHand.rawX * w;
        const hy = this._flowHand.rawY * h;
        ctx.save();
        ctx.beginPath();
        ctx.arc(hx, hy, this._externalGrabActive ? 11 : 9, 0, Math.PI * 2);
        ctx.fillStyle = this._externalGrabActive ? 'rgba(255, 79, 134, 0.42)' : 'rgba(255, 143, 171, 0.22)';
        ctx.fill();
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = this._externalGrabActive ? '#ff4f86' : '#ffffff';
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(hx, hy, 2.3, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.restore();
      }
    }

    // Live 360° directional velocity arrow in center
    const speed = Math.hypot(this.smoothVx, this.smoothVy);
    if (speed > 0.06) {
      const cx = w * 0.5;
      const cy = h * 0.5;
      const maxLen = Math.min(w, h) * 0.38;
      const len = Math.min(maxLen, speed * maxLen * 0.95);
      const ux = this.smoothVx / speed;
      const uy = this.smoothVy / speed;
      const ex = cx + ux * len;
      const ey = cy + uy * len;

      ctx.save();
      ctx.strokeStyle = '#ff6b9b';
      ctx.fillStyle = '#ff6b9b';
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ex, ey);
      ctx.stroke();

      const headLen = 8.5;
      const ang = Math.atan2(uy, ux);
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - headLen * Math.cos(ang - 0.55), ey - headLen * Math.sin(ang - 0.55));
      ctx.lineTo(ex - headLen * Math.cos(ang + 0.55), ey - headLen * Math.sin(ang + 0.55));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
}
