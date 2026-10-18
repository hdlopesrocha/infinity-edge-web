// HostSession: the browser-hosted match's frame production. A fake world of
// real object instances (constructed without their constructors, which would
// need GL) is streamed to a fake guest transport, and every frame is decoded
// with the client codec to prove the two ends agree.

import { describe, expect, it } from 'vitest';
import { HostSession } from '../src/game/mp/host';
import type { GuestTransport } from '../src/game/mp/host';
import { GameMap } from '../src/game/map';
import {
  Addon, Ark, Asteroid, Base, Billboard, Bullet, Flag, HomingMissile, SpaceShip,
} from '../src/game/objects';
import type { ModelData } from '../src/game/objects';
import { Life1, Life3 } from '../src/game/life';
import { Team } from '../src/game/team';
import { P } from '../src/game/physics';
import { quat, vec3 } from '../src/engine/math';
import { decodeMessage, encodeMessage } from '../src/game/net';
import {
  decodeEvents, decodeHud, decodeResult, decodeScene, decodeSnapshot, encodeInput, encodeJoin,
  GameMsg, NO_INDEX, Reader, WireAddon, WireFlag, WireKind,
} from '../src/game/protocol';
import type { NetScene } from '../src/game/protocol';

const MODEL = { name: 'Fighter3', solid: [null], color: [null], tex: null, texes: null, icon: null, flares: { engine: [], color: [] }, friction: 1, detail: 1 } as unknown as ModelData;

/** Real prototype (instanceof passes), fields only - no constructor, no GL. */
function make<T>(cls: object, fields: Record<string, unknown>): T {
  return Object.assign(Object.create(cls), fields) as T;
}

function ship(team: Team, pos: [number, number, number], physics = P.SS1R, life = new Life1(100)): SpaceShip {
  return make<SpaceShip>(SpaceShip.prototype, {
    pos: vec3.fromValues(...pos),
    rot: quat.create(),
    scale: 1,
    model: MODEL,
    team,
    physics,
    life,
    active: true,
    destroyed: false,
    isPlayer: false,
    intelligence: { execute: () => undefined },
    homings: 2,
    nitro: 0,
    accel: vec3.create(),
    insideMap: true,
    teleported: false,
    vel: vec3.create(),
    side: vec3.fromValues(1, 0, 0),
    dir: vec3.fromValues(0, 0, 1),
    sx: pos[0], sy: pos[1], sz: pos[2], sradius: 4,
    lifePercentage: (): number => 1,
    update: () => undefined,
    markPrev: () => undefined,
  });
}

interface FakeWorld {
  gi: unknown;
  map: GameMap;
  human: Team;
  alien: Team;
  host: SpaceShip;
  ai: SpaceShip;
  enemy: SpaceShip;
  asteroid: Asteroid;
  base: Base;
  flag: Flag;
  bullet: Bullet;
  missile: HomingMissile;
  ark: Ark;
  decor: Billboard;
  optionDistance: number;
}

function fakeWorld(): FakeWorld {
  const map = new GameMap('Sky2', 2048);
  map.rng = () => 0.5;
  map.octree = {
    insert: () => undefined,
    remove: () => undefined,
    refresh: () => undefined,
    sphereSelectInteractive: () => undefined,
    sphereSelect: () => undefined,
  } as unknown as typeof map.octree;
  const human = new Team('human', [0.25, 0.8, 0.75]);
  const alien = new Team('alien', [1, 0, 0]);
  const ambient = new Team('ambient', [0.2, 0.8, 0.2]);
  human.enemys.push(alien);
  alien.enemys.push(human);
  const host = ship(human, [0, 0, 0]);
  host.isPlayer = true;
  const ai = ship(human, [10, 0, 0]);
  const enemy = ship(alien, [20, 0, 0]);
  human.objects.push(host, ai);
  alien.objects.push(enemy);
  const base = make<Base>(Base.prototype, {
    pos: vec3.fromValues(200, 0, 0), rot: quat.create(), scale: 1, model: MODEL,
    team: human, active: true, destroyed: false, sx: 200, sy: 0, sz: 0, sradius: 20,
  });
  human.base = base;
  human.objects.push(base);
  const flag = make<Flag>(Flag.prototype, {
    pos: vec3.fromValues(200, 0, 0), rot: quat.create(), scale: 1, model: MODEL,
    team: human, active: true, destroyed: false, sx: 200, sy: 0, sz: 0, sradius: 4,
    owner: base, getOwner(): unknown { return this.owner; },
  });
  human.flag = flag;
  const asteroid = make<Asteroid>(Asteroid.prototype, {
    pos: vec3.fromValues(50, 10, -20), rot: quat.create(), scale: 1, model: MODEL,
    team: ambient, active: true, destroyed: false, sx: 50, sy: 10, sz: -20, sradius: 8,
  });
  const bullet = make<Bullet>(Bullet.prototype, {
    pos: vec3.fromValues(3, 0, 3), rot: quat.create(), scale: 1, model: MODEL,
    team: human, active: true, destroyed: false, sx: 3, sy: 0, sz: 3, sradius: 1,
  });
  const missile = make<HomingMissile>(HomingMissile.prototype, {
    pos: vec3.fromValues(4, 1, 4), rot: quat.create(), scale: 1, model: MODEL,
    team: human, active: true, destroyed: false, sx: 4, sy: 1, sz: 4, sradius: 2,
    intelligence: { lockedTarget: () => enemy },
  });
  const ark = make<Ark>(Ark.prototype, {
    pos: vec3.fromValues(0, 0, 400), rot: quat.create(), scale: 1, model: MODEL,
    team: human, active: true, destroyed: false, sx: 0, sy: 0, sz: 400, sradius: 20,
  });
  const decor = make<Billboard>(Billboard.prototype, {
    pos: vec3.fromValues(-100, -50, 100), prevPos: vec3.create(), scale: 2, active: true, team: ambient,
  });
  map.live.push(base, flag, asteroid, bullet, missile, ark, host, ai, enemy, decor);
  const teams = new Map<string, Team>([['human', human], ['ambient', ambient], ['alien', alien]]);
  const octree = map.octree;
  const gi = {
    map,
    teams,
    selectedObject: host,
    levelKey: 'ctf-test',
    levelTitle: 'Capture the Flag - Test',
    levelText: 'briefing',
    gameType: 'CTF',
    matchTimeMs: 300000,
    startCountdownMs: 0,
    finished: false,
    result: null,
    deathCauses: new Map(),
    rc: {
      options: { distance: 192, billboards: true },
      model: () => MODEL,
      loadedAliases: () => ['Base', 'Bullet', 'Fighter3', 'HomingMissile2'],
    },
    // The host session reads the octree through the map only; keep the type.
    __octree: octree,
  };
  // The lock-on probe casts a sphere at the guest's ship: report the enemies.
  (gi.map.octree as unknown as { sphereSelectInteractive: (x: number, y: number, z: number, r: number, out: unknown[]) => void })
    .sphereSelectInteractive = (_x, _y, _z, _r, out) => {
      out.push(enemy);
    };
  return { gi, map, human, alien, host, ai, enemy, asteroid, base, flag, bullet, missile, ark, decor, optionDistance: 192 };
}

class FakeTransport implements GuestTransport {
  raw: Uint8Array[] = [];
  private cache: { type: number; payload: Uint8Array }[] = [];
  closed = false;

  send(frame: Uint8Array): void {
    this.raw.push(frame.slice());
  }

  close(): void {
    this.closed = true;
  }

  /** Decode every frame received so far (the host gzips like the server). */
  async frames(): Promise<{ type: number; payload: Uint8Array }[]> {
    while (this.cache.length < this.raw.length) {
      this.cache.push(await decodeMessage(this.raw[this.cache.length]));
    }
    return this.cache;
  }

  async ofType(type: number): Promise<{ type: number; payload: Uint8Array }[]> {
    return (await this.frames()).filter((f) => f.type === type);
  }
}

const JOIN = encodeMessage(GameMsg.Join, encodeJoin('ctf-test', {
  smartAI: false, distance: 192, axisX: true, axisY: false,
}));

async function joinedHost(): Promise<{ world: FakeWorld; host: HostSession; guest: FakeTransport; id: number }> {
  const world = fakeWorld();
  const host = new HostSession(world.gi as never);
  const guest = new FakeTransport();
  const id = host.addGuest({ pubkey: 'ab'.repeat(32), name: 'Pilot', transport: guest });
  await host.handleFrame(id, JOIN);
  return { world, host, guest, id };
}

describe('multiplayer host session', () => {
  it('sends Scene + the first snapshot on Join, with the guest ship as playerId', async () => {
    const { world, guest } = await joinedHost();
    const frames = await guest.frames();
    expect(frames.map((f) => f.type)).toEqual([
      GameMsg.Scene, GameMsg.Snapshot, GameMsg.Hud,
    ]);
    const scene = decodeScene(new Reader(frames[0].payload));
    expect(scene.levelKey).toBe('ctf-test');
    expect(scene.title).toBe('Capture the Flag - Test');
    expect(scene.models).toEqual(['Base', 'Bullet', 'Fighter3', 'HomingMissile2']);
    expect(scene.teams.map((t) => t.name)).toEqual(['human', 'ambient', 'alien']);
    // Only teams that field objects (plus the neutral ambient) travel; the
    // enemy mask is over that sent list.
    expect(scene.teams[0].enemies).toBe(0b100);
    expect(scene.teams[2].enemies).toBe(0b001);
    expect(scene.decor).toHaveLength(1);
    expect(scene.mapSize).toBe(2048);
    expect(scene.gameType).toBe(0); // CTF

    const half = scene.mapSize / 2;
    const snap = decodeSnapshot(new Reader(frames[1].payload), half);
    const kinds = new Map(snap.spawns.map((s) => [s.id, s]));
    expect(kinds.size).toBe(9); // base, flag, asteroid, bullet, missile, ark, 3 ships
    const byKind = (k: number): typeof snap.spawns => snap.spawns.filter((s) => s.kind === k);
    expect(byKind(WireKind.Ship)).toHaveLength(3);
    expect(byKind(WireKind.Missile)).toHaveLength(1);
    expect(byKind(WireKind.Bullet)).toHaveLength(1);
    expect(byKind(WireKind.Asteroid)).toHaveLength(1);
    expect(byKind(WireKind.Base)).toHaveLength(1);
    expect(byKind(WireKind.Flag)).toHaveLength(1);
    expect(byKind(WireKind.Ark)).toHaveLength(1);
    expect(byKind(WireKind.Flag)[0].state).toBe(WireFlag.AtBase);
    const ship = snap.spawns.find((s) => s.id === scene.playerId)!;
    expect(ship.kind).toBe(WireKind.Ship);
    expect(ship.state).toBe(1); // respawning ship
    expect(ship.teamIdx).toBe(0); // human
    // Dynamic objects are posed; the decor billboard is Scene-only.
    const posed = new Set(snap.poses.map((p) => p.id));
    expect(posed.has(ship.id)).toBe(true);
    expect(posed.has(byKind(WireKind.Bullet)[0].id)).toBe(true);
    expect(posed.has(byKind(WireKind.Ark)[0].id)).toBe(true);
    expect(posed.has(byKind(WireKind.Asteroid)[0].id)).toBe(false);
    expect(snap.spawns.some((s) => s.modelIdx === NO_INDEX)).toBe(false);
    void world;
  });

  it('adopts a free AI ship of the host team instead of spawning one', async () => {
    const world = fakeWorld();
    const original = world.ai.intelligence;
    const host = new HostSession(world.gi as never);
    const guest = new FakeTransport();
    const id = host.addGuest({ pubkey: 'ab'.repeat(32), name: 'Pilot', transport: guest });
    await host.handleFrame(id, JOIN);
    expect(host.guestShip(id)).toBe(world.ai);
    expect(world.ai.isPlayer).toBe(true);
    expect(world.ai.intelligence).not.toBe(original);
    host.removeGuest(id, false);
    expect(world.ai.intelligence).toBe(original);
    expect(world.ai.isPlayer).toBe(false);
    void guest;
  });

  it('applies guest input frames to the guest ship before the step', async () => {
    const { world, host, id } = await joinedHost();
    const shipRef = host.guestShip(id)!;
    await host.handleFrame(id, encodeMessage(GameMsg.Input, encodeInput({
      stickX: -1, stickY: 0.5, throttle: 1, fire: false, homing: false, nitro: false,
    })));
    host.preTick(16);
    // The adopted ship flies with HILocal over the guest's RemoteControl:
    // running it once must produce full throttle and a turn.
    (shipRef.intelligence as import('../src/game/objects').Command).execute();
    expect(vec3.length(shipRef.accel)).toBeCloseTo(shipRef.physics.accelMax, 3);
    expect(shipRef.rot[3]).not.toBe(1); // steering changed the rotation
    void world;
  });

  it('streams removals, sees the guest leave and reports the result', async () => {
    const { world, host, guest, id } = await joinedHost();
    // A destroyed (removed) object leaves every guest's live set.
    const idx = world.map.live.indexOf(world.bullet);
    world.map.live.splice(idx, 1);
    host.preTick(16);
    // Each postTick(40) crosses the 30 Hz wire cadence exactly once.
    host.postTick(40);
    const snaps = (await guest.ofType(GameMsg.Snapshot)).map(
      (f) => decodeSnapshot(new Reader(f.payload), 1024),
    );
    expect(snaps).toHaveLength(2);
    expect(snaps[1].removals).toHaveLength(1);

    // Hud: the guest's own ship, its life pool and the team table.
    const huds = (await guest.ofType(GameMsg.Hud)).map((f) => decodeHud(new Reader(f.payload)));
    const hud = huds[huds.length - 1];
    expect(hud.selectedId).toBe(host.guestShip(id) ? hud.selectedId : 0);
    expect(hud.selectedId).toBeGreaterThan(0);
    expect(hud.teams.map((t) => t.name)).toEqual(['human', 'ambient', 'alien']);
    expect(hud.ships.length).toBe(3);
    expect(hud.matchLeft).toBeGreaterThan(0);

    // Result frame once the match finishes.
    (world.gi as { finished: boolean }).finished = true;
    (world.gi as { result: unknown }).result = { won: true, reward: 'Victory', message: 'You win' };
    host.postTick(40);
    const result = await guest.ofType(GameMsg.Result);
    expect(result).toHaveLength(1);
    expect(decodeResult(new Reader(result[0].payload))).toEqual({ won: true, reward: 'Victory', message: 'You win' });
    void world;
  });

  it('rejects a Join for another level and closes with the room on dispose', async () => {
    const world = fakeWorld();
    const host = new HostSession(world.gi as never);
    const guest = new FakeTransport();
    const id = host.addGuest({ pubkey: 'cd'.repeat(32), name: 'Other', transport: guest });
    await host.handleFrame(id, encodeMessage(GameMsg.Join, encodeJoin('kots-other', {
      smartAI: false, distance: 192, axisX: false, axisY: false,
    })));
    expect((await guest.frames())[0].type).toBe(GameMsg.Error);
    host.dispose();
    expect(guest.closed).toBe(true);
    expect(host.guestCount).toBe(0);
  });

  it('spawns a wingman when there is no free AI ship (time trial)', async () => {
    const world = fakeWorld();
    // Solo level: only the host's ship exists.
    world.map.live = [world.host];
    world.human.objects = [world.host];
    const host = new HostSession(world.gi as never);
    const guest = new FakeTransport();
    const id = host.addGuest({ pubkey: 'ef'.repeat(32), name: 'Racer', transport: guest });
    await host.handleFrame(id, encodeMessage(GameMsg.Join, encodeJoin('ctf-test', {
      smartAI: false, distance: 192, axisX: false, axisY: false,
    })));
    const spawned = host.guestShip(id);
    expect(spawned).not.toBeNull();
    expect(spawned).not.toBe(world.host);
    expect(spawned!.isPlayer).toBe(true);
    expect(world.map.live).toContain(spawned);
    expect(world.human.objects).toContain(spawned);
    const frames = await guest.frames();
    const scene = decodeScene(new Reader(frames[0].payload));
    const snap = decodeSnapshot(new Reader(frames[1].payload), 1024);
    expect(snap.spawns.some((s) => s.id === scene.playerId && s.kind === WireKind.Ship)).toBe(true);
    host.removeGuest(id, false);
    expect(world.map.live).not.toContain(spawned);
  });

  it('sends voice/sfx/explosion events to the right guests', async () => {
    const { world, host, guest, id } = await joinedHost();
    const shipRef = host.guestShip(id)!;
    const { simHooks } = await import('../src/game/mp/bridge');
    simHooks.host!.shipSfx(shipRef, 'hitSound', 0.4);
    simHooks.host!.shipNotification(shipRef, 'leavingFieldOfBattle');
    simHooks.host!.voice('ourFlagWasStolen');
    simHooks.host!.explosion({ pos: [1, 2, 3], scale: 3, life: 750, smoke: 12, debris: 6, model: MODEL });
    host.preTick(16);
    host.postTick(40);
    const events = (await guest.ofType(GameMsg.Events)).map((f) => decodeEvents(new Reader(f.payload), 1024));
    const all = events.flat();
    expect(all.some((e) => e.type === 'sound' && e.id === 3 && Math.abs(e.volume - 0.4) < 0.01)).toBe(true);
    expect(all.some((e) => e.type === 'voice')).toBe(true);
    const ex = all.find((e) => e.type === 'explosion');
    expect(ex).toBeDefined();
    if (ex && ex.type === 'explosion') {
      expect(ex.scale).toBe(3);
      expect(ex.smoke).toBe(12);
      expect(ex.debris).toBe(6);
      expect(ex.seed).toBeGreaterThan(0);
    }
    void world;
  });

  it('uses life pools and the respawn timer in the guest Hud', async () => {
    const { world, host, id, guest } = await joinedHost();
    const shipRef = host.guestShip(id)!;
    shipRef.life = new Life3(40, 30, 30);
    (shipRef.life as Life3).left = 10;
    (shipRef.life as Life3).center = 20;
    (shipRef.life as Life3).right = 30;
    world.map.respawned.push({ obj: shipRef, elapsed: 4000, max: 10000 });
    world.gi.deathCauses.set(shipRef, 'rammed by alien');
    host.preTick(16);
    host.postTick(40);
    const huds = (await guest.ofType(GameMsg.Hud)).map((f) => decodeHud(new Reader(f.payload)));
    const hud = huds[huds.length - 1];
    expect(hud.life).toEqual([
      { value: 10, max: 40 },
      { value: 20, max: 30 },
      { value: 30, max: 30 },
    ]);
    expect(hud.respawn).toEqual({ left: 6000, total: 10000 });
    expect(hud.deathCause).toBe('rammed by alien');
    void world;
  });

  it('sends an addon kind and a carried flag state', async () => {
    const { world, host, guest } = await joinedHost();
    const addon = make<Addon>(Addon.prototype, {
      pos: vec3.fromValues(5, 5, 5), rot: quat.create(), scale: 1, model: MODEL,
      team: world.human, active: true, destroyed: false, sx: 5, sy: 5, sz: 5, sradius: 2,
      command: 'nitro',
    });
    const carried = make<Flag>(Flag.prototype, {
      pos: vec3.fromValues(0, 0, 0), rot: quat.create(), scale: 1, model: MODEL,
      team: world.human, active: true, destroyed: false, sx: 0, sy: 0, sz: 0, sradius: 4,
      owner: world.host, getOwner(): unknown { return this.owner; },
    });
    world.map.live.push(addon, carried);
    host.preTick(16);
    host.postTick(40);
    const snaps = (await guest.ofType(GameMsg.Snapshot)).map(
      (f) => decodeSnapshot(new Reader(f.payload), 1024),
    );
    const last = snaps[snaps.length - 1];
    const addonSpawn = last.spawns.find((s) => s.kind === WireKind.Addon);
    expect(addonSpawn?.state).toBe(WireAddon.nitro);
    const flagSpawn = last.spawns.find((s) => s.kind === WireKind.Flag);
    expect(flagSpawn?.state).toBe(WireFlag.Carried);
  });
});
