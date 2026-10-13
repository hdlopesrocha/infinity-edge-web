import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { audio } from './game/audio';
import './style.css';

createApp(App).use(router).mount('#app');

// Music starts at launch (Game1.LoadContent -> MediaPlayer.Play). Browsers
// block audio until the first user gesture, so retry once on the first
// pointer/key event anywhere in the page.
const unlockOnce = (): void => {
  audio.unlock();
  window.removeEventListener('pointerdown', unlockOnce);
  window.removeEventListener('keydown', unlockOnce);
};
window.addEventListener('pointerdown', unlockOnce);
window.addEventListener('keydown', unlockOnce);

(window as unknown as { __ieAudio?: typeof audio }).__ieAudio = audio;
