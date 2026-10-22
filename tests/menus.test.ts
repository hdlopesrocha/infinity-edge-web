// WebGL menu content: the screens the MenuView paints and the ?username= link
// parameter (both are pure data, so they are testable in Node).
import { describe, expect, it } from 'vitest';
import * as screens from '../src/game/ui/screens';
import { parseUsernameParam } from '../src/game/resources';
import { store } from '../src/game/store';
import { applyRoster, defaultRoster } from '../src/game/agents';
import type { AgentConfig } from '../src/game/agents';
import type { LevelDef } from '../src/game/levels';
import {
  ACTIONS_W, CONTENT_W, CONTENT_X, MENU_H, MENU_W, NAVBAR_H, PANEL_H, PANEL_Y,
  contentWidth,
} from '../src/game/ui/layout';

describe('menu screens', () => {
  it('boot/engine/start screens use text wordmarks (Airstrike), not logo bitmaps', () => {
    expect(screens.bootScreen('boot', null).wordmark).toBe('Infinity Edge');
    expect(screens.bootScreen('engine', null).wordmark).toBe('Floating Gear');
    expect(screens.bootScreen('start', null).wordmark).toBe('Infinity Edge');
    // The old `logo` field is gone; screens carry text only.
    expect('logo' in screens.bootScreen('engine', null)).toBe(false);
  });

  it('layout: actions on the right and one maximised content rectangle', () => {
    expect(CONTENT_X).toBe(0);
    expect(CONTENT_X + CONTENT_W + ACTIONS_W).toBe(MENU_W);
    expect(NAVBAR_H).toBeLessThan(PANEL_Y);
    expect(PANEL_Y + PANEL_H).toBe(MENU_H);
    // The generic UI plane can reclaim the action column for the game scene.
    expect(contentWidth(true)).toBe(CONTENT_W);
    expect(contentWidth(false)).toBe(MENU_W);
  });

  it('main menu: one icon per entry, including multiplayer and social', () => {
    const s = screens.mainMenu();
    expect(s.left?.icons?.map((i) => i.id)).toEqual([
      '/single-player', '/multiplayer', '/social', '/hangar', '/settings', '/about',
    ]);
    expect(s.left?.icons?.every((i) => !!i.icon)).toBe(true);
    expect(s.left?.icons?.find((i) => i.id === '/multiplayer')?.icon).toBe('_multiPlayer.png');
    expect(s.left?.buttons).toBeUndefined();
    expect(s.title).toBe('MAIN MENU');
  });

  it('social screen: identity, per-game high scores and message composer', () => {
    const prev = {
      scores: store.gameHighScores, inbox: store.socialInbox, to: store.socialTo,
      body: store.socialBody, npub: store.identityNpub, nsec: store.identityNsec,
      revealed: store.identityRevealed, status: store.identityStatus,
    };
    try {
      store.gameHighScores = [{
        type: 'CTF', label: 'CAPTURE THE FLAG', name: 'ace', owner: 'ab'.repeat(32), value: '9 captures',
      }];
      store.socialInbox = [{ id: '1', from: 'cd'.repeat(32), text: 'gg', created: 1_700_000_000 }];
      store.socialTo = '';
      store.socialBody = '';
      store.identityNpub = 'npub1test';
      store.identityNsec = 'nsec1secret';
      store.identityRevealed = false;
      store.identityStatus = '';
      const s = screens.socialMenu();
      expect(s.title).toBe('SOCIAL');
      expect(s.actions?.[0]).toEqual({ id: 'refresh-social', label: 'refresh' });
      const leftIds = (s.left?.rows ?? []).map((r) => (r.kind === 'info' ? '' : r.id));
      expect(leftIds).toEqual(['nwc-uri', 'wallet-connect']);
      const rightIds = (s.right?.rows ?? []).map((r) => (r.kind === 'info' ? '' : r.id));
      expect(rightIds).toEqual([
        'identity-copy:npub', 'identity-copy:nsec', 'identity-nsec', 'identity-import',
        'social-to', 'social-body', 'social-send',
      ]);
      // The identity and the message render; the nsec stays masked.
      expect(JSON.stringify(s.right?.lines)).toContain('npub1test');
      expect(JSON.stringify(s.right?.lines)).not.toContain('nsec1secret');
      // The left panel lists each game mode with its best run.
      expect(JSON.stringify(s.left?.lines)).toContain('CAPTURE THE FLAG');
      expect(JSON.stringify(s.left?.lines)).toContain('9 captures');
      expect(JSON.stringify(s.left?.lines)).toContain('ace');
      expect(JSON.stringify(s.right?.lines)).toContain('gg');
    } finally {
      store.gameHighScores = prev.scores;
      store.socialInbox = prev.inbox;
      store.socialTo = prev.to;
      store.socialBody = prev.body;
      store.identityNpub = prev.npub;
      store.identityNsec = prev.nsec;
      store.identityRevealed = prev.revealed;
      store.identityStatus = prev.status;
    }
  });

  it('hangar: aimbot, shop and social rows', () => {
    const s = screens.hangarMenu();
    const ids = (s.left?.rows ?? []).map((r) => (r.kind === 'info' ? '' : r.id));
    expect(ids).toEqual(['aimbot', '/shop', '/social']);
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
      'username', 'team1Color', 'team2Color', 'team3Color', 'team4Color',
      'distance', 'detail', 'musicVolume',
      'billboards', 'zoomBlur', 'showMs', 'partyMode', 'music', 'clear',
    ]);
    expect(s.primary?.id).toBe('save');
    const username = s.left?.rows?.find((r) => r.kind === 'text');
    expect(username && username.kind === 'text' && username.maxLength).toBe(12);
    // The VR toggle moved to the chrome; no VR row remains.
    expect(ids).not.toContain('vr');
    // The wallet moved to the social page.
    expect(ids).not.toContain('nwc-uri');
    // Only the four teams are configurable now.
    expect(ids).not.toContain('playerColor');
    expect(ids).not.toContain('enemyColor');
  });

  it('options: the CONTROLS tab carries the control settings and the reference', () => {
    try {
      screens.setOptionsTab('controls');
      const s = screens.optionsMenu();
      expect(s.tabs?.map((t) => t.id)).toEqual(['options-tab:settings', 'options-tab:controls']);
      expect(s.tabs?.find((t) => t.id === 'options-tab:controls')?.active).toBe(true);
      const ids = (s.left?.rows ?? []).map((r) => (r.kind === 'info' ? '' : r.id));
      expect(ids).toEqual(['dwellTime', 'axisX', 'axisY']);
      const dwell = s.left?.rows?.find((r) => r.kind === 'slider' && r.id === 'dwellTime');
      expect(dwell && dwell.kind === 'slider' ? [dwell.min, dwell.max, dwell.step] : null)
        .toEqual([0.5, 5, 0.1]);
      const text = JSON.stringify([s.left?.lines, s.right?.lines]);
      expect(text).toContain('W A S D');
      expect(text).toContain('Left stick');
      expect(text).toContain('Re-centre');
      // Control settings live here, so the tab can be saved.
      expect(s.primary?.id).toBe('save');
    } finally {
      screens.setOptionsTab('settings');
    }
    // The hangar no longer draws the controls reference.
    const hangar = screens.hangarMenu();
    expect(JSON.stringify(hangar.right?.lines)).not.toContain('W A S D');
  });

  it('social: the Lightning wallet lives here now', () => {
    const s = screens.socialMenu();
    const ids = [...(s.left?.rows ?? []), ...(s.right?.rows ?? [])]
      .filter((r) => r.kind !== 'info')
      .map((r) => (r.kind === 'info' ? '' : r.id));
    expect(ids).toContain('nwc-uri');
    expect(ids).toContain('wallet-connect');
  });

  it('pause menu: all paused actions live in the action column', () => {
    const s = screens.pauseMenu();
    expect(s.title).toBe('PAUSED');
    expect(s.left?.icons).toBeUndefined();
    expect(s.left?.lines?.[0]).toMatchObject({ wrap: true });
    expect(s.actions?.map((a) => a.id)).toEqual(['pause:settings']);
    expect(s.primary?.id).toBe('pause:resume');
    expect(s.backLabel).toBe('leave match');
    expect(s.showActions).toBe(true);
  });

  it('briefing and result carry the level/roster/medal data', () => {
    const roster: AgentConfig[] = [
      { id: 'HS1', name: 'HS1', role: 'player', team: 'team1', ai: '', enabled: true, added: false },
      { id: 'HS2', name: 'HS2', role: 'bot', team: 'team1', ai: 'AIFlagCap', enabled: true, added: false },
      { id: 'AS1', name: 'AS1', role: 'bot', team: 'team2', ai: 'AIHunt', enabled: true, added: false },
      { id: 'AS2', name: 'AS2', role: 'bot', team: 'team2', ai: 'AIHunt', enabled: false, added: false },
    ];
    const briefing = screens.briefingScreen('ctf-easy', 'hello', ['1 - 10'], roster);
    expect(briefing.primary?.id).toBe('start');
    // No separate skirmish menu any more.
    expect(briefing.actions).toBeUndefined();
    // One shared roster list (players + bots) then Add Bot; the team filter
    // lists the teams present.
    const ids = (briefing.left?.rows ?? []).map((r) => (r.kind === 'info' ? '' : r.id));
    expect(ids).toEqual(['HS1', 'HS2', 'AS1', 'agent:add']);
    expect(briefing.left?.filter?.teams).toEqual(['team1', 'team2']);
    const player = briefing.left?.rows?.find((r) => r.kind === 'roster' && r.id === 'HS1');
    expect(player && player.kind === 'roster' && player.entry.team).toBe('team1');
    expect(player && player.kind === 'roster' && player.entry.badges).toContain('YOU');
    expect(player && player.kind === 'roster' && player.entry.teamOptions.some((o) => o.label === 'Team 2')).toBe(true);
    const hs2 = briefing.left?.rows?.find((r) => r.kind === 'roster' && r.id === 'HS2');
    expect(hs2 && hs2.kind === 'roster' && hs2.entry.ai).toBe('AIFlagCap');
    expect(hs2 && hs2.kind === 'roster' && hs2.entry.aiOptions?.some((o) => o.label === 'Flag Runner')).toBe(true);
    const as1 = briefing.left?.rows?.find((r) => r.kind === 'roster' && r.id === 'AS1');
    expect(as1 && as1.kind === 'roster' && as1.entry.team).toBe('team2');
    expect(as1 && as1.kind === 'roster' && as1.entry.teamOptions.some((o) => o.label === 'Team 2')).toBe(true);
    // The disabled bot is not listed.
    expect(ids).not.toContain('AS2');
    // Filtering by a team hides the others.
    try {
      screens.setBriefingTeamFilter('team2');
      const filtered = screens.briefingScreen('ctf-easy', 'hello', [], roster);
      const filteredIds = (filtered.left?.rows ?? []).map((r) => r.id);
      expect(filteredIds).toEqual(['AS1', 'agent:add']);
      expect(filtered.left?.filter?.active).toBe('team2');
    } finally {
      screens.setBriefingTeamFilter(null);
    }
    // High scores moved into the mission panel.
    expect(briefing.right?.lines?.some((l) => 'text' in l && l.text === 'HIGH SCORES')).toBe(true);

    const won = screens.resultMenu(true, 'You win', '_gold.png');
    expect(won.title).toBe('VICTORY');
    expect(won.right?.icons?.[0]?.icon).toBe('_gold.png');
    const lost = screens.resultMenu(false, null, null);
    expect(lost.title).toBe('DEFEAT');
    expect(lost.right).toBeUndefined();
    const draw = screens.resultMenu(false, "It's a draw!", null, true);
    expect(draw.title).toBe('DRAW');
    expect(draw.left?.lines?.[0]).toMatchObject({ text: 'The match is a draw.' });
  });

  it('defaultRoster seeds the level player and every AI ship', () => {
    const def = {
      key: 'ctf-easy',
      objects: [
        { team: 'team1', type: 'base', model: 'Base', position: '0|0|0', name: 'HB' },
        { team: 'team1', type: 'spaceShipRespawn', model: 'Fighter3', position: 'around', name: 'HS1' },
        { team: 'team1', type: 'spaceShipRespawn', model: 'Fighter3', position: 'around', name: 'HS2' },
        { team: 'team2', type: 'spaceShipRespawn', model: 'Fighter3', position: 'around', name: 'AS1' },
      ],
      actions: [
        { name: 'HILocal', from: 'HS1' },
        { name: 'AIFlagCap', from: 'HS2' },
        { name: 'AIHunt', from: 'AS1' },
      ],
    } as unknown as LevelDef;
    const roster = defaultRoster(def);
    expect(roster.map((a) => [a.id, a.role])).toEqual([
      ['HS1', 'player'], ['HS2', 'bot'], ['AS1', 'bot'],
    ]);
    expect(roster[0].team).toBe('team1');
    expect(roster[1].ai).toBe('AIFlagCap');
    expect(roster[2].ai).toBe('AIHunt');
    expect(roster.every((a) => a.enabled)).toBe(true);
  });

  it('applyRoster retags, removes and adds level bots', () => {
    const def = {
      key: 'ctf-easy',
      objects: [
        { team: 'team1', type: 'base', model: 'Base', position: '0|0|0', name: 'HB' },
        { team: 'team1', type: 'spaceShipRespawn', model: 'Fighter3', position: 'around', name: 'HS1' },
        { team: 'team1', type: 'spaceShipRespawn', model: 'Fighter3', position: 'around', name: 'HS2' },
        { team: 'team2', type: 'spaceShipRespawn', model: 'Fighter3', position: 'around', name: 'AS1' },
      ],
      actions: [
        { name: 'HILocal', from: 'HS1' },
        { name: 'AIFlagCap', from: 'HS2' },
        { name: 'AIHunt', from: 'AS1' },
      ],
    } as unknown as LevelDef;
    const roster = defaultRoster(def);
    roster.find((a) => a.id === 'HS2')!.team = 'team3';
    roster.find((a) => a.id === 'AS1')!.enabled = false;
    roster.push({ id: 'BOT1', name: 'BOT1', role: 'bot', team: 'team4', ai: 'AIHunt', enabled: true, added: true });
    const applied = applyRoster(def, roster);
    expect(applied.objects.find((o) => o.name === 'HS2')?.team).toBe('team3');
    expect(applied.objects.some((o) => o.name === 'AS1')).toBe(false);
    expect(applied.added.map((a) => a.id)).toEqual(['BOT1']);
    expect([...applied.teams].sort()).toEqual(['team1', 'team3', 'team4']);
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

  it('the menu chrome is only the path: no pilot/version subtitle', () => {
    const previous = store.options.username;
    store.options.username = 'MenuTest';
    const s = screens.mainMenu();
    expect('subtitle' in s).toBe(false);
    expect(JSON.stringify(s)).not.toContain('Infinity Edge 3.7');
    expect(JSON.stringify(s)).not.toContain('pilot');
    store.options.username = previous;
  });
});
