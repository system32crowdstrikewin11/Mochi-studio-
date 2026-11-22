/**
 * CameraHandTracker v21 — Ultra-Smooth, Granular Dual-Engine Real-Time Hand Tracking
 *
 * Engine 1 (AI Hands — Default, auto-loads lazily when Camera turns on):
 *   - MediaPipe 21-Landmark HandLandmarker (@mediapipe/tasks-vision, GPU w/ CPU fallback)
 *   - Tracks up to 2 hands in real time, 100% immune to head/background/lighting noise
 *   - Adaptive 1-Euro Filter gives zero micro-jitter when steady & zero lag on fast waves
 *   - Continuous 360° velocity-to-spring coupling (micro-bobs to full directional bounces!)
 *   - Optional Mid-Air Pinch Grab (thumb + index pinch grabs & pulls mochi cheeks hands-free!)
 *
 * Engine 2 (Sub-Pixel Pyramid Lucas-Kanade Optical Flow — 0ms instant startup & offline):
 *   - 2-level Gaussian pyramid (48x36 coarse -> 96x72 fine) with iterative bilinear warping
 *   - Resolves continuous floating-point sub-pixel motion down to 0.03 px/frame (zero stair-stepping!)
 *   - Shi-Tomasi minimum-eigenvalue & motion-coherence gating rejects static walls & noise
 *   - Synced to native camera cadence via requestVideoFrameCallback
 */

const MEDIAPIPE_ESM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';
const MEDIAPIPE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MEDIAPIPE_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// 21-landmark hand bone connections for crisp PiP skeleton overlay
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

// Sub-pixel Pyramid Lucas-Kanade dimensions
const FW = 96;
const FH = 72;
const CW = 48;
const CH = 36;

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
// Sub-Pixel 2-Level Pyramid Lucas-Kanade Helpers (Zero-allocation hot path!)
// ============================================================================
function smoothBox(src, tmp, dst, w, h) {
  // Horizontal [1, 2, 1] / 4
  for (let y = 0; y < h; y++) {
    const row = y * w;
    tmp[row] = src[row];
    for (let x = 1; x < w - 1; x++) {
      tmp[row + x] = (src[row + x - 1] + 2 * src[row + x] + src[row + x + 1]) * 0.25;
    }
    tmp[row + w - 1] = src[row + w - 1];
  }
  // Vertical [1, 2, 1] / 4
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

    // Engine selection: 'ai' (MediaPipe 21-landmark w/ instant Sub-px LK fallback) | 'flow' (Sub-px LK only)
    this.preferredEngine = 'ai';
    this.activeEngine = 'flow'; // 'ai' | 'flow'
    this.aiStatus = 'idle';     // 'idle' | 'loading' | 'ready' | 'failed'
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

    // Pre-allocated Sub-Pixel Pyramid Lucas-Kanade buffers (zero GC per frame!)
    this.procCanvas = document.createElement('canvas');
    this.procCanvas.width = FW;
    this.procCanvas.height = FH;
    this.procCtx = this.procCanvas.getContext('2d', { willReadFrequently: true });

    this._rawFine = new Float32Array(FW * FH);
    this._tmpFine = new Float32Array(FW * FH);
    this._prevFine = new Float32Array(FW * FH);
    this._currFine = new Float32Array(FW * FH);
    this._skinFine = new Uint8Array(FW * FH);

    this._rawCoarse = new Float32Array(CW * CH);
    this._tmpCoarse = new Float32Array(CW * CH);
    this._prevCoarse = new Float32Array(CW * CH);
    this._currCoarse = new Float32Array(CW * CH);
    this._hasPrevFlow = false;

    // Adaptive 1-Euro filters
    this._flowVelFilter = new OneEuro2D(2.2, 0.14, 1.2);
    this._centroidFilter = new OneEuro2D(1.8, 0.08, 1.0);

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
    this.centroidX = 0;
    this.centroidY = 0;
    this.activeBlocks = [];
    this.handCursors = []; // [{ id, x, y, pinching }] normalized [0..1] for stage overlay

    // Continuous forces consumed at full display/physics FPS (zero stair-stepping!)
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
    this.onPinchStart = null;    // (handId, normX, normY) => void
    this.onPinchMove = null;     // (handId, normX, normY) => void
    this.onPinchEnd = null;      // (handId) => void

    this._applySmoothness();
  }

  setSmoothness(val) {
    this.smoothness = Math.max(0, Math.min(100, Number(val) || 55));
    this._applySmoothness();
  }

  _applySmoothness() {
    // smoothness 0 = ultra-snappy raw response, 100 = ultra-silky velvet smoothing
    const s = this.smoothness / 100;
    const minCut = 4.2 - s * 3.1;   // 4.2 Hz -> 1.1 Hz
    const beta = 0.24 - s * 0.17;   // 0.24 -> 0.07
    this._flowVelFilter.setParams(minCut * 1.1, beta);
    this._centroidFilter.setParams(minCut, beta * 0.8);
    for (const h of this._hands) {
      h.palmFilter.setParams(minCut, beta);
      h.pinchFilter.setParams(minCut * 1.25, beta * 1.3);
      h.velFilter.setParams(minCut * 1.2, beta);
    }
  }

  setPreferredEngine(mode) {
    this.preferredEngine = mode === 'flow' ? 'flow' : 'ai';
    if (!this.enabled) return;
    if (this.preferredEngine === 'flow') {
      this._releaseAllPinches();
      this.activeEngine = 'flow';
      this._hasPrevFlow = false;
      if (this.onEngineChange) this.onEngineChange('flow', 'Switched to Sub-Pixel Optical Flow');
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
        // Prefer GPU delegate for 60fps mobile speed; gracefully fall back to CPU delegate if GPU busy
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
            this.onEngineChange('ai', 'AI 21-Point Hand Tracking ready! Wave or pinch in mid-air.');
          }
        }
        return true;
      } catch {
        this.aiStatus = 'failed';
        this.activeEngine = 'flow';
        if (this.onEngineChange) {
          this.onEngineChange('flow', null);
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
      this._hasPrevFlow = false;
      this._hasNewVideoFrame = true;
      this._lastVideoTime = -1;
      this._lastProcessMs = 0;
      this._flowVelFilter.reset();
      this._centroidFilter.reset();
      this._resetHandStates();

      this.smoothVx = 0;
      this.smoothVy = 0;
      this._leadGx = 0;
      this._leadGy = 0;
      this._followGx = 0;
      this._followGy = 0;
      this._impX = 0;
      this._impY = 0;
      this.activeBlocks.length = 0;
      this.lastGestureText = 'Wave hand';
      this.lastGestureTime = 0;

      this._scheduleVideoFrameHook();

      if (this.preferredEngine === 'ai') {
        if (this._handLandmarker) {
          this.activeEngine = 'ai';
          return {
            active: true,
            message: 'AI Hand Tracking ON! Wave in any direction or pinch to grab cheeks.',
          };
        }
        // Start immediately with Sub-pixel Lucas-Kanade while AI model warms up in background!
        this.activeEngine = 'flow';
        this._ensureAIModelLoaded();
        return {
          active: true,
          message: 'Camera tracking ON! Loading 21-point AI hand model in background...',
        };
      }

      this.activeEngine = 'flow';
      return {
        active: true,
        message: 'Sub-pixel Camera Tracking ON! Wave in any direction to bounce.',
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
    this._hasPrevFlow = false;
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
    this.activeBlocks.length = 0;
    this.handCursors.length = 0;
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

  /**
   * Called every rAF in Play mode.
   * Only runs CV when the camera delivers a genuinely NEW frame (0 redundant work!),
   * and smoothly decays continuous lead/velocity every frame for 120Hz silky physics!
   */
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
      // Smooth inter-frame exponential decay of lead force so 60/120Hz display stays buttery smooth
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
      active = this._updateSubpixelFlow(now, dt);
    }

    if (previewCanvas) {
      this._renderPreview(previewCanvas);
    }
    return active;
  }

  // ==========================================================================
  // ENGINE 1: MediaPipe 21-Landmark AI Hand Tracking (Ultra-Granular + Pinch!)
  // ==========================================================================
  _mapActiveZone(nx, ny) {
    // Comfortable ergonomic camera box -> full 0..1 viewport reach without stretching arm out of frame
    const u = (nx - 0.13) / 0.74;
    const v = (ny - 0.11) / 0.76;
    return {
      x: Math.max(0.005, Math.min(0.995, u)),
      y: Math.max(0.005, Math.min(0.995, v)),
    };
  }

  _updateAIHands(now, dt) {
    let result = null;
    try {
      result = this._handLandmarker.detectForVideo(this.video, now);
    } catch {
      this.activeEngine = 'flow';
      this._hasPrevFlow = false;
      this._releaseAllPinches();
      return false;
    }

    const detected = (result && result.landmarks) ? result.landmarks : [];
    const sensNorm = this.sensitivity / 100;

    // Extract ergonomic stabilized aim point + palm + pinch ratio per detected hand
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

      // Anti-drift hybrid aim point: blends fingertip pinch midpoint (65%) with stable index knuckle (35%)
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

    // Nearest-neighbor slot assignment so Hand 0 & Hand 1 stay consistent across frames
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

      // Continuous pinch-closeness progress [0..1] (for tactile cursor ring!)
      const prog = Math.max(0, Math.min(1, (0.68 - raw.pinchRatio) / (0.68 - 0.35)));
      h.pinchProgress = prog;

      // Pre-pinch stabilization: gently steady cursor while thumb+index are closing together
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

      // Hysteresis pinch detection (thumb tip + index tip)
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

    // Only emit wave bounce when allowed (Play mode) and not currently pinching
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
  // ENGINE 2: 2-Level Sub-Pixel Pyramid Lucas-Kanade Optical Flow (0ms & Offline)
  // ==========================================================================
  _lkLevel(prev, curr, w, h, initU, initV, gridStep, winR, iters, maxDisp, minTdiff, collectBlocks) {
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
            const d = curr[idx] - prev[idx];
            tdiff += d < 0 ? -d : d;
            if (collectBlocks) skinHits += this._skinFine[idx];
          }
        }
        if (tdiff < minTdiff) continue;

        const skinBoost = collectBlocks && skinHits >= 4 ? 1.55 : 1.0;
        if (collectBlocks) {
          centSumX += ((cx / w) * 2 - 1) * tdiff * skinBoost;
          centSumY += ((cy / h) * 2 - 1) * tdiff * skinBoost;
          centSumW += tdiff * skinBoost;
        }

        // Compute spatial structure tensor on prev window
        let gxx = 0, gxy = 0, gyy = 0;
        for (let dy = -winR; dy <= winR; dy += 2) {
          const r0 = (cy + dy - 1) * w;
          const r1 = (cy + dy) * w;
          const r2 = (cy + dy + 1) * w;
          for (let dx = -winR; dx <= winR; dx += 2) {
            const px = cx + dx;
            const ix = 0.5 * (prev[r1 + px + 1] - prev[r1 + px - 1]);
            const iy = 0.5 * (prev[r2 + px] - prev[r0 + px]);
            gxx += ix * ix;
            gxy += ix * iy;
            gyy += iy * iy;
          }
        }

        const det = gxx * gyy - gxy * gxy;
        const trace = gxx + gyy;
        if (trace < 30.0 || det < 1e-3) continue;
        const disc = Math.max(0, (gxx - gyy) * (gxx - gyy) + 4 * gxy * gxy);
        if (0.5 * (trace - Math.sqrt(disc)) < 8.0) continue;

        const invDet = 1.0 / det;
        let u = initU;
        let v = initV;

        for (let it = 0; it < iters; it++) {
          let bx = 0, by = 0;
          for (let dy = -winR; dy <= winR; dy += 2) {
            const py = cy + dy;
            const r0 = (py - 1) * w;
            const r1 = py * w;
            const r2 = (py + 1) * w;
            for (let dx = -winR; dx <= winR; dx += 2) {
              const px = cx + dx;
              const ix = 0.5 * (prev[r1 + px + 1] - prev[r1 + px - 1]);
              const iy = 0.5 * (prev[r2 + px] - prev[r0 + px]);
              const dtVal = sampleBilinear(curr, w, h, px + u, py + v) - prev[r1 + px];
              bx += ix * dtVal;
              by += iy * dtVal;
            }
          }
          const du = -(gyy * bx - gxy * by) * invDet;
          const dv = -(-gxy * bx + gxx * by) * invDet;
          u += du;
          v += dv;
          if (u * u + v * v > maxDisp * maxDisp || du * du + dv * dv < 1e-4) break;
        }

        const mag = Math.hypot(u, v);
        if (mag > maxDisp || mag < 0.03) continue;

        let resAfter = 0;
        for (let dy = -winR; dy <= winR; dy += 2) {
          const py = cy + dy;
          const r1 = py * w;
          for (let dx = -winR; dx <= winR; dx += 2) {
            const px = cx + dx;
            const d = sampleBilinear(curr, w, h, px + u, py + v) - prev[r1 + px];
            resAfter += d < 0 ? -d : d;
          }
        }

        if (resAfter < tdiff * 0.78) {
          const gain = tdiff - resAfter;
          vecs.push({ weight: gain * (gain / tdiff) * skinBoost, u, v, cx, cy });
        }
      }
    }

    if (vecs.length < 3) {
      return { u: 0, v: 0, centSumX, centSumY, centSumW };
    }

    vecs.sort((a, b) => b.weight - a.weight);
    const keepN = Math.max(3, Math.floor(vecs.length * 0.6));
    let sw = 0, su = 0, sv = 0, smag = 0;
    for (let i = 0; i < keepN; i++) {
      const c = vecs[i];
      sw += c.weight;
      su += c.weight * c.u;
      sv += c.weight * c.v;
      smag += c.weight * Math.hypot(c.u, c.v);
      if (collectBlocks) {
        this.activeBlocks.push({ x: c.cx / w, y: c.cy / h });
      }
    }

    const ux = su / sw;
    const uy = sv / sw;
    const coherence = Math.hypot(ux, uy) / Math.max(1e-5, smag / sw);
    if (coherence < 0.50) {
      return { u: 0, v: 0, centSumX, centSumY, centSumW };
    }
    return { u: ux, v: uy, centSumX, centSumY, centSumW };
  }

  _updateSubpixelFlow(now, dt) {
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
    for (let i = 0; i < nPx; i++) {
      const p = i << 2;
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      rawFine[i] = (77 * r + 150 * g + 29 * b) * (1 / 256);
      const cb = 128 + ((-43 * r - 85 * g + 128 * b) >> 8);
      const cr = 128 + ((128 * r - 107 * g - 21 * b) >> 8);
      skin[i] = (cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173) ? 1 : 0;
    }

    // Build smoothed 2-level Gaussian pyramid (96x72 -> 48x36)
    smoothBox(rawFine, this._tmpFine, this._currFine, FW, FH);
    downsample2x(this._currFine, this._rawCoarse, FW, FH);
    smoothBox(this._rawCoarse, this._tmpCoarse, this._currCoarse, CW, CH);

    if (!this._hasPrevFlow) {
      this._prevFine.set(this._currFine);
      this._prevCoarse.set(this._currCoarse);
      this._hasPrevFlow = true;
      return false;
    }

    this.activeBlocks.length = 0;
    const coarse = this._lkLevel(
      this._prevCoarse, this._currCoarse, CW, CH,
      0, 0, 5, 3, 3, 6.0, 18.0, false
    );
    const fine = this._lkLevel(
      this._prevFine, this._currFine, FW, FH,
      coarse.u * 2.0, coarse.v * 2.0, 7, 4, 3, 12.0, 26.0, true
    );

    this._prevFine.set(this._currFine);
    this._prevCoarse.set(this._currCoarse);

    // Convert fine sub-pixel displacement -> normalized screen-widths / second
    const rawVx = (fine.u / FW) / dt;
    const rawVy = (fine.v / FH) / dt;
    const fv = this._flowVelFilter.filter(rawVx, rawVy, dt);
    const vx = Math.max(-4.0, Math.min(4.0, fv.x));
    const vy = Math.max(-4.0, Math.min(4.0, fv.y));
    this.smoothVx = vx * 0.55;
    this.smoothVy = vy * 0.55;

    let centX = 0;
    let centY = 0;
    let hasCent = 0;
    if (fine.centSumW > 380) {
      const fc = this._centroidFilter.filter(
        Math.max(-1, Math.min(1, fine.centSumX / fine.centSumW)),
        Math.max(-1, Math.min(1, fine.centSumY / fine.centSumW)),
        dt
      );
      centX = fc.x;
      centY = fc.y;
      hasCent = 1;
    }

    if (!this.allowWaveBounce) { this._leadGx *= 0.8; this._leadGy *= 0.8; return false; }
    return this._applyContinuousWavePhysics(vx, vy, dt, now, this.sensitivity / 100, false, hasCent, centX, centY, false);
  }

  // ==========================================================================
  // Unified Silky-Smooth Continuous 360° Wave Coupling (No Steppy Cooldowns!)
  // ==========================================================================
  _applyContinuousWavePhysics(vx, vy, dt, now, sensNorm, isAI, presentCount, centSumX, centSumY, anyPinching) {
    // Micro deadzone preserves tiny granular gestures while staying 100% calm at rest
    const deadzone = isAI ? (this.airCursorEnabled ? (0.42 - sensNorm * 0.14) : (0.10 - sensNorm * 0.05)) : (0.14 - sensNorm * 0.06);
    const speed = Math.hypot(vx, vy);
    let active = anyPinching;

    if (this.bounceEnabled && speed > deadzone) {
      const excess = speed - deadzone;
      const ux = vx / speed;
      const uy = vy / speed;

      // 1. Continuous silky lead-displacement target (gives immediate ultra-granular feel on gentle moves!)
      const leadMag = Math.min(1.15, excess * (0.38 + sensNorm * 0.55));
      this._leadGx += (ux * leadMag - this._leadGx) * 0.45;
      this._leadGy += (uy * leadMag - this._leadGy) * 0.45;

      // 2. Smooth dt-normalized elastic bounce impulse (proportional to velocity^1.22, zero steppy jumps!)
      const shaped = Math.pow(Math.min(2.6, excess), 1.22);
      const gain = (165 + sensNorm * 240) * dt * shaped;
      this._impX += ux * gain;
      this._impY += uy * gain;
      active = true;

      // Live directional badge + soft boing audio on brisk waves
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

    // Optional Follow-Hand continuous lean
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

    // Safe single-frame impulse clamp
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
      // Draw crisp 21-joint hand skeletons + pinch glow!
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
    } else if (this.activeBlocks.length > 0) {
      ctx.fillStyle = 'rgba(255, 143, 171, 0.55)';
      for (let i = 0; i < this.activeBlocks.length; i++) {
        const b = this.activeBlocks[i];
        ctx.beginPath();
        ctx.arc(b.x * w, b.y * h, 2.6, 0, Math.PI * 2);
        ctx.fill();
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
