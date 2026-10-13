// BasicEffect-exact GLSL: ambient 0.001, LightBlue spec 1024, per-pixel.

export const LIT_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uWorld; uniform mat4 uView; uniform mat4 uProj; uniform mat4 uWorldInvT;
out vec3 vN; out vec3 vW; out vec2 vUV;
void main() {
  vec4 w = uWorld * vec4(aPos, 1.0);
  vW = w.xyz; vN = mat3(uWorldInvT) * aNormal; vUV = aUV;
  gl_Position = uProj * uView * w;
}`;

export const LIT_FRAG = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vW; in vec2 vUV;
uniform sampler2D uTex; uniform bool uHasTex;
uniform vec3 uDiffuse; uniform vec3 uEmissive; uniform vec3 uAmbient;
uniform vec3 uLightDir; uniform vec3 uLightDiffuse; uniform vec3 uLightSpec;
uniform float uShininess; uniform vec3 uCamPos; uniform float uAlpha;
out vec4 oColor;
void main() {
  vec3 base = uDiffuse;
  vec4 sampled = uHasTex ? texture(uTex, vUV) : vec4(1.0);
  base *= sampled.rgb;
  vec3 N = normalize(vN);
  vec3 L = normalize(uLightDir);
  float nd = max(dot(N, L), 0.0);
  vec3 V = normalize(uCamPos - vW);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), uShininess) * step(0.001, nd);
  vec3 col = base * (uAmbient + uLightDiffuse * nd) + uLightSpec * spec + uEmissive;
  oColor = vec4(col, uAlpha * sampled.a);
}`;

export const UNLIT_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uWorld; uniform mat4 uView; uniform mat4 uProj;
out vec2 vUV;
void main() { vUV = aUV; gl_Position = uProj * uView * uWorld * vec4(aPos, 1.0); }`;

export const UNLIT_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex; uniform bool uHasTex; uniform vec3 uColor; uniform float uAlpha;
out vec4 oColor;
void main() {
  vec4 t = uHasTex ? texture(uTex, vUV) : vec4(1.0);
  oColor = vec4(uColor * t.rgb, uAlpha * t.a);
}`;

export const BB_VERT = `#version 300 es
layout(location=0) in vec2 aCorner;
uniform vec3 uCenter; uniform float uSize;
uniform vec3 uRight; uniform vec3 uUp;
uniform mat4 uView; uniform mat4 uProj;
out vec2 vUV;
void main() {
  vec3 w = uCenter + (uRight * aCorner.x + uUp * aCorner.y) * (uSize * 0.5);
  vUV = aCorner * 0.5 + 0.5;
  gl_Position = uProj * uView * vec4(w, 1.0);
}`;

export const BB_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex; uniform bool uHasTex; uniform vec3 uColor; uniform float uAlpha;
out vec4 oColor;
void main() {
  vec4 t = uHasTex ? texture(uTex, vUV) : vec4(1.0);
  oColor = vec4(uColor * t.rgb, uAlpha * t.a);
}`;

// Batched billboards (same math as Draws.DrawBillBoard, one draw call per texture).
export const BBQ_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
layout(location=2) in vec3 aColor;
layout(location=3) in float aAlpha;
uniform mat4 uView; uniform mat4 uProj;
out vec2 vUV; out vec3 vColor; out float vAlpha;
void main() {
  vUV = aUV; vColor = aColor; vAlpha = aAlpha;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

export const BBQ_FRAG = `#version 300 es
precision highp float;
in vec2 vUV; in vec3 vColor; in float vAlpha;
uniform sampler2D uTex;
out vec4 oColor;
void main() {
  vec4 t = texture(uTex, vUV);
  oColor = vec4(vColor * t.rgb, vAlpha * t.a);
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('Shader compile failed: ' + log);
  }
  return s;
}

export function linkProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('Program link failed: ' + log);
  }
  return p;
}

export function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram, names: string[]): Record<string, WebGLUniformLocation | null> {
  const out: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) out[n] = gl.getUniformLocation(p, n);
  return out;
}
