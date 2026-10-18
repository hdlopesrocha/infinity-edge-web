// Multiplayer host: the browser that created the room runs the authoritative
// match (the ordinary local simulation) and streams it to every guest over
// their RTC data channel with the same frames the C++ server sends
// (src/game/protocol.ts, mirrored from server/src/session.cpp).
//
// Per guest: the Scene once (with that guest's ship as playerId), then
// Snapshot/Events/Hud every 30 Hz tick, and Result when the match ends. Input
// frames steer the guest's own ship through an HILocal driven by a
// RemoteControl, so remote ships fly exactly like the local player's.

import { quat, vec3 } from '../../engine/math';
import type { Abstract3D, ModelData } from '../objects';
import {
  Addon, Ark, Asteroid, Base, Billboard, Bullet, Flag, HomingMissile, SpaceObject, SpaceShip,
} from '../objects';
import type { Command } from '../objects';
import type { GameInstance } from '../instance';
import { Life1, Life3 } from '../life';
import { HILocal } from '../ai';
import type { ShipControl } from '../ai';
import { decodeMessage, encodeMessage } from '../net';
import {
  encodeEvents, encodeHud, encodeResult, encodeScene, encodeSnapshot, encodeError,
  GAME_TYPE_ORDER, GameMsg, NO_INDEX, Reader, SFX_NAMES, TICK_MS, VOICE_FIELDS, WireAddon,
  WireFlag, WireKind, Writer,
} from '../protocol';
import type { InputState, NetEvent, NetHud, NetHudTeam, NetPose, NetScene, NetSnapshot, NetSpawn } from '../protocol';
import { simHooks } from './bridge';

/** Sfx/voice payloads smaller than this are still gzipped (server parity). */
const HOST_GZIP_THRESHOLD = 64;
/** Input has to keep arriving; after this the ship coasts on its own. */
const INPUT_TIMEOUT_MS = 1200;

/** A framed link to one guest (RTC data channel, or a test double). */
export interface GuestTransport {
  send(frame: Uint8Array): void;
  close(): void;
}

/** The read surface HILocal needs, filled from a guest's input frames. */
class RemoteControl implements ShipControl {
  analogStick = { value: { x: 0, y: 0 } };
  analogAcel = { value: 0 };
  fireButton = { value: false };
  homingButton = { value: false };
  invertX = false;
  invertY = false;

  apply(input: InputState): void {
    this.analogStick.value.x = input.stickX;
    this.analogStick.value.y = input.stickY;
    this.analogAcel.value = input.throttle;
    this.fireButton.value = input.fire;
    this.homingButton.value = input.homing;
  }

  release(): void {
    this.analogStick.value.x = 0;
    this.analogStick.value.y = 0;
    this.analogAcel.value = 0;
    this.fireButton.value = false;
    this.homingButton.value = false;
  }
}

export interface GuestInfo {
  /** Nostr public key (hex) - the guest's identity in the room. */
  pubkey: string;
  /** Display name. */
  name: string;
  transport: GuestTransport;
}

export interface GuestSummary {
  id: number;
  pubkey: string;
  name: string;
}

interface Guest extends GuestInfo {
  id: number;
  control: RemoteControl;
  /** The ship this guest flies (owned by the simulation). */
  ship: SpaceShip | null;
  /** Wire id of `ship` (Scene playerId / Hud selectedId). */
  shipId: number;
  joined: boolean;
  /** Objects already spawned on this guest's client. */
  liveIds: Set<number>;
  lastInputAt: number;
  /** Nitro held on the latest input frame (applied before the step). */
  inputNitro: boolean;
  /** Brain of an adopted AI ship, restored when the guest leaves. */
  restoreIntelligence: Command | null;
  /** True when the ship was created for the guest (removed on leave). */
  spawned: boolean;
  /** Sfx/voices queued for this guest since the last Events frame. */
  events: NetEvent[];
}

export class HostSession {
  private guests = new Map<number, Guest>();
  private nextGuestId = 1;
  private ids = new Map<Abstract3D, number>();
  private nextId = 1;
  private tick = 0;
  /** Explosion seeds: the same LCG recurrence the simulation uses. */
  private seed = (Math.random() * 0xffffffff) >>> 0;
  private modelIndex = new Map<ModelData, number>();
  private aliases: string[] = [];
  private teamList: { team: import('../team').Team; wireIndex: number }[] = [];
  private resultSent = false;
  private accumMs = 0;
  /** Voices raised this tick (sent to every guest). */
  private voices: number[] = [];
  /** Explosions spawned this tick (sent to every guest). */
  private explosions: NetEvent[] = [];
  /** Called whenever the guest list changes (room updates, HUD). */
  onGuests: ((list: GuestSummary[]) => void) | null = null;
  /** Called when a guest's link closes on its own. */
  onGuestClosed: ((id: number) => void) | null = null;

  constructor(private gi: GameInstance) {
    this.installHooks();
  }

  get guestCount(): number {
    return this.guests.size;
  }

  /** The ship a guest flies (null before Join / while destroyed). */
  guestShip(id: number): SpaceShip | null {
    const g = this.guests.get(id);
    return g?.ship ?? null;
  }

  /** Diagnostics (console / e2e): per-guest control and ship state. */
  debugGuests(): Record<string, unknown>[] {
    return [...this.guests.values()].map((g) => ({
      id: g.id, name: g.name, joined: g.joined, shipId: g.shipId,
      throttle: g.control.analogAcel.value,
      stickX: g.control.analogStick.value.x,
      stickY: g.control.analogStick.value.y,
      fire: g.control.fireButton.value,
      active: g.ship ? g.ship.active : null,
      speed: g.ship ? Math.round(Math.hypot(g.ship.vel[0], g.ship.vel[1], g.ship.vel[2])) : null,
      pos: g.ship ? [g.ship.pos[0], g.ship.pos[1], g.ship.pos[2]].map((v) => Math.round(v)) : null,
      sinceInput: g.lastInputAt ? Math.round(performance.now() - g.lastInputAt) : null,
    }));
  }

  guestList(): GuestSummary[] {
    return [...this.guests.values()].map((g) => ({ id: g.id, pubkey: g.pubkey, name: g.name }));
  }

  // ----------------------------------------------------------------- guests
  /** Registers a link; the match starts for it when its Join frame arrives. */
  addGuest(info: GuestInfo): number {
    const id = this.nextGuestId++;
    const guest: Guest = {
      ...info,
      id,
      control: new RemoteControl(),
      ship: null,
      shipId: 0,
      joined: false,
      liveIds: new Set(),
      lastInputAt: 0,
      inputNitro: false,
      restoreIntelligence: null,
      spawned: false,
      events: [],
    };
    this.guests.set(id, guest);
    this.onGuests?.(this.guestList());
    return id;
  }

  removeGuest(id: number, closeTransport = true): void {
    const guest = this.guests.get(id);
    if (!guest) return;
    this.guests.delete(id);
    this.releaseShip(guest);
    if (closeTransport) {
      try { guest.transport.close(); } catch { /* already closed */ }
    }
    this.onGuests?.(this.guestList());
  }

  /** Drops every guest and detaches from the simulation. */
  dispose(): void {
    simHooks.host = null;
    for (const guest of [...this.guests.values()]) this.removeGuest(guest.id);
    this.guests.clear();
  }

  // -------------------------------------------------------------- inbound
  /** Feed one framed message from a guest's link (gzip handled by net.ts). */
  async handleFrame(id: number, data: ArrayBuffer | Uint8Array): Promise<void> {
    let frame;
    try {
      frame = await decodeMessage(data);
    } catch {
      return;
    }
    const guest = this.guests.get(id);
    if (!guest) return;
    const r = new Reader(frame.payload);
    try {
      switch (frame.type) {
        case GameMsg.Join:
          this.handleJoin(guest, r);
          break;
        case GameMsg.Input: {
          const input: InputState = {
            stickX: r.f32(),
            stickY: r.f32(),
            throttle: r.f32(),
            fire: false,
            homing: false,
            nitro: false,
          };
          const bits = r.u8();
          input.fire = (bits & 0x01) !== 0;
          input.homing = (bits & 0x02) !== 0;
          input.nitro = (bits & 0x04) !== 0;
          guest.control.apply(input);
          guest.lastInputAt = performance.now();
          guest.inputNitro = input.nitro;
          break;
        }
        case GameMsg.Ping: {
          const echo = r.u32();
          const w = new Writer();
          w.u32(echo);
          w.u32(Math.floor(performance.now()) >>> 0);
          this.send(guest, GameMsg.Pong, w.data());
          break;
        }
        case GameMsg.Leave:
          this.removeGuest(guest.id);
          break;
        default:
          break;
      }
    } catch {
      this.sendError(guest, 'bad payload');
    }
  }

  private handleJoin(guest: Guest, r: Reader): void {
    if (guest.joined) {
      this.sendError(guest, 'already joined');
      return;
    }
    let levelKey = '';
    try {
      levelKey = r.str();
    } catch {
      levelKey = '';
    }
    const flags = r.u8();
    const distance = r.f32();
    const axisX = r.u8() !== 0;
    const axisY = r.u8() !== 0;
    void flags;
    void distance;
    if (levelKey && levelKey !== this.gi.levelKey) {
      this.sendError(guest, 'room is playing ' + this.gi.levelKey);
      return;
    }
    const ship = this.assignShip(guest);
    if (!ship) {
      this.sendError(guest, 'no ship available');
      return;
    }
    guest.control.invertX = axisX;
    guest.control.invertY = axisY;
    guest.joined = true;
    guest.shipId = this.idOf(ship);
    guest.liveIds = new Set();
    // Scene + the full world (empty live set = everything spawns), exactly
    // like the C++ session's first tick.
    this.send(guest, GameMsg.Scene, this.buildScene(guest));
    this.sendSnapshot(guest);
    this.sendEvents(guest);
    this.sendHud(guest);
  }

  // -------------------------------------------------------------- outbound
  private send(guest: Guest, type: number, payload: Uint8Array): void {
    try {
      guest.transport.send(encodeMessage(type, payload, { threshold: HOST_GZIP_THRESHOLD }));
    } catch { /* link down */ }
  }

  private sendError(guest: Guest, message: string): void {
    this.send(guest, GameMsg.Error, encodeError(message));
  }

  /** Assign the guest a ship: adopt an AI-ship slot, else spawn one. */
  private assignShip(guest: Guest): SpaceShip | null {
    const gi = this.gi;
    const host = gi.selectedObject;
    if (!host) return null;
    const team = host.team;
    const taken = new Set<SpaceShip>();
    for (const g of this.guests.values()) if (g.ship) taken.add(g.ship);
    // 1. An AI ship of the host's team still flying its own brain.
    for (const o of [...team.objects]) {
      if (!(o instanceof SpaceShip) || !o.active || o.isPlayer || taken.has(o)) continue;
      if (!o.intelligence) continue;
      guest.restoreIntelligence = o.intelligence;
      guest.spawned = false;
      o.intelligence = new HILocal(gi, o, guest.control, gi.rc);
      o.isPlayer = true;
      guest.ship = o;
      return o;
    }
    // 2. No free AI ship (time trials): build a new wingman next to the host.
    const life = host.life instanceof Life3
      ? new Life3(host.life.maxLeft, host.life.maxCenter, host.life.maxRight)
      : new Life1(100);
    const side = host.side;
    const pos = vec3.fromValues(
      host.pos[0] + side[0] * 14 - host.dir[0] * 6,
      host.pos[1] + 2 + side[1] * 14,
      host.pos[2] + side[2] * 14 - host.dir[2] * 6,
    );
    const ship = new SpaceShip(host.physics, gi, team, pos, host.model, life, gi.rc.model('Base'));
    quat.copy(ship.rot, host.rot);
    ship.isPlayer = true;
    ship.intelligence = new HILocal(gi, ship, guest.control, gi.rc);
    ship.update();
    guest.spawned = true;
    guest.ship = ship;
    return ship;
  }

  /** Undo `assignShip`: give the AI its brain back, or remove the wingman. */
  private releaseShip(guest: Guest): void {
    const ship = guest.ship;
    if (!ship) return;
    ship.intelligence = null;
    if (guest.restoreIntelligence && !guest.spawned) {
      ship.intelligence = guest.restoreIntelligence;
      ship.isPlayer = false;
    } else {
      // The wingman exists only for this guest: remove it from the world.
      const i = ship.team.objects.indexOf(ship);
      if (i >= 0) ship.team.objects.splice(i, 1);
      this.gi.map.removeObject(ship);
      this.ids.delete(ship);
    }
    guest.ship = null;
    guest.restoreIntelligence = null;
  }

  // -------------------------------------------------------------- per tick
  /** Before the simulation steps: apply remote throttles (nitro burns now). */
  preTick(dtMs: number): void {
    const now = performance.now();
    for (const guest of this.guests.values()) {
      if (!guest.joined || !guest.ship) continue;
      if (now - guest.lastInputAt > INPUT_TIMEOUT_MS) guest.control.release();
      if (guest.inputNitro && guest.ship.active) guest.ship.launchNitro(dtMs);
    }
  }

  /** Streams snapshots/events/hud at the fixed 30 Hz wire cadence. */
  postTick(dtMs: number): void {
    this.accumMs += dtMs;
    if (this.accumMs < TICK_MS) return;
    this.accumMs = Math.min(this.accumMs % TICK_MS, TICK_MS);
    for (const guest of this.guests.values()) {
      if (!guest.joined) continue;
      this.sendSnapshot(guest);
      this.sendEvents(guest);
      this.sendHud(guest);
    }
    if (this.gi.finished && !this.resultSent) {
      this.resultSent = true;
      const res = this.gi.result;
      this.broadcast(GameMsg.Result, encodeResult({
        won: !!res?.won,
        reward: res?.reward ?? 'Defeat',
        message: res?.message ?? '',
      }));
    }
    this.tick = (this.tick + 1) >>> 0;
    this.voices.length = 0;
    this.explosions.length = 0;
  }

  private broadcast(type: number, payload: Uint8Array): void {
    for (const guest of this.guests.values()) {
      if (guest.joined) this.send(guest, type, payload);
    }
  }

  // ------------------------------------------------------------------ ids
  /** Stable wire id per object (the C++ session's idOf). */
  private idOf(obj: Abstract3D): number {
    const hit = this.ids.get(obj);
    if (hit !== undefined) return hit;
    const id = this.nextId++;
    this.ids.set(obj, id);
    return id;
  }

  private wireKind(obj: Abstract3D): number | null {
    if (obj instanceof SpaceShip) return WireKind.Ship;
    if (obj instanceof HomingMissile) return WireKind.Missile;
    if (obj instanceof Bullet) return WireKind.Bullet;
    if (obj instanceof Flag) return WireKind.Flag;
    if (obj instanceof Ark) return WireKind.Ark;
    if (obj instanceof Addon) return WireKind.Addon;
    if (obj instanceof Base) return WireKind.Base;
    if (obj instanceof Asteroid) return WireKind.Asteroid;
    return null; // billboards/decor travel in the Scene; the rest is visual
  }

  private isDynamic(obj: Abstract3D): boolean {
    return obj instanceof SpaceShip || obj instanceof Flag || obj instanceof Ark || obj instanceof Bullet;
  }

  // ----------------------------------------------------------------- scene
  /** Alias table + team list (the client indexes both by position). */
  private buildTables(): void {
    this.modelIndex.clear();
    this.aliases = this.gi.rc.loadedAliases();
    this.aliases.forEach((alias, i) => {
      const m = this.gi.rc.model(alias);
      if (m) this.modelIndex.set(m, i);
    });
    // Only teams that field objects (plus the neutral ambient one) travel;
    // the level's other team slots are local bookkeeping.
    const teams = [...this.gi.teams.values()].filter((t) => t.objects.length > 0 || t.name === 'ambient');
    this.teamList = teams.map((team, wireIndex) => ({ team, wireIndex }));
  }

  private modelIndexOf(model: ModelData | null): number {
    if (!model) return NO_INDEX;
    return this.modelIndex.get(model) ?? NO_INDEX;
  }

  private teamIndexOf(team: import('../team').Team | null): number {
    if (!team) return NO_INDEX;
    for (const entry of this.teamList) if (entry.team === team) return entry.wireIndex;
    return NO_INDEX;
  }

  private buildScene(guest: Guest): Uint8Array {
    if (this.aliases.length === 0) this.buildTables();
    const gi = this.gi;
    const decor = gi.map.live.filter((o): o is Billboard => o instanceof Billboard);
    const scene: NetScene = {
      gameType: Math.max(0, GAME_TYPE_ORDER.indexOf(gi.gameType)),
      levelKey: gi.levelKey,
      title: gi.levelTitle,
      text: gi.levelText,
      mapSize: gi.map.size,
      sky: gi.map.skyName,
      matchTimeMs: gi.matchTimeMs,
      playerId: guest.shipId,
      models: this.aliases,
      teams: this.teamList.map(({ team }) => {
        let mask = 0;
        this.teamList.forEach((other, i) => {
          if (i < 8 && team.enemys.includes(other.team)) mask |= 1 << i;
        });
        return { name: team.name, color: [...team.color] as [number, number, number], enemies: mask };
      }),
      decor: decor.map((b) => ({ x: b.pos[0], y: b.pos[1], z: b.pos[2], scale: b.scale })),
      sun: gi.map.sun ? { x: gi.map.sun.pos[0], y: gi.map.sun.pos[1], z: gi.map.sun.pos[2], radius: gi.map.sun.radius } : null,
      region: gi.map.region ? { x: gi.map.region.pos[0], y: gi.map.region.pos[1], z: gi.map.region.pos[2], radius: gi.map.region.radius } : null,
    };
    return encodeScene(scene);
  }

  // -------------------------------------------------------------- snapshot
  private transform(obj: Abstract3D): { x: number; y: number; z: number; rx: number; ry: number; rz: number; rw: number; scale: number } {
    const so = obj as unknown as { pos?: Float32Array; rot?: Float32Array };
    const pos = so.pos;
    const rot = so.rot;
    return {
      x: pos ? pos[0] : 0,
      y: pos ? pos[1] : 0,
      z: pos ? pos[2] : 0,
      rx: rot ? rot[0] : 0,
      ry: rot ? rot[1] : 0,
      rz: rot ? rot[2] : 0,
      rw: rot ? rot[3] : 1,
      scale: obj.scale,
    };
  }

  private writeSpawn(obj: Abstract3D, id: number): NetSpawn {
    const kind = this.wireKind(obj)!;
    let state = 0;
    let model: ModelData | null = null;
    let team: import('../team').Team | null = null;
    let scale = obj.scale;
    if (obj instanceof SpaceShip) {
      state = obj.physics.reSpawns ? 1 : 0;
      scale = 1;
    } else if (obj instanceof Addon) {
      state = ADDON_WIRE[obj.command] ?? WireAddon.homing;
    } else if (obj instanceof Flag) {
      const owner = obj.getOwner();
      state = !owner ? WireFlag.Free : owner instanceof Base ? WireFlag.AtBase : WireFlag.Carried;
    }
    model = (obj as unknown as { model: ModelData | null }).model ?? null;
    team = (obj as unknown as { team: import('../team').Team | null }).team ?? null;
    return {
      id,
      kind,
      state,
      modelIdx: this.modelIndexOf(model),
      teamIdx: this.teamIndexOf(team),
      ...this.transform(obj),
      scale,
    };
  }

  private sendSnapshot(guest: Guest): void {
    const spawns: NetSpawn[] = [];
    const poses: NetPose[] = [];
    const now = new Set<number>();
    for (const obj of this.gi.map.live) {
      // Ship is wire kind 0: test for null, not truthiness.
      if (this.wireKind(obj) === null) continue;
      if (obj instanceof SpaceObject && obj.destroyed) continue;
      const id = this.idOf(obj);
      now.add(id);
      if (!guest.liveIds.has(id)) spawns.push(this.writeSpawn(obj, id));
      if (this.isDynamic(obj)) poses.push({ id, ...this.transform(obj) });
    }
    const removals: number[] = [];
    for (const id of guest.liveIds) if (!now.has(id)) removals.push(id);
    guest.liveIds = now;
    const snap: NetSnapshot = { tick: this.tick, spawns, poses, removals };
    this.send(guest, GameMsg.Snapshot, encodeSnapshot(snap, this.gi.map.size / 2));
  }

  // ---------------------------------------------------------------- events
  private sendEvents(guest: Guest): void {
    const events: NetEvent[] = [];
    for (const id of this.voices) events.push({ type: 'voice', id });
    events.push(...guest.events);
    for (const e of this.explosions) events.push(e);
    guest.events = [];
    if (events.length === 0) return;
    this.send(guest, GameMsg.Events, encodeEvents(events, this.gi.map.size / 2));
  }

  private nextSeed(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed;
  }

  private guestOf(ship: SpaceObject | null): Guest | null {
    if (!ship) return null;
    for (const guest of this.guests.values()) if (guest.ship === ship) return guest;
    return null;
  }

  /** Host simulation hooks: the moments only the player would have noticed. */
  private installHooks(): void {
    simHooks.host = {
      shipSfx: (ship, name, volume) => {
        const id = SFX_NAMES.indexOf(name);
        const guest = this.guestOf(ship);
        if (id < 0 || !guest) return;
        guest.events.push({ type: 'sound', id, volume, pan: 0 });
      },
      shipNotification: (ship, field) => {
        const id = VOICE_FIELDS.indexOf(field);
        const guest = this.guestOf(ship);
        if (id < 0 || !guest) return;
        guest.events.push({ type: 'voice', id });
      },
      voice: (field) => {
        const id = VOICE_FIELDS.indexOf(field);
        if (id >= 0) this.voices.push(id);
      },
      explosion: (info) => {
        this.explosions.push({
          type: 'explosion',
          x: info.pos[0],
          y: info.pos[1],
          z: info.pos[2],
          scale: info.scale,
          life: info.life,
          smoke: info.smoke,
          debris: info.debris,
          modelIdx: this.modelIndexOf(info.model),
          seed: this.nextSeed(),
        });
      },
      explosionSfx: (obj) => {
        for (const guest of this.guests.values()) {
          const ship = guest.ship;
          if (!guest.joined || !ship || ship === obj || !ship.active) continue;
          const vx = obj.pos[0] - ship.pos[0];
          const vy = obj.pos[1] - ship.pos[1];
          const vz = obj.pos[2] - ship.pos[2];
          const dist = Math.hypot(vx, vy, vz) || 1;
          const volume = Math.max(0, Math.min(1, 1 - dist / this.gi.rc.options.distance));
          if (volume <= 0) continue;
          const pan = Math.max(-1, Math.min(1, -8 * (
            ship.side[0] * (vx / dist) + ship.side[1] * (vy / dist) + ship.side[2] * (vz / dist)
          )));
          const name = obj instanceof Ark
            ? 'addonSound'
            : dist < this.gi.rc.options.distance / 2 ? 'closeExplosion' : 'farExplosion';
          const id = SFX_NAMES.indexOf(name);
          if (id >= 0) guest.events.push({ type: 'sound', id, volume, pan });
        }
      },
    };
  }

  // ------------------------------------------------------------------- hud
  private shipOf(guest: Guest): SpaceShip | null {
    const ship = guest.ship;
    return ship && ship.active ? ship : null;
  }

  private buildHud(guest: Guest): NetHud {
    const gi = this.gi;
    const sel = this.shipOf(guest);
    const matchLeft = gi.matchTimeMs > 0 && sel ? Math.max(0, gi.matchTimeMs - sel.team.timeMs) : -1;
    const countdownSec = gi.startCountdownMs > 0 ? Math.ceil(gi.startCountdownMs / 1000) : 0;
    const deathCause = sel ? gi.deathCauses.get(sel) ?? '' : '';
    let life: { value: number; max: number }[] = [];
    if (sel?.life) {
      if (sel.life instanceof Life3) {
        life = [
          { value: sel.life.left, max: sel.life.maxLeft },
          { value: sel.life.center, max: sel.life.maxCenter },
          { value: sel.life.right, max: sel.life.maxRight },
        ];
      } else {
        life = [{ value: sel.life.total(), max: 100 }];
      }
    }
    const outside = this.timerOf(gi.map.outsideObjects, sel);
    const respawn = this.timerOf(gi.map.respawned, sel);
    let missileWarn = false;
    if (sel) {
      for (const o of gi.map.live) {
        if (!(o instanceof HomingMissile) || !o.active || !o.intelligence) continue;
        const locked = (o.intelligence as unknown as { lockedTarget?: () => SpaceObject | null }).lockedTarget?.();
        if (locked === sel) {
          missileWarn = true;
          break;
        }
      }
    }
    const lockOn = sel ? this.lockCandidate(sel) : false;
    const teams: NetHudTeam[] = this.teamList.map(({ team }) => ({
      name: team.name,
      points: team.points,
      kills: team.kills,
      hillMs: team.hillMs,
      timeMs: team.timeMs,
    }));
    const ships: { id: number; pct: number }[] = [];
    for (const o of gi.map.live) {
      if (!(o instanceof SpaceShip) || !o.active) continue;
      let pct = o.lifePercentage();
      if (!(pct > 0)) pct = 0;
      if (pct > 1) pct = 1;
      ships.push({ id: this.idOf(o), pct: Math.round(pct * 100) });
    }
    return {
      tick: this.tick,
      matchLeft,
      countdownSec,
      deathCause,
      life,
      outside,
      respawn,
      speed: sel ? vec3.length(sel.vel) : 0,
      missileWarn,
      lockOn,
      homings: sel ? sel.homings & 0xff : 0,
      nitroPct: sel ? Math.floor((sel.nitro / 3000) * 100) : 0,
      teams,
      ships,
      selectedId: sel ? this.idOf(sel) : 0,
      finished: gi.finished,
    };
  }

  private timerOf(list: { obj: SpaceObject; elapsed: number; max: number }[], ship: SpaceShip | null): { left: number; total: number } | null {
    if (!ship) return null;
    for (const t of list) {
      if (t.obj === ship) return { left: Math.max(0, t.max - t.elapsed), total: t.max };
    }
    return null;
  }

  /** An enemy ship inside the 10 degree cone within missile range. */
  private lockCandidate(sel: SpaceShip): boolean {
    const found: SpaceObject[] = [];
    this.gi.map.octree.sphereSelectInteractive(
      sel.sx, sel.sy, sel.sz, 256, found as unknown as import('../../engine/octree').OctItem[],
    );
    const cosCone = Math.cos(0.175);
    for (const o of found) {
      if (!(o instanceof SpaceShip) || !o.active || o === sel) continue;
      if (!sel.team.enemys.includes(o.team)) continue;
      const dx = o.pos[0] - sel.pos[0];
      const dy = o.pos[1] - sel.pos[1];
      const dz = o.pos[2] - sel.pos[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      if ((sel.dir[0] * dx + sel.dir[1] * dy + sel.dir[2] * dz) / len > cosCone) return true;
    }
    return false;
  }

  private sendHud(guest: Guest): void {
    this.send(guest, GameMsg.Hud, encodeHud(this.buildHud(guest)));
  }
}

const ADDON_WIRE: Record<string, number> = {
  homing: WireAddon.homing,
  life: WireAddon.life,
  nitro: WireAddon.nitro,
  shield: WireAddon.shield,
};
