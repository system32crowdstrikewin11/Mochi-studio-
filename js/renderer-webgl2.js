/**
 * MochiRendererWebGL2 v22 — Exact 1:1 High-Res GPU Mochi Mesh Renderer
 *
 * - Dense 128..192 segment WebGL2 mesh with GPU analytic quintic-falloff physics,
 *   ring bulge, 4-tap mask smoothing, depth-lift, bicubic zoom sampling, and Paint mask view
 * - Exact 1:1 Original 2-Finger Similarity Transform (Zoom + Pan + Rotation!)
 *   plus smooth animated Reset View & `isTransformed()` auto-hide check
 * - Automatic WebGL2 `webglcontextlost` / `webglcontextrestored` recovery
 */

const MESH_SHORT_SEGS = 128;
const MESH_MAX_SEGS = 192;
const FIT_RATIO = 0.76;

const FALLBACK_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aRest;
uniform float uAspect;
uniform mat3 uView;
uniform int uGrabCount;
uniform vec4 uGrabA[8];
uniform vec2 uGrabPull[8];
uniform float uBulge;
uniform vec2 uMotionDisp;
uniform sampler2D uMask;
uniform float uMaskEnabled;
uniform vec2 uMaskCell;
out vec2 vUV;
out float vStrain;
float falloff(float t){float s=1.0-t;return s*s*s*(6.0*t*t+3.0*t+1.0);}
float ring(float t){return 6.75*t*(1.0-t)*(1.0-t);}
float maskAt(vec2 uv){vec2 h=uMaskCell*0.5;return (textureLod(uMask,uv+vec2(-h.x,-h.y),0.0).r+textureLod(uMask,uv+vec2(h.x,-h.y),0.0).r+textureLod(uMask,uv+vec2(-h.x,h.y),0.0).r+textureLod(uMask,uv+vec2(h.x,h.y),0.0).r)*0.25;}
void main(){
  vec2 iso=vec2(aRest.x*uAspect,aRest.y);
  vec2 disp=vec2(0.0);float wsum=0.0;float sa=0.0;
  for(int i=0;i<8;i++){if(i>=uGrabCount)break;float st=uGrabA[i].w;if(st<=0.0)continue;vec2 rel=iso-uGrabA[i].xy;float d=length(rel);float t=clamp(d/uGrabA[i].z,0.0,1.0);float w=falloff(t)*st;vec2 pull=uGrabPull[i];float pl=length(pull);vec2 dir=d>1e-5?rel/d:vec2(0.0);float rv=ring(t);disp+=w*pull+uBulge*pl*rv*dir*st;wsum+=w;sa+=(dot(dir,pull)/max(0.05,uGrabA[i].z))*rv*st;}
  float m=uMaskEnabled>0.5?maskAt(aRest):1.0;
  vec2 md=vec2(0.0);if(dot(uMotionDisp,uMotionDisp)>1e-10){if(uMaskEnabled>0.5){md=uMotionDisp*m;}else{vec2 c=aRest-vec2(0.5);float tf=0.48+0.72*(1.0-aRest.y);float cd=0.85+0.28*falloff(clamp(length(c*1.5),0.0,1.0));md=uMotionDisp*(tf*cd)+vec2(c.x*uMotionDisp.y*0.55,-c.y*abs(uMotionDisp.x)*0.40);}}disp=disp*(m/max(1.0,wsum))+md;
  float lift=clamp(wsum,0.0,1.0)*m;
  vec3 clip=uView*vec3(iso+disp,1.0);
  gl_Position=vec4(clip.xy,-0.5*lift,1.0);
  vUV=aRest;vStrain=clamp(sa*m*1.4,-1.0,1.0);
}`;

const FALLBACK_FRAG = `#version 300 es
precision mediump float;
in vec2 vUV;
in float vStrain;
uniform sampler2D uTex;
uniform sampler2D uMask;
uniform float uMaskView;
uniform float uPass;
uniform vec2 uTexSize;
uniform float uBicubic;
uniform float uShading;
out vec4 outColor;
vec4 cubicW(float v){vec4 n=vec4(1.0,2.0,3.0,4.0)-v;vec4 s=n*n*n;float x=s.x;float y=s.y-4.0*s.x;float z=s.z-4.0*s.y+6.0*s.x;float w=6.0-x-y-z;return vec4(x,y,z,w)*(1.0/6.0);}
vec4 sampleImage(vec2 uv){if(uBicubic<0.5)return texture(uTex,uv);vec2 inv=1.0/uTexSize;vec2 coord=uv*uTexSize-0.5;vec2 fxy=fract(coord);coord-=fxy;vec4 xc=cubicW(fxy.x);vec4 yc=cubicW(fxy.y);vec4 c=coord.xxyy+vec2(-0.5,1.5).xyxy;vec4 s=vec4(xc.xz+xc.yw,yc.xz+yc.yw);vec4 off=(c+vec4(xc.yw,yc.yw)/s)*inv.xxyy;vec4 s0=texture(uTex,off.xz);vec4 s1=texture(uTex,off.yz);vec4 s2=texture(uTex,off.xw);vec4 s3=texture(uTex,off.yw);float sx=s.x/(s.x+s.y);float sy=s.z/(s.z+s.w);return mix(mix(s3,s2,sx),mix(s1,s0,sx),sy);}
void main(){
  vec4 c=sampleImage(vUV);
  if(uMaskView>0.5){float m=texture(uMask,vUV).r;float mq=floor(m*4.0+0.5)/4.0;c*=0.45+0.4*mq;c+=vec4(1.0,0.55,0.68,1.0)*(0.35*mq);}
  else if(uPass<0.5){if(c.a<0.95)discard;}
  else{if(c.a<0.004||c.a>=0.95)discard;}
  if(uMaskView<0.5&&uShading>0.5){float s=clamp(vStrain,-1.0,1.0);if(s>0.0)c.rgb=mix(c.rgb,vec3(c.a,c.a*0.995,c.a*0.99),s*0.08);else if(s<0.0)c.rgb=mix(c.rgb,c.rgb*vec3(0.96,0.91,0.93),(-s)*0.10);}
  outColor=c;
}`;

export class MochiRendererWebGL2 {
  constructor(canvas, physics) {
    this.canvas = canvas;
    this.physics = physics;
    this.gl = null;
    this.program = null;
    this.u = {};

    this.vertSrc = FALLBACK_VERT;
    this.fragSrc = FALLBACK_FRAG;

    this.mesh = null;
    this.imageTex = null;
    this.maskTex = null;
    this._lastImageSource = null;

    this.aspect = 1.0;
    this.imageW = 1;
    this.imageH = 1;

    // Base fit parameters
    this.canvasW = 1;
    this.canvasH = 1;
    this.cssWidth = 1;
    this.cssHeight = 1;
    this.dpr = 1;
    this.k = 1;
    this.ox = 0;
    this.oy = 0;

    // Exact original 2D similarity view transform (zoom + pan + rotation in canvas pixels)
    // Maps base canvas px (x, y) -> (a*x - b*y + tx, b*x + a*y + ty)
    this.a = 1.0;
    this.b = 0.0;
    this.tx = 0.0;
    this.ty = 0.0;
    this.animReset = false;
    this.viewMat = new Float32Array(9);

    this.shadingEnabled = false;
  }

  get scale() {
    return Math.hypot(this.a, this.b);
  }

  get zoom() {
    return this.scale;
  }

  get isAnimatingView() {
    return this.animReset;
  }

  async init() {
    try {
      const [vRes, fRes] = await Promise.all([
        fetch('./shaders/mochi.vert.glsl?v=21'),
        fetch('./shaders/mochi.frag.glsl?v=21'),
      ]);
      if (vRes.ok && fRes.ok) {
        this.vertSrc = await vRes.text();
        this.fragSrc = await fRes.text();
      }
    } catch {
      // fallback embedded shaders ready
    }

    this._initGLContext();
    this.resize();
  }

  _initGLContext() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error('WebGL2 is not supported on this browser.');
    }
    this.gl = gl;
    this.mesh = null;
    this.imageTex = null;

    this.program = this._createProgram(this.vertSrc, this.fragSrc);
    const names = [
      'uAspect', 'uView', 'uGrabCount', 'uGrabA', 'uGrabPull', 'uBulge',
      'uMotionDisp', 'uMask', 'uMaskEnabled', 'uMaskCell',
      'uTex', 'uMaskView', 'uPass', 'uTexSize', 'uBicubic', 'uShading',
    ];
    for (const n of names) {
      this.u[n] = gl.getUniformLocation(this.program, n);
    }

    this.maskTex = this._createDefaultMaskTex();

    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
  }

  /** Automatic recovery after mobile app switching drops WebGL2 context */
  restoreContext(maskCanvas = null) {
    try {
      this._initGLContext();
      this.gl.viewport(0, 0, this.canvasW, this.canvasH);
      if (this._lastImageSource) {
        this.uploadTexture(this._lastImageSource);
      }
      if (maskCanvas) {
        this.uploadMask(maskCanvas);
      }
      return true;
    } catch {
      return false;
    }
  }

  _compileShader(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('GLSL compile error: ' + info);
    }
    return sh;
  }

  _createProgram(vertSrc, fragSrc) {
    const gl = this.gl;
    const vs = this._compileShader(gl.VERTEX_SHADER, vertSrc);
    const fs = this._compileShader(gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('GLSL link error: ' + gl.getProgramInfoLog(prog));
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
  }

  _createDefaultMaskTex() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  _buildMesh(aspect) {
    const gl = this.gl;
    if (this.mesh) {
      gl.deleteVertexArray(this.mesh.vao);
      gl.deleteBuffer(this.mesh.vbo);
      gl.deleteBuffer(this.mesh.ibo);
    }

    const segsX = aspect >= 1 ? Math.min(MESH_MAX_SEGS, Math.round(MESH_SHORT_SEGS * aspect)) : MESH_SHORT_SEGS;
    const segsY = aspect >= 1 ? MESH_SHORT_SEGS : Math.min(MESH_MAX_SEGS, Math.round(MESH_SHORT_SEGS / aspect));
    const nx = segsX + 1;
    const ny = segsY + 1;

    const verts = new Float32Array(nx * ny * 2);
    let p = 0;
    for (let j = 0; j < ny; j++) {
      const v = j / segsY;
      for (let i = 0; i < nx; i++) {
        verts[p++] = i / segsX;
        verts[p++] = v;
      }
    }

    const idx = new Uint16Array(segsX * segsY * 6);
    let q = 0;
    for (let j = 0; j < segsY; j++) {
      for (let i = 0; i < segsX; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        idx[q++] = a; idx[q++] = c; idx[q++] = b;
        idx[q++] = b; idx[q++] = c; idx[q++] = d;
      }
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    this.mesh = { vao, vbo, ibo, indexCount: idx.length, segsX, segsY };
  }

  uploadTexture(source) {
    this._lastImageSource = source;
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;
    const w = source.naturalWidth || source.width || 512;
    const h = source.naturalHeight || source.height || 512;
    this.imageW = w;
    this.imageH = h;
    this.aspect = w / h;

    if (this.imageTex) gl.deleteTexture(this.imageTex);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.imageTex = tex;

    this._buildMesh(this.aspect);
    this._updateFit();
  }

  uploadMask(maskCanvas) {
    const gl = this.gl;
    if (!gl || !this.maskTex || gl.isContextLost()) return;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, maskCanvas);
  }

  _updateFit() {
    this.k = FIT_RATIO * Math.min(this.canvasW / this.aspect, this.canvasH);
    this.ox = (this.canvasW - this.k * this.aspect) * 0.5;
    this.oy = (this.canvasH - this.k) * 0.5;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cw = Math.max(1, Math.round(cssW * dpr));
    const ch = Math.max(1, Math.round(cssH * dpr));

    if (cw === this.canvasW && ch === this.canvasH && cssW === this.cssWidth && cssH === this.cssHeight) {
      return false;
    }

    this.cssWidth = cssW;
    this.cssHeight = cssH;
    this.dpr = dpr;
    this.canvasW = cw;
    this.canvasH = ch;
    this.canvas.width = cw;
    this.canvas.height = ch;
    if (this.gl && !this.gl.isContextLost()) {
      this.gl.viewport(0, 0, cw, ch);
    }
    this._updateFit();
    return true;
  }

  // ==========================================================================
  // Exact 1:1 Original Similarity View Transform (Zoom + Pan + Rotation!)
  // ==========================================================================
  isTransformed() {
    return (
      Math.abs(this.scale - 1) > 0.001 ||
      Math.abs(this.b) > 0.001 ||
      Math.abs(this.tx) > 0.5 ||
      Math.abs(this.ty) > 0.5
    );
  }

  resetView(animated = true) {
    if (!animated) {
      this.a = 1.0;
      this.b = 0.0;
      this.tx = 0.0;
      this.ty = 0.0;
      this.animReset = false;
      return;
    }
    this.animReset = true;
  }

  _compose(c, s, dx, dy) {
    const { a: r, b: n, tx: o, ty: h } = this;
    this.a = c * r - s * n;
    this.b = s * r + c * n;
    this.tx = c * o - s * h + dx;
    this.ty = s * o + c * h + dy;
  }

  /** Exact original 2-finger gesture (simultaneous zoom, pan, AND rotation!) */
  applyGesture(p1Old, p2Old, p1New, p2New) {
    this.animReset = false;
    const dx0 = p2Old.x - p1Old.x;
    const dy0 = p2Old.y - p1Old.y;
    const dx1 = p2New.x - p1New.x;
    const dy1 = p2New.y - p1New.y;
    const d0Sq = dx0 * dx0 + dy0 * dy0;
    if (d0Sq < 1e-6) return;

    let c = (dx1 * dx0 + dy1 * dy0) / d0Sq;
    let s = (dy1 * dx0 - dx1 * dy0) / d0Sq;
    const f = Math.hypot(c, s);
    if (f < 1e-6) return;

    const clamped = Math.min(Math.max(f * this.scale, 0.5), 8.0) / this.scale;
    c *= clamped / f;
    s *= clamped / f;
    this._compose(
      c,
      s,
      p1New.x - (c * p1Old.x - s * p1Old.y),
      p1New.y - (s * p1Old.x + c * p1Old.y)
    );
  }

  /** Exact original wheel zoom centered directly under cursor canvas pixel */
  zoomAt(pxX, pxY, factor) {
    this.animReset = false;
    const clamped = Math.min(Math.max(factor * this.scale, 0.5), 8.0) / this.scale;
    this._compose(clamped, 0, pxX * (1 - clamped), pxY * (1 - clamped));
  }

  /** Column-major 3x3 matrix mapping iso -> WebGL clip space [-1..1] */
  _computeViewMatrix() {
    const { k, ox, oy, canvasW: cw, canvasH: ch, a, b, tx, ty } = this;
    const c = a * k;
    const u = b * k;
    const fx = a * ox - b * oy + tx;
    const fy = b * ox + a * oy + ty;
    this.viewMat.set([
      (2 * c) / cw, (-2 * u) / ch, 0,
      (-2 * u) / cw, (-2 * c) / ch, 0,
      (2 * fx) / cw - 1, 1 - (2 * fy) / ch, 1,
    ]);
    return this.viewMat;
  }

  canvasPxFromClient(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) * this.canvasW) / Math.max(1, rect.width),
      y: ((clientY - rect.top) * this.canvasH) / Math.max(1, rect.height),
    };
  }

  isoFromClient(clientX, clientY) {
    const px = this.canvasPxFromClient(clientX, clientY);
    const { a, b, tx, ty } = this;
    const det = a * a + b * b;
    const dx = px.x - tx;
    const dy = px.y - ty;
    const bx = (a * dx + b * dy) / det;
    const by = (-b * dx + a * dy) / det;
    return {
      x: (bx - this.ox) / this.k,
      y: (by - this.oy) / this.k,
    };
  }

  restUvFromIso(isoX, isoY) {
    return { x: isoX / this.aspect, y: isoY };
  }

  /** Exact screen CSS length for an isotropic distance (1:1 cursor-to-paint match at any zoom/rotation!) */
  isoToCssLength(isoLen) {
    const rect = this.canvas.getBoundingClientRect();
    return isoLen * this.k * this.scale * (rect.width / Math.max(1, this.canvasW));
  }

  stepViewAnimation() {
    if (!this.animReset) return false;
    this.a += (1.0 - this.a) * 0.25;
    this.b += (0.0 - this.b) * 0.25;
    this.tx += (0.0 - this.tx) * 0.25;
    this.ty += (0.0 - this.ty) * 0.25;
    if (!this.isTransformed()) {
      this.a = 1.0;
      this.b = 0.0;
      this.tx = 0.0;
      this.ty = 0.0;
      this.animReset = false;
    }
    return true;
  }

  render(maskView = false) {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) return;

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.mesh || !this.imageTex) return;

    gl.useProgram(this.program);
    const u = this.u;
    const uni = this.physics.fillUniforms();

    gl.uniform1f(u.uAspect, this.aspect);
    gl.uniformMatrix3fv(u.uView, false, this._computeViewMatrix());
    gl.uniform1i(u.uGrabCount, maskView ? 0 : uni.grabCount);
    gl.uniform4fv(u.uGrabA, uni.grabA);
    gl.uniform2fv(u.uGrabPull, uni.grabPull);
    gl.uniform1f(u.uBulge, uni.bulge);
    gl.uniform2f(u.uMotionDisp, maskView ? 0 : uni.motionX, maskView ? 0 : uni.motionY);
    gl.uniform1f(u.uMaskEnabled, uni.maskEnabled ? 1.0 : 0.0);
    gl.uniform1f(u.uMaskView, maskView ? 1.0 : 0.0);
    gl.uniform2f(u.uMaskCell, 1 / this.mesh.segsX, 1 / this.mesh.segsY);

    gl.uniform2f(u.uTexSize, this.imageW, this.imageH);
    const displayScale = (this.k * this.scale) / Math.max(1, this.imageH);
    gl.uniform1f(u.uBicubic, displayScale > 1.05 ? 1.0 : 0.0);
    gl.uniform1f(u.uShading, this.shadingEnabled ? 1.0 : 0.0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    gl.uniform1i(u.uTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(u.uMask, 1);

    gl.bindVertexArray(this.mesh.vao);

    if (maskView) {
      gl.uniform1f(u.uPass, 0.0);
      gl.depthMask(true);
      gl.drawElements(gl.TRIANGLES, this.mesh.indexCount, gl.UNSIGNED_SHORT, 0);
    } else {
      gl.uniform1f(u.uPass, 0.0);
      gl.depthMask(true);
      gl.drawElements(gl.TRIANGLES, this.mesh.indexCount, gl.UNSIGNED_SHORT, 0);

      gl.uniform1f(u.uPass, 1.0);
      gl.depthMask(false);
      gl.drawElements(gl.TRIANGLES, this.mesh.indexCount, gl.UNSIGNED_SHORT, 0);
      gl.depthMask(true);
    }

    gl.bindVertexArray(null);
  }
}
