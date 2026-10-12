// WebGL2 context management: init, resize/DPR, state setup, context-loss recovery.
// Mirrors Game1.cs Initialize(): multisample AA, Depth24, VSync-driven loop.

export interface GLContext {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  onLost: (() => void) | null;
  onRestored: (() => void) | null;
}

export function initGL(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  const gl = canvas.getContext('webgl2', {
    antialias: true, // PreferMultiSampling = true
    depth: true, // Depth24 approx (browser picks 16/24)
    stencil: false,
    alpha: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null;
  if (!gl) return null;
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK); // CullCounterClockwise like Map.Draw
  gl.frontFace(gl.CCW);
  gl.disable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(0, 0, 0, 1); // GraphicsDevice.Clear(Black)
  gl.clearDepth(1);
  return gl;
}

/** Resize canvas to CSS size * DPR (high-DPI support). Returns true if changed. */
export function resizeGL(
  canvas: HTMLCanvasElement,
  gl: WebGL2RenderingContext,
  maxDpr = 2,
): boolean {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    return true;
  }
  return false;
}

/** Wire context-lost/restored handlers so resources can be rebuilt. */
export function watchContextLoss(
  canvas: HTMLCanvasElement,
  onLost: () => void,
  onRestored: () => void,
): () => void {
  const lost = (e: Event) => {
    e.preventDefault();
    onLost();
  };
  const restored = () => onRestored();
  canvas.addEventListener('webglcontextlost', lost, false);
  canvas.addEventListener('webglcontextrestored', restored, false);
  return () => {
    canvas.removeEventListener('webglcontextlost', lost, false);
    canvas.removeEventListener('webglcontextrestored', restored, false);
  };
}
