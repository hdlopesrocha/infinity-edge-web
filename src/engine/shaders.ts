// BasicEffect-exact GLSL: ambient 0.001, LightBlue spec 1024, per-pixel.

// Motion-vector convention, shared by every pass that writes one. Mirrors
// src/engine/motion.ts (single source of truth): independent perspective
// divides, NDC -> UV with +Y up in both, velocity = currentUV - previousUV in
// UV per rendered frame. Never subtract matrices, never scale by delta time.
export const MB_VELOCITY_GLSL = `
vec2 mbClipToUV(vec4 clip) {
  return clip.xy / max(clip.w, 1e-4) * 0.5 + 0.5;
}
vec2 mbVelocity(vec4 curClip, vec4 prevClip) {
  return mbClipToUV(curClip) - mbClipToUV(prevClip);
}`;

export const LIT_VERT = `#version 300 es
${MB_VELOCITY_GLSL}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uWorld; uniform mat4 uView; uniform mat4 uProj; uniform mat4 uWorldInvT;
uniform mat4 uPrevWorld; uniform mat4 uViewProjPrev;
out vec3 vN; out vec3 vW; out vec2 vUV; out vec2 vVel;
void main() {
  vec4 w = uWorld * vec4(aPos, 1.0);
  vW = w.xyz; vN = mat3(uWorldInvT) * aNormal; vUV = aUV;
  vec4 cur = uProj * uView * w;
  vec4 prev = uViewProjPrev * (uPrevWorld * vec4(aPos, 1.0));
  vVel = mbVelocity(cur, prev);
  gl_Position = cur;
}`;

export const LIT_FRAG = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vW; in vec2 vUV; in vec2 vVel;
uniform sampler2D uTex; uniform bool uHasTex;
uniform vec3 uDiffuse; uniform vec3 uEmissive; uniform vec3 uAmbient;
uniform vec3 uLightDir; uniform vec3 uLightDiffuse; uniform vec3 uLightSpec;
uniform float uShininess; uniform vec3 uCamPos; uniform float uAlpha;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;
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
  oVelocity = vec4(vVel, 0.0, 1.0);
}`;

export const UNLIT_VERT = `#version 300 es
${MB_VELOCITY_GLSL}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uWorld; uniform mat4 uView; uniform mat4 uProj;
uniform mat4 uPrevWorld; uniform mat4 uViewProjPrev;
out vec2 vUV; out vec2 vVel;
void main() {
  vUV = aUV;
  vec4 cur = uProj * uView * uWorld * vec4(aPos, 1.0);
  vec4 prev = uViewProjPrev * (uPrevWorld * vec4(aPos, 1.0));
  vVel = mbVelocity(cur, prev);
  gl_Position = cur;
}`;

export const UNLIT_FRAG = `#version 300 es
precision highp float;
in vec2 vUV; in vec2 vVel;
uniform sampler2D uTex; uniform bool uHasTex; uniform vec3 uColor; uniform float uAlpha;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;
void main() {
  vec4 t = uHasTex ? texture(uTex, vUV) : vec4(1.0);
  oColor = vec4(uColor * t.rgb, uAlpha * t.a);
  oVelocity = vec4(vVel, 0.0, 1.0);
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

// Batched billboards (same math as Draws.DrawBillBoard, one draw call per
// texture). aPrevPos carries the previous frame's world position so the pass
// can write real per-object velocity for the motion-blur stage.
export const BBQ_VERT = `#version 300 es
${MB_VELOCITY_GLSL}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aPrevPos;
layout(location=2) in vec2 aUV;
layout(location=3) in vec3 aColor;
layout(location=4) in float aAlpha;
uniform mat4 uView; uniform mat4 uProj; uniform mat4 uViewProjPrev;
out vec2 vUV; out vec3 vColor; out float vAlpha; out vec2 vVel;
void main() {
  vUV = aUV; vColor = aColor; vAlpha = aAlpha;
  vec4 cur = uProj * uView * vec4(aPos, 1.0);
  vec4 prev = uViewProjPrev * vec4(aPrevPos, 1.0);
  vVel = mbVelocity(cur, prev);
  gl_Position = cur;
}`;

export const BBQ_FRAG = `#version 300 es
precision highp float;
in vec2 vUV; in vec3 vColor; in float vAlpha; in vec2 vVel;
uniform sampler2D uTex;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;
void main() {
  vec4 t = texture(uTex, vUV);
  oColor = vec4(vColor * t.rgb, vAlpha * t.a);
  oVelocity = vec4(vVel, 0.0, 1.0);
}`;

// ---------------------------------------------------------------- smoke
// Real (non-sprite) smoke: each particle is a camera-facing disc whose density
// comes from a tileable 3D Perlin field sampled in world space, animated over
// the particle's lifetime (drift + turbulence), with a soft-particle depth fade
// against the scene depth copy so puffs dissolve into geometry instead of
// intersecting it hard.
export const SMOKE_VERT = `#version 300 es
${MB_VELOCITY_GLSL}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aPrevPos;
layout(location=2) in vec2 aUV;
layout(location=3) in vec4 aData;   // x seed, y age01, z alpha, w turbulence
uniform mat4 uView; uniform mat4 uProj; uniform mat4 uViewProjPrev;
out vec2 vUV; out vec4 vData; out vec3 vWorld; out vec4 vClip; out vec2 vVel;
void main() {
  vUV = aUV; vData = aData; vWorld = aPos;
  vec4 cur = uProj * uView * vec4(aPos, 1.0);
  vec4 prev = uViewProjPrev * vec4(aPrevPos, 1.0);
  vVel = mbVelocity(cur, prev);
  vClip = cur;
  gl_Position = cur;
}`;

export const SMOKE_FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUV; in vec4 vData; in vec3 vWorld; in vec4 vClip; in vec2 vVel;
uniform sampler3D uNoise;
uniform sampler2D uDepth;
uniform float uTime; uniform float uNear; uniform float uFar;
uniform vec3 uTint; uniform float uFreq; uniform float uSoftness; uniform float uDensity;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;

float linearDepth(float ndc) {
  float z = ndc * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

void main() {
  float seed = vData.x;
  float age = vData.y;
  float alpha = vData.z;
  float turb = vData.w;

  // round puff with a soft edge
  vec2 q = vUV * 2.0 - 1.0;
  float r = length(q);
  if (r > 1.0) discard;
  float edge = smoothstep(1.0, 0.1, r);

  // world-space noise field: drifts upward and swirls; two octaves move at
  // different speeds so the puff keeps "boiling" instead of scrolling rigidly
  vec3 p = vWorld * uFreq + vec3(seed * 11.7, -uTime * 0.35, seed * 3.1);
  float n = texture(uNoise, p).r;
  float ridged = texture(uNoise, p * 2.1 + vec3(uTime * 0.06, -uTime * 0.21, 0.0)).g;
  float density = n * (0.55 + 0.75 * ridged) * (1.0 - turb * 0.35 * (1.0 - age));
  density = clamp((density - 0.22) * 2.8, 0.0, 1.0);

  // life curve: quick fade-in, long fade-out
  float life = smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(0.35, 1.0, age));

  float a = edge * density * life * alpha * uDensity;

  // soft particles: fade where the puff is about to intersect geometry
  vec2 suv = (vClip.xy / max(vClip.w, 1e-4)) * 0.5 + 0.5;
  float sceneZ = linearDepth(texture(uDepth, suv).r);
  float fragZ = linearDepth(vClip.z / max(vClip.w, 1e-4));
  a *= clamp((sceneZ - fragZ) * uSoftness, 0.0, 1.0);
  if (a <= 0.002) discard;

  oColor = vec4(uTint, a);
  oVelocity = vec4(vVel, 0.0, 1.0);
}`;

// ---------------------------------------------------------------- flare mesh
// Engine flare as real 3D geometry: an additive cone plume that lives in the
// ship's frame (parallax when the camera moves) with a volumetric thickness
// term and noise-driven flicker instead of a camera-facing sprite.
export const PLUME_VERT = `#version 300 es
${MB_VELOCITY_GLSL}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
uniform mat4 uWorld; uniform mat4 uPrevWorld; uniform mat4 uView; uniform mat4 uProj; uniform mat4 uViewProjPrev;
out vec3 vN; out vec3 vW; out vec2 vUV; out vec2 vVel;
void main() {
  vec4 w = uWorld * vec4(aPos, 1.0);
  vW = w.xyz; vN = mat3(uWorld) * aNormal; vUV = aUV;
  vec4 cur = uProj * uView * w;
  vec4 prev = uViewProjPrev * (uPrevWorld * vec4(aPos, 1.0));
  vVel = mbVelocity(cur, prev);
  gl_Position = cur;
}`;

export const PLUME_FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec3 vN; in vec3 vW; in vec2 vUV; in vec2 vVel;
uniform sampler3D uNoise;
uniform vec3 uCamPos; uniform vec3 uColor; uniform float uTime; uniform float uIntensity;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;

// Turbine / afterburner fire: a blue-white core right at the nozzle that turns
// orange further down the plume, turbulent tongues eating into the envelope,
// faint shock diamonds and a hot axial core.
void main() {
  vec3 V = normalize(uCamPos - vW);
  vec3 N = normalize(vN);
  float t = clamp(vUV.y, 0.0, 1.0);              // 0 nozzle -> 1 tip

  // volumetric thickness: the tube is brightest through its middle
  float thick = pow(max(abs(dot(N, V)), 0.0), 1.0);

  // turbulent burn: two noise octaves scrolling down the flame at different
  // speeds make the tongues flicker instead of a static cone
  float n1 = texture(uNoise, vec3(vUV.x * 5.0, t * 3.0 - uTime * 2.6, uTime * 0.40)).r;
  float n2 = texture(uNoise, vec3(vUV.x * 11.0, t * 7.0 - uTime * 4.2, uTime * 0.75)).g;
  float turb = n1 * 0.65 + n2 * 0.45;

  // envelope: strong at the nozzle, thinning out (and eaten by the turbulence)
  float env = exp(-t * 1.9) * (1.0 - smoothstep(0.55, 1.0, t));
  float burn = env * (0.45 + 1.0 * turb);

  // colour ramp: blue-white core -> orange/yellow tail
  vec3 coreCol = vec3(0.72, 0.86, 1.0);
  vec3 tailCol = uColor;
  vec3 col = mix(coreCol, tailCol, smoothstep(0.0, 0.22, t + turb * 0.15));

  // hot axial core + faint shock diamonds along the plume
  float axial = pow(max(abs(dot(N, V)), 0.0), 6.0) * exp(-t * 4.0);
  float diamonds = 0.75 + 0.25 * sin(t * 26.0 - uTime * 9.0);
  col += vec3(0.65, 0.85, 1.0) * axial * diamonds * 0.9;

  float a = clamp(thick * burn * uIntensity, 0.0, 1.0);
  if (a <= 0.002) discard;
  oColor = vec4(col * a, a);
  oVelocity = vec4(vVel, 0.0, 1.0);
}`;

// ---------------------------------------------------------------- glow shell
// Spherical additive halo used for bullets, addons and pickup flashes: real
// geometry with a thickness term, no camera-facing quad.
export const GLOW_VERT = PLUME_VERT;

export const GLOW_FRAG = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vW; in vec2 vUV; in vec2 vVel;
uniform vec3 uCamPos; uniform vec3 uColor; uniform float uIntensity; uniform float uSoftness;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;
void main() {
  vec3 V = normalize(uCamPos - vW);
  // uSoftness: high = tight hot spot (engine glow), low = broad fireball
  float a = pow(max(0.0, abs(dot(normalize(vN), V))), uSoftness) * uIntensity;
  if (a <= 0.002) discard;
  oColor = vec4(uColor * a, a);
  oVelocity = vec4(vVel, 0.0, 1.0);
}`;

// ---------------------------------------------------------------- post chain
export const FS_VERT = `#version 300 es
layout(location=0) in vec2 aCorner;
out vec2 vUV;
void main() { vUV = aCorner * 0.5 + 0.5; gl_Position = vec4(aCorner, 0.0, 1.0); }`;

export const POST_MB_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uColor;    // sharp 3D objects (premultiplied, alpha = coverage)
uniform sampler2D uVelocity; // per-pixel screen velocity, UV/frame
uniform sampler2D uDepth;    // opaque scene depth (window space copy)
uniform float uShutter;      // exposure / rendered frame interval (1 = one frame)
uniform float uMaxLen;       // streak cap in UV
uniform float uNear; uniform float uFar;
uniform float uDepthTol;     // relative view-depth tolerance
uniform int uSamples;        // integration samples, <= MB_MAX_SAMPLES
out vec4 oColor;
const int MB_MAX_SAMPLES = 32;
// Interleaved gradient noise: offsets the tap pattern per pixel so the streak
// is smooth instead of a stack of discrete, faded copies.
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float viewDepth(vec2 uv) {
  float ndc = texture(uDepth, uv).r * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}
void main() {
  vec4 c = texture(uColor, vUV);
  // uVelocity holds the screen motion of the surface under this pixel
  // *relative to the camera*: the scene shaders project each vertex with the
  // current and the previous view-projection (currentUV - previousUV), so
  // camera translation/rotation and the object's own movement are both in it,
  // with perspective baked in (near surfaces move far, distant ones barely).
  vec2 flow = texture(uVelocity, vUV).xy * uShutter;
  float len = length(flow);
  if (len < 0.0015) { oColor = c; return; }   // negligible motion: stay sharp
  if (len > uMaxLen) flow *= uMaxLen / len;    // extreme motion: clamp
  float d0 = viewDepth(vUV);
  float j = ign(gl_FragCoord.xy);
  int n = clamp(uSamples, 2, MB_MAX_SAMPLES);
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < MB_MAX_SAMPLES; i++) {
    if (i >= n) break;
    // Trailing exposure: t = 0 is this frame, t = -1 the start of the
    // exposure, so the streak always trails behind the motion, never ahead.
    float t = -1.0 + (float(i) + j) / float(n);
    vec2 suv = clamp(vUV + flow * t, vec2(0.0), vec2(1.0));
    // Weight by depth similarity instead of hard rejection: samples that land
    // on a much nearer/further surface fade out, so a streak does not smear
    // one surface across another, while a surface's own trail survives.
    float d = viewDepth(suv);
    float rel = abs(d - d0) / max(uDepthTol * max(d, d0), 1e-4);
    float w = 1.0 / (1.0 + rel * rel);
    sum += texture(uColor, suv) * w;
    wsum += w;
  }
  // Coverage is averaged too: the composite lays the sharp objects over this.
  oColor = wsum > 0.0 ? sum / wsum : c;
}`;

// Debug view for the motion-blur stage: renders the per-pixel velocity buffer
// straight to the canvas. Red = signed +x, green = signed +y (both scaled and
// biased around mid grey), blue = magnitude. Enable with
//   #/game/<level>?debug=velocity
// (optionally &scale=<n>, default 10).
export const POST_VELOCITY_DEBUG_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uVelocity;  // UV per frame, signed
uniform float uScale;
out vec4 oColor;
void main() {
  vec2 v = texture(uVelocity, vUV).xy * uScale;
  oColor = vec4(clamp(v.x, -1.0, 1.0) * 0.5 + 0.5,
                clamp(v.y, -1.0, 1.0) * 0.5 + 0.5,
                clamp(length(v), 0.0, 1.0), 1.0);
}`;

export const POST_BRIGHT_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uColor; uniform float uThreshold;
out vec4 oColor;
void main() {
  vec3 c = texture(uColor, vUV).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float k = smoothstep(uThreshold, uThreshold + 0.4, l);
  oColor = vec4(c * k, 1.0);
}`;

export const POST_BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex; uniform vec2 uDir;
out vec4 oColor;
void main() {
  vec3 sum = texture(uTex, vUV).rgb * 0.227;
  sum += (texture(uTex, vUV + uDir * 1.0).rgb + texture(uTex, vUV - uDir * 1.0).rgb) * 0.194;
  sum += (texture(uTex, vUV + uDir * 2.0).rgb + texture(uTex, vUV - uDir * 2.0).rgb) * 0.121;
  sum += (texture(uTex, vUV + uDir * 3.0).rgb + texture(uTex, vUV - uDir * 3.0).rgb) * 0.054;
  oColor = vec4(sum, 1.0);
}`;

// Lens flare: broad halo + ghost chain of the bright pass, mirrored and scaled
// through the screen centre and shaped by the flare2 sprite (the original's
// flare texture). Because the bright pass is taken from the *rendered* scene,
// occluded sources never produce a flare.
export const POST_COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uSky; uniform sampler2D uSharp; uniform sampler2D uBlur;
uniform sampler2D uBloom; uniform sampler2D uFlareTex;
uniform float uBlurAmount; uniform float uFlare; uniform float uExposureKnee;
out vec4 oColor;
void main() {
  // A + C + B, composited premultiplied: the sky (never blurred), the blurred
  // objects over it, then the sharp objects over both -- so objects stay crisp
  // and only their trail smears.
  vec3 sky = texture(uSky, vUV).rgb;
  vec4 sharp = texture(uSharp, vUV);
  vec4 blur = texture(uBlur, vUV) * uBlurAmount;
  vec3 col = blur.rgb + sky * (1.0 - blur.a);
  col = sharp.rgb + col * (1.0 - sharp.a);
  vec2 d = vUV - vec2(0.5);
  if (uFlare > 0.0) {
    vec3 flare = texture(uBloom, vUV).rgb * 0.30;
    for (int i = 0; i < 5; i++) {
      float k = -0.35 + float(i) * 0.55;
      vec2 g = vec2(0.5) + d * (1.0 + k) * -1.0 + d * k;
      g = clamp(g, vec2(0.0), vec2(1.0));
      vec3 s = texture(uBloom, g).rgb;
      vec2 fuv = (g - vec2(0.5)) * 1.5 + vec2(0.5);
      float shape = texture(uFlareTex, fuv).r * 0.5 + texture(uFlareTex, fuv.yx * 0.9).g * 0.5;
      flare += s * shape * (0.6 / (1.0 + float(i) * 0.8));
    }
    col += flare * uFlare;
  }
  // gentle knee above 1.0 so additive highlights roll off instead of clipping
  vec3 over = max(vec3(0.0), col - 1.0);
  col = col - over * uExposureKnee;
  oColor = vec4(col, 1.0);
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
