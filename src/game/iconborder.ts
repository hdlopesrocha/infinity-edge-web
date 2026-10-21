// Runtime border images for DOM HUD markers.
//
// CSS-only masking (full icon XOR an inset copy) is a good fallback, but it
// also outlines transparent *detail inside* an icon (the dark panels of the
// base texture, for example). The GL/XR HUD traces only the outer contour, so
// the DOM path uses the same alpha flood-fill to generate a 1 px ring. Images
// are loaded once and the data URLs cached per colour and display size.

import type { Rgb } from './colors';

type Ring = string | null;

const imageCache = new Map<string, HTMLImageElement>();
const ringCache = new Map<string, Ring>();
let listener: (() => void) | null = null;

/** GameView subscribes so a late image load repaints the marker list. */
export function onMarkerBorderReady(fn: (() => void) | null): void {
  listener = fn;
}

function notify(): void {
  if (!listener) return;
  queueMicrotask(() => listener?.());
}

function ringCanvas(
  img: HTMLImageElement,
  color: Rgb,
  cw: number,
  ch: number,
): string | null {
  const cv = document.createElement('canvas');
  cv.width = cw;
  cv.height = ch;
  const g = cv.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0, cw, ch);
  const data = g.getImageData(0, 0, cw, ch).data;
  const out = g.createImageData(cw, ch);
  const r = Math.round(color[0] * 255);
  const gg = Math.round(color[1] * 255);
  const b = Math.round(color[2] * 255);

  // Mark transparent pixels connected to the canvas edge. Transparent pixels
  // enclosed by the silhouette (internal art) stay holes, not outside.
  const outside = new Uint8Array(cw * ch);
  const queue = new Int32Array(cw * ch);
  let head = 0;
  let tail = 0;
  const push = (x: number, y: number): void => {
    const p = y * cw + x;
    if (outside[p] || data[p * 4 + 3] > 8) return;
    outside[p] = 1;
    queue[tail++] = p;
  };
  for (let x = 0; x < cw; x++) { push(x, 0); push(x, ch - 1); }
  for (let y = 1; y < ch - 1; y++) { push(0, y); push(cw - 1, y); }
  while (head < tail) {
    const p = queue[head++];
    const x = p % cw;
    const y = (p / cw) | 0;
    if (x > 0) push(x - 1, y);
    if (x + 1 < cw) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y + 1 < ch) push(x, y + 1);
  }
  const isOutside = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= cw || y >= ch || outside[y * cw + x] === 1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4;
      if (data[i + 3] <= 8) continue;
      if (!(
        isOutside(x - 1, y) || isOutside(x + 1, y) ||
        isOutside(x, y - 1) || isOutside(x, y + 1) ||
        isOutside(x - 1, y - 1) || isOutside(x + 1, y - 1) ||
        isOutside(x - 1, y + 1) || isOutside(x + 1, y + 1)
      )) continue;
      out.data[i] = r;
      out.data[i + 1] = gg;
      out.data[i + 2] = b;
      out.data[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  return cv.toDataURL('image/png');
}

/** Data URL of a coloured 1 px inner ring, or null while the image loads. */
export function iconBorderDataUrl(
  url: string, color: Rgb, width: number, height: number,
): string | null {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const cw = Math.max(1, Math.round(width));
  const ch = Math.max(1, Math.round(height));
  const key = `${url}|${color[0]},${color[1]},${color[2]}|${cw}x${ch}`;
  const cached = ringCache.get(key);
  if (cached !== undefined) return cached;

  let img = imageCache.get(url);
  if (img?.complete && img.naturalWidth > 0) {
    const ring = ringCanvas(img, color, cw, ch);
    ringCache.set(key, ring);
    return ring;
  }
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      // Drop all pending entries for this URL; the next paint generates them
      // synchronously from the now-decoded image.
      for (const k of [...ringCache.keys()]) {
        if (k.startsWith(url + '|') && ringCache.get(k) === null) ringCache.delete(k);
      }
      notify();
    };
    img.onerror = () => notify();
    img.src = url;
    imageCache.set(url, img);
  }
  if (ringCache.size > 64) {
    const first = ringCache.keys().next();
    if (!first.done) ringCache.delete(first.value);
  }
  ringCache.set(key, null);
  return null;
}
