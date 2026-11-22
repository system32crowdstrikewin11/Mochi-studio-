/**
 * Mochi Studio v16 — Main Application Controller
 * - Exact 1:1 Original GPU Analytic Quintic-Falloff Mochi Physics (128..192 mesh, 240Hz spring)
 * - Exact 1:1 Original Synthesized Web Audio (Grab puff + Wobble-synced Release boing)
 * - Zero-Lag Spotlight-Reveal Brush (Sharp / Soft, Undo / Redo, Zoom-adaptive Size)
 * - Smooth 2-finger Pinch-Zoom & Pan in BOTH Paint & Play Modes
 * - Optional Phone Motion Sensors (Tilt gravity + Shake jiggle) + Virtual Tilt Pad
 * - Direct Engine Video Recording (60 / 90 / 120 / Custom FPS) & Optional High-FPS GIF (up to 60 FPS)
 */

import {
  MochiPhysicsContinuum,
  zetaFromWobble,
  wobbleFromZeta,
} from './physics-continuum.js';
import { MochiRendererWebGL2 } from './renderer-webgl2.js';
import { BrushEngine } from './brush-engine.js';
import { MotionSensorManager } from './motion-sensors.js';
import { SquishAudio } from './audio-squish.js';
import { EngineRecorder } from './engine-recorder.js';
import { getSample, fullSquishyMask } from './samples.js';

const $ = (id) => document.getElementById(id);

const state = {
  step: 'play', // 'image' | 'paint' | 'play'
  currentSample: 'bear',
  artworkSource: null,

  // Active pointers: Map<pointerId, { clientX, clientY, prevIsoX, prevIsoY, currIsoX, currIsoY, role, pointerType }>
  activeTouches: new Map(),
  pinchState: null,
  sizePreviewTimer: null,

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
const renderer = new MochiRendererWebGL2(glCanvas, physics);
const brush = new BrushEngine(512);
const motion = new MotionSensorManager();
const audio = new SquishAudio();
const recorder = new EngineRecorder();

// Connect physics mask sampler to BrushEngine's exact blurred mask
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
  $('btnResetView').classList.toggle('hidden', nextStep === 'image');

  state.activeTouches.clear();
  state.pinchState = null;
  brush.cancelStroke();
  physics.resetPose();

  if (nextStep === 'paint') {
    $('motionHud').classList.add('hidden');
    brush.markPreviewDirty();
    showCenterBrushPreview(1100);
  } else if (nextStep === 'play') {
    if (!brush.hasAnyPaint()) {
      physics.maskEnabled = false;
      if (!state._suppressEmptyToast) {
        showToast('Nothing was painted, so the whole image is squishy', 2800);
      }
      state._suppressEmptyToast = false;
    } else {
      physics.maskEnabled = true;
      renderer.uploadMask(brush.getBlurredMaskCanvas());
    }
    brush.cursor.visible = false;
    updateMotionHud();
  }
}

// ============================================================================
// Load Artwork (Sample, File Picker, Drag-Drop, or Ctrl+V Paste)
// ============================================================================
function loadArtwork(imgOrCanvas) {
  state.artworkSource = imgOrCanvas;
  const w = imgOrCanvas.naturalWidth || imgOrCanvas.width || 512;
  const h = imgOrCanvas.naturalHeight || imgOrCanvas.height || 512;
  const aspect = w / h;

  physics.setAspect(aspect);
  physics.updateArtworkAlphaSampler(imgOrCanvas);
  brush.setArtworkSource(imgOrCanvas);
  renderer.uploadTexture(imgOrCanvas);
  renderer.resetView();

  brush.resetHistory();
  brush.clear(false);
  physics.maskEnabled = false;
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

function handleImageBlob(blob) {
  if (!blob || !blob.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      document.querySelectorAll('.sample-chip').forEach((c) => c.classList.remove('active'));
      loadArtwork(img);
      setStep('paint');
      showToast('Paint squishy parts, or tap Play to make the whole image squishy!', 3000);
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(blob);
}

// ============================================================================
// 2-Finger Pinch-Zoom & Pan (Works in BOTH Paint Mode AND Play Mode!)
// ============================================================================
function getPinchPointers() {
  if (state.step === 'paint') {
    return Array.from(state.activeTouches.values());
  }
  return Array.from(state.activeTouches.values()).filter((p) => p.role === 'bg');
}

function startTwoFingerPinch() {
  const pts = getPinchPointers();
  if (pts.length < 2) return;
  const [p1, p2] = pts;
  const midClientX = (p1.clientX + p2.clientX) * 0.5;
  const midClientY = (p1.clientY + p2.clientY) * 0.5;
  const dist = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);
  const anchorIso = renderer.isoFromClient(midClientX, midClientY);

  state.pinchState = {
    startDist: Math.max(12, dist),
    startZoom: renderer.zoom,
    anchorIsoX: anchorIso.x,
    anchorIsoY: anchorIso.y,
  };
}

function updateTwoFingerPinch() {
  const pts = getPinchPointers();
  if (pts.length < 2 || !state.pinchState) return;
  const [p1, p2] = pts;
  const midClientX = (p1.clientX + p2.clientX) * 0.5;
  const midClientY = (p1.clientY + p2.clientY) * 0.5;
  const dist = Math.hypot(p2.clientX - p1.clientX, p2.clientY - p1.clientY);

  const newZoom = state.pinchState.startZoom * (dist / state.pinchState.startDist);
  const midPx = renderer.canvasPxFromClient(midClientX, midClientY);
  renderer.setViewAnchored(newZoom, state.pinchState.anchorIsoX, state.pinchState.anchorIsoY, midPx.x, midPx.y);
}

/** Convert current screen-space brush radius (CSS px) into mask-canvas pixels for zoom-adaptive precision */
function getCurrentMaskRadius() {
  const topLeft = renderer.screenFromIso(0, 0);
  const botRight = renderer.screenFromIso(renderer.aspect, 1);
  const drawW = Math.max(24, botRight.x - topLeft.x);
  return (brush.screenRadius / drawW) * brush.maskSize;
}

function showCenterBrushPreview(duration = 700) {
  clearTimeout(state.sizePreviewTimer);
  brush.cursor = {
    visible: state.step === 'paint',
    x: renderer.cssWidth * 0.5,
    y: renderer.cssHeight * 0.44,
    screenRadius: brush.screenRadius,
    isSizePreview: true,
  };
  if (duration > 0) {
    state.sizePreviewTimer = setTimeout(() => {
      if (brush.cursor.isSizePreview && !brush.isDrawing) {
        brush.cursor.visible = false;
      }
    }, duration);
  }
}

function updateBrushCursor(clientX, clientY) {
  clearTimeout(state.sizePreviewTimer);
  const rect = glCanvas.getBoundingClientRect();
  brush.cursor = {
    visible: state.step === 'paint' && state.activeTouches.size <= 1,
    x: clientX - rect.left,
    y: clientY - rect.top,
    screenRadius: brush.screenRadius,
    isSizePreview: false,
  };
}

// ============================================================================
// Unified Pointer Events
// ============================================================================
glCanvas.addEventListener('pointerdown', (e) => {
  if (state.step === 'image') return;
  try { glCanvas.setPointerCapture(e.pointerId); } catch {}
  const iso = renderer.isoFromClient(e.clientX, e.clientY);

  if (state.step === 'play') {
    const grab = physics.tryGrab(e.pointerId, iso.x, iso.y);
    const role = grab ? 'grab' : 'bg';
    state.activeTouches.set(e.pointerId, {
      clientX: e.clientX,
      clientY: e.clientY,
      prevIsoX: iso.x,
      prevIsoY: iso.y,
      currIsoX: iso.x,
      currIsoY: iso.y,
      role,
      pointerType: e.pointerType,
    });

    if (grab) {
      audio.playGrab();
    } else if (getPinchPointers().length >= 2) {
      physics.releaseAllActive();
      startTwoFingerPinch();
    }
    return;
  }

  // PAINT MODE — Instant zero-lag stroke start + lossless 2-finger pinch cancellation
  state.activeTouches.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY, role: 'paint' });

  if (state.activeTouches.size >= 2) {
    if (brush.isDrawing) {
      if (brush.shouldCancelForPinch()) {
        brush.cancelStroke();
      } else {
        brush.endStroke();
      }
    }
    brush.cursor.visible = false;
    startTwoFingerPinch();
    return;
  }

  updateBrushCursor(e.clientX, e.clientY);
  const uv = renderer.restUvFromIso(iso.x, iso.y);
  const m = brush.uvToMask(Math.min(1, Math.max(0, uv.x)), Math.min(1, Math.max(0, uv.y)));
  brush.beginStroke(m.x, m.y, getCurrentMaskRadius());
});

glCanvas.addEventListener('pointermove', (e) => {
  if (state.step === 'paint') updateBrushCursor(e.clientX, e.clientY);

  const rec = state.activeTouches.get(e.pointerId);
  if (!rec) return;
  rec.clientX = e.clientX;
  rec.clientY = e.clientY;

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
    } else if (getPinchPointers().length >= 2) {
      updateTwoFingerPinch();
    }
    return;
  }

  if (state.step === 'paint') {
    if (state.activeTouches.size >= 2) {
      updateTwoFingerPinch();
      return;
    }
    if (brush.isDrawing) {
      const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
      const list = events && events.length > 0 ? events : [e];
      for (let i = 0; i < list.length; i++) {
        const ce = list[i];
        const cIso = renderer.isoFromClient(ce.clientX, ce.clientY);
        const uv = renderer.restUvFromIso(cIso.x, cIso.y);
        const cm = brush.uvToMask(Math.min(1, Math.max(0, uv.x)), Math.min(1, Math.max(0, uv.y)));
        brush.moveStroke(cm.x, cm.y);
      }
    }
  }
});

function handlePointerEnd(e) {
  const rec = state.activeTouches.get(e.pointerId);
  state.activeTouches.delete(e.pointerId);

  if (state.step === 'play') {
    if (rec && rec.role === 'grab') {
      const g = physics.release(e.pointerId);
      if (g) {
        audio.playRelease(physics.intensityOf(g), physics.params.releaseFreq);
      }
    }
    if (getPinchPointers().length < 2) {
      state.pinchState = null;
    }
    return;
  }

  if (state.step === 'paint') {
    if (brush.isDrawing && state.activeTouches.size === 0) {
      brush.endStroke();
    }
    if (state.activeTouches.size === 0 && e.pointerType === 'touch') {
      brush.cursor.visible = false;
    }
    if (state.activeTouches.size < 2) {
      state.pinchState = null;
    }
  }
}

glCanvas.addEventListener('pointerup', handlePointerEnd);
glCanvas.addEventListener('pointercancel', handlePointerEnd);
glCanvas.addEventListener('pointerleave', () => {
  if (state.activeTouches.size === 0) brush.cursor.visible = false;
});

// Desktop wheel zoom anchored directly under mouse cursor
glCanvas.addEventListener('wheel', (e) => {
  if (state.step === 'image') return;
  e.preventDefault();
  const anchorIso = renderer.isoFromClient(e.clientX, e.clientY);
  const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
  const px = renderer.canvasPxFromClient(e.clientX, e.clientY);
  renderer.setViewAnchored(renderer.zoom * factor, anchorIso.x, anchorIso.y, px.x, px.y);
}, { passive: false });

// ============================================================================
// 2D Overlay Rendering (Paint Mask Spotlight-Reveal & Cursor Ring)
// ============================================================================
function renderOverlay() {
  const w = renderer.cssWidth;
  const h = renderer.cssHeight;
  const dpr = renderer.dpr;
  if (overlayCanvas.width !== Math.round(w * dpr) || overlayCanvas.height !== Math.round(h * dpr)) {
    overlayCanvas.width = Math.round(w * dpr);
    overlayCanvas.height = Math.round(h * dpr);
  }

  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  overlayCtx.clearRect(0, 0, w, h);

  if (state.step === 'paint') {
    const theme = document.documentElement.getAttribute('data-theme') || 'light';
    const topLeft = renderer.screenFromIso(0, 0);
    const botRight = renderer.screenFromIso(renderer.aspect, 1);
    const drawW = botRight.x - topLeft.x;
    const drawH = botRight.y - topLeft.y;
    overlayCtx.imageSmoothingEnabled = true;
    overlayCtx.drawImage(brush.getPreviewCanvas(theme), topLeft.x, topLeft.y, drawW, drawH);

    if (brush.cursor.visible) {
      const { x, y, screenRadius } = brush.cursor;
      overlayCtx.save();
      overlayCtx.beginPath();
      overlayCtx.arc(x, y, screenRadius, 0, Math.PI * 2);
      if (brush.tool === 'eraser') {
        overlayCtx.strokeStyle = '#eb6b92';
        overlayCtx.lineWidth = 1.8;
        overlayCtx.setLineDash([5, 4]);
        overlayCtx.stroke();
        overlayCtx.fillStyle = 'rgba(255, 255, 255, 0.16)';
        overlayCtx.fill();
      } else {
        overlayCtx.strokeStyle = '#eb6b92';
        overlayCtx.lineWidth = 1.8;
        overlayCtx.stroke();
        overlayCtx.fillStyle = 'rgba(242, 132, 164, 0.14)';
        overlayCtx.fill();
      }
      overlayCtx.restore();
    }
  } else if (state.step === 'play' && state.activeTouches.size > 0) {
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
    }
  }
}

// ============================================================================
// Main Loop (with Direct Engine-Stepped High-FPS Recording Pipeline!)
// ============================================================================
function tick(now) {
  const dt = Math.min(0.05, Math.max(0.001, (now - state.lastFrameTime) / 1000));
  state.lastFrameTime = now;

  if (state.step === 'play') {
    const f = motion.getCombinedForce();
    physics.setMotionForce(f.gx, f.gy, f.ax, f.ay);

    if (motion.enabled || motion.virtualEnabled) {
      const dx = Math.max(-7, Math.min(7, f.gx * 7));
      const dy = Math.max(-7, Math.min(7, f.gy * 7));
      $('tiltDot').style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    }

    if (recorder.isRecording && !state.recStopping) {
      const targetFps = recorder.fps;
      const stepDt = 1.0 / targetFps;
      const theme = document.documentElement.getAttribute('data-theme') || 'light';
      state.recAccum += dt;

      if (targetFps >= 45) {
        // High-FPS Engine Lock (60 / 90 / 120 / Custom >= 45 FPS) with sub-frame finger interpolation
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
            renderer.render();
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
          renderer.render();
        }
      } else {
        // Lower-FPS Engine Capture (15/24/30 FPS GIF or <45 FPS Custom Video)
        for (const [pid, pt] of state.activeTouches.entries()) {
          if (pt.role === 'grab') {
            pt.prevIsoX = pt.currIsoX;
            pt.prevIsoY = pt.currIsoY;
            physics.move(pid, pt.currIsoX, pt.currIsoY);
          }
        }
        physics.step(dt);
        renderer.render();
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

      const sec = Math.floor(recorder.getElapsedSeconds());
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      const tag = recorder.format === 'gif' ? `${recorder.fps} FPS GIF` : `${recorder.fps} FPS`;
      $('recTimer').textContent = `${mm}:${ss} • ${tag}`;
    } else {
      physics.step(dt);
      renderer.render();
    }
  } else {
    renderer.render();
  }

  renderOverlay();
  requestAnimationFrame(tick);
}

// ============================================================================
// Direct Engine Video (60/90/120/Custom FPS) & Optional High-FPS GIF Recording
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

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function stopRecordingFlow() {
  if (!recorder.isRecording || state.recStopping) return;
  state.recStopping = true;
  $('recBadge').classList.add('hidden');
  $('btnRecord').classList.remove('recording');
  $('recLabel').textContent = 'Record';
  showToast(recorder.format === 'gif' ? 'Finalizing GIF...' : 'Finalizing video...', 1800);

  try {
    const result = await recorder.stop();
    if (result && result.blob && result.blob.size > 0) {
      downloadBlob(result.blob, result.filename);
      const label = result.format === 'gif'
        ? `Saved ${result.fps} FPS GIF (${result.frames} frames)!`
        : `Saved ${result.fps} FPS video (${result.frames} engine frames)!`;
      showToast(label, 3000);
    } else {
      showToast('Recording was empty — try squishing for a moment!');
    }
  } catch {
    showToast('Could not save recording.');
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
  });
  $('btnCloseVpad').addEventListener('click', () => setVirtualPadOpen(false));
}

function setVirtualPadOpen(open) {
  motion.virtualEnabled = open;
  $('virtualPad').classList.toggle('hidden', !open);
  $('optVpad').checked = open;
  if (!open) motion.setVirtualTilt(0, 0);
  updateMotionHud();
}

function updateMotionHud() {
  const anyOn = (motion.enabled || motion.virtualEnabled) && state.step === 'play';
  $('motionHud').classList.toggle('hidden', !anyOn);
  $('btnSensors').classList.toggle('active', motion.enabled);
  $('btnSensorsLabel').textContent = motion.enabled ? 'Sensors' : 'Motion';
  $('motionHudText').textContent = motion.enabled ? 'Phone Tilt' : 'Virtual Tilt';
  $('btnCalibrate').classList.toggle('hidden', !motion.enabled);
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
// UI Bindings
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

function wireUI() {
  // Unlock Web Audio cleanly on first user interaction (mobile Safari/Chrome requirement)
  const unlockAudio = () => audio.unlock();
  window.addEventListener('pointerup', unlockAudio, { once: true });
  window.addEventListener('touchend', unlockAudio, { once: true });

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
    brush.markPreviewDirty();
  });

  // Reset View
  $('btnResetView').addEventListener('click', () => renderer.resetView());

  // Step 1: Add Image
  $('btnTrySample').addEventListener('click', () => selectSample(state.currentSample, 'play'));
  document.querySelectorAll('.sample-chip').forEach((chip) => {
    chip.addEventListener('click', () => selectSample(chip.dataset.sample, 'play'));
  });
  $('fileInput').addEventListener('change', (e) => {
    handleImageBlob(e.target.files[0]);
    e.target.value = '';
  });

  const dz = $('dropzone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    handleImageBlob(e.dataTransfer.files[0]);
  });

  // Global Ctrl+V clipboard image paste
  window.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        handleImageBlob(item.getAsFile());
        break;
      }
    }
  });

  // Step 2: Paint Controls
  const setTool = (t) => {
    brush.tool = t;
    $('toolBrush').classList.toggle('active', t === 'brush');
    $('toolEraser').classList.toggle('active', t === 'eraser');
    showCenterBrushPreview(550);
  };
  $('toolBrush').addEventListener('click', () => setTool('brush'));
  $('toolEraser').addEventListener('click', () => setTool('eraser'));

  const setEdge = (edge) => {
    brush.edge = edge;
    $('edgeSharp').classList.toggle('active', edge === 'sharp');
    $('edgeSoft').classList.toggle('active', edge === 'soft');
  };
  $('edgeSharp').addEventListener('click', () => setEdge('sharp'));
  $('edgeSoft').addEventListener('click', () => setEdge('soft'));

  $('brushSize').addEventListener('input', (e) => {
    brush.screenRadius = Number(e.target.value);
    updateSliderFill(e.target);
    showCenterBrushPreview(650);
  });

  $('btnUndo').addEventListener('click', () => brush.undo());
  $('btnRedo').addEventListener('click', () => brush.redo());
  $('btnClearMask').addEventListener('click', () => {
    brush.clear(true);
    showToast('Cleared painted areas', 1800);
  });
  $('btnAllSquishy').addEventListener('click', () => {
    if (!state.artworkSource) return;
    const all = fullSquishyMask(state.artworkSource, 512);
    brush.setMaskFromCanvas(all, true);
    showToast('Made whole character squishy!', 1800);
  });
  $('btnDonePaint').addEventListener('click', () => setStep('play'));

  brush.onHistoryChange = (canUndo, canRedo) => {
    $('btnUndo').disabled = !canUndo;
    $('btnRedo').disabled = !canRedo;
  };
  brush.onMaskCommit = (blurredCanvas) => {
    renderer.uploadMask(blurredCanvas);
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
  });
  motion.onStatusChange = (msg) => showToast(msg, 3200);

  // Settings Bottom Sheet
  const openSettings = (open) => {
    $('settingsBackdrop').classList.toggle('hidden', !open);
    $('settingsSheet').classList.toggle('hidden', !open);
    if (open) refreshAllSliderFills();
  };
  $('btnSettings').addEventListener('click', () => openSettings(true));
  $('btnCloseSettings').addEventListener('click', () => openSettings(false));
  $('settingsBackdrop').addEventListener('click', () => openSettings(false));

  // Collapsible Fine-tune
  $('btnFineTune').addEventListener('click', () => {
    const box = $('fineTuneBox');
    const willOpen = box.classList.contains('hidden');
    box.classList.toggle('hidden', !willOpen);
    $('fineTuneArrow').textContent = willOpen ? '▾' : '▸';
    $('btnFineTune').setAttribute('aria-expanded', String(willOpen));
    if (willOpen) refreshAllSliderFills();
  });

  // Presets
  document.querySelectorAll('.preset-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      physics.applyPreset(pill.dataset.preset);
      syncSlidersFromPhysics();
      document.querySelectorAll('.preset-pill').forEach((p) => p.classList.toggle('active', p === pill));
      physics.triggerJiggle(0.55);
    });
  });

  // Exact original Softness slider -> updates Stretch, Wobble speed, Wobbles automatically!
  $('optSoftness').addEventListener('input', (e) => {
    physics.setSoftness(parseFloat(e.target.value));
    syncSlidersFromPhysics();
    document.querySelectorAll('.preset-pill').forEach((p) => p.classList.remove('active'));
  });

  const bindFloat = (id, fn) => {
    $(id).addEventListener('input', (e) => {
      fn(parseFloat(e.target.value));
      updateSliderFill(e.target);
      document.querySelectorAll('.preset-pill').forEach((p) => p.classList.remove('active'));
    });
  };
  bindFloat('optGrab', (v) => physics.setParams({ radius: v }));
  bindFloat('optStretch', (v) => physics.setParams({ stretch: v }));
  bindFloat('optWobbleSpeed', (v) => physics.setParams({ releaseFreq: v }));
  bindFloat('optWobbles', (v) => physics.setParams({ releaseZeta: zetaFromWobble(v) }));
  bindFloat('optPuffiness', (v) => physics.setParams({ bulge: v }));
  bindFloat('optMotion', (v) => physics.setParams({ motion: v }));

  $('optMotionTilt').addEventListener('change', (e) => {
    motion.tiltEnabled = e.target.checked;
  });
  $('optMotionShake').addEventListener('change', (e) => {
    motion.shakeEnabled = e.target.checked;
  });

  $('optShading').addEventListener('change', (e) => {
    renderer.shadingEnabled = e.target.checked;
  });
  $('optVpad').addEventListener('change', (e) => setVirtualPadOpen(e.target.checked));
  $('btnTestJiggle').addEventListener('click', () => {
    physics.triggerJiggle(1.0);
    audio.playRelease(0.65, physics.params.releaseFreq);
  });

  $('btnResetPhysics').addEventListener('click', () => {
    physics.applyPreset('real');
    syncSlidersFromPhysics();
    document.querySelectorAll('.preset-pill').forEach((p) => {
      p.classList.toggle('active', p.dataset.preset === 'real');
    });
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
      el.textContent = 'Lightweight 15 FPS GIF (up to 6 seconds).';
    } else if (state.gifHighFps > 50) {
      el.textContent = `${state.gifHighFps} FPS engine capture (up to 4s; uses 20ms GIF89a floor for universal browser playback).`;
    } else {
      const secs = state.gifHighFps > 30 ? 4 : 6;
      el.textContent = `Smooth ${state.gifHighFps} FPS GIF directly from engine (up to ${secs} seconds).`;
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

  // Video FPS preset pills (60 / 90 / 120 / Custom)
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

  // Optional High-FPS GIF controls (up to 60 FPS)
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

  window.addEventListener('resize', () => renderer.resize());
}

// ============================================================================
// Bootstrap
// ============================================================================
async function boot() {
  try {
    await renderer.init();
  } catch (err) {
    showToast(err.message, 6000);
    return;
  }

  populateSampleThumbnails();
  wireUI();
  initVirtualPad();
  syncSlidersFromPhysics();
  updateSoundUI();
  refreshAllSliderFills();

  selectSample('bear', 'play', true);
  requestAnimationFrame(tick);
}

boot();
