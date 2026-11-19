#version 300 es
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
    if (s > 0.0) {
        rgb = mix(rgb, vec3(col.a, col.a * 0.995, col.a * 0.99), s * 0.08);
    } else if (s < 0.0) {
        rgb = mix(rgb, rgb * vec3(0.96, 0.91, 0.93), (-s) * 0.10);
    }

    outColor = vec4(rgb, col.a);
}
