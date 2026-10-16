import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { audio } from './game/audio';
import { initChannel } from './game/netclient';
import './style.css';

createApp(App).use(router).mount('#app');

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
