#version 300 es
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
    vec2 clip = vec2(p.x * u_scale.x, -p.y * u_scale.y);
    gl_Position = vec4(clip, 0.0, 1.0);
    v_uv = a_uv;
    v_strain = a_strain;
}
