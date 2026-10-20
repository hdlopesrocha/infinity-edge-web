// WebGL menu content: the screens the MenuView paints and the ?username= link
// parameter (both are pure data, so they are testable in Node).
import { describe, expect, it } from 'vitest';
import * as screens from '../src/game/ui/screens';
import { parseUsernameParam } from '../src/game/resources';
import { store } from '../src/game/store';

describe('menu screens', () => {
  it('boot/engine/start screens use text wordmarks (Airstrike), not logo bitmaps', () => {
    expect(screens.bootScreen('boot', null).wordmark).toBe('Infinity Edge');
    expect(screens.bootScreen('engine', null).wordmark).toBe('Floating Gear');
    expect(screens.bootScreen('start', null).wordmark).toBe('Infinity Edge');
    // The old `logo` field is gone; screens carry text only.
    expect('logo' in screens.bootScreen('engine', null)).toBe(false);
  });

  it('main menu: one icon per entry, including multiplayer', () => {
    const s = screens.mainMenu();
    expect(s.left?.icons?.map((i) => i.id)).toEqual([
      '/single-player', '/multiplayer', '/hangar', '/options', '/about',
    ]);
    expect(s.left?.icons?.every((i) => !!i.icon)).toBe(true);
    expect(s.left?.icons?.find((i) => i.id === '/multiplayer')?.icon).toBe('_multiPlayer.png');
    expect(s.left?.buttons).toBeUndefined();
    expect(s.title).toBe('MAIN MENU');
  });

  it('mode menus: difficulties follow the TEAMS/SOLO switch', () => {
    const teams = screens.modeMenu('kots');
    expect(teams.left?.icons?.map((i) => i.id)).toEqual([
      '/briefing/kots-teams-easy', '/briefing/kots-teams-normal', '/briefing/kots-teams-hard',
    ]);
    expect(teams.left?.buttons?.[0]).toEqual({ id: 'mode-toggle', label: 'TEAMS' });
    screens.toggleTeamsMode();
    const solo = screens.modeMenu('kots');
    expect(solo.left?.icons?.map((i) => i.id)).toEqual([
      '/briefing/kots-solo-easy', '/briefing/kots-solo-normal', '/briefing/kots-solo-hard',
    ]);
    expect(solo.left?.buttons?.[0]?.label).toBe('SOLO');
    screens.toggleTeamsMode();
  });

  it('tracks menu: one button per track and the class watermark', () => {
    const normal = screens.tracksMenu('normal');
    expect(normal.left?.buttons?.map((b) => b.id)).toEqual([
      '/briefing/tt-normal-01', '/briefing/tt-normal-02', '/briefing/tt-normal-03', '/briefing/tt-normal-04',
    ]);
    expect(normal.right?.watermark).toBe('_normal.png');
    const hard = screens.tracksMenu('hard');
    expect(hard.left?.buttons?.map((b) => b.label)).toEqual(['Demo Track']);
  });

  it('options: every row the WebGL screen draws', () => {
    const s = screens.optionsMenu();
    const ids = [...(s.left?.rows ?? []), ...(s.right?.rows ?? [])]
      .filter((r) => r.kind !== 'info')
      .map((r) => (r.kind === 'info' ? '' : r.id));
    expect(ids).toEqual([
      'username', 'playerColor', 'enemyColor', 'distance', 'detail', 'musicVolume',
      'billboards', 'zoomBlur', 'showMs', 'vr', 'dwellTime', 'axisX', 'axisY', 'music', 'clear',
    ]);
    const dwell = s.right?.rows?.find((r) => r.kind === 'slider' && r.id === 'dwellTime');
    expect(dwell && dwell.kind === 'slider' ? [dwell.min, dwell.max, dwell.step] : null)
      .toEqual([0.5, 5, 0.1]);
    expect(s.primary?.id).toBe('save');
    const username = s.left?.rows?.find((r) => r.kind === 'text');
    expect(username && username.kind === 'text' && username.maxLength).toBe(12);
  });

  it('briefing and result carry the level/medal data', () => {
    const briefing = screens.briefingScreen('ctf-easy', 'hello', ['1 - 10']);
    expect(briefing.primary?.id).toBe('start');
    expect(briefing.left?.table?.rows).toEqual(['1 - 10']);
    expect(briefing.right?.lines?.[0]).toMatchObject({ text: 'hello', wrap: true });
    const won = screens.resultMenu(true, 'You win', '_gold.png');
    expect(won.title).toBe('VICTORY');
    expect(won.right?.icons?.[0]?.icon).toBe('_gold.png');
    const lost = screens.resultMenu(false, null, null);
    expect(lost.title).toBe('DEFEAT');
    expect(lost.right).toBeUndefined();
  });
});

describe('?username=', () => {
  it('reads the search string and the hash query, sanitising the value', () => {
    expect(parseUsernameParam('?username=Bob', '')).toBe('Bob');
    expect(parseUsernameParam('', '#/menu?username=Ann')).toBe('Ann');
    expect(parseUsernameParam('?username=%20Zed%20', '#/menu')).toBe('Zed');
    expect(parseUsernameParam('?username=' + 'x'.repeat(40), '')).toBe('x'.repeat(12));
    expect(parseUsernameParam('?username=a"b<c>d', '')).toBe('abcd');
    expect(parseUsernameParam('?username=', '')).toBeNull();
    expect(parseUsernameParam('', '')).toBeNull();
  });

  it('the menu stamps the pilot name into the title lines', () => {
    const previous = store.options.username;
    store.options.username = 'MenuTest';
    const s = screens.mainMenu();
    expect(s.subtitle).toContain('MenuTest');
    store.options.username = previous;
  });
});
