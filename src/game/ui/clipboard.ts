// Clipboard helper shared by the menu screens and the multiplayer lobby.
//
// Uses the async Clipboard API when available and falls back to a hidden
// textarea + execCommand (which still works in insecure contexts / older
// browsers and inside some embedded views).

/** Copy text to the clipboard (best-effort; never throws). */
export function copyText(text: string): void {
  const fallback = (): void => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch { /* clipboard unavailable */ }
  };
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(fallback);
      return;
    }
  } catch { /* fall through to the textarea fallback */ }
  fallback();
}
