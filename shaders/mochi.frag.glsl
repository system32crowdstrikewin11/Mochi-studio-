#version 300 es
precision mediump float;

in vec2 vUV;
in float vStrain;

uniform sampler2D uTex;     // premultiplied alpha artwork
uniform sampler2D uMask;    // R8 mask (unblurred in Paint mode, blurred in Play mode)
uniform float uMaskView;    // 1 = Paint mode quantized pink mask overlay
uniform float uPass;        // 0 = opaque depth-write pass (a >= 0.95), 1 = soft fringe blend pass (a < 0.95)
uniform vec2 uTexSize;
uniform float uBicubic;     // 1 = bicubic B-spline sampling when zoomed in (> 1.05x)
uniform float uShading;     // 0 = pure 1:1 original artwork, 1 = optional soft 3D squish shading

out vec4 outColor;

vec4 cubicW(float v) {
    vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
    vec4 s = n * n * n;
    float x = s.x;
    float y = s.y - 4.0 * s.x;
    float z = s.z - 4.0 * s.y + 6.0 * s.x;
    float w = 6.0 - x - y - z;
    return vec4(x, y, z, w) * (1.0 / 6.0);
}

vec4 sampleImage(vec2 uv) {
    if (uBicubic < 0.5) return texture(uTex, uv);
    vec2 invSize = 1.0 / uTexSize;
    vec2 coord = uv * uTexSize - 0.5;
    vec2 fxy = fract(coord);
    coord -= fxy;
    vec4 xcubic = cubicW(fxy.x);
    vec4 ycubic = cubicW(fxy.y);
    vec4 c = coord.xxyy + vec2(-0.5, 1.5).xyxy;
    vec4 s = vec4(xcubic.xz + xcubic.yw, ycubic.xz + ycubic.yw);
    vec4 offset = (c + vec4(xcubic.yw, ycubic.yw) / s) * invSize.xxyy;
    vec4 s0 = texture(uTex, offset.xz);
    vec4 s1 = texture(uTex, offset.yz);
    vec4 s2 = texture(uTex, offset.xw);
    vec4 s3 = texture(uTex, offset.yw);
    float sx = s.x / (s.x + s.y);
    float sy = s.z / (s.z + s.w);
    return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}

void main() {
    vec4 c = sampleImage(vUV);
    if (uMaskView > 0.5) {
        float m = texture(uMask, vUV).r;
        // Exact original 4-step quantized mask view: Soft shows concentric rings, Sharp shows a crisp edge
        float mq = floor(m * 4.0 + 0.5) / 4.0;
        c *= 0.45 + 0.4 * mq;
        c += vec4(1.0, 0.55, 0.68, 1.0) * (0.35 * mq);
    } else if (uPass < 0.5) {
        if (c.a < 0.95) discard;
    } else {
        if (c.a < 0.004 || c.a >= 0.95) discard;
    }

    if (uMaskView < 0.5 && uShading > 0.5) {
        float s = clamp(vStrain, -1.0, 1.0);
        if (s > 0.0) {
            c.rgb = mix(c.rgb, vec3(c.a, c.a * 0.995, c.a * 0.99), s * 0.08);
        } else if (s < 0.0) {
            c.rgb = mix(c.rgb, c.rgb * vec3(0.96, 0.91, 0.93), (-s) * 0.10);
        }
    }

    outColor = c;
}
