/**
 * EngineRecorder — Direct Engine-Driven Video (60 / 90 / 120 / Custom FPS) & Optional High-FPS GIF Recorder
 *
 * Pulls frames directly from the physics + WebGL2 rendering engine rather than the screen:
 * 1. Video mode (Primary): WebCodecs VideoEncoder + MiniWebmMuxer
 *    - Stamps every frame with mathematically exact engine timestamps (frameIndex * 1e6 / fps)
 *      so 60, 90, 120, or Custom FPS videos play back at true target FPS even on a 60Hz display!
 *    - Composites clean pastel/dark polka-dot studio background + WebGL2 artwork (zero UI overlays).
 * 2. Video mode (Automatic Fallback): Engine-composited MediaRecorder (captureStream(0) + requestFrame)
 *    for browsers without WebCodecs VideoEncoder.
 * 3. GIF mode: Incremental high-speed MiniGifEncoder supporting default 15 FPS or optional up to 60 FPS!
 */

import { MiniWebmMuxer } from './webm-muxer.js';
import { MiniGifEncoder } from './gif-encoder.js';

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
    this.backend = 'none'; // 'webcodecs' | 'mediarecorder' | 'gif'

    // Offscreen studio compositor canvas (clean polka-dot backdrop + WebGL2 mesh)
    this.compCanvas = document.createElement('canvas');
    this.compCtx = this.compCanvas.getContext('2d', { willReadFrequently: false });
    this._bgPatternCanvas = null;
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
    this._mrStopResolve = null;

    // GIF state
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

    this._bgPatternCanvas = p;
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
    // GIF MODE (Default 15 FPS, Optional up to 60 FPS!)
    // ------------------------------------------------------------------
    if (format === 'gif') {
      const targetW = this.fps > 30 ? 256 : 320;
      const w = makeEven(targetW, 128);
      const h = makeEven(w / aspect, 128);
      this.compCanvas.width = w;
      this.compCanvas.height = h;
      this.compCtx = this.compCanvas.getContext('2d', { willReadFrequently: true });
      this._bgTheme = null;

      this.gifEncoder = new MiniGifEncoder(w, h, this.fps);
      const maxSecs = this.fps > 30 ? 4 : 6;
      this.gifMaxFrames = Math.round(this.fps * maxSecs);
      this.backend = 'gif';
      this.isRecording = true;
      return {
        backend: 'gif',
        fps: this.fps,
        maxSeconds: maxSecs,
        message: `Recording ${this.fps} FPS GIF directly from engine...`,
      };
    }

    // ------------------------------------------------------------------
    // VIDEO MODE (60 / 90 / 120 / Custom FPS directly from engine!)
    // ------------------------------------------------------------------
    // Smart even dimensions (capped at 1080 longest side for silky 120fps+ encoding on mobile)
    const maxLong = this.fps > 90 ? 960 : 1080;
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

    // Try WebCodecs VideoEncoder first for mathematically exact engine FPS (60/90/120/Custom)!
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
          // try next codec
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

    // Fallback: Engine-composited MediaRecorder
    if (typeof MediaRecorder === 'undefined' || !this.compCanvas.captureStream) {
      throw new Error('Video recording is not supported in this browser — switch to GIF!');
    }

    const useManualPush = typeof CanvasCaptureMediaStreamTrack !== 'undefined' &&
      typeof CanvasCaptureMediaStreamTrack.prototype.requestFrame === 'function';
    const stream = this.compCanvas.captureStream(useManualPush ? 0 : Math.min(this.fps, 60));
    this.mrTrack = useManualPush ? stream.getVideoTracks()[0] : null;

    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : (MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm');

    const mr = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: Math.min(16000000, Math.max(3000000, Math.round(w * h * this.fps * 0.10))),
    });
    this.mrChunks = [];
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.mrChunks.push(e.data);
    };
    mr.onstop = () => {
      const blob = new Blob(this.mrChunks, { type: mime });
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
      message: `Recording ${this.fps} FPS video (MediaRecorder fallback)`,
    };
  }

  /**
   * Push one freshly rendered engine frame directly into the active encoder.
   * Returns { limitReached: boolean } so caller can auto-stop GIFs cleanly at max duration.
   */
  pushEngineFrame(glCanvas, theme) {
    if (!this.isRecording) return { limitReached: false };

    this._compositeFrame(glCanvas, theme);

    if (this.backend === 'gif') {
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
      // Backpressure protection for very high custom FPS on slower CPUs
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

  async stop() {
    if (!this.isRecording) return null;
    this.isRecording = false;
    const capturedFrames = this.frameIndex;
    const fps = this.fps;

    if (this.backend === 'gif') {
      const enc = this.gifEncoder;
      this.gifEncoder = null;
      this.backend = 'none';
      const blob = enc ? enc.buildBlob() : null;
      return {
        blob,
        filename: `mochi-squish-${fps}fps-${Date.now()}.gif`,
        frames: capturedFrames,
        fps,
        format: 'gif',
      };
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
      return {
        blob,
        filename: `mochi-squish-${fps}fps-${Date.now()}.webm`,
        frames: capturedFrames,
        fps,
        format: 'video',
      };
    }

    if (this.backend === 'mediarecorder') {
      const mr = this.mediaRecorder;
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
      return {
        blob,
        filename: `mochi-squish-${fps}fps-${Date.now()}.webm`,
        frames: capturedFrames,
        fps,
        format: 'video',
      };
    }

    return null;
  }
}
