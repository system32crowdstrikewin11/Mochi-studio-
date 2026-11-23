/**
 * CameraHandTracker v23 — Ultra-Smooth Dual-Engine Hand Tracking + Precision Air Cursor
 *
 * Engine 1 (AI Hands — Default, lazy-loaded):
 *   - MediaPipe 21-Landmark HandLandmarker (GPU w/ CPU fallback, up to 2 hands)
 *   - Ergonomic active-zone mapping + anti-drift pinch stabilization + 1-Euro filter
 *   - Air Cursor (Pinch & Hold to pull cheeks / paint / scrub sliders; Quick Pinch to click)
 *   - Continuous 360° open-hand wave bounce
 *
 * Engine 2 (Fast Flow — 0ms instant startup & 100% offline):
 *   - Automatic Face-Exclusion Halo (integral-image oval detector + native FaceDetector
 *     fusion, excluding the union of prev & curr face halos so head nods/turns = 0 motion!)
 *   - Global Camera-Shake Rejection (rejects uniform whole-frame motion when phone moves)
 *   - Skin-Rich Compact Hand-Cluster Filter (ignores fans, curtains, chairs & scattered noise)
 *   - 3-Level Illumination-Invariant Sub-Pixel Pyramid Lucas-Kanade (24x18 -> 48x36 -> 96x72)
 *     with precomputed gradients, auto-exposure cancellation & Huber-reweighted median consensus
 *   - Precision Relative Air-Trackpad Cursor: stays 100% rock-steady when still (zero wild
 *     jumping!) and glides smoothly with trackpad acceleration + 1-Euro smoothing when your
 *     hand moves, paired with Dwell-Lock Grab/Click!
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
// 3-Level Sub-Pixel Pyramid Lucas-Kanade & Face-Exclusion Helpers
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

function inFaceHalo(cx, cy, face, scale = 1.0) {
  if (!face) return false;
  const dx = (cx - face.cx * scale) / Math.max(1, face.rx * scale);
  const dy = (cy - face.cy * scale) / Math.max(1, face.ry * scale);
  return (dx * dx + dy * dy) <= 1.0;
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
    this.faceFilterEnabled = true; // Ignore face, head nods, camera shake & non-skin room clutter in Fast Flow!
    this.sensitivity = 68;         // 20 .. 100
    this.smoothness = 55;          // 0 .. 100 (tunes 1-Euro filter live!)

    // External grab lock notification (e.g. Fast Flow dwell-grab active in AirCursorController)
    this._externalGrabActive = false;
    this._externalReleaseGraceUntil = 0;

    // Engine selection: 'ai' | 'flow'
    this.preferredEngine = 'ai';
    this.activeEngine = 'flow';
    this.aiStatus = 'idle'; // 'idle' | 'loading' | 'ready' | 'failed'
    this._handLandmarker = null;
    this._aiLoadPromise = null;

    // Optional native hardware FaceDetector (available on Android Chrome / macOS Chrome)
    this._nativeFaceDetector = null;
    this._nativeFaceBusy = false;
    this._nativeFaceLastMs = 0;
    this._nativeFaceBox = null; // { cx, cy, rx, ry, seenMs } in 96x72 coords
    if (typeof window !== 'undefined' && typeof window.FaceDetector === 'function') {
      try {
        this._nativeFaceDetector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
      } catch {
        this._nativeFaceDetector = null;
      }
    }

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

    // Pre-allocated 3-Level Pyramid Lucas-Kanade & Face-Mask Buffers (zero GC!)
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
    this._prevSkin = new Uint8Array(FW * FH);
    this._currSkin = new Uint8Array(FW * FH);
    this._skinII = new Int32Array((FW + 1) * (FH + 1));

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

    // Tracked face exclusion ellipses (prev & curr union prevents head-nod leaks!)
    this._prevFace = null;
    this._currFace = null;
    this._faceLastSeenMs = 0;

    // Adaptive 1-Euro filters for Fast Flow
    this._flowVelFilter = new OneEuro2D(2.4, 0.16, 1.2);
    this._flowCursorFilter = new OneEuro2D(2.6, 0.18, 1.2);

    // Fast Flow Relative Air-Trackpad Cursor state (NEVER teleports to face/background!)
    this._trackpad = {
      visible: false,
      x: 0.5,          // [0..1] viewport coordinate
      y: 0.5,
      filteredX: 0.5,
      filteredY: 0.5,
      clusterX: 0.5,   // camera-space centroid of last verified hand cluster (for PiP reticle)
      clusterY: 0.5,
      lastMoveMs: 0,
      hasCluster: false,
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
    this._flowCursorFilter.setParams(minCut * 1.25, beta * 1.4);
    for (const h of this._hands) {
      h.palmFilter.setParams(minCut, beta);
      h.pinchFilter.setParams(minCut * 1.25, beta * 1.3);
      h.velFilter.setParams(minCut * 1.2, beta);
    }
  }

  recenterFlowCursor() {
    this._trackpad.x = 0.5;
    this._trackpad.y = 0.5;
    this._trackpad.filteredX = 0.5;
    this._trackpad.filteredY = 0.5;
    this._flowCursorFilter.reset();
  }

  _resetFlowTracker() {
    this._hasPrevFlow = false;
    this._prevFace = null;
    this._currFace = null;
    this._nativeFaceBox = null;
    this._flowVelFilter.reset();
    this._flowCursorFilter.reset();
    this._trackpad.visible = false;
    this._trackpad.x = 0.5;
    this._trackpad.y = 0.5;
    this._trackpad.filteredX = 0.5;
    this._trackpad.filteredY = 0.5;
    this._trackpad.hasCluster = false;
    this._trackpad.lastMoveMs = 0;
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
            ? 'Fast Flow active (Face ignored)! Glide hand like a trackpad & pause to grab/click.'
            : 'Fast Flow optical flow active (Face ignored)! Wave in any direction.'
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
      return { active: false, message: 'Camera tracking needs localhost or HTTPS.' };
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return { active: false, message: 'Camera access is not available in this browser.' };
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
          ? 'Fast Flow ON (Face ignored)! Glide hand like a trackpad & pause to grab/click.'
          : 'Fast Flow ON (Face ignored)! Wave hand in any direction to bounce.',
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
  // ENGINE 2: Face-Masked, Camera-Shake-Canceled Fast Flow + Precision Trackpad
  // ==========================================================================
  _pollNativeFaceDetector(now) {
    if (!this._nativeFaceDetector || this._nativeFaceBusy || now - this._nativeFaceLastMs < 160) return;
    this._nativeFaceBusy = true;
    this._nativeFaceLastMs = now;
    this._nativeFaceDetector.detect(this.procCanvas).then((faces) => {
      if (faces && faces.length > 0 && faces[0].boundingBox) {
        const bb = faces[0].boundingBox;
        this._nativeFaceBox = {
          cx: bb.x + bb.width * 0.5,
          cy: bb.y + bb.height * 0.52,
          rx: Math.max(10, bb.width * 0.78),
          ry: Math.max(12, bb.height * 0.86),
          seenMs: performance.now(),
        };
      }
    }).catch(() => {
      this._nativeFaceDetector = null;
    }).finally(() => {
      this._nativeFaceBusy = false;
    });
  }

  /** Fast integral-image skin-oval face detector on 96x72 (fused with native FaceDetector) */
  _detectFaceHalo(now, skinMask) {
    if (!this.faceFilterEnabled || this.facingMode !== 'user') {
      return null;
    }

    this._pollNativeFaceDetector(now);
    if (this._nativeFaceBox && now - this._nativeFaceBox.seenMs < 650) {
      return {
        cx: this._nativeFaceBox.cx,
        cy: this._nativeFaceBox.cy,
        rx: this._nativeFaceBox.rx,
        ry: this._nativeFaceBox.ry,
      };
    }

    // Build 2D summed-area table (integral image) of skinMask
    const ii = this._skinII;
    const stride = FW + 1;
    for (let x = 0; x <= FW; x++) ii[x] = 0;
    for (let y = 0; y < FH; y++) {
      let rowSum = 0;
      const srcRow = y * FW;
      const prevRow = y * stride;
      const curRow = (y + 1) * stride;
      ii[curRow] = 0;
      for (let x = 0; x < FW; x++) {
        rowSum += skinMask[srcRow + x];
        ii[curRow + x + 1] = ii[prevRow + x + 1] + rowSum;
      }
    }

    const boxSum = (x0, y0, x1, y1) => {
      const a = x0 < 0 ? 0 : (x0 > FW ? FW : x0);
      const b = x1 < 0 ? 0 : (x1 > FW ? FW : x1);
      const c = y0 < 0 ? 0 : (y0 > FH ? FH : y0);
      const d = y1 < 0 ? 0 : (y1 > FH ? FH : y1);
      if (b <= a || d <= c) return 0;
      return ii[d * stride + b] - ii[c * stride + b] - ii[d * stride + a] + ii[c * stride + a];
    };

    let bestScore = 0;
    let best = null;
    const radii = [8, 12, 16];
    const yMin = Math.round(FH * 0.12);
    const yMax = Math.round(FH * 0.64);
    const xMin = Math.round(FW * 0.22);
    const xMax = Math.round(FW * 0.78);

    for (let ri = 0; ri < radii.length; ri++) {
      const rx = radii[ri];
      const ry = Math.round(rx * 1.25);
      const area = (2 * rx) * (2 * ry);
      const outerArea = Math.max(1, (4 * rx) * (4 * ry) - area);

      for (let cy = yMin; cy <= yMax; cy += 3) {
        for (let cx = xMin; cx <= xMax; cx += 3) {
          const inner = boxSum(cx - rx, cy - ry, cx + rx, cy + ry);
          const density = inner / area;
          if (density < 0.44) continue;
          const outer = boxSum(cx - rx * 2, cy - ry * 2, cx + rx * 2, cy + ry * 2) - inner;
          const outerDensity = outer / outerArea;
          const centerBias = 1.0 - 0.35 * Math.abs(cx / FW - 0.5) * 2.0;
          const score = (density - outerDensity * 0.62) * Math.sqrt(inner) * centerBias;
          if (score > bestScore) {
            bestScore = score;
            // Generous 1.85x halo covers cheeks, ears, forehead, hair & chin completely!
            best = {
              cx,
              cy: cy + 2,
              rx: rx * 1.85,
              ry: ry * 1.90,
            };
          }
        }
      }
    }

    if (best && bestScore >= 5.5) {
      this._faceLastSeenMs = now;
      if (this._currFace) {
        // Smooth face halo slightly so it doesn't jitter, while adapting immediately to head turns
        return {
          cx: this._currFace.cx * 0.35 + best.cx * 0.65,
          cy: this._currFace.cy * 0.35 + best.cy * 0.65,
          rx: Math.max(best.rx, this._currFace.rx * 0.85 + best.rx * 0.15),
          ry: Math.max(best.ry, this._currFace.ry * 0.85 + best.ry * 0.15),
        };
      }
      return best;
    }

    // Keep previous face halo alive briefly during momentary occlusion (e.g. blinking/shadow)
    if (this._currFace && now - this._faceLastSeenMs < 700) {
      return this._currFace;
    }
    return null;
  }

  _solveBlock(prev, curr, ixImg, iyImg, w, h, cx, cy, winR, initU, initV, maxDisp, minTdiff, lumaShift, iters) {
    let tdiff = 0;
    for (let dy = -winR; dy <= winR; dy += 2) {
      const row = (cy + dy) * w;
      for (let dx = -winR; dx <= winR; dx += 2) {
        const idx = row + cx + dx;
        const d = (curr[idx] - lumaShift) - prev[idx];
        tdiff += d < 0 ? -d : d;
      }
    }
    if (tdiff < minTdiff) return null;

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
    if (trace < 28.0 || det < 1e-3) return null;
    const disc = Math.max(0, (gxx - gyy) * (gxx - gyy) + 4 * gxy * gxy);
    if (0.5 * (trace - Math.sqrt(disc)) < 7.0) return null;

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
    if (mag > maxDisp || mag < 0.03) return null;

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

    if (resAfter >= tdiff * 0.78) return null;
    const gain = tdiff - resAfter;
    return { u, v, weight: gain * (gain / tdiff) };
  }

  /** Detect whole-frame camera shake (holding/tilting phone) on coarse 48x36 grid */
  _isCameraShake(lumaShift) {
    let total = 0;
    let moving = 0;
    let su = 0, sv = 0, smag = 0;
    for (let cy = 5; cy < CH - 5; cy += 5) {
      for (let cx = 5; cx < CW - 5; cx += 5) {
        total++;
        const r = this._solveBlock(
          this._prevCoarse, this._currCoarse, this._ixCoarse, this._iyCoarse,
          CW, CH, cx, cy, 3, 0, 0, 9.0, 16.0, lumaShift, 2
        );
        if (r) {
          moving++;
          su += r.u;
          sv += r.v;
          smag += Math.hypot(r.u, r.v);
        }
      }
    }
    if (moving > total * 0.44 && smag > 1e-4) {
      const coh = Math.hypot(su, sv) / smag;
      if (coh > 0.62) return true;
    }
    return false;
  }

  _lkHandLevel(prev, curr, ixImg, iyImg, w, h, initU, initV, gridStep, winR, iters, maxDisp, minTdiff, lumaShift, scaleToFine, enforceSkin, clusterFine) {
    const margin = winR + 2;
    const vecs = [];
    const face0 = this._prevFace;
    const face1 = this._currFace;
    const filterFace = this.faceFilterEnabled && this.facingMode === 'user';

    for (let cy = margin; cy < h - margin; cy += gridStep) {
      for (let cx = margin; cx < w - margin; cx += gridStep) {
        // Exclude UNION of prev & curr face halos at every pyramid level!
        if (filterFace) {
          const fx = cx * scaleToFine;
          const fy = cy * scaleToFine;
          if (inFaceHalo(fx, fy, face0, 1.0) || inFaceHalo(fx, fy, face1, 1.0)) {
            continue;
          }
        }

        // On fine level, strictly require skin pixels when filter is enabled (rejects fans, chairs, curtains!)
        let skinMul = 1.0;
        if (enforceSkin && filterFace) {
          let skinHits = 0;
          for (let dy = -winR; dy <= winR; dy += 2) {
            const row = (cy + dy) * w;
            for (let dx = -winR; dx <= winR; dx += 2) {
              const idx = row + cx + dx;
              skinHits += this._prevSkin[idx] + this._currSkin[idx];
            }
          }
          if (skinHits < 6) continue;
          skinMul = 1.0 + skinHits * 0.05;
        }

        const r = this._solveBlock(
          prev, curr, ixImg, iyImg, w, h, cx, cy, winR,
          initU, initV, maxDisp, minTdiff, lumaShift, iters
        );
        if (!r) continue;

        // Also reject blocks whose warped destination lands inside the face halo!
        if (filterFace) {
          const destX = (cx + r.u) * scaleToFine;
          const destY = (cy + r.v) * scaleToFine;
          if (inFaceHalo(destX, destY, face1, 1.0)) continue;
        }

        vecs.push({ cx, cy, u: r.u, v: r.v, weight: r.weight * skinMul });
      }
    }

    const minBlocks = clusterFine ? 3 : 2;
    if (vecs.length < minBlocks) {
      return { u: 0, v: 0, ok: false, clusterX: 0.5, clusterY: 0.5 };
    }

    // Spatial compactness gate on fine level: pick the densest hand-sized cluster (radius 22px)!
    // Eliminates scattered background noise & isolated flickers completely!
    let pool = vecs;
    if (clusterFine) {
      let bestCluster = [];
      let bestW = 0;
      for (let i = 0; i < vecs.length; i++) {
        const a = vecs[i];
        let cw = 0;
        const cl = [];
        for (let j = 0; j < vecs.length; j++) {
          const b = vecs[j];
          if (Math.hypot(b.cx - a.cx, b.cy - a.cy) <= 22.0) {
            cl.push(b);
            cw += b.weight;
          }
        }
        if (cw > bestW) {
          bestW = cw;
          bestCluster = cl;
        }
      }
      if (bestCluster.length < 3) {
        return { u: 0, v: 0, ok: false, clusterX: 0.5, clusterY: 0.5 };
      }
      pool = bestCluster;
    }

    // Huber-reweighted median consensus on the hand cluster
    const us = pool.map((b) => b.u);
    const vs = pool.map((b) => b.v);
    const medU = medianOf(us);
    const medV = medianOf(vs);

    let sw = 0, su = 0, sv = 0, smag = 0, sx = 0, sy = 0;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      const dist = Math.hypot(c.u - medU, c.v - medV);
      const hw = c.weight / (1.0 + (dist / 1.8) * (dist / 1.8));
      sw += hw;
      su += hw * c.u;
      sv += hw * c.v;
      smag += hw * Math.hypot(c.u, c.v);
      sx += hw * (c.cx / w);
      sy += hw * (c.cy / h);
      if (clusterFine && dist < 3.4) {
        this.activeBlocks.push({ x: c.cx / w, y: c.cy / h, u: c.u, v: c.v });
      }
    }

    if (sw <= 1e-6) return { u: 0, v: 0, ok: false, clusterX: 0.5, clusterY: 0.5 };
    const ux = su / sw;
    const uy = sv / sw;
    const coh = Math.hypot(ux, uy) / Math.max(1e-5, smag / sw);
    if (coh < (clusterFine ? 0.54 : 0.46)) {
      return { u: 0, v: 0, ok: false, clusterX: 0.5, clusterY: 0.5 };
    }
    return { u: ux, v: uy, ok: true, clusterX: sx / sw, clusterY: sy / sw };
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
    const currSkin = this._currSkin;
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
      // Inclusive skin-tone detector across light/medium/deep skin tones while rejecting grey/white/cool walls
      const cb = 128 + ((-43 * r - 85 * g + 128 * b) >> 8);
      const cr = 128 + ((128 * r - 107 * g - 21 * b) >> 8);
      currSkin[i] = (yVal > 38 && r > b + 10 && cb >= 72 && cb <= 128 && cr >= 130 && cr <= 178) ? 1 : 0;
    }

    // Build 3-level smoothed Gaussian pyramid (96x72 -> 48x36 -> 24x18)
    smoothBox(rawFine, this._tmpFine, this._currFine, FW, FH);
    downsample2x(this._currFine, this._rawCoarse, FW, FH);
    smoothBox(this._rawCoarse, this._tmpCoarse, this._currCoarse, CW, CH);
    downsample2x(this._currCoarse, this._rawTiny, CW, CH);
    smoothBox(this._rawTiny, this._tmpTiny, this._currTiny, TW, TH);

    // Detect current face halo BEFORE overwriting prevFace
    const nextFace = this._detectFaceHalo(now, currSkin);
    this._prevFace = this._currFace;
    this._currFace = nextFace;

    if (!this._hasPrevFlow) {
      this._prevFine.set(this._currFine);
      this._prevCoarse.set(this._currCoarse);
      this._prevTiny.set(this._currTiny);
      this._prevSkin.set(currSkin);
      this._hasPrevFlow = true;
      return false;
    }

    // Global auto-exposure shift cancellation
    let sumPrev = 0;
    const prevFine = this._prevFine;
    for (let i = 0; i < nPx; i++) sumPrev += prevFine[i];
    const lumaShift = (sumCurr - sumPrev) / nPx;

    // Precompute spatial gradients once per pyramid level
    computeGradients(this._prevTiny, this._ixTiny, this._iyTiny, TW, TH);
    computeGradients(this._prevCoarse, this._ixCoarse, this._iyCoarse, CW, CH);
    computeGradients(this._prevFine, this._ixFine, this._iyFine, FW, FH);

    this.activeBlocks.length = 0;
    let fine = { u: 0, v: 0, ok: false, clusterX: 0.5, clusterY: 0.5 };

    // 1. Camera-shake gate: if whole phone shifted, reject frame cleanly so cursor stays rock-still!
    if (!this._isCameraShake(lumaShift)) {
      const tiny = this._lkHandLevel(
        this._prevTiny, this._currTiny, this._ixTiny, this._iyTiny, TW, TH,
        0, 0, 3, 2, 3, 5.5, 10.0, lumaShift, 4, false, false
      );
      const coarse = this._lkHandLevel(
        this._prevCoarse, this._currCoarse, this._ixCoarse, this._iyCoarse, CW, CH,
        tiny.u * 2.0, tiny.v * 2.0, 5, 3, 3, 11.0, 16.0, lumaShift, 2, false, false
      );
      fine = this._lkHandLevel(
        this._prevFine, this._currFine, this._ixFine, this._iyFine, FW, FH,
        coarse.u * 2.0, coarse.v * 2.0, 6, 4, 3, 20.0, 22.0, lumaShift, 1, true, true
      );
    }

    this._prevFine.set(this._currFine);
    this._prevCoarse.set(this._currCoarse);
    this._prevTiny.set(this._currTiny);
    this._prevSkin.set(currSkin);

    // 2. Precision Relative Air-Trackpad Cursor (stays rock-steady at rest — ZERO wild jumping!)
    const tp = this._trackpad;
    const sensNorm = this.sensitivity / 100; // 0.20 .. 1.00

    if (this.airCursorEnabled) {
      if (fine.ok) {
        tp.hasCluster = true;
        tp.clusterX = fine.clusterX;
        tp.clusterY = fine.clusterY;

        const mag = Math.hypot(fine.u, fine.v);
        // Clean micro-deadzone keeps cursor 100% locked while resting/pausing to dwell-grab!
        const moveDeadzone = 0.16;
        if (mag > moveDeadzone) {
          if (!tp.visible) {
            tp.visible = true;
            this._flowCursorFilter.reset();
          }
          tp.lastMoveMs = now;
          const effMag = mag - moveDeadzone;
          const dirX = fine.u / mag;
          const dirY = fine.v / mag;
          // Laptop trackpad acceleration curve: gentle = ultra-precise aim, faster = full-screen glide
          const gain = (1.05 + sensNorm * 1.15) * (1.0 + Math.min(0.85, effMag * 0.14));
          const dx = (dirX * effMag / FW) * gain;
          const dy = (dirY * effMag / FH) * gain;
          // Clamp single-frame delta so even an extreme glitch can never teleport cursor across screen
          const maxStep = 0.12;
          tp.x = Math.max(0.015, Math.min(0.985, tp.x + Math.max(-maxStep, Math.min(maxStep, dx))));
          tp.y = Math.max(0.015, Math.min(0.985, tp.y + Math.max(-maxStep, Math.min(maxStep, dy))));
        }
      } else {
        tp.hasCluster = false;
      }

      // Auto-hide cursor if hand has been completely inactive for >4.5s (and not currently grabbing)
      // Prevents accidental auto-grab when sitting still before raising your hand!
      if (tp.visible && !this._externalGrabActive && tp.lastMoveMs > 0 && now - tp.lastMoveMs > 4500) {
        tp.visible = false;
      }

      if (tp.visible) {
        const fc = this._flowCursorFilter.filter(tp.x, tp.y, dt);
        tp.filteredX = fc.x;
        tp.filteredY = fc.y;

        this.handCursors.push({
          id: 0,
          x: tp.filteredX,
          y: tp.filteredY,
          mode: 'dwell',
          pinching: false,
          pinchProgress: 0,
        });
      }
    } else {
      tp.visible = false;
    }

    // 3. Velocity for 360° wave bounce
    const rawVx = fine.ok ? ((fine.u / FW) / dt) : 0;
    const rawVy = fine.ok ? ((fine.v / FH) / dt) : 0;
    const fv = this._flowVelFilter.filter(rawVx, rawVy, dt);
    const vx = Math.max(-4.5, Math.min(4.5, fv.x));
    const vy = Math.max(-4.5, Math.min(4.5, fv.y));
    this.smoothVx = vx * 0.55;
    this.smoothVy = vy * 0.55;

    if (!this.allowWaveBounce || this._externalGrabActive || now < this._externalReleaseGraceUntil) {
      this._leadGx *= 0.80;
      this._leadGy *= 0.80;
      this._followGx *= 0.85;
      this._followGy *= 0.85;
      return this._externalGrabActive;
    }

    const centX = tp.filteredX * 2 - 1;
    const centY = tp.filteredY * 2 - 1;
    const hasCent = tp.visible ? 1 : 0;

    return this._applyContinuousWavePhysics(vx, vy, dt, now, sensNorm, false, hasCent, centX, centY, false);
  }

  // ==========================================================================
  // Unified Silky-Smooth Continuous 360° Wave Coupling (No Steppy Cooldowns!)
  // ==========================================================================
  _applyContinuousWavePhysics(vx, vy, dt, now, sensNorm, isAI, presentCount, centSumX, centSumY, anyPinching) {
    const deadzone = this.airCursorEnabled
      ? (isAI ? (0.42 - sensNorm * 0.14) : (0.58 - sensNorm * 0.16))
      : (isAI ? (0.10 - sensNorm * 0.05) : (0.12 - sensNorm * 0.05));
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
      // Draw subtle dashed Face-Ignored Exclusion Oval so user can see face is safely masked out!
      if (this._currFace && this.faceFilterEnabled && this.facingMode === 'user') {
        const fx = (this._currFace.cx / FW) * w;
        const fy = (this._currFace.cy / FH) * h;
        const frx = (this._currFace.rx / FW) * w;
        const fry = (this._currFace.ry / FH) * h;
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
        ctx.fillStyle = 'rgba(24, 18, 30, 0.22)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.ellipse(fx, fy, frx, fry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      // Draw verified hand-cluster directional flow needles
      if (this.activeBlocks.length > 0) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 132, 174, 0.90)';
        ctx.lineWidth = 1.6;
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

      // Draw active hand cluster highlight ring when hand is moving
      if (this._trackpad.hasCluster) {
        const hx = this._trackpad.clusterX * w;
        const hy = this._trackpad.clusterY * h;
        ctx.save();
        ctx.beginPath();
        ctx.arc(hx, hy, this._externalGrabActive ? 11 : 8.5, 0, Math.PI * 2);
        ctx.fillStyle = this._externalGrabActive ? 'rgba(255, 79, 134, 0.42)' : 'rgba(255, 143, 171, 0.24)';
        ctx.fill();
        ctx.lineWidth = 1.7;
        ctx.strokeStyle = this._externalGrabActive ? '#ff4f86' : '#ffffff';
        ctx.stroke();
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
