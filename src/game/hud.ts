// HUD snapshot shared by the normal frame loop and the WebXR session loop.
// (Was a local in GameCanvas.vue; the XR loop needs the same snapshot because
// the in-GL HUD overlay renders from it while the DOM is hidden.)
import { store } from './store';
import type { GameInstance } from './instance';
import { Life3 } from './life';
import { hexToRgb } from './colors';

/**
 * Snapshot, written right after the scene draw, i.e. after every movement of
 * the frame, so the HUD (markers, aim, life, throttle) always shows the
 * positions that were just rendered instead of trailing by a frame or by the
 * old 66 ms interval.
 */
export function syncHud(g: GameInstance): void {
  if (g.gameType === 'BACK') return;
  const hud = store.hud;
  hud.score = g.scoreText();
  hud.notify = g.notificationText;
  // HUD accents follow the selected ship's live team colour: the chosen player
  // colour normally, and the rotating/flashing party colour when active.
  const accent = g.selectedObject?.team?.color;
  hud.accent = accent
    ? [accent[0], accent[1], accent[2]]
    : hexToRgb(store.options.playerColor, [64 / 255, 224 / 255, 208 / 255]);
  const aim = g.aimPos();
  hud.aimX = aim.x;
  hud.aimY = aim.y;
  const sel = g.selectedObject;
  if (sel?.life instanceof Life3) {
    hud.life = [
      { value: sel.life.left, max: sel.life.maxLeft },
      { value: sel.life.center, max: sel.life.maxCenter },
      { value: sel.life.right, max: sel.life.maxRight },
    ];
  } else if (sel?.life) {
    hud.life = [{ value: sel.life.total(), max: 100 }];
  } else {
    hud.life = [];
  }
  // Timers the original showed as voices only: the 10 s window before a ship
  // that left the field of battle is destroyed, and the 10 s respawn wait
  // after the player's ship was destroyed (Map MANAGE_OUTSIDERS / MANAGE
  // RESPAWNS). The HUD shows them as countdowns.
  hud.outside = null;
  hud.respawn = null;
  if (sel && !sel.insideMap) {
    const t = g.map.outsideObjects.find((o) => o.obj === sel);
    if (t) hud.outside = { left: Math.max(0, t.max - t.elapsed), total: t.max };
  }
  if (sel) {
    const r = g.map.respawned.find((o) => o.obj === sel);
    if (r) hud.respawn = { left: Math.max(0, r.max - r.elapsed), total: r.max };
  }
  // Match clock: the level's MoreTime goal is when the match ends.
  hud.matchLeft = g.matchTimeMs > 0 && sel ? Math.max(0, g.matchTimeMs - sel.team.timeMs) : null;
  hud.speed = sel ? Math.hypot(sel.vel[0], sel.vel[1], sel.vel[2]) : 0;
  hud.missileWarn = g.missileLocked();
  hud.lockOn = g.lockCandidate();
  hud.countdown = g.startCountdownMs > 0 ? Math.ceil(g.startCountdownMs / 1000) : 0;
  hud.deathCause = g.deathCause;
  hud.homings = g.control.homings;
  hud.nitroPct = Math.floor(g.control.nitroFrac * 100);
  hud.stickOn = g.control.analogStick.enabled;
  hud.backX = g.control.analogStick.backX;
  hud.backY = g.control.analogStick.backY;
  hud.knobX = g.control.analogStick.stickX;
  hud.knobY = g.control.analogStick.stickY;
  hud.acel = g.control.analogAcel.value;
  hud.pointers = g.pointers();
  hud.canvasW = g.canvasW;
  hud.canvasH = g.canvasH;
  hud.frameMs = g.renderer.frameMs;
  hud.frame++;
}
