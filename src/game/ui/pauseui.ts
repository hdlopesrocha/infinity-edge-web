// In-match pause menu, painted by the same WebGL MenuUi as every other screen.
//
// The frozen match stays visible behind it (GameCanvas draws the scene but does
// not update the simulation or the HUD). This controller owns the pause/options
// sub-screen state, the live option changes and the rollback rules that used to
// live in the DOM pause panel.

import type { Renderer } from '../../engine/renderer';
import type { Options } from '../resources';
import { audio } from '../audio';
import { normalizeHexColor, teamDefaultColor } from '../colors';
import { pickMusicFile } from '../musicfile';
import { clearGameData, saveOptions, store } from '../store';
import { enableVr, setVr } from '../vr';
import { leaveXr } from '../xr';
import { toggleFullscreen } from './fullscreen';
import { MenuUi } from './menuui';
import type { MenuCallbacks, MenuScreen } from './menuui';
import { optionsMenu, pauseMenu } from './screens';

export interface PauseHooks {
  /** Close the menu and let the match continue. */
  resume(): void;
  /** Close the menu and return to the briefing / previous menu. */
  leave(): void;
}

type View = 'main' | 'options';

export class PauseMenuUi {
  readonly ui: MenuUi;
  private view: View = 'main';
  private snapshot: Options | null = null;
  private saved = false;
  private hooks: PauseHooks;

  constructor(hooks: PauseHooks) {
    this.hooks = hooks;
    this.ui = new MenuUi(this.screen(), {
      onSelect: (id) => this.select(id),
      onChange: (id, value) => this.change(id, value),
      onBack: () => this.back(),
      onPrimary: () => this.primary(),
      onCrumb: (index) => this.crumb(index),
    } satisfies MenuCallbacks, () => this.ui.bump());
    this.refresh();
  }

  /** Prepare a fresh pause menu (main view, no stale rollback snapshot). */
  open(): void {
    this.revertOptions();
    this.view = 'main';
    this.saved = false;
    this.refresh();
  }

  /** Tear the menu down; unsaved settings are rolled back like CANCEL. */
  close(): void {
    this.revertOptions();
    this.view = 'main';
    this.saved = false;
  }

  /** Keyboard routing: Esc resumes from the main pause view, while the options
   *  view keeps MenuUi's normal back behaviour (revert and return). */
  key(e: KeyboardEvent): boolean {
    if (this.view === 'main' && e.key === 'Escape') {
      this.hooks.resume();
      return true;
    }
    return this.ui.key(e);
  }

  private renderer(): Renderer | null {
    return (window as unknown as { __ieRenderer?: Renderer }).__ieRenderer ?? null;
  }

  private screen(): MenuScreen {
    return this.view === 'main' ? pauseMenu() : optionsMenu();
  }

  private crumbs(): { label: string; current: boolean }[] {
    if (this.view === 'main') return [{ label: 'PAUSED', current: true }];
    return [
      { label: 'PAUSED', current: false },
      { label: 'SETTINGS', current: true },
    ];
  }

  private refresh(): void {
    this.ui.setScreen(this.screen());
    this.ui.setCrumbs(this.crumbs());
  }

  /** Live-apply the options mirror to the running game and audio. SAVE is the
   *  only path that persists the values; leaving options reverts them. */
  private applyLive(): void {
    const rc = (window as unknown as { __ieRC?: { options: Options } }).__ieRC;
    if (rc) Object.assign(rc.options, store.options);
    store.username = store.options.username;
    audio.setMusicVolume(store.options.musicVolume);
  }

  private revertOptions(): void {
    if (this.snapshot && !this.saved) {
      Object.assign(store.options, this.snapshot);
      this.applyLive();
    }
    this.snapshot = null;
    this.saved = false;
  }

  private openOptions(): void {
    this.snapshot = { ...store.options };
    this.saved = false;
    this.view = 'options';
    this.refresh();
  }

  private backToPause(): void {
    this.revertOptions();
    this.view = 'main';
    this.refresh();
  }

  private saveSettings(): void {
    if (store.options.username === '') store.options.username = 'Infinity Edge Fan';
    if (store.options.username === 'suckmyrocket') store.options.cheats = !store.options.cheats;
    saveOptions(store.options);
    this.applyLive();
    this.snapshot = null;
    this.saved = true;
    this.view = 'main';
    this.refresh();
  }

  private back(): void {
    if (this.view === 'options') {
      this.backToPause();
      return;
    }
    this.close();
    this.hooks.leave();
  }

  private primary(): void {
    if (this.view === 'options') {
      this.saveSettings();
      return;
    }
    this.close();
    this.hooks.resume();
  }

  private crumb(index: number): void {
    if (this.view === 'options' && index === 0) this.backToPause();
  }

  private select(id: string): void {
    audio.unlock();
    void audio.sfx('button');
    if (id === 'fs') {
      void toggleFullscreen().finally(() => this.ui.bump());
      return;
    }
    if (this.view === 'main') {
      if (id === 'pause:resume') this.primary();
      else if (id === 'pause:settings') this.openOptions();
      else if (id === 'pause:leave') this.back();
      return;
    }
    switch (id) {
      case 'clear':
        clearGameData();
        this.refresh();
        break;
      case 'vr-toggle':
        void this.toggleVr();
        break;
      case 'music':
        void this.pickMusic();
        break;
      case 'music-reset':
        void audio.useMusicFile(null).then(() => this.refresh());
        break;
      default:
        break;
    }
  }

  private change(id: string, value: number | boolean | string): void {
    const o = store.options;
    switch (id) {
      case 'username': o.username = String(value).slice(0, 12); break;
      case 'distance': o.distance = Math.round(Number(value)); break;
      case 'detail': o.detail = Math.round(Number(value)); break;
      case 'musicVolume':
        o.musicVolume = Number(value);
        audio.setMusicVolume(o.musicVolume);
        break;
      case 'billboards': o.billboards = Boolean(value); break;
      case 'zoomBlur': o.zoomBlur = Boolean(value); break;
      case 'showMs': o.showMs = Boolean(value); break;
      case 'partyMode': o.partyMode = Boolean(value); break;
      case 'dwellTime': o.dwellTime = Math.max(0.5, Math.min(5, Math.round(Number(value) * 10) / 10)); break;
      case 'team1Color':
        o.teamColors.team1 = normalizeHexColor(value, o.playerColor);
        o.playerColor = o.teamColors.team1;
        break;
      case 'team2Color': o.teamColors.team2 = normalizeHexColor(value, o.enemyColor); break;
      case 'team3Color': o.teamColors.team3 = normalizeHexColor(value, teamDefaultColor('team3')); break;
      case 'team4Color': o.teamColors.team4 = normalizeHexColor(value, teamDefaultColor('team4')); break;
      case 'axisX': o.axisX = Boolean(value); break;
      case 'axisY': o.axisY = Boolean(value); break;
      default: break;
    }
    this.applyLive();
    this.refresh();
  }

  private async pickMusic(): Promise<void> {
    const picked = await pickMusicFile();
    if (!picked) return;
    await audio.useMusicFile(picked);
    this.refresh();
  }

  private async toggleVr(): Promise<void> {
    if (store.vr) {
      leaveXr();
      setVr(false);
      this.refresh();
      return;
    }
    const r = this.renderer();
    if (!r) return;
    await enableVr({
      renderer: r,
      getInstance: () =>
        (window as unknown as { __ieGame?: import('../instance').GameInstance }).__ieGame ?? null,
      onEnd: () => undefined,
    });
    this.refresh();
  }
}
