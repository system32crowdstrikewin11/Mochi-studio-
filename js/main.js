/**
 * Mochi Studio v20 — Main Application Controller
 * - Exact 1:1 Original GPU Analytic Quintic-Falloff Mochi Physics (128..192 mesh, 240Hz spring)
 * - Exact 1:1 Original Aspect-Matched Brush Tool (Sharp/Soft, Streamline 0.35, 1:1 Cursor & GPU Mask View)
 * - Exact 1:1 Original 2-Finger Zoom + Pan + Rotation + Auto-Hiding Reset View
 * - Exact 1:1 Original Synthesized Web Audio (Grab puff + Wobble-synced Release boing)
 * - Exact 1:1 Original Recording Preview Modal + OS Share Sheet + Adaptive 256-Color GIF Worker
 * - High-Resolution 2048px EXIF-Oriented Image Loader + Global Drag-Drop + WebGL2 Context Recovery
 * - Idle GPU Optimization (0% GPU draw when still) + Undo/Redo + Motion Sensors + 60/90/120/Custom FPS Video
 */

import {
  MochiPhysicsContinuum,
  zetaFromWobble,
  wobbleFromZeta,
} from './physics-continuum.js?v=20';
import { MochiRendererWebGL2 } from './renderer-webgl2.js?v=20';
import { BrushEngine } from './brush-engine.js?v=20';
import { MotionSensorManager } from './motion-sensors.js?v=20';
import { CameraHandTracker } from './camera-tracker.js?v=20';
import { SquishAudio } from './audio-squish.js?v=20';
import { EngineRecorder } from './engine-recorder.js?v=20';
import { getSample } from './samples.js?v=20';

const $ = (id) => document.getElementById(id);
const IMAGE_MAX_SIDE = 2048;

const state = {
  step: 'play', // 'image' | 'paint' | 'play'
  currentSample: 'bear',
  artworkSource: null,

  // Active pointers: Map<pointerId, { pxX, pxY, clientX, clientY, prevIsoX, prevIsoY, currIsoX, currIsoY, role, pointerType }>
  activeTouches: new Map(),
  gestureActive: false,
  brushPreviewTimer: 0,
  cursorVisible: false,

  // Idle GPU optimization flag (only redraw when something moved/changed!)
  needsRender: true,

  // Direct Engine Recording config & fixed-timestep accumulator
  recordFormat: 'video',     // 'video' | 'gif'
  videoFpsMode: '60',        // '60' | '90' | '120' | 'custom'
  customVideoFps: 144,       // 15 .. 240
  gifHighFpsEnabled: false,  // Optional up to 60 FPS GIF (false = classic 15 FPS)
  gifHighFps: 30,            // 15 .. 60
  recAccum: 0,
  recStopping: false,

  lastFrameTime: performance.now(),
};

const physics = new MochiPhysicsContinuum();
const glCanvas = $('glCanvas');
const overlayCanvas = $('overlayCanvas');
const overlayCtx = overlayCanvas.getContext('2d');
const stageWrap = $('stageWrap');
const brushCursorEl = $('brushCursor');
const brushPreviewEl = $('brushPreview');
const renderer = new MochiRendererWebGL2(glCanvas, physics);
const brush = new BrushEngine(512);
const motion = new MotionSensorManager();
const camera = new CameraHandTracker();
const audio = new SquishAudio();
const recorder = new EngineRecorder();

physics.maskSample = brush.sampleBlurred;

// ============================================================================
// Toast Banner
// ============================================================================
let toastTimer = null;
function hideToast() {
  clearTimeout(toastTimer);
  $('toast').classList.add('hidden');
}
function showToast(msg, duration = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), duration);
}

// ============================================================================
// EXIF-Aware, 2048px-Capped Image Decoder (matches original quality & safety)
// ============================================================================
async function decodeImageFallback(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeAndScaleImageBlob(blob) {
  if (!blob || !blob.type.startsWith('image/')) {
    throw new Error('Not an image file');
  }
  let bmp;
  if (blob.type === 'image/svg+xml' || typeof createImageBitmap !== 'function') {
    bmp = await decodeImageFallback(blob);
  } else {
    try {
      bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      bmp = await decodeImageFallback(blob);
    }
  }

  const nw = 'naturalWidth' in bmp ? bmp.naturalWidth : bmp.width;
  const nh = 'naturalHeight' in bmp ? bmp.naturalHeight : bmp.height;
  if (!nw || !nh) {
    if ('close' in bmp) bmp.close();
    throw new Error('Empty image');
  }

  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(nw, nh));
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  if ('close' in bmp) bmp.close();
  return out;
}

// ============================================================================
// Exact 1:1 Original Brush Cursor, Center Preview & Auto-Hide Reset View
// ============================================================================
function updateBrushCursorSize() {
  const r = Number.isFinite(brush.brushRadius) ? Math.max(0.01, Math.min(0.20, brush.brushRadius)) : 0.07;
  brush.brushRadius = r;
  const diam = Math.max(4, renderer.isoToCssLength(r * physics.S) * 2);
  brushCursorEl.style.width = `${diam}px`;
  brushCursorEl.style.height = `${diam}px`;
  brushPreviewEl.style.width = `${diam}px`;
  brushPreviewEl.style.height = `${diam}px`;
}

function updateBrushCursorClasses() {
  const isSoft = brush.brushType === 'soft';
  const isEraser = brush.erasing;
  brushCursorEl.classList.toggle('soft', isSoft && !isEraser);
  brushPreviewEl.classList.toggle('soft', isSoft && !isEraser);
  brushCursorEl.classList.toggle('eraser', isEraser);
  brushPreviewEl.classList.toggle('eraser', isEraser);
}

function syncBrushSizeSlider() {
  const slider = $('brushSize');
  const intVal = Math.max(10, Math.min(200, Math.round(brush.brushRadius * 1000)));
  slider.value = String(intVal);
  updateSliderFill(slider);
  updateBrushCursorSize();
}

function showBrushPreview(duration = 800) {
  if (state.step !== 'paint') return;
  updateBrushCursorSize();
  updateBrushCursorClasses();
  brushPreviewEl.classList.remove('hidden');
  brushCursorEl.classList.add('hidden');
  clearTimeout(state.brushPreviewTimer);
  state.brushPreviewTimer = setTimeout(() => hideBrushPreview(), duration);
}

function hideBrushPreview() {
  clearTimeout(state.brushPreviewTimer);
  brushPreviewEl.classList.add('hidden');
  if (state.step === 'paint' && state.cursorVisible && !state.gestureActive) {
    brushCursorEl.classList.remove('hidden');
  }
}

function moveBrushCursor(clientX, clientY) {
  const rect = stageWrap.getBoundingClientRect();
  brushCursorEl.style.left = `${clientX - rect.left}px`;
  brushCursorEl.style.top = `${clientY - rect.top}px`;
  updateBrushCursorSize();
  state.cursorVisible = true;
  if (state.step === 'paint' && brushPreviewEl.classList.contains('hidden') && !state.gestureActive) {
    brushCursorEl.classList.remove('hidden');
  }
}

function afterViewChange() {
  state.needsRender = true;
  updateBrushCursorSize();
  const showReset = state.step !== 'image' && renderer.isTransformed();
  $('btnResetView').classList.toggle('hidden', !showReset);
}

// ============================================================================
// 3-Step Workflow Navigation (1 Add -> 2 Paint -> 3 Play)
// ============================================================================
function setStep(nextStep) {
  if (nextStep !== 'play' && recorder.isRecording) {
    stopRecordingFlow();
  }
  hideToast();
  state.step = nextStep;
  document.querySelectorAll('.step-tab').forEach((btn) => {
    const active = btn.dataset.step === nextStep;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });

  $('panelImage').classList.toggle('hidden', nextStep !== 'image');
  $('dockPaint').classList.toggle('hidden', nextStep !== 'paint');
  $('paintHint').classList.toggle('hidden', nextStep !== 'paint');
  $('dockPlay').classList.toggle('hidden', nextStep !== 'play');

  state.activeTouches.clear();
  state.gestureActive = false;
  brush.cancelStroke();
  physics.resetPose();
  state.cursorVisible = false;
  brushCursorEl.classList.add('hidden');
  brushPreviewEl.classList.add('hidden');
  state.needsRender = true;

  camera.paused = nextStep !== 'play';
  updateCameraUI();

  if (nextStep === 'paint') {
    $('motionHud').classList.add('hidden');
    brush.dirty = true;
    syncBrushSizeSlider();
    showBrushPreview(900);
  } else if (nextStep === 'play') {
    if (!brush.hasAnyPaint()) {
      physics.maskEnabled = false;
      if (!state._suppressEmptyToast) {
        showToast('Nothing was painted, so the whole image is squishy', 2800);
      }
      state._suppressEmptyToast = false;
    } else {
      physics.maskEnabled = true;
      renderer.uploadMask(brush.textureSource());
    }
    updateMotionHud();
  }

  afterViewChange();
}

// ============================================================================
// Load Artwork (Sample, File Picker, Global Drag-Drop, or Ctrl+V Paste)
// ============================================================================
function loadArtwork(imgOrCanvas) {
  state.artworkSource = imgOrCanvas;
  const w = imgOrCanvas.naturalWidth || imgOrCanvas.width || 512;
  const h = imgOrCanvas.naturalHeight || imgOrCanvas.height || 512;
  const aspect = w / h;

  physics.setAspect(aspect);
  physics.updateArtworkAlphaSampler(imgOrCanvas);
  brush.setup(aspect);
  renderer.uploadTexture(imgOrCanvas);
  renderer.uploadMask(brush.canvas);
  renderer.resetView(false);
  physics.maskEnabled = false;
  afterViewChange();
}

function selectSample(key, goStep = null, silentToast = false) {
  state.currentSample = key;
  document.querySelectorAll('.sample-chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.sample === key);
  });
  const s = getSample(key);
  loadArtwork(s.art);
  if (silentToast) state._suppressEmptyToast = true;
  if (goStep) setStep(goStep);
}

function populateSampleThumbnails() {
  for (const key of ['bear', 'cat', 'pudding', 'bunny']) {
    const s = getSample(key);
    const thumb = $(`thumb-${key}`);
    if (thumb) {
      thumb.style.backgroundImage = `url(${s.art.toDataURL('image/png')})`;
    }
  }
}

async function handleImageBlob(blob) {
  if (!blob || !blob.type.startsWith('image/')) return;
  try {
    const scaledCanvas = await decodeAndScaleImageBlob(blob);
    document.querySelectorAll('.sample-chip').forEach((c) => c.classList.remove('active'));
    loadArtwork(scaledCanvas);
    setStep('paint');
    showToast('Paint squishy parts, or tap Play to make the whole image squishy!', 3000);
  } catch {
    showToast("Couldn't load the image — please try another file.", 3000);
  }
}

// ============================================================================
// Exact 1:1 Original 2-Finger Zoom + Pan + Rotation Handler
// ============================================================================
function handleTwoFingerGestureMove(e) {
  if (!state.activeTouches.has(e.pointerId)) return;
  const entries = Array.from(state.activeTouches.entries());
  if (entries.length < 2) return;

  const [id1, r1] = entries[0];
  const [id2, r2] = entries[1];
  const newPx = renderer.canvasPxFromClient(e.clientX, e.clientY);
  const p1Old = { x: r1.pxX, y: r1.pxY };
  const p2Old = { x: r2.pxX, y: r2.pxY };

  if (e.pointerId === id1) {
    renderer.applyGesture(p1Old, p2Old, newPx, p2Old);
    r1.pxX = newPx.x;
    r1.pxY = newPx.y;
  } else if (e.pointerId === id2) {
    renderer.applyGesture(p1Old, p2Old, p1Old, newPx);
    r2.pxX = newPx.x;
    r2.pxY = newPx.y;
  } else {
    return;
  }

  afterViewChange();
}

function paintAt(clientX, clientY) {
  const iso = renderer.isoFromClient(clientX, clientY);
  const uv = renderer.restUvFromIso(iso.x, iso.y);
  brush.strokeTo(uv.x, uv.y, physics.S);
  state.needsRender = true;
}

// ============================================================================
// Unified Pointer Events + ContextMenu / GestureStart Protection
// ============================================================================
glCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());

glCanvas.addEventListener('pointerdown', (e) => {
  if (state.step === 'image') return;
  e.preventDefault();
  try { glCanvas.setPointerCapture(e.pointerId); } catch {}
  const px = renderer.canvasPxFromClient(e.clientX, e.clientY);
  const iso = renderer.isoFromClient(e.clientX, e.clientY);

  if (state.step === 'play') {
    if (state.gestureActive) {
      state.activeTouches.set(e.pointerId, {
        pxX: px.x, pxY: px.y, clientX: e.clientX, clientY: e.clientY,
        prevIsoX: iso.x, prevIsoY: iso.y, currIsoX: iso.x, currIsoY: iso.y,
        role: 'bg', pointerType: e.pointerType,
      });
      return;
    }

    const grab = physics.tryGrab(e.pointerId, iso.x, iso.y);
    const role = grab ? 'grab' : 'bg';
    state.activeTouches.set(e.pointerId, {
      pxX: px.x, pxY: px.y, clientX: e.clientX, clientY: e.clientY,
      prevIsoX: iso.x, prevIsoY: iso.y, currIsoX: iso.x, currIsoY: iso.y,
      role, pointerType: e.pointerType,
    });

    if (grab) {
      audio.playGrab();
      state.needsRender = true;
    } else if (state.activeTouches.size >= 2) {
      // Exact original behavior: touching background with a 2nd finger enters 2-finger zoom/pan/rotate
      state.gestureActive = true;
      physics.releaseAllActive();
      state.needsRender = true;
    }
    return;
  }

  // PAINT MODE — Exact original 1-finger paint + lossless 2-finger zoom/pan/rotate cancellation
  if (!brushPreviewEl.classList.contains('hidden')) hideBrushPreview();
  state.activeTouches.set(e.pointerId, {
    pxX: px.x, pxY: px.y, clientX: e.clientX, clientY: e.clientY, role: 'paint',
  });

  if (state.activeTouches.size === 1 && !state.gestureActive) {
    brush.beginStroke();
    moveBrushCursor(e.clientX, e.clientY);
    paintAt(e.clientX, e.clientY);
  } else if (state.activeTouches.size === 2 && !state.gestureActive) {
    state.gestureActive = true;
    brush.cancelStroke();
    brushCursorEl.classList.add('hidden');
    state.needsRender = true;
  }
});

glCanvas.addEventListener('pointermove', (e) => {
  if (state.step === 'paint' && !state.gestureActive) {
    moveBrushCursor(e.clientX, e.clientY);
  }

  const rec = state.activeTouches.get(e.pointerId);
  if (!rec) return;
  rec.clientX = e.clientX;
  rec.clientY = e.clientY;

  if (state.gestureActive) {
    handleTwoFingerGestureMove(e);
    return;
  }

  const px = renderer.canvasPxFromClient(e.clientX, e.clientY);
  rec.pxX = px.x;
  rec.pxY = px.y;

  if (state.step === 'play') {
    if (rec.role === 'grab') {
      const iso = renderer.isoFromClient(e.clientX, e.clientY);
      rec.currIsoX = iso.x;
      rec.currIsoY = iso.y;
      if (!recorder.isRecording) {
        rec.prevIsoX = iso.x;
        rec.prevIsoY = iso.y;
        physics.move(e.pointerId, iso.x, iso.y);
      }
      state.needsRender = true;
    }
    return;
  }

  if (state.step === 'paint' && brush.isDrawing) {
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    const list = events && events.length > 0 ? events : [e];
    for (let i = 0; i < list.length; i++) {
      paintAt(list[i].clientX, list[i].clientY);
    }
  }
});

function handlePointerEnd(e) {
  const rec = state.activeTouches.get(e.pointerId);
  if (!state.activeTouches.delete(e.pointerId)) return;

  if (state.step === 'play') {
    if (state.gestureActive) {
      if (state.activeTouches.size === 0) state.gestureActive = false;
      return;
    }
    if (rec && rec.role === 'grab') {
      const g = physics.release(e.pointerId);
      if (g) {
        audio.playRelease(physics.intensityOf(g), physics.params.releaseFreq);
        state.needsRender = true;
      }
    }
    return;
  }

  if (state.step === 'paint') {
    if (!state.gestureActive && brush.isDrawing && state.activeTouches.size === 0) {
      brush.endStroke();
      state.needsRender = true;
    }
    if (state.activeTouches.size === 0) {
      state.gestureActive = false;
      if (e.pointerType === 'touch') {
        state.cursorVisible = false;
        brushCursorEl.classList.add('hidden');
      } else if (state.cursorVisible && brushPreviewEl.classList.contains('hidden')) {
        brushCursorEl.classList.remove('hidden');
      }
    }
  }
}

glCanvas.addEventListener('pointerup', handlePointerEnd);
glCanvas.addEventListener('pointercancel', handlePointerEnd);
glCanvas.addEventListener('pointerleave', () => {
  if (state.activeTouches.size === 0) {
    state.cursorVisible = false;
    brushCursorEl.classList.add('hidden');
  }
});

// Desktop wheel zoom anchored directly under mouse cursor
glCanvas.addEventListener('wheel', (e) => {
  if (state.step === 'image') return;
  e.preventDefault();
  const px = renderer.canvasPxFromClient(e.clientX, e.clientY);
  renderer.zoomAt(px.x, px.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  afterViewChange();
}, { passive: false });

// ============================================================================
// 2D Overlay Rendering (Desktop Pointer Ring in Play Mode)
// ============================================================================
let overlayHasDrawn = false;
function renderOverlay() {
  const showMouseDots = state.step === 'play' && state.activeTouches.size > 0;
  const showHandDots = state.step === 'play' && camera.enabled && !camera.paused && camera.handCursors.length > 0;
  if (!showMouseDots && !showHandDots && !overlayHasDrawn) return;

  const w = renderer.cssWidth;
  const h = renderer.cssHeight;
  const dpr = renderer.dpr;
  if (overlayCanvas.width !== Math.round(w * dpr) || overlayCanvas.height !== Math.round(h * dpr)) {
    overlayCanvas.width = Math.round(w * dpr);
    overlayCanvas.height = Math.round(h * dpr);
  }

  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  overlayCtx.clearRect(0, 0, w, h);
  overlayHasDrawn = false;

  if (showMouseDots) {
    const rect = glCanvas.getBoundingClientRect();
    for (const pt of state.activeTouches.values()) {
      if (pt.pointerType !== 'mouse') continue;
      const x = pt.clientX - rect.left;
      const y = pt.clientY - rect.top;
      overlayCtx.save();
      overlayCtx.beginPath();
      overlayCtx.arc(x, y, 11, 0, Math.PI * 2);
      overlayCtx.fillStyle = 'rgba(242, 132, 164, 0.14)';
      overlayCtx.fill();
      overlayCtx.lineWidth = 1.5;
      overlayCtx.strokeStyle = 'rgba(242, 132, 164, 0.55)';
      overlayCtx.stroke();
      overlayCtx.restore();
      overlayHasDrawn = true;
    }
  }

  if (showHandDots) {
    for (let i = 0; i < camera.handCursors.length; i++) {
      const hc = camera.handCursors[i];
      const x = hc.x * w;
      const y = hc.y * h;
      overlayCtx.save();
      overlayCtx.beginPath();
      overlayCtx.arc(x, y, hc.pinching ? 15 : 11, 0, Math.PI * 2);
      overlayCtx.fillStyle = hc.pinching ? 'rgba(255, 79, 134, 0.28)' : 'rgba(242, 132, 164, 0.12)';
      overlayCtx.fill();
      overlayCtx.lineWidth = hc.pinching ? 2.4 : 1.6;
      overlayCtx.strokeStyle = hc.pinching ? '#ff4f86' : 'rgba(242, 132, 164, 0.70)';
      overlayCtx.stroke();
      overlayCtx.restore();
      overlayHasDrawn = true;
    }
  }
}

// ============================================================================
// Main Loop (Idle GPU Optimization + Direct Engine-Stepped High-FPS Recording!)
// ============================================================================
function tick(now) {
  const dt = Math.min(0.05, Math.max(0.001, (now - state.lastFrameTime) / 1000));
  state.lastFrameTime = now;

  // Smooth Reset View animation
  if (renderer.stepViewAnimation()) {
    afterViewChange();
  }

  // Upload mask texture whenever dirty (unblurred in Paint mode, blurred in Play mode)
  if (brush.dirty) {
    renderer.uploadMask(state.step === 'paint' ? brush.canvas : brush.textureSource());
    brush.dirty = false;
    state.needsRender = true;
  }

  if (state.step === 'paint') {
    if (state.needsRender) {
      renderer.render(true);
      state.needsRender = false;
    }
  } else if (state.step === 'play') {
    if (camera.enabled && !camera.paused) {
      const previewCanvas = camera.showPreview ? $('camPreviewCanvas') : null;
      camera.update(now, previewCanvas);
      const badgeText = (now - camera.lastGestureTime < 900 && camera.lastGestureTime > 0)
        ? camera.lastGestureText
        : 'Wave hand';
      const badgeEl = $('camDirBadge');
      if (badgeEl.textContent !== badgeText) badgeEl.textContent = badgeText;
    }

    const mf = motion.getCombinedForce();
    const cf = camera.enabled && !camera.paused ? camera.consumeForce() : { gx: 0, gy: 0, ax: 0, ay: 0 };
    const gx = Math.max(-1.4, Math.min(1.4, mf.gx + cf.gx));
    const gy = Math.max(-1.4, Math.min(1.4, mf.gy + cf.gy));
    const ax = mf.ax + cf.ax;
    const ay = mf.ay + cf.ay;
    const hasForce = Math.abs(gx) > 1e-4 || Math.abs(gy) > 1e-4 || Math.abs(ax) > 1e-4 || Math.abs(ay) > 1e-4;
    physics.setMotionForce(gx, gy, ax, ay);

    if (motion.enabled || motion.virtualEnabled) {
      const dx = Math.max(-7, Math.min(7, gx * 7));
      const dy = Math.max(-7, Math.min(7, gy * 7));
      $('tiltDot').style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    }

    if (recorder.isRecording && !state.recStopping) {
      const targetFps = recorder.fps;
      const stepDt = 1.0 / targetFps;
      const theme = document.documentElement.getAttribute('data-theme') || 'light';
      state.recAccum += dt;

      if (targetFps >= 45) {
        let steps = Math.floor(state.recAccum / stepDt);
        if (steps > 8) {
          steps = 8;
          state.recAccum = 0;
        } else {
          state.recAccum -= steps * stepDt;
        }

        if (steps > 0) {
          for (let s = 1; s <= steps; s++) {
            const alpha = s / steps;
            for (const [pid, pt] of state.activeTouches.entries()) {
              if (pt.role === 'grab') {
                const ix = pt.prevIsoX + (pt.currIsoX - pt.prevIsoX) * alpha;
                const iy = pt.prevIsoY + (pt.currIsoY - pt.prevIsoY) * alpha;
                physics.move(pid, ix, iy);
              }
            }
            physics.step(stepDt);
            renderer.render(false);
            const res = recorder.pushEngineFrame(glCanvas, theme);
            if (res.limitReached) {
              stopRecordingFlow();
              break;
            }
          }
          for (const pt of state.activeTouches.values()) {
            if (pt.role === 'grab') {
              pt.prevIsoX = pt.currIsoX;
              pt.prevIsoY = pt.currIsoY;
            }
          }
        } else {
          renderer.render(false);
        }
      } else {
        for (const [pid, pt] of state.activeTouches.entries()) {
          if (pt.role === 'grab') {
            pt.prevIsoX = pt.currIsoX;
            pt.prevIsoY = pt.currIsoY;
            physics.move(pid, pt.currIsoX, pt.currIsoY);
          }
        }
        physics.step(dt);
        renderer.render(false);
        let captures = Math.floor(state.recAccum / stepDt);
        if (captures > 3) {
          captures = 3;
          state.recAccum = 0;
        } else {
          state.recAccum -= captures * stepDt;
        }
        for (let c = 0; c < captures; c++) {
          const res = recorder.pushEngineFrame(glCanvas, theme);
          if (res.limitReached) {
            stopRecordingFlow();
            break;
          }
        }
      }
      state.needsRender = false;

      const sec = Math.floor(recorder.getElapsedSeconds());
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      const tag = recorder.format === 'gif' ? `${recorder.fps} FPS GIF` : `${recorder.fps} FPS`;
      $('recTimer').textContent = `${mm}:${ss} • ${tag}`;
    } else {
      const wasActive = physics.active;
      if (wasActive || hasForce) {
        physics.step(dt);
        state.needsRender = true;
      }
      if (state.needsRender) {
        renderer.render(false);
        state.needsRender = false;
      }
    }
  } else if (state.needsRender) {
    renderer.render(false);
    state.needsRender = false;
  }

  renderOverlay();
  requestAnimationFrame(tick);
}

// ============================================================================
// Recording Preview Modal + OS Share Sheet + Download (1:1 Original UX!)
// ============================================================================
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);

const previewCtl = (() => {
  const modal = $('previewModal');
  const media = $('previewMedia');
  const metaEl = $('previewMeta');
  const btnShare = $('btnPreviewShare');
  const btnDownload = $('btnPreviewDownload');
  const noteEl = $('previewNote');

  let currentFile = null;
  let currentUrl = '';
  let canShareFile = false;

  const formatBytes = (b) => {
    if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
    return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  };

  const downloadFile = (file) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const shareFile = async (file, text) => {
    try {
      await navigator.share(text ? { files: [file], text } : { files: [file] });
    } catch (err) {
      if (err && err.name !== 'AbortError') {
        showToast("Couldn't open share sheet — try Download instead.", 2600);
      }
    }
  };

  const close = () => {
    modal.classList.add('hidden');
    media.replaceChildren();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = '';
    currentFile = null;
  };

  const back = () => {
    if (history.state && history.state.mochiPreview) {
      history.back();
    } else {
      close();
    }
  };

  window.addEventListener('popstate', () => {
    if (!modal.classList.contains('hidden')) close();
  });
  $('btnPreviewBack').addEventListener('click', back);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) back();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) back();
  });

  btnDownload.addEventListener('click', () => {
    if (!currentFile) return;
    if (isIOS && canShareFile) {
      shareFile(currentFile);
    } else {
      downloadFile(currentFile);
      showToast(`Saved ${currentFile.name}!`, 2200);
    }
  });

  btnShare.addEventListener('click', () => {
    if (!currentFile) return;
    if (canShareFile) {
      shareFile(currentFile, 'Made a squishy animation in Mochi Studio!');
    } else {
      downloadFile(currentFile);
      showToast('Downloaded — attach it anywhere to share!', 2600);
    }
  });

  return {
    show(result) {
      close();
      const file = result.file;
      if (!file) return;
      currentFile = file;
      currentUrl = URL.createObjectURL(file);
      const isVideo = file.type.startsWith('video/');

      if (isVideo) {
        const v = document.createElement('video');
        v.autoplay = true;
        v.loop = true;
        v.muted = true;
        v.playsInline = true;
        v.setAttribute('playsinline', '');
        v.src = currentUrl;
        v.addEventListener('click', () => v.play().catch(() => {}));
        media.replaceChildren(v);
      } else {
        const img = document.createElement('img');
        img.alt = 'Recorded squishy GIF';
        img.src = currentUrl;
        media.replaceChildren(img);
      }

      const fmtLabel = isVideo ? (file.type.includes('mp4') ? 'MP4' : 'WebM') : 'GIF';
      metaEl.textContent = `${result.fps} FPS ${fmtLabel} • ${formatBytes(file.size)}`;

      canShareFile = Boolean(navigator.canShare && navigator.canShare({ files: [file] }));
      btnShare.classList.toggle('hidden', !canShareFile);
      btnDownload.textContent = isIOS && canShareFile ? 'Save to Photos' : 'Download';

      if (isIOS) {
        noteEl.textContent = canShareFile
          ? 'Tap "Save to Photos" or "Share" to send straight to other apps.'
          : (isVideo ? 'Open in Safari to save videos to Photos.' : 'Long-press the GIF above to save it.');
      } else {
        noteEl.textContent = canShareFile
          ? 'Share directly to Discord, WhatsApp, X, or download the file.'
          : `${result.frames} engine frames captured cleanly — click Download to save.`;
      }

      modal.classList.remove('hidden');
      try { history.pushState({ mochiPreview: true }, ''); } catch {}
    },
  };
})();

// ============================================================================
// Direct Engine Video (60/90/120/Custom FPS) & Adaptive Worker GIF Recording
// ============================================================================
function getActiveRecordFps() {
  if (state.recordFormat === 'gif') {
    return state.gifHighFpsEnabled ? state.gifHighFps : 15;
  }
  if (state.videoFpsMode === 'custom') {
    return Math.max(15, Math.min(240, Math.round(state.customVideoFps || 60)));
  }
  return Number(state.videoFpsMode) || 60;
}

async function stopRecordingFlow() {
  if (!recorder.isRecording || state.recStopping) return;
  state.recStopping = true;
  $('recBadge').classList.add('hidden');
  $('btnRecord').classList.remove('recording');
  $('recLabel').textContent = 'Record';
  showToast(recorder.format === 'gif' ? 'Making adaptive 256-color GIF...' : 'Finalizing video...', 2400);

  try {
    const result = await recorder.stop();
    if (result && result.file && result.file.size > 0) {
      hideToast();
      previewCtl.show(result);
    } else {
      showToast('Recording was empty — try squishing for a moment!');
    }
  } catch {
    showToast('Could not finalize recording.');
  } finally {
    state.recStopping = false;
    state.recAccum = 0;
  }
}

async function toggleRecording() {
  if (recorder.isRecording) {
    await stopRecordingFlow();
    return;
  }
  if (state.recStopping) return;

  const fps = getActiveRecordFps();
  try {
    const info = await recorder.start({
      format: state.recordFormat,
      fps,
      glCanvas,
    });
    if (!info) return;
    state.recAccum = 0;
    $('recBadge').classList.remove('hidden');
    $('btnRecord').classList.add('recording');
    $('recLabel').textContent = 'Stop';
    const tag = state.recordFormat === 'gif' ? `${fps} FPS GIF` : `${fps} FPS`;
    $('recTimer').textContent = `00:00 • ${tag}`;
    showToast(info.message, 2200);
  } catch (err) {
    showToast(err.message || 'Could not start recording.');
  }
}

// ============================================================================
// Virtual Tilt Pad
// ============================================================================
function initVirtualPad() {
  const arena = $('vpadArena');
  const knob = $('vpadKnob');
  let activeId = null;

  const setKnob = (nx, ny) => {
    const r = arena.clientWidth * 0.36;
    knob.style.transform = `translate(calc(-50% + ${nx * r}px), calc(-50% + ${ny * r}px))`;
    motion.setVirtualTilt(nx, ny);
    state.needsRender = true;
  };

  const updateFromEvent = (e) => {
    const rect = arena.getBoundingClientRect();
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    const maxR = rect.width * 0.42;
    let dx = (e.clientX - cx) / maxR;
    let dy = (e.clientY - cy) / maxR;
    const mag = Math.hypot(dx, dy);
    if (mag > 1) { dx /= mag; dy /= mag; }
    setKnob(dx, dy);
  };

  arena.addEventListener('pointerdown', (e) => {
    arena.setPointerCapture(e.pointerId);
    activeId = e.pointerId;
    updateFromEvent(e);
  });
  arena.addEventListener('pointermove', (e) => {
    if (e.pointerId === activeId) updateFromEvent(e);
  });
  const endPad = (e) => {
    if (e.pointerId !== activeId) return;
    activeId = null;
    if (!$('chkVpadHold').checked) setKnob(0, 0);
  };
  arena.addEventListener('pointerup', endPad);
  arena.addEventListener('pointercancel', endPad);

  $('btnVpadShake').addEventListener('click', () => {
    physics.triggerJiggle(1.0);
    audio.playRelease(0.65, physics.params.releaseFreq);
    state.needsRender = true;
  });
  $('btnCloseVpad').addEventListener('click', () => setVirtualPadOpen(false));
}

function setVirtualPadOpen(open) {
  motion.virtualEnabled = open;
  $('virtualPad').classList.toggle('hidden', !open);
  $('optVpad').checked = open;
  if (!open) motion.setVirtualTilt(0, 0);
  updateMotionHud();
  state.needsRender = true;
}

function updateMotionHud() {
  const anyOn = (motion.enabled || motion.virtualEnabled) && state.step === 'play';
  $('motionHud').classList.toggle('hidden', !anyOn);
  $('btnSensors').classList.toggle('active', motion.enabled);
  $('btnSensorsLabel').textContent = motion.enabled ? 'Sensors' : 'Motion';
  $('motionHudText').textContent = motion.enabled ? 'Phone Tilt' : 'Virtual Tilt';
  $('btnCalibrate').classList.toggle('hidden', !motion.enabled);
}


function updateCameraUI() {
  const on = camera.enabled;
  const showPip = on && camera.showPreview && state.step === 'play';
  $('btnCamera').classList.toggle('active', on);
  $('btnCameraLabel').textContent = on ? 'Cam ON' : 'Camera';
  $('optCamera').checked = on;
  $('optCamPreview').checked = camera.showPreview;
  $('optCamMirror').checked = camera.mirror;
  $('optCamPinch').checked = camera.pinchGrabEnabled;
  $('camEngineAI').classList.toggle('active', camera.preferredEngine === 'ai');
  $('camEngineFlow').classList.toggle('active', camera.preferredEngine === 'flow');
  $('camEngineBadge').textContent = camera.getEngineBadge();
  $('cameraPip').classList.toggle('hidden', !showPip);
}

async function toggleCameraFlow() {
  const res = await camera.toggle();
  camera.paused = state.step !== 'play';
  updateCameraUI();
  if (res.message) showToast(res.message, 3000);
}

function updateSoundUI() {
  const on = audio.enabled && audio.volume > 0;
  $('svgSoundOn').classList.toggle('hidden', !on);
  $('svgSoundOff').classList.toggle('hidden', on);
  $('btnSound').classList.toggle('active', on);
  $('optVolume').value = on ? Math.round(audio.volume * 100) : 0;
  updateSliderFill($('optVolume'));
}

// ============================================================================
// UI Bindings + Global Drag-Drop + WebGL2 Context Recovery + ResizeObserver
// ============================================================================
function updateSliderFill(el) {
  if (!el) return;
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 100;
  const val = parseFloat(el.value) || 0;
  const pct = ((val - min) / Math.max(1e-6, max - min)) * 100;
  el.style.setProperty('--pct', `${pct}%`);
}

function refreshAllSliderFills() {
  document.querySelectorAll('input[type="range"]').forEach(updateSliderFill);
}

function syncSlidersFromPhysics() {
  const p = physics.params;
  $('optSoftness').value = String(physics.softness);
  $('optGrab').value = String(p.radius);
  $('optStretch').value = String(p.stretch);
  $('optWobbleSpeed').value = String(p.releaseFreq);
  $('optWobbles').value = String(wobbleFromZeta(p.releaseZeta));
  $('optPuffiness').value = String(p.bulge);
  $('optMotion').value = String(p.motion ?? 58);
  refreshAllSliderFills();
}

function wireGlobalFileInputs() {
  $('fileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) handleImageBlob(file);
    e.target.value = '';
  });

  // Global drag & drop works in Add, Paint, AND Play modes!
  const dropOverlay = $('dropOverlay');
  const dz = $('dropzone');
  const hasFiles = (e) => Boolean(e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files'));
  let dragDepth = 0;

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (hasFiles(e)) {
      dragDepth++;
      dropOverlay.classList.remove('hidden');
      dz.classList.add('dragover');
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropOverlay.classList.add('hidden');
      dz.classList.remove('dragover');
    }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.add('hidden');
    dz.classList.remove('dragover');
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleImageBlob(file);
  });

  // Global Ctrl+V paste
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) {
          e.preventDefault();
          handleImageBlob(f);
          return;
        }
      }
    }
  });
}

function wireUI() {
  const unlockAudio = () => audio.unlock();
  window.addEventListener('pointerup', unlockAudio, { once: true });
  window.addEventListener('touchend', unlockAudio, { once: true });

  // WebGL2 Context Lost / Restored recovery (prevents blank screen after switching mobile apps!)
  glCanvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
  });
  glCanvas.addEventListener('webglcontextrestored', () => {
    const maskSrc = state.step === 'paint' ? brush.canvas : brush.textureSource();
    if (renderer.restoreContext(maskSrc)) {
      state.needsRender = true;
      afterViewChange();
    }
  });

  // ResizeObserver on stageWrap (handles mobile browser address bar & orientation changes cleanly!)
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (renderer.resize()) afterViewChange();
    }).observe(stageWrap);
  }
  window.addEventListener('resize', () => {
    if (renderer.resize()) afterViewChange();
  });

  wireGlobalFileInputs();

  // 3-Step Tabs
  document.querySelectorAll('.step-tab').forEach((btn) => {
    btn.addEventListener('click', () => setStep(btn.dataset.step));
  });

  // Theme Toggle
  $('btnTheme').addEventListener('click', () => {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    $('iconMoon').classList.toggle('hidden', !isDark);
    $('iconSun').classList.toggle('hidden', isDark);
  });

  // Reset View
  $('btnResetView').addEventListener('click', () => {
    renderer.resetView(true);
    state.needsRender = true;
  });

  // Step 1: Add Image
  $('btnTrySample').addEventListener('click', () => selectSample(state.currentSample, 'play'));
  document.querySelectorAll('.sample-chip').forEach((chip) => {
    chip.addEventListener('click', () => selectSample(chip.dataset.sample, 'play'));
  });

  // Step 2: Paint Controls (Exact 1:1 Original MaskTool + Fixed Integer Size Slider + Undo/Redo)
  const setErasing = (erasing) => {
    brush.erasing = erasing;
    $('toolBrush').classList.toggle('active', !erasing);
    $('toolEraser').classList.toggle('active', erasing);
    showBrushPreview(700);
  };
  $('toolBrush').addEventListener('click', () => setErasing(false));
  $('toolEraser').addEventListener('click', () => setErasing(true));

  const setBrushType = (type) => {
    brush.brushType = type; // 'hard' | 'soft'
    $('edgeSharp').classList.toggle('active', type === 'hard');
    $('edgeSoft').classList.toggle('active', type === 'soft');
    showBrushPreview(800);
  };
  $('edgeSharp').addEventListener('click', () => setBrushType('hard'));
  $('edgeSoft').addEventListener('click', () => setBrushType('soft'));

  const handleBrushSizeChange = (e) => {
    const raw = parseFloat(e.target.value);
    if (!Number.isFinite(raw)) return;
    // Integer range 10..200 maps cleanly to 0.010..0.200 isotropic radius (never peanut-locked!)
    brush.brushRadius = Math.max(0.01, Math.min(0.20, raw / 1000));
    updateSliderFill(e.target);
    showBrushPreview(800);
  };
  $('brushSize').addEventListener('input', handleBrushSizeChange);
  $('brushSize').addEventListener('change', handleBrushSizeChange);

  $('btnUndo').addEventListener('click', () => {
    if (brush.undo()) state.needsRender = true;
  });
  $('btnRedo').addEventListener('click', () => {
    if (brush.redo()) state.needsRender = true;
  });
  $('btnClearMask').addEventListener('click', () => {
    brush.clear(true);
    state.needsRender = true;
    showToast('Cleared painted areas', 1800);
  });
  $('btnAllSquishy').addEventListener('click', () => {
    brush.fillAll(state.artworkSource, true);
    state.needsRender = true;
    showToast('Made whole character squishy!', 1800);
  });
  $('btnDonePaint').addEventListener('click', () => setStep('play'));

  brush.onHistoryChange = (canUndo, canRedo) => {
    $('btnUndo').disabled = !canUndo;
    $('btnRedo').disabled = !canRedo;
  };

  // Step 3: Play Controls
  $('btnPlayImage').addEventListener('click', () => setStep('image'));
  $('btnPlayPaint').addEventListener('click', () => setStep('paint'));
  $('btnSound').addEventListener('click', () => {
    audio.toggle();
    updateSoundUI();
  });
  $('btnRecord').addEventListener('click', toggleRecording);

  // Motion Sensors
  $('btnSensors').addEventListener('click', async () => {
    const res = await motion.toggleHardwareSensors();
    if (res.needsVirtual) setVirtualPadOpen(true);
    updateMotionHud();
    if (res.message) showToast(res.message, 3000);
  });
  $('btnCalibrate').addEventListener('click', () => {
    motion.calibrate();
    showToast('Neutral angle calibrated!', 1800);
  });
  $('btnHudJiggle').addEventListener('click', () => {
    physics.triggerJiggle(1.0);
    audio.playRelease(0.65, physics.params.releaseFreq);
    state.needsRender = true;
  });
  motion.onStatusChange = (msg) => showToast(msg, 3200);

  // Camera Hand Tracking Controls
  $('btnCamera').addEventListener('click', toggleCameraFlow);
  $('optCamera').addEventListener('change', async (e) => {
    if (e.target.checked !== camera.enabled) {
      await toggleCameraFlow();
    }
  });
  $('camEngineAI').addEventListener('click', () => {
    camera.setPreferredEngine('ai');
    updateCameraUI();
  });
  $('camEngineFlow').addEventListener('click', () => {
    camera.setPreferredEngine('flow');
    updateCameraUI();
  });
  $('optCamSens').addEventListener('input', (e) => {
    camera.sensitivity = Number(e.target.value);
    updateSliderFill(e.target);
  });
  $('optCamSmooth').addEventListener('input', (e) => {
    camera.setSmoothness(Number(e.target.value));
    updateSliderFill(e.target);
  });
  $('optCamBounce').addEventListener('change', (e) => {
    camera.bounceEnabled = e.target.checked;
  });
  $('optCamPinch').addEventListener('change', (e) => {
    camera.pinchGrabEnabled = e.target.checked;
    updateCameraUI();
  });
  $('optCamFollow').addEventListener('change', (e) => {
    camera.followEnabled = e.target.checked;
    if (!camera.followEnabled) state.needsRender = true;
  });

  // Mid-Air Pinch Grab callbacks (maps camera hand pinch directly into 1:1 mochi cheek grabs!)
  const camNormToIso = (nx, ny) => {
    const rect = glCanvas.getBoundingClientRect();
    return renderer.isoFromClient(rect.left + nx * rect.width, rect.top + ny * rect.height);
  };
  camera.onPinchStart = (slot, nx, ny) => {
    if (state.step !== 'play') return;
    const iso = camNormToIso(nx, ny);
    const g = physics.tryGrab(9000 + slot, iso.x, iso.y);
    if (g) {
      audio.playGrab();
      state.needsRender = true;
    }
  };
  camera.onPinchMove = (slot, nx, ny) => {
    if (state.step !== 'play') return;
    const iso = camNormToIso(nx, ny);
    physics.move(9000 + slot, iso.x, iso.y);
    state.needsRender = true;
  };
  camera.onPinchEnd = (slot) => {
    const g = physics.release(9000 + slot);
    if (g) {
      audio.playRelease(physics.intensityOf(g), physics.params.releaseFreq);
      state.needsRender = true;
    }
  };
  camera.onEngineChange = (_eng, msg) => {
    updateCameraUI();
    if (msg) showToast(msg, 2800);
  };
  $('optCamPreview').addEventListener('change', (e) => {
    camera.showPreview = e.target.checked;
    updateCameraUI();
  });
  $('optCamMirror').addEventListener('change', (e) => {
    camera.mirror = e.target.checked;
  });

  $('btnCamFlip').addEventListener('click', async () => {
    const res = await camera.flipCamera();
    updateCameraUI();
    showToast(camera.facingMode === 'user' ? 'Switched to Front Camera' : 'Switched to Back Camera', 1800);
  });
  $('btnCamHide').addEventListener('click', () => {
    camera.showPreview = false;
    updateCameraUI();
    showToast('Camera preview hidden (still tracking!)', 2000);
  });
  $('btnCamClose').addEventListener('click', () => {
    camera.stop();
    updateCameraUI();
    showToast('Camera tracking turned off', 1800);
  });

  camera.onGestureBounce = (intensity) => {
    audio.playRelease(Math.min(0.85, 0.25 + intensity * 0.6), physics.params.releaseFreq);
    state.needsRender = true;
  };

  window.addEventListener('pagehide', () => {
    if (camera.enabled) camera.stop();
  });

  // Settings Bottom Sheet
  const openSettings = (open) => {
    $('settingsBackdrop').classList.toggle('hidden', !open);
    $('settingsSheet').classList.toggle('hidden', !open);
    if (open) refreshAllSliderFills();
  };
  $('btnSettings').addEventListener('click', () => openSettings(true));
  $('btnCloseSettings').addEventListener('click', () => openSettings(false));
  $('settingsBackdrop').addEventListener('click', () => openSettings(false));

  $('btnFineTune').addEventListener('click', () => {
    const box = $('fineTuneBox');
    const willOpen = box.classList.contains('hidden');
    box.classList.toggle('hidden', !willOpen);
    $('fineTuneArrow').textContent = willOpen ? '▾' : '▸';
    $('btnFineTune').setAttribute('aria-expanded', String(willOpen));
    if (willOpen) refreshAllSliderFills();
  });

  document.querySelectorAll('.preset-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      physics.applyPreset(pill.dataset.preset);
      syncSlidersFromPhysics();
      document.querySelectorAll('.preset-pill').forEach((p) => p.classList.toggle('active', p === pill));
      physics.triggerJiggle(0.55);
      state.needsRender = true;
    });
  });

  $('optSoftness').addEventListener('input', (e) => {
    physics.setSoftness(parseFloat(e.target.value));
    syncSlidersFromPhysics();
    document.querySelectorAll('.preset-pill').forEach((p) => p.classList.remove('active'));
    state.needsRender = true;
  });

  const bindFloat = (id, fn) => {
    $(id).addEventListener('input', (e) => {
      fn(parseFloat(e.target.value));
      updateSliderFill(e.target);
      document.querySelectorAll('.preset-pill').forEach((p) => p.classList.remove('active'));
      state.needsRender = true;
    });
  };
  bindFloat('optGrab', (v) => physics.setParams({ radius: v }));
  bindFloat('optStretch', (v) => physics.setParams({ stretch: v }));
  bindFloat('optWobbleSpeed', (v) => physics.setParams({ releaseFreq: v }));
  bindFloat('optWobbles', (v) => physics.setParams({ releaseZeta: zetaFromWobble(v) }));
  bindFloat('optPuffiness', (v) => physics.setParams({ bulge: v }));
  bindFloat('optMotion', (v) => physics.setParams({ motion: v }));

  $('optMotionTilt').addEventListener('change', (e) => { motion.tiltEnabled = e.target.checked; });
  $('optMotionShake').addEventListener('change', (e) => { motion.shakeEnabled = e.target.checked; });
  $('optShading').addEventListener('change', (e) => {
    renderer.shadingEnabled = e.target.checked;
    state.needsRender = true;
  });
  $('optVpad').addEventListener('change', (e) => setVirtualPadOpen(e.target.checked));
  $('btnTestJiggle').addEventListener('click', () => {
    physics.triggerJiggle(1.0);
    audio.playRelease(0.65, physics.params.releaseFreq);
    state.needsRender = true;
  });

  $('btnResetPhysics').addEventListener('click', () => {
    physics.applyPreset('real');
    syncSlidersFromPhysics();
    document.querySelectorAll('.preset-pill').forEach((p) => {
      p.classList.toggle('active', p.dataset.preset === 'real');
    });
    state.needsRender = true;
    showToast('Reset to original mochi feel', 1800);
  });

  $('optVolume').addEventListener('input', (e) => {
    audio.setVolume(Number(e.target.value) / 100);
    updateSoundUI();
    updateSliderFill(e.target);
  });

  const updateGifNote = () => {
    const el = $('gifRecordNote');
    if (!state.gifHighFpsEnabled) {
      el.textContent = 'Adaptive 256-color 15 FPS GIF encoded in a Web Worker (up to 6s).';
    } else if (state.gifHighFps > 50) {
      el.textContent = `${state.gifHighFps} FPS adaptive GIF (up to 4s; uses 20ms GIF89a floor for universal browser playback).`;
    } else {
      const secs = state.gifHighFps > 30 ? 4 : 6;
      el.textContent = `Smooth ${state.gifHighFps} FPS adaptive 256-color GIF encoded in a Web Worker (up to ${secs}s).`;
    }
  };

  const setRecMode = (mode) => {
    state.recordFormat = mode;
    $('recModeVideo').classList.toggle('active', mode === 'video');
    $('recModeGif').classList.toggle('active', mode === 'gif');
    $('recVideoOpts').classList.toggle('hidden', mode !== 'video');
    $('recGifOpts').classList.toggle('hidden', mode !== 'gif');
    refreshAllSliderFills();
  };
  $('recModeVideo').addEventListener('click', () => setRecMode('video'));
  $('recModeGif').addEventListener('click', () => setRecMode('gif'));

  document.querySelectorAll('#videoFpsPills .fps-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      state.videoFpsMode = pill.dataset.fps;
      document.querySelectorAll('#videoFpsPills .fps-pill').forEach((p) => {
        p.classList.toggle('active', p === pill);
      });
      $('customFpsRow').classList.toggle('hidden', state.videoFpsMode !== 'custom');
      refreshAllSliderFills();
    });
  });

  const setCustomVideoFps = (val) => {
    const clamped = Math.max(15, Math.min(240, Math.round(Number(val) || 60)));
    state.customVideoFps = clamped;
    $('optCustomFps').value = clamped;
    $('numCustomFps').value = clamped;
    updateSliderFill($('optCustomFps'));
  };
  $('optCustomFps').addEventListener('input', (e) => setCustomVideoFps(e.target.value));
  $('numCustomFps').addEventListener('change', (e) => setCustomVideoFps(e.target.value));

  $('optGifHighFps').addEventListener('change', (e) => {
    state.gifHighFpsEnabled = e.target.checked;
    $('gifFpsRow').classList.toggle('hidden', !state.gifHighFpsEnabled);
    updateGifNote();
    refreshAllSliderFills();
  });

  const setGifFps = (val) => {
    const clamped = Math.max(15, Math.min(60, Math.round(Number(val) || 30)));
    state.gifHighFps = clamped;
    $('optGifFps').value = clamped;
    $('valGifFps').textContent = `${clamped} FPS`;
    updateSliderFill($('optGifFps'));
    document.querySelectorAll('#gifFpsPills .fps-pill').forEach((p) => {
      p.classList.toggle('active', Number(p.dataset.gfps) === clamped);
    });
    updateGifNote();
  };
  document.querySelectorAll('#gifFpsPills .fps-pill').forEach((pill) => {
    pill.addEventListener('click', () => setGifFps(pill.dataset.gfps));
  });
  $('optGifFps').addEventListener('input', (e) => setGifFps(e.target.value));
  updateGifNote();
}

// ============================================================================
// Bootstrap
// ============================================================================
async function boot() {
  try {
    await renderer.init();
  } catch (err) {
    $('fatalCard').classList.remove('hidden');
    showToast(err.message, 6000);
    return;
  }

  populateSampleThumbnails();
  wireUI();
  initVirtualPad();
  syncSlidersFromPhysics();
  syncBrushSizeSlider();
  updateSoundUI();
  updateCameraUI();
  refreshAllSliderFills();

  selectSample('bear', 'play', true);
  requestAnimationFrame(tick);
}

boot();
