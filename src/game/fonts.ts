// The boot/start wordmarks used to be two bitmap logos; they are text in the
// original Airstrike face now (public/assets/fonts/airstrike.ttf). The font is
// preloaded from index.html and requested before the heavy asset preload, so
// the first screens can paint it as soon as it arrives; MenuView repaints when
// the face is ready. Without it the canvas falls back to the system font.
export const WORDMARK_FAMILY = 'Airstrike';

const FONT_URL = (import.meta.env.BASE_URL + 'assets/fonts/airstrike.ttf').replace(/([^:])\/\//g, '$1/');

let pending: Promise<boolean> | null = null;

/** Load the wordmark face once; resolves false on non-browser/unsupported. */
export function loadWordmarkFont(): Promise<boolean> {
  if (pending) return pending;
  pending = (async () => {
    if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) return false;
    try {
      const face = new FontFace(WORDMARK_FAMILY, `url(${FONT_URL})`, { weight: '400', style: 'normal' });
      await face.load();
      document.fonts.add(face);
      return true;
    } catch {
      // Missing/blocked font: keep the fallback stack, the text still shows.
      return false;
    }
  })();
  return pending;
}

/** Canvas font string for a wordmark size (device pixels). */
export function wordmarkFont(size: number): string {
  return `${Math.max(1, Math.round(size))}px ${WORDMARK_FAMILY}, 'DejaVu Sans', Verdana, sans-serif`;
}
