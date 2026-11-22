/**
 * MochiRendererWebGL2 v16 — Exact 1:1 High-Res GPU Mochi Mesh Renderer
 *
 * - Builds a dense 128..192 segment WebGL2 mesh (matching original meshShortSegs=128, meshMaxSegs=192)
 * - Runs all quintic falloff, ring bulge, 4-tap mask smoothing, depth-lift, and bicubic sampling
 *   on the GPU via ./shaders/mochi.{vert,frag}.glsl
 * - Two-pass depth-tested alpha rendering:
 *     Pass 0: Opaque interior (a >= 0.95) with depth write -> stretched cheeks overlap cleanly on top!
 *     Pass 1: Soft transparent edge fringe (a < 0.95) without depth write -> zero edge halo bugs!
 * - Smooth Zoom & Pan camera in exact isotropic space (`iso = (u * aspect, v)`, `fitRatio = 0.76`)
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
  disp=disp*(m/max(1.0,wsum))+uMotionDisp*m;
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
uniform float uPass;
uniform vec2 uTexSize;
uniform float uBicubic;
uniform float uShading;
out vec4 outColor;
vec4 cubicW(float v){vec4 n=vec4(1.0,2.0,3.0,4.0)-v;vec4 s=n*n*n;float x=s.x;float y=s.y-4.0*s.x;float z=s.z-4.0*s.y+6.0*s.x;float w=6.0-x-y-z;return vec4(x,y,z,w)*(1.0/6.0);}
vec4 sampleImage(vec2 uv){if(uBicubic<0.5)return texture(uTex,uv);vec2 inv=1.0/uTexSize;vec2 coord=uv*uTexSize-0.5;vec2 fxy=fract(coord);coord-=fxy;vec4 xc=cubicW(fxy.x);vec4 yc=cubicW(fxy.y);vec4 c=coord.xxyy+vec2(-0.5,1.5).xyxy;vec4 s=vec4(xc.xz+xc.yw,yc.xz+yc.yw);vec4 off=(c+vec4(xc.yw,yc.yw)/s)*inv.xxyy;vec4 s0=texture(uTex,off.xz);vec4 s1=texture(uTex,off.yz);vec4 s2=texture(uTex,off.xw);vec4 s3=texture(uTex,off.yw);float sx=s.x/(s.x+s.y);float sy=s.z/(s.z+s.w);return mix(mix(s3,s2,sx),mix(s1,s0,sx),sy);}
void main(){
  vec4 c=sampleImage(vUV);
  if(uPass<0.5){if(c.a<0.95)discard;}else{if(c.a<0.004||c.a>=0.95)discard;}
  if(uShading>0.5){float s=clamp(vStrain,-1.0,1.0);if(s>0.0)c.rgb=mix(c.rgb,vec3(c.a,c.a*0.995,c.a*0.99),s*0.08);else if(s<0.0)c.rgb=mix(c.rgb,c.rgb*vec3(0.96,0.91,0.93),(-s)*0.10);}
  outColor=c;
}`;

export class MochiRendererWebGL2 {
  constructor(canvas, physics) {
    this.canvas = canvas;
    this.physics = physics;
    this.gl = null;
    this.program = null;
    this.u = {};

    this.mesh = null;
    this.imageTex = null;
    this.maskTex = null;

    this.aspect = 1.0;
    this.imageW = 1;
    this.imageH = 1;

    // View state (exact original iso -> canvas pixel -> clip transform)
    this.canvasW = 1;
    this.canvasH = 1;
    this.cssWidth = 1;
    this.cssHeight = 1;
    this.dpr = 1;
    this.k = 1;
    this.ox = 0;
    this.oy = 0;

    // Smooth camera zoom & pan (in canvas pixels, supporting animated Reset View)
    this.zoom = 1.0;
    this.tx = 0.0;
    this.ty = 0.0;
    this.targetZoom = 1.0;
    this.targetTx = 0.0;
    this.targetTy = 0.0;
    this.viewMat = new Float32Array(9);

    this.shadingEnabled = false;
  }

  async init() {
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

    let vertSrc = FALLBACK_VERT;
    let fragSrc = FALLBACK_FRAG;
    try {
      const [vRes, fRes] = await Promise.all([
        fetch('./shaders/mochi.vert.glsl'),
        fetch('./shaders/mochi.frag.glsl'),
      ]);
      if (vRes.ok && fRes.ok) {
        vertSrc = await vRes.text();
        fragSrc = await fRes.text();
      }
    } catch {
      // fallback embedded shaders ready
    }

    this.program = this._createProgram(vertSrc, fragSrc);
    const names = [
      'uAspect', 'uView', 'uGrabCount', 'uGrabA', 'uGrabPull', 'uBulge',
      'uMotionDisp', 'uMask', 'uMaskEnabled', 'uMaskCell',
      'uTex', 'uPass', 'uTexSize', 'uBicubic', 'uShading',
    ];
    for (const n of names) {
      this.u[n] = gl.getUniformLocation(this.program, n);
    }

    // Default 1x1 white R8 mask texture
    this.maskTex = this._createDefaultMaskTex();

    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    this.resize();
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
    const gl = this.gl;
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

  /** Upload blurred grayscale/RGB mask canvas to R8 GPU texture */
  uploadMask(maskCanvas) {
    const gl = this.gl;
    if (!gl || !this.maskTex) return;
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
    this.cssWidth = Math.max(1, rect.width);
    this.cssHeight = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvasW = Math.max(1, Math.round(this.cssWidth * this.dpr));
    this.canvasH = Math.max(1, Math.round(this.cssHeight * this.dpr));
    this.canvas.width = this.canvasW;
    this.canvas.height = this.canvasH;
    if (this.gl) {
      this.gl.viewport(0, 0, this.canvasW, this.canvasH);
    }
    this._updateFit();
  }

  /** Column-major 3x3 matrix mapping iso -> WebGL clip space [-1..1] */
  _computeViewMatrix() {
    const c = this.zoom * this.k;
    const fx = this.zoom * this.ox + this.tx;
    const fy = this.zoom * this.oy + this.ty;
    const cw = this.canvasW;
    const ch = this.canvasH;
    this.viewMat.set([
      (2 * c) / cw, 0, 0,
      0, (-2 * c) / ch, 0,
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
    const ix = (px.x - this.tx) / this.zoom;
    const iy = (px.y - this.ty) / this.zoom;
    return {
      x: (ix - this.ox) / this.k,
      y: (iy - this.oy) / this.k,
    };
  }

  /** Map isotropic coordinates -> CSS pixels relative to canvas top-left (for 2D overlay) */
  screenFromIso(isoX, isoY) {
    const px = (isoX * this.k + this.ox) * this.zoom + this.tx;
    const py = (isoY * this.k + this.oy) * this.zoom + this.ty;
    return {
      x: (px / this.canvasW) * this.cssWidth,
      y: (py / this.canvasH) * this.cssHeight,
    };
  }

  restUvFromIso(isoX, isoY) {
    return { x: isoX / this.aspect, y: isoY };
  }

  resetView() {
    this.targetZoom = 1.0;
    this.targetTx = 0.0;
    this.targetTy = 0.0;
  }

  /** Keep anchorIso locked directly beneath canvas pixel (pxX, pxY) at newZoom */
  setViewAnchored(newZoom, anchorIsoX, anchorIsoY, pxX, pxY) {
    const z = Math.max(0.45, Math.min(6.0, newZoom));
    const basePxX = anchorIsoX * this.k + this.ox;
    const basePxY = anchorIsoY * this.k + this.oy;
    this.zoom = this.targetZoom = z;
    this.tx = this.targetTx = pxX - basePxX * z;
    this.ty = this.targetTy = pxY - basePxY * z;
  }

  render() {
    const gl = this.gl;
    if (!gl) return;

    this.zoom += (this.targetZoom - this.zoom) * 0.22;
    this.tx += (this.targetTx - this.tx) * 0.22;
    this.ty += (this.targetTy - this.ty) * 0.22;

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.mesh || !this.imageTex) return;

    gl.useProgram(this.program);
    const u = this.u;
    const uni = this.physics.fillUniforms();

    gl.uniform1f(u.uAspect, this.aspect);
    gl.uniformMatrix3fv(u.uView, false, this._computeViewMatrix());
    gl.uniform1i(u.uGrabCount, uni.grabCount);
    gl.uniform4fv(u.uGrabA, uni.grabA);
    gl.uniform2fv(u.uGrabPull, uni.grabPull);
    gl.uniform1f(u.uBulge, uni.bulge);
    gl.uniform2f(u.uMotionDisp, uni.motionX, uni.motionY);
    gl.uniform1f(u.uMaskEnabled, uni.maskEnabled ? 1.0 : 0.0);
    gl.uniform2f(u.uMaskCell, 1 / this.mesh.segsX, 1 / this.mesh.segsY);

    gl.uniform2f(u.uTexSize, this.imageW, this.imageH);
    const displayScale = (this.k * this.zoom) / Math.max(1, this.imageH);
    gl.uniform1f(u.uBicubic, displayScale > 1.05 ? 1.0 : 0.0);
    gl.uniform1f(u.uShading, this.shadingEnabled ? 1.0 : 0.0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    gl.uniform1i(u.uTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(u.uMask, 1);

    gl.bindVertexArray(this.mesh.vao);

    // Exact 2-pass depth-tested alpha draw:
    // Pass 0: opaque pixels write depth (pulled cheeks overlap cleanly in front!)
    gl.uniform1f(u.uPass, 0.0);
    gl.depthMask(true);
    gl.drawElements(gl.TRIANGLES, this.mesh.indexCount, gl.UNSIGNED_SHORT, 0);

    // Pass 1: semi-transparent anti-aliased edge fringe blends cleanly without punching depth holes
    gl.uniform1f(u.uPass, 1.0);
    gl.depthMask(false);
    gl.drawElements(gl.TRIANGLES, this.mesh.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.depthMask(true);

    gl.bindVertexArray(null);
  }
}
