/**
 * EngineRecorder v18 — Direct Engine-Driven Video (60 / 90 / 120 / Custom FPS)
 * & Adaptive 256-Color Web Worker GIF (Default 15 FPS, Optional up to 60 FPS)
 *
 * - Video (Primary): WebCodecs VideoEncoder + MiniWebmMuxer with exact 0.1ms engine timestamps
 * - Video (Fallback): MediaRecorder (prefers MP4/H.264 on Safari/iOS, VP9/VP8 WebM elsewhere)
 * - GIF (Primary): Captures clean composited RGBA buffers directly from the engine and encodes
 *   in `js/gif-worker.js` using adaptive per-frame 256-color quantization + LZW off the main thread!
 * - GIF (Fallback): Incremental MiniGifEncoder if Web Workers are blocked.
 * - Returns a ready-to-preview `File` object for the Recording Preview Modal & OS Share Sheet!
 */

import { MiniWebmMuxer } from './webm-muxer.js?v=18';
import { MiniGifEncoder } from './gif-encoder.js?v=18';

function makeEven(n, minVal = 64) {
  const v = Math.max(minVal, Math.round(n));
  return v & ~1;
}

export class EngineRecorder {
  constructor() {
    this.isRecording = false;
    this.format = 'video'; // 'video' | 'gif'
    this.fps = 60;
    this.frameIndex = 0;
    this.backend = 'none'; // 'webcodecs' | 'mediarecorder' | 'gif-worker' | 'gif-fallback'

    this.compCanvas = document.createElement('canvas');
    this.compCtx = this.compCanvas.getContext('2d', { willReadFrequently: false });
    this._bgTheme = null;
    this._bgPattern = null;

    // WebCodecs state
    this.encoder = null;
    this.muxer = null;
    this._encoderError = null;

    // MediaRecorder fallback state
    this.mediaRecorder = null;
    this.mrChunks = [];
    this.mrTrack = null;
    this.mrExt = 'webm';
    this.mrMime = 'video/webm';
    this._mrStopResolve = null;

    // GIF state
    this.gifFrames = []; // ArrayBuffer[] for Web Worker
    this.gifEncoder = null;
    this.gifMaxFrames = 90;
  }

  _ensureBgPattern(theme, scale) {
    const key = `${theme}:${Math.round(scale * 10)}`;
    if (this._bgTheme === key && this._bgPattern) return;
    this._bgTheme = key;

    const tile = Math.max(16, Math.round(28 * scale));
    const p = document.createElement('canvas');
    p.width = tile;
    p.height = tile;
    const pctx = p.getContext('2d');
    pctx.fillStyle = theme === 'dark' ? '#17151f' : '#fff9fb';
    pctx.fillRect(0, 0, tile, tile);
    pctx.fillStyle = theme === 'dark' ? 'rgba(244, 150, 185, 0.14)' : 'rgba(246, 178, 200, 0.30)';
    pctx.beginPath();
    pctx.arc(tile * 0.5, tile * 0.5, Math.max(1.6, 3 * scale), 0, Math.PI * 2);
    pctx.fill();

    this._bgPattern = this.compCtx.createPattern(p, 'repeat');
  }

  _compositeFrame(glCanvas, theme) {
    const ctx = this.compCtx;
    const w = this.compCanvas.width;
    const h = this.compCanvas.height;
    const scale = w / Math.max(1, glCanvas.clientWidth || 390);
    this._ensureBgPattern(theme, scale);

    ctx.fillStyle = this._bgPattern || (theme === 'dark' ? '#17151f' : '#fff9fb');
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(glCanvas, 0, 0, w, h);
  }

  async start({ format, fps, glCanvas }) {
    if (this.isRecording) return null;

    this.format = format;
    this.fps = Math.max(10, Math.min(240, Math.round(fps)));
    this.frameIndex = 0;
    this._encoderError = null;

    const cssW = Math.max(1, glCanvas.clientWidth || glCanvas.width);
    const cssH = Math.max(1, glCanvas.clientHeight || glCanvas.height);
    const aspect = cssW / cssH;

    // ------------------------------------------------------------------
    // GIF MODE — Adaptive 256-Color Web Worker (15 FPS default, up to 60 FPS!)
    // ------------------------------------------------------------------
    if (format === 'gif') {
      // Crisp 440px max side at classic/30fps, 340px at 50-60fps for fast Worker encoding
      const maxSide = this.fps > 30 ? 340 : 440;
      const w = aspect >= 1 ? makeEven(maxSide, 128) : makeEven(maxSide * aspect, 128);
      const h = aspect >= 1 ? makeEven(maxSide / aspect, 128) : makeEven(maxSide, 128);
      this.compCanvas.width = w;
      this.compCanvas.height = h;
      this.compCtx = this.compCanvas.getContext('2d', { willReadFrequently: true });
      this._bgTheme = null;

      const maxSecs = this.fps > 30 ? 4 : 6;
      this.gifMaxFrames = Math.round(this.fps * maxSecs);
      this.gifFrames = [];
      this.gifEncoder = null;

      if (typeof Worker === 'function') {
        this.backend = 'gif-worker';
      } else {
        this.gifEncoder = new MiniGifEncoder(w, h, this.fps);
        this.backend = 'gif-fallback';
      }

      this.isRecording = true;
      return {
        backend: this.backend,
        fps: this.fps,
        maxSeconds: maxSecs,
        message: `Recording ${this.fps} FPS GIF (up to ${maxSecs}s)...`,
      };
    }

    // ------------------------------------------------------------------
    // VIDEO MODE (60 / 90 / 120 / Custom FPS directly from engine!)
    // ------------------------------------------------------------------
    const maxLong = this.fps > 90 ? 960 : 1280;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let rawW = cssW * dpr;
    let rawH = cssH * dpr;
    const longest = Math.max(rawW, rawH);
    if (longest > maxLong) {
      const s = maxLong / longest;
      rawW *= s;
      rawH *= s;
    }
    const w = makeEven(rawW, 128);
    const h = makeEven(rawH, 128);
    this.compCanvas.width = w;
    this.compCanvas.height = h;
    this.compCtx = this.compCanvas.getContext('2d', { willReadFrequently: false });
    this._bgTheme = null;

    if (typeof VideoEncoder === 'function' && typeof VideoFrame === 'function') {
      const bitrate = Math.min(20000000, Math.max(2500000, Math.round(w * h * this.fps * 0.12)));
      const candidates = [
        { codec: 'vp09.00.10.08', webmId: 'V_VP9' },
        { codec: 'vp8', webmId: 'V_VP8' },
      ];

      let chosen = null;
      for (const cand of candidates) {
        const cfg = {
          codec: cand.codec,
          width: w,
          height: h,
          bitrate,
          framerate: Math.min(this.fps, 240),
          latencyMode: 'realtime',
        };
        try {
          const sup = await VideoEncoder.isConfigSupported(cfg);
          if (sup && sup.supported) {
            chosen = { cfg, webmId: cand.webmId };
            break;
          }
        } catch {
          // try next
        }
      }

      if (chosen) {
        try {
          this.muxer = new MiniWebmMuxer({
            width: w,
            height: h,
            fps: this.fps,
            codecId: chosen.webmId,
          });
          this.encoder = new VideoEncoder({
            output: (chunk) => {
              if (this.muxer) this.muxer.addEncodedChunk(chunk);
            },
            error: (err) => {
              this._encoderError = err;
            },
          });
          this.encoder.configure(chosen.cfg);
          this.backend = 'webcodecs';
          this.isRecording = true;
          return {
            backend: 'webcodecs',
            fps: this.fps,
            codec: chosen.webmId,
            message: `Recording ${this.fps} FPS video directly from engine!`,
          };
        } catch {
          this.encoder = null;
          this.muxer = null;
        }
      }
    }

    // Fallback: Engine-composited MediaRecorder (MP4 on Safari/iOS, WebM elsewhere)
    if (typeof MediaRecorder === 'undefined' || !this.compCanvas.captureStream) {
      throw new Error('Video recording is not supported in this browser — switch to GIF!');
    }

    const useManualPush = typeof CanvasCaptureMediaStreamTrack !== 'undefined' &&
      typeof CanvasCaptureMediaStreamTrack.prototype.requestFrame === 'function';
    const stream = this.compCanvas.captureStream(useManualPush ? 0 : Math.min(this.fps, 60));
    this.mrTrack = useManualPush ? stream.getVideoTracks()[0] : null;

    const mimeCandidates = [
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
    this.mrMime = mime.split(';')[0];
    this.mrExt = this.mrMime === 'video/mp4' ? 'mp4' : 'webm';

    const mr = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: Math.min(16000000, Math.max(3000000, Math.round(w * h * this.fps * 0.10))),
    });
    this.mrChunks = [];
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.mrChunks.push(e.data);
    };
    mr.onstop = () => {
      for (const tr of stream.getTracks()) tr.stop();
      const blob = new Blob(this.mrChunks, { type: this.mrMime });
      if (this._mrStopResolve) {
        this._mrStopResolve(blob);
        this._mrStopResolve = null;
      }
    };
    mr.start(250);
    this.mediaRecorder = mr;
    this.backend = 'mediarecorder';
    this.isRecording = true;

    return {
      backend: 'mediarecorder',
      fps: this.fps,
      message: `Recording ${this.fps} FPS video! Tap again to stop`,
    };
  }

  pushEngineFrame(glCanvas, theme) {
    if (!this.isRecording) return { limitReached: false };

    this._compositeFrame(glCanvas, theme);

    if (this.backend === 'gif-worker') {
      const img = this.compCtx.getImageData(0, 0, this.compCanvas.width, this.compCanvas.height);
      this.gifFrames.push(img.data.buffer);
      this.frameIndex++;
      return { limitReached: this.frameIndex >= this.gifMaxFrames };
    }

    if (this.backend === 'gif-fallback') {
      if (this.gifEncoder) {
        this.gifEncoder.addCanvasFrame(this.compCtx);
      }
      this.frameIndex++;
      return { limitReached: this.frameIndex >= this.gifMaxFrames };
    }

    if (this.backend === 'webcodecs') {
      if (!this.encoder || this.encoder.state !== 'configured' || this._encoderError) {
        return { limitReached: false };
      }
      if (this.encoder.encodeQueueSize > 16) {
        this.frameIndex++;
        return { limitReached: false };
      }
      const timestamp = Math.round(this.frameIndex * (1000000 / this.fps));
      const duration = Math.round(1000000 / this.fps);
      const frame = new VideoFrame(this.compCanvas, { timestamp, duration });
      const keyFrame = (this.frameIndex % Math.max(30, this.fps)) === 0;
      this.encoder.encode(frame, { keyFrame });
      frame.close();
      this.frameIndex++;
      return { limitReached: false };
    }

    if (this.backend === 'mediarecorder') {
      if (this.mrTrack && typeof this.mrTrack.requestFrame === 'function') {
        this.mrTrack.requestFrame();
      }
      this.frameIndex++;
      return { limitReached: false };
    }

    return { limitReached: false };
  }

  getElapsedSeconds() {
    return this.fps > 0 ? (this.frameIndex / this.fps) : 0;
  }

  _encodeGifWithWorker(buffers, width, height, fps) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(new URL('./gif-worker.js?v=18', import.meta.url));
      } catch (err) {
        reject(err);
        return;
      }
      const delayMs = Math.max(20, Math.round(1000 / fps));
      worker.onmessage = (e) => {
        worker.terminate();
        resolve(new Blob([e.data], { type: 'image/gif' }));
      };
      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };
      worker.postMessage({ width, height, delayMs, buffers }, buffers);
    });
  }

  async stop() {
    if (!this.isRecording) return null;
    this.isRecording = false;
    const capturedFrames = this.frameIndex;
    const fps = this.fps;

    if (this.backend === 'gif-worker') {
      const buffers = this.gifFrames;
      this.gifFrames = [];
      this.backend = 'none';
      if (buffers.length === 0) return null;

      let blob = null;
      try {
        blob = await this._encodeGifWithWorker(buffers, this.compCanvas.width, this.compCanvas.height, fps);
      } catch {
        // Fallback if Worker failed
        const enc = new MiniGifEncoder(this.compCanvas.width, this.compCanvas.height, fps);
        const tmp = document.createElement('canvas');
        tmp.width = this.compCanvas.width;
        tmp.height = this.compCanvas.height;
        const tctx = tmp.getContext('2d', { willReadFrequently: true });
        for (const buf of buffers) {
          if (buf.byteLength > 0) {
            tctx.putImageData(new ImageData(new Uint8ClampedArray(buf), tmp.width, tmp.height), 0, 0);
            enc.addCanvasFrame(tctx);
          }
        }
        blob = enc.buildBlob();
      }

      const filename = `mochi-squish-${fps}fps-${Date.now()}.gif`;
      const file = blob ? new File([blob], filename, { type: 'image/gif' }) : null;
      return { file, blob, filename, frames: capturedFrames, fps, format: 'gif' };
    }

    if (this.backend === 'gif-fallback') {
      const enc = this.gifEncoder;
      this.gifEncoder = null;
      this.backend = 'none';
      const blob = enc ? enc.buildBlob() : null;
      const filename = `mochi-squish-${fps}fps-${Date.now()}.gif`;
      const file = blob ? new File([blob], filename, { type: 'image/gif' }) : null;
      return { file, blob, filename, frames: capturedFrames, fps, format: 'gif' };
    }

    if (this.backend === 'webcodecs') {
      const enc = this.encoder;
      const mux = this.muxer;
      this.encoder = null;
      this.muxer = null;
      this.backend = 'none';
      try {
        if (enc && enc.state === 'configured') {
          await enc.flush();
          enc.close();
        }
      } catch {
        // ignore close errors
      }
      const blob = mux ? mux.buildBlob() : null;
      const filename = `mochi-squish-${fps}fps-${Date.now()}.webm`;
      const file = blob ? new File([blob], filename, { type: 'video/webm' }) : null;
      return { file, blob, filename, frames: capturedFrames, fps, format: 'video' };
    }

    if (this.backend === 'mediarecorder') {
      const mr = this.mediaRecorder;
      const ext = this.mrExt;
      const mime = this.mrMime;
      this.mediaRecorder = null;
      this.mrTrack = null;
      this.backend = 'none';
      const blob = await new Promise((resolve) => {
        this._mrStopResolve = resolve;
        if (mr && mr.state === 'recording') {
          mr.stop();
        } else {
          resolve(null);
        }
      });
      const filename = `mochi-squish-${fps}fps-${Date.now()}.${ext}`;
      const file = blob ? new File([blob], filename, { type: mime }) : null;
      return { file, blob, filename, frames: capturedFrames, fps, format: 'video' };
    }

    return null;
  }
}
