#version 300 es
precision highp float;

layout(location = 0) in vec2 aRest; // rest UV [0, 1]

uniform float uAspect;              // image width / height
uniform mat3 uView;                 // iso -> clip space
uniform int uGrabCount;
uniform vec4 uGrabA[8];             // anchor.xy (iso), radiusEff, strength (ease * mask)
uniform vec2 uGrabPull[8];          // pull.xy (iso)
uniform float uBulge;               // puffiness kappa
uniform vec2 uMotionDisp;           // optional phone motion sensor displacement (iso)
uniform sampler2D uMask;            // blurred squishy mask (R8)
uniform float uMaskEnabled;
uniform vec2 uMaskCell;             // 1 mesh cell in rest UV (for 4-tap smooth mask sampling)

out vec2 vUV;
out float vStrain;

// Exact quintic smootherstep complement: flat at center (100% locked to finger), C2 smooth to 0 at boundary
float falloff(float t) {
    float s = 1.0 - t;
    return s * s * s * (6.0 * t * t + 3.0 * t + 1.0);
}

// Ring function peaking at t = 1/3 with value 1.0 (outward mochi cheek puffiness)
float ring(float t) {
    return 6.75 * t * (1.0 - t) * (1.0 - t);
}

// 4-tap half-cell mask sampling prevents jagged vertex steps along sharp painted boundaries
float maskAt(vec2 uv) {
    vec2 h = uMaskCell * 0.5;
    return (textureLod(uMask, uv + vec2(-h.x, -h.y), 0.0).r +
            textureLod(uMask, uv + vec2( h.x, -h.y), 0.0).r +
            textureLod(uMask, uv + vec2(-h.x,  h.y), 0.0).r +
            textureLod(uMask, uv + vec2( h.x,  h.y), 0.0).r) * 0.25;
}

void main() {
    vec2 iso = vec2(aRest.x * uAspect, aRest.y);
    vec2 disp = vec2(0.0);
    float wsum = 0.0;
    float strainAcc = 0.0;

    for (int i = 0; i < 8; i++) {
        if (i >= uGrabCount) break;
        float strength = uGrabA[i].w;
        if (strength <= 0.0) continue;
        vec2 rel = iso - uGrabA[i].xy;
        float d = length(rel);
        float t = clamp(d / uGrabA[i].z, 0.0, 1.0);
        float w = falloff(t) * strength;
        vec2 pull = uGrabPull[i];
        float pullLen = length(pull);
        vec2 dir = d > 1e-5 ? rel / d : vec2(0.0);
        float rVal = ring(t);
        disp += w * pull + uBulge * pullLen * rVal * dir * strength;
        wsum += w;
        // Analytical directional strain for optional 3D squish shading (unused when uShading == 0)
        strainAcc += (dot(dir, pull) / max(0.05, uGrabA[i].z)) * rVal * strength;
    }

    // Apply mask & normalize overlapping multi-finger grabs identically to original
    float m = uMaskEnabled > 0.5 ? maskAt(aRest) : 1.0;
    disp = disp * (m / max(1.0, wsum)) + uMotionDisp * m;

    // Depth-lift pulled parts forward so stretched cheeks cleanly overlap stationary background
    float lift = clamp(wsum, 0.0, 1.0) * m;

    vec3 clip = uView * vec3(iso + disp, 1.0);
    gl_Position = vec4(clip.xy, -0.5 * lift, 1.0);
    vUV = aRest;
    vStrain = clamp(strainAcc * m * 1.4, -1.0, 1.0);
}
