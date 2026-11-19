/**
 * MochiRendererWebGL2 — Hardware-accelerated WebGL2 Mesh Renderer
 * Loads external GLSL ES 3.00 shaders from ./shaders/mochi.{vert,frag}.glsl
 */

const FALLBACK_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in float a_strain;
uniform vec2 u_scale;
uniform vec2 u_pan;
uniform float u_zoom;
out vec2 v_uv;
out float v_strain;
void main() {
  vec2 p = a_pos * u_zoom + u_pan;
  gl_Position = vec4(p.x * u_scale.x, -p.y * u_scale.y, 0.0, 1.0);
  v_uv = a_uv;
  v_strain = a_strain;
}`;

const FALLBACK_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_strain;
uniform sampler2D u_tex;
uniform float u_shading;
out vec4 outColor;
void main() {
  vec4 col = texture(u_tex, v_uv);
  if (col.a < 0.004) discard;
  float s = clamp(v_strain, -1.0, 1.0) * u_shading;
  vec3 rgb = col.rgb;
  if (s > 0.0) rgb = mix(rgb, vec3(col.a, col.a * 0.995, col.a * 0.99), s * 0.08);
  else if (s < 0.0) rgb = mix(rgb, rgb * vec3(0.96, 0.91, 0.93), (-s) * 0.10);
  outColor = vec4(rgb, col.a);
}`;

export class MochiRendererWebGL2 {
  constructor(canvas, physics) {
    this.canvas = canvas;
    this.physics = physics;
    this.gl = null;
    this.program = null;
    this.vao = null;
    this.posBuf = null;
    this.uvBuf = null;
    this.strainBuf = null;
    this.idxBuf = null;
    this.texture = null;

    // Camera transform (world space -> clip space)
    this.zoom = 1.0;
    this.panX = 0.0;
    this.panY = 0.0;
    this.targetZoom = 1.0;
    this.targetPanX = 0.0;
    this.targetPanY = 0.0;
    this.baseFitScale = 1.38; // Warm, inviting framing like original while keeping elastic margin!

    this.shadingEnabled = false;
    this.cssWidth = 1;
    this.cssHeight = 1;
    this.dpr = 1;
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
      // fallback ready
    }

    this.program = this._createProgram(vertSrc, fragSrc);
    this.uScale = gl.getUniformLocation(this.program, 'u_scale');
    this.uPan = gl.getUniformLocation(this.program, 'u_pan');
    this.uZoom = gl.getUniformLocation(this.program, 'u_zoom');
    this.uTex = gl.getUniformLocation(this.program, 'u_tex');
    this.uShading = gl.getUniformLocation(this.program, 'u_shading');

    this._initBuffers();
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

  _initBuffers() {
    const gl = this.gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.physics.posInterleaved, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.physics.uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

    this.strainBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.strainBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.physics.strain, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);

    this.idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.physics.indices, gl.STATIC_DRAW);

    gl.bindVertexArray(null);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  uploadTexture(source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.physics.uv, gl.STATIC_DRAW);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.cssWidth = Math.max(1, rect.width);
    this.cssHeight = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.round(this.cssWidth * this.dpr);
    this.canvas.height = Math.round(this.cssHeight * this.dpr);
    if (this.gl) {
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  getScaleXY() {
    const viewAspect = this.cssWidth / this.cssHeight;
    const s = 1.0 / (0.5 * this.baseFitScale);
    if (viewAspect >= 1) {
      return [s / viewAspect, s];
    }
    return [s, s * viewAspect];
  }

  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((clientY - rect.top) / rect.height) * 2 - 1;
    const [sx, sy] = this.getScaleXY();
    const wx = (nx / sx - this.panX) / this.zoom;
    const wy = (ny / sy - this.panY) / this.zoom;
    return { x: wx, y: wy };
  }

  worldToScreen(wx, wy) {
    const [sx, sy] = this.getScaleXY();
    const nx = (wx * this.zoom + this.panX) * sx;
    const ny = (wy * this.zoom + this.panY) * sy;
    return {
      x: (nx * 0.5 + 0.5) * this.cssWidth,
      y: (ny * 0.5 + 0.5) * this.cssHeight,
    };
  }

  resetView() {
    this.targetZoom = 1.0;
    this.targetPanX = 0.0;
    this.targetPanY = 0.0;
  }

  setViewImmediate(zoom, panX, panY) {
    this.zoom = this.targetZoom = Math.max(0.45, Math.min(4.5, zoom));
    this.panX = this.targetPanX = Math.max(-1.8, Math.min(1.8, panX));
    this.panY = this.targetPanY = Math.max(-1.8, Math.min(1.8, panY));
  }

  render() {
    const gl = this.gl;
    if (!gl) return;

    this.zoom += (this.targetZoom - this.zoom) * 0.2;
    this.panX += (this.targetPanX - this.panX) * 0.2;
    this.panY += (this.targetPanY - this.panY) * 0.2;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.physics.posInterleaved);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.strainBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.physics.strain);

    const [sx, sy] = this.getScaleXY();
    gl.uniform2f(this.uScale, sx, sy);
    gl.uniform2f(this.uPan, this.panX, this.panY);
    gl.uniform1f(this.uZoom, this.zoom);
    gl.uniform1f(this.uShading, this.shadingEnabled ? 1.0 : 0.0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uTex, 0);

    gl.drawElements(gl.TRIANGLES, this.physics.indices.length, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }
}
