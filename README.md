# Mochi Studio v22

Interactive squishy artwork studio built with **HTML5**, **CSS3**, **GLSL ES 3.00 (WebGL2)**, **ES Modules JavaScript**, **WebCodecs + Pure-JS WebM Muxer**, **Adaptive 256-Color GIF Web Worker**, and **Web Audio API**.

## ▶ Try it live

**[Launch Mochi Studio →](https://system32crowdstrikewin11.github.io/Mochi-studio-/)**

No install needed — runs entirely in your browser. Phone motion sensors work over HTTPS, so you can try tilt & shake right on your phone.

## Run on Localhost (Port 25565)

```bash
python3 server.py 25565
# or:
node server.js 25565
```

Open `http://localhost:25565` in your mobile or desktop browser.

## Highlights
- **1:1 GPU Mochi Physics & Audio:**
  - Dense 128–192 segment WebGL2 mesh with analytic quintic falloff, ring bulge, 4-tap mask smoothing, 2-pass depth-tested alpha overlap, bicubic zoom interpolation, and 240Hz damped harmonic spring simulation.
  - Synthesized Web Audio grab puff and wobble-frequency-synced release boing.
  - Idle GPU optimization (renders only when moving, interacting, or recording) + automatic WebGL2 context loss recovery.
- **1:1 Aspect-Matched Paint Mode:**
  - Aspect-matched mask canvas with exact 1:1 cursor-to-paint sizing across square, portrait, and landscape artwork at any zoom/rotation.
  - **Sharp** solid mask, **Soft** 4-stop radial airbrush buildup, direct GPU quantized mask preview, **Undo / Redo** (30 steps), **Clear all**, and **All squishy**.
  - **2-finger Zoom, Pan & Rotation** in both Paint and Play modes with auto-hiding **Reset view**.
- **EXIF-Aware Image Import:**
  - Global drag-and-drop anywhere on the page, Ctrl+V paste, file picker, or built-in samples, auto-oriented from EXIF and smoothly capped at 2048px.
- **Camera Hand Gesture Tracking (360° Directional Bounce):**
  - Tap **Camera** in Play mode to bounce the mochi in any direction (**Up, Down, Left, Right, or Diagonals**) by waving your hand in front of the camera—Dual-engine real-time tracking: **AI 21-Point Hand Tracking** (MediaPipe HandLandmarker with 1-Euro adaptive filter, 21-joint skeleton preview, continuous 360° wave bounce, full site-wide **Air Cursor** where thumb+index pinch acts as a real long-press/click to pull cheeks with two hands, paint masks, click buttons/tabs, scrub sliders, and scroll Settings!) plus an instant-start / offline **3-Level Illumination-Invariant Sub-Pixel Pyramid Lucas-Kanade Fast Flow** engine with persistent hand tracking and Hold-to-Grab / Dwell Air Cursor!
- **Optional Phone Motion Sensors:**
  - Real-time tilt gravity & shake jiggle plus an interactive **Virtual Tilt Pad**.
- **Direct Engine Video & Adaptive GIF Recording + Preview/Share Modal:**
  - **Video:** Direct engine capture at **60**, **90**, **120**, or **Custom (15–240) FPS** with sub-frame finger interpolation and exact 0.1ms WebM timestamps (plus Safari/iOS MP4 fallback).
  - **GIF:** Off-main-thread adaptive 256-color quantization Web Worker (**15 FPS** default, or optional **High-FPS GIF up to 60 FPS**).
  - Built-in looping **Preview Modal** with one-tap **OS Share Sheet** (Discord, WhatsApp, X, Photos) and **Download**.

## Credits

- Inspired by [もちほっぺ・メーカー (Moti Hoppe Maker)](https://sabanogames.com/entertainments/moti_hoppe_maker/) by SABANO GAMES — huge thanks for the original squishy-cheek inspiration!
- All code, built-in sample artwork, physics, and audio in this project are original and made from scratch.

