# Mochi Studio v14

Interactive squishy artwork studio built with **HTML5**, **CSS3**, **GLSL ES 3.00 (WebGL2)**, **ES Modules JavaScript**, **WebCodecs + Pure-JS WebM Muxer**, and **Web Audio API**.

## Run on Localhost (Port 25565)

```bash
python3 server.py 25565
# or:
node server.js 25565
```

Open `http://localhost:25565` in your mobile or desktop browser.

## Highlights
- **Play Mode:**
  - Adaptive yield-stress mochi physics (slight touches stay plump & slightly firm; committed stretches yield into chewy full pulls and fold-free `>w<` pinches).
  - Touch **outside the artwork** with **2 fingers** (or mouse scroll wheel) to **Zoom & Pan** freely.
  - Tap **Motion** for optional phone tilt & shake sensors (or enable **Virtual Tilt Pad** in Settings).
- **Direct Engine Video & GIF Recording (Settings → Record):**
  - **Video (WebM):** Choose **60**, **90**, **120**, or **Custom (15–240) FPS**. Pulls frames directly from the physics & WebGL2 engine with sub-frame finger interpolation and exact 0.1ms WebM timestamps (independent of screen refresh rate).
  - **GIF:** Lightweight **15 FPS** by default, with an optional **High-FPS GIF (up to 60 FPS)** toggle in Settings.
- **Paint Mode:**
  - Zero-lag Spotlight-Reveal brush (**Sharp / Soft**, zoom-adaptive **Size**, **Undo / Redo**, **Clear all**, **All squishy**, plus **2-finger Zoom & Pan**).
