const BUILD_MARKER = "v4-padding";
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { audio } from './game/audio';
import { initChannel } from './game/netclient';
import { store } from './game/store';
import { armBackGuard, installBackGuard } from './game/backguard';
import { startGamepadWatch } from './game/gamepadwatch';
import './style.css';

createApp(App).use(router).mount('#app');
// Android maps a controller B to system Back; keep it from closing the app.
// Wait for the router's first navigation, then arm the bottom sentinel so a
// Back press always has a same-document entry to consume.
installBackGuard();
void router.isReady().then(() => armBackGuard());
startGamepadWatch();

// Music starts at launch (Game1.LoadContent -> MediaPlayer.Play). Browsers
// block audio until the first user gesture, so retry once on the first
// pointer/key event anywhere in the page (and opportunistically when the page
// regains focus / the pointer moves, which covers browsers that already trust
// the origin).
const unlockOnce = (): void => {
  audio.unlock();
  window.removeEventListener('pointerdown', unlockOnce);
  window.removeEventListener('keydown', unlockOnce);
};
window.addEventListener('pointerdown', unlockOnce);
window.addEventListener('keydown', unlockOnce);
// A user gesture is the most reliable moment to make sure Android Back has
// an entry to consume.
window.addEventListener('pointerdown', armBackGuard, { capture: true });
document.addEventListener('visibilitychange', armBackGuard);

// Gamepad/system Back can arrive as a keyboard event on some platforms. While
// a match is live, cancel the browser's own Back/exit handling; our game
// handlers still run (this only prevents the default navigation/close).
// Silence browser default key bindings app-wide (Back/exit, fullscreen,
// zoom, find, tab shortcuts, controller keys the OS turns into key events).
// Text fields keep their keys so typing a username still works.
const silenceBrowserKey = (e: KeyboardEvent): void => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  e.preventDefault();
};
window.addEventListener('keydown', silenceBrowserKey, { capture: true });
window.addEventListener('keyup', silenceBrowserKey, { capture: true });

// Last line of defence: never let the page close or unload silently.
window.addEventListener('beforeunload', (e) => {
  e.preventDefault();
  e.returnValue = '';
});
const retry = (): void => {
  if (!audio.playing()) audio.unlock();
};
document.addEventListener('visibilitychange', retry);
window.addEventListener('focus', retry);
window.addEventListener('pointermove', retry, { passive: true });

(window as unknown as { __ieAudio?: typeof audio }).__ieAudio = audio;

// Optional WebSocket asset/scene channel (docs/protocol.md). Disabled unless a
// URL is configured, in which case converted level/model assets may travel as
// gzip-framed binary messages instead of HTTP fetches. Never blocks rendering;
// failures fall back to HTTP.
const net = initChannel();
(window as unknown as { __ieNet?: typeof net }).__ieNet = net;
if (net.enabled) {
  net.onStatus = (s) => console.debug('[net]', s.state, s.url);
}

// The browser must never offer its own options on this UI: a long press
// (mobile) or right click on any icon, button or the scene used to show
// "open image in new tab / download / share". Blocked app-wide; text inputs
// keep theirs so copy/paste still works while typing a name.
window.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  e.preventDefault();
}, { capture: true });
window.addEventListener('dragstart', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'IMG' || t.tagName === 'BUTTON')) e.preventDefault();
}, { capture: true });
