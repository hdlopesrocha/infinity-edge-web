// GLSL shaders reproducing XNA BasicEffect behavior used by the original game:
// Model3D.Draw sets PreferPerPixelLighting=true, one directional light (Light0),
// ambient ~0.001, diffuse white * texture, specular LightBlue, emissive add, alpha.
// Draws.cs primitives use LightingEnabled=false -> unlit textured path.
// Coordinate note: XNA row-major World*View*Proj == GLSL column-major proj*view*world.

export const LIT_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uWorld;
uniform mat4 uView;
uniform mat4 uProj;
uniform mat4 uWorldInvT; // inverse-transpose for correct normal transform
out vec3 vNormalW;
out vec3 vPosW;
out vec2 vUV;
void main() {
  vec4 w = uWorld * vec4(aPos, 1.0);
  vPosW = w.xyz;
  vNormalW = mat3(uWorldInvT) * aNormal;
  vUV = aUV;
  gl_Position = uProj * uView * w;
}`;

export const LIT_FRAG = `#version 300 es
precision highp float;
in vec3 vNormalW;
in vec3 vPosW;
in vec2 vUV;
uniform sampler2D uTex;
uniform bool uHasTex;
uniform vec3 uDiffuse;      // BasicEffect.DiffuseColor
uniform vec3 uEmissive;     // BasicEffect.EmissiveColor
uniform vec3 uAmbient;      // BasicEffect.AmbientLightColor
uniform vec3 uLightDir;     // direction TO light, world space (DirectionalLight0)
uniform vec3 uLightDiffuse;
uniform vec3 uLightSpec;
uniform float uShininess;   // SpecularPower mapped to Blinn-Phong range
uniform vec3 uCamPos;
uniform float uAlpha;       // BasicEffect.Alpha
out vec4 oColor;
void main() {
  vec3 base = uDiffuse;
  if (uHasTex) base *= texture(uTex, vUV).rgb;
  vec3 N = normalize(vNormalW);
  vec3 L = normalize(uLightDir);
  float nd = max(dot(N, L), 0.0);
  vec3 V = normalize(uCamPos - vPosW);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), uShininess) * step(0.001, nd);
  vec3 col = base * (uAmbient + uLightDiffuse * nd) + uLightSpec * spec + uEmissive;
  float a = uAlpha;
  if (uHasTex) a *= texture(uTex, vUV).a;
  oColor = vec4(col, a);
}`;

export const UNLIT_VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uWorld;
uniform mat4 uView;
uniform mat4 uProj;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = uProj * uView * uWorld * vec4(aPos, 1.0);
}`;

export const UNLIT_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform bool uHasTex;
uniform vec3 uColor;
uniform float uAlpha;
out vec4 oColor;
void main() {
  vec4 t = uHasTex ? texture(uTex, vUV) : vec4(1.0);
  oColor = vec4(uColor * t.rgb, uAlpha * t.a);
}`;

export function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
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

export function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  // Attribute locations are fixed via layout(location=) in GLSL; still bind for safety.
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('Program link failed: ' + log);
  }
  return p;
}

export interface LitProgram {
  prog: WebGLProgram;
  uWorld: WebGLUniformLocation | null;
  uView: WebGLUniformLocation | null;
  uProj: WebGLUniformLocation | null;
  uWorldInvT: WebGLUniformLocation | null;
  uTex: WebGLUniformLocation | null;
  uHasTex: WebGLUniformLocation | null;
  uDiffuse: WebGLUniformLocation | null;
  uEmissive: WebGLUniformLocation | null;
  uAmbient: WebGLUniformLocation | null;
  uLightDir: WebGLUniformLocation | null;
  uLightDiffuse: WebGLUniformLocation | null;
  uLightSpec: WebGLUniformLocation | null;
  uShininess: WebGLUniformLocation | null;
  uCamPos: WebGLUniformLocation | null;
  uAlpha: WebGLUniformLocation | null;
}

export interface UnlitProgram {
  prog: WebGLProgram;
  uWorld: WebGLUniformLocation | null;
  uView: WebGLUniformLocation | null;
  uProj: WebGLUniformLocation | null;
  uTex: WebGLUniformLocation | null;
  uHasTex: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uAlpha: WebGLUniformLocation | null;
}

function U(gl: WebGL2RenderingContext, p: WebGLProgram, n: string) {
  return gl.getUniformLocation(p, n);
}

export function createLitProgram(gl: WebGL2RenderingContext): LitProgram {
  const prog = linkProgram(
    gl,
    compileShader(gl, gl.VERTEX_SHADER, LIT_VERT),
    compileShader(gl, gl.FRAGMENT_SHADER, LIT_FRAG),
  );
  return {
    prog,
    uWorld: U(gl, prog, 'uWorld'),
    uView: U(gl, prog, 'uView'),
    uProj: U(gl, prog, 'uProj'),
    uWorldInvT: U(gl, prog, 'uWorldInvT'),
    uTex: U(gl, prog, 'uTex'),
    uHasTex: U(gl, prog, 'uHasTex'),
    uDiffuse: U(gl, prog, 'uDiffuse'),
    uEmissive: U(gl, prog, 'uEmissive'),
    uAmbient: U(gl, prog, 'uAmbient'),
    uLightDir: U(gl, prog, 'uLightDir'),
    uLightDiffuse: U(gl, prog, 'uLightDiffuse'),
    uLightSpec: U(gl, prog, 'uLightSpec'),
    uShininess: U(gl, prog, 'uShininess'),
    uCamPos: U(gl, prog, 'uCamPos'),
    uAlpha: U(gl, prog, 'uAlpha'),
  };
}

export function createUnlitProgram(gl: WebGL2RenderingContext): UnlitProgram {
  const prog = linkProgram(
    gl,
    compileShader(gl, gl.VERTEX_SHADER, UNLIT_VERT),
    compileShader(gl, gl.FRAGMENT_SHADER, UNLIT_FRAG),
  );
  return {
    prog,
    uWorld: U(gl, prog, 'uWorld'),
    uView: U(gl, prog, 'uView'),
    uProj: U(gl, prog, 'uProj'),
    uTex: U(gl, prog, 'uTex'),
    uHasTex: U(gl, prog, 'uHasTex'),
    uColor: U(gl, prog, 'uColor'),
    uAlpha: U(gl, prog, 'uAlpha'),
  };
}
