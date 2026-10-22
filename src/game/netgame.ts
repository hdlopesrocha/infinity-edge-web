// NetGame: a server-authoritative match. The C++ game server (see server/)
// owns the simulation and every model position; this GameInstance only renders
// the Scene/Snapshot/Events/Hud frames it receives and streams the player's
// Input back. It is selected when a game server is configured - `?game=...`,
// VITE_IE_GAME_WS or window.__IE_GAME_WS - and the plain local GameInstance
// simulation stays the offline fallback when there is none (or it is down).
//
// Frames are the binary protocol of src/game/protocol.ts, wrapped in the same
// gzipped 8-byte header the asset channel uses (net.ts). Poses are rendered
// through a one-tick interpolation gutter: each new snapshot starts a fresh
// 33 ms segment from wherever the object is currently drawn towards the new
// pose, so 30 Hz snapshots look smooth at any frame rate.

import { quat, vec3 } from '../engine/math';
import type { OctItem } from '../engine/octree';
import type { Renderer } from '../engine/renderer';
import { GameInstance } from './instance';
import type { GameType } from './instance';
import { Life1, Life3 } from './life';
import { GameMap } from './map';
import {
  Addon, Ark, Asteroid, Base, Billboard, Bullet, Flag, HomingMissile, Object3D, SpaceObject,
  SpaceShip, spawnExplosion,
} from './objects';
import type { Abstract3D, ModelData } from './objects';
import { P } from './physics';
import type { RC } from './resources';
import { Team } from './team';
import type { RewardType } from './team';
import { SKY_HSB } from './config';
import { smartAIRequested } from './ai';
import { decodeMessage, encodeMessage } from './net';
import { webSocketTransport } from './mp/transport';
import type { GameTransport } from './mp/transport';
import {
  decodeError, decodeEvents, decodeHud, decodePong, decodeResult, decodeScene, decodeSnapshot,
  encodeInput, encodeJoin, encodeLeave, encodePing, GAME_TYPE_ORDER, GameMsg, NO_INDEX, SFX_NAMES,
  TICK_MS, VOICE_FIELDS, WireAddon, WireFlag, WireKind, Reader,
} from './protocol';
import type { InputState, NetEvent, NetHud, NetPose, NetScene, NetSnapshot, NetSpawn } from './protocol';

/** Scene models/textures the client needs besides the server's model table. */
const SCENE_TEXTURES = [
  'flare1', 'flare2', 'hexagon', 'aim', 'over',
  'Fighter3_icon', 'Ark_icon', 'Base_icon', 'Flag_icon',
];

/** WebSocket URL of the game server, or null to keep the local simulation. */
export function resolveGameWsUrl(): string | null {
  const w = (window as unknown as { __IE_GAME_WS?: unknown }).__IE_GAME_WS;
  if (typeof w === 'string' && w.trim()) return normalizeWsUrl(w);
  let param: string | null = null;
  try {
    param = new URLSearchParams(window.location.search).get('game');
  } catch { param = null; }
  if (param) {
    if (param === '1' || param === 'on' || param === 'true') {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const host = window.location.hostname || '127.0.0.1';
      return normalizeWsUrl(`${proto}://${host}:8091/game`);
    }
    return normalizeWsUrl(param);
  }
  const env = import.meta.env.VITE_IE_GAME_WS as string | undefined;
  return env && env.trim() ? normalizeWsUrl(env) : null;
}

/** Accepts full ws URLs, `host:port` and paths; defaults the path to /game. */
function normalizeWsUrl(url: string): string {
  let u = url.trim();
  if (!/^wss?:\/\//i.test(u)) {
    // Relative paths are same-origin: on an https page they must be wss (the
    // dev server's /game proxy or a TLS-terminating reverse proxy).
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    u = u.startsWith('/') ? `${proto}://${window.location.host}${u}` : `ws://${u}`;
  }
  try {
    const parsed = new URL(u);
    if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = '/game';
    return parsed.toString();
  } catch {
    return u;
  }
}

/** Deterministic 32-bit LCG, the same recurrence the simulation uses. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function sqDist(a: vec3, b: vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

/** Per-object interpolation state: where it is drawn and where it is going. */
class Track {
  readonly prevPos = new Float32Array(3);
  readonly prevRot = new Float32Array(4);
  readonly curPos = new Float32Array(3);
  readonly curRot = new Float32Array(4);
  prevScale = 1;
  curScale = 1;
  /** Milliseconds into the current segment (TICK_MS = arrived at `cur`). */
  t = TICK_MS;
}

export class NetGame extends GameInstance {
  private transport: GameTransport | null = null;
  /** Frames are processed strictly in arrival order (gunzip is async). */
  private chain: Promise<void> = Promise.resolve();
  private pendingReady: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private disposed = false;
  private joined = false;

  private scene: NetScene | null = null;
  private ids = new Map<number, Abstract3D>();
  private tracks = new Map<number, Track>();
  private teamsByIndex: Team[] = [];
  private modelsByIndex: (ModelData | null)[] = [];
  private ships: SpaceShip[] = [];
  private flags: Flag[] = [];
  private respawnShips = new Set<number>();
  private pendingFlags: NetSpawn[] = [];
  private launchers = new Map<Team, SpaceObject>();
  private half = 1024;
  private playerId = 0;
  private netMissileWarn = false;
  private netLockOn = false;
  /** Authoritative speed of the selected ship, from the Hud frame. */
  private netSpeed = 0;
  private latencyMs = 0;
  private pingId = 1;
  private pingSent = new Map<number, number>();
  private lastPingAt = 0;
  private lastInputAt = 0;
  private beatTimer = 0;

  private constructor(renderer: Renderer, rc: RC) {
    super(renderer, rc);
  }

  /** Connects to a WebSocket server, joins `levelKey`, resolves on Scene. */
  static async open(renderer: Renderer, rc: RC, url: string, levelKey: string): Promise<NetGame> {
    const gi = new NetGame(renderer, rc);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      throw e as Error;
    }
    await gi.connect(webSocketTransport(ws), levelKey);
    return gi;
  }

  /**
   * Same, over any prepared transport - the multiplayer mode hands in an open
   * RTC data channel to the browser host instead of a WebSocket to the C++
   * server. The wire frames are identical.
   */
  static async openTransport(
    renderer: Renderer, rc: RC, transport: GameTransport, levelKey: string,
  ): Promise<NetGame> {
    const gi = new NetGame(renderer, rc);
    await gi.connect(transport, levelKey);
    return gi;
  }

  /** Last measured round-trip time to the server (Ping/Pong). */
  get rtt(): number {
    return this.latencyMs;
  }

  // ------------------------------------------------------------ connection
  private connect(transport: GameTransport, levelKey: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.transport = transport;
      const sendJoin = (): void => {
        this.send(GameMsg.Join, encodeJoin(levelKey, {
          smartAI: smartAIRequested(),
          distance: this.rc.options.distance,
          axisX: this.rc.options.axisX,
          axisY: this.rc.options.axisY,
        }));
      };
      const timer = window.setTimeout(() => {
        this.failPending(new Error('timeout waiting for the Scene frame'));
        this.closeSocket();
      }, 15000);
      this.pendingReady = {
        resolve: () => {
          window.clearTimeout(timer);
          this.joined = true;
          this.lastInputAt = 0;
          this.lastPingAt = 0;
          this.beatTimer = window.setInterval(() => this.beat(), 200);
          resolve();
        },
        reject: (e: Error) => {
          window.clearTimeout(timer);
          reject(e);
        },
      };
      transport.onopen = () => sendJoin();
      transport.onmessage = (data) => {
        this.chain = this.chain
          .then(() => this.onRaw(data))
          .catch((e: unknown) => {
            console.warn('[net] frame failed:', e);
            this.failPending(e as Error);
          });
      };
      transport.onclose = () => this.onClose();
      if (transport.open) sendJoin();
    });
  }

  /** Leaves the match and closes the link (scene switches, unmount). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearInterval(this.beatTimer);
    const t = this.transport;
    this.transport = null;
    if (t) {
      try {
        if (t.open) t.send(encodeMessage(GameMsg.Leave, encodeLeave()));
      } catch { /* already closing */ }
      try {
        t.close();
      } catch { /* already closed */ }
    }
    this.failPending(new Error('disposed'));
    this.tracks.clear();
    this.ids.clear();
  }

  private closeSocket(): void {
    const t = this.transport;
    this.transport = null;
    if (t) {
      try {
        t.close();
      } catch { /* already closed */ }
    }
  }

  private failPending(e: Error): void {
    const p = this.pendingReady;
    this.pendingReady = null;
    if (p) p.reject(e);
  }

  private onClose(): void {
    window.clearInterval(this.beatTimer);
    this.transport = null;
    if (this.pendingReady) {
      this.failPending(new Error('game server closed the connection'));
      return;
    }
    if (this.disposed || this.result || this.finished) return;
    // Lost mid-match: route through the normal defeat flow with a clear cause.
    this.notificationText = 'Connection lost';
    this.notificationTime = 3000;
    this.result = { won: false, reward: 'Defeat', message: 'Connection lost' };
  }

  private send(type: number, payload: Uint8Array): void {
    const t = this.transport;
    if (!t || !t.open) return;
    try {
      t.send(encodeMessage(type, payload));
    } catch { /* closing */ }
  }

  /** Neutral inputs while paused/backgrounded: the server must not fly on. */
  private beat(): void {
    if (this.disposed || !this.joined) return;
    const now = performance.now();
    if (now - this.lastInputAt > 250) {
      this.lastInputAt = now;
      this.send(GameMsg.Input, encodeInput({
        stickX: 0, stickY: 0, throttle: 0, fire: false, homing: false, nitro: false,
      }));
    }
    if (now - this.lastPingAt > 2000) {
      this.lastPingAt = now;
      const id = this.pingId++;
      this.pingSent.set(id, now);
      this.send(GameMsg.Ping, encodePing(id));
    }
  }

  // -------------------------------------------------------------- inbound
  private async onRaw(data: ArrayBuffer | Uint8Array): Promise<void> {
    const frame = await decodeMessage(data);
    const r = new Reader(frame.payload);
    switch (frame.type) {
      case GameMsg.Scene: {
        const scene = decodeScene(r);
        try {
          await this.prepareScene(scene);
        } catch (e) {
          this.failPending(e as Error);
          return;
        }
        const ready = this.pendingReady;
        this.pendingReady = null;
        ready?.resolve();
        break;
      }
      case GameMsg.Snapshot:
        this.applySnapshot(decodeSnapshot(r, this.half));
        break;
      case GameMsg.Events:
        this.applyEvents(decodeEvents(r, this.half));
        break;
      case GameMsg.Hud:
        this.applyHud(decodeHud(r));
        break;
      case GameMsg.Result: {
        const res = decodeResult(r);
        this.result = {
          won: res.won,
          draw: res.reward === 'Draw',
          reward: res.reward as RewardType,
          message: res.message || null,
        };
        break;
      }
      case GameMsg.Pong: {
        const pong = decodePong(r);
        const sent = this.pingSent.get(pong.id);
        if (sent !== undefined) {
          this.latencyMs = performance.now() - sent;
          this.pingSent.delete(pong.id);
        }
        break;
      }
      case GameMsg.Error: {
        const message = decodeError(r);
        console.warn('[net] server error:', message);
        this.notificationText = message;
        this.notificationTime = 5000;
        if (this.pendingReady) {
          this.failPending(new Error(message));
          this.closeSocket();
        }
        break;
      }
      default:
        break;  // unknown types are ignored (forward compatibility)
    }
  }

  private async prepareScene(s: NetScene): Promise<void> {
    this.scene = s;
    this.levelKey = s.levelKey;
    this.levelTitle = s.title;
    this.levelText = s.text;
    this.gameType = (GAME_TYPE_ORDER[s.gameType] as GameType | undefined) ?? 'BACK';
    this.matchTimeMs = s.matchTimeMs;
    this.playerId = s.playerId;
    // The server owns the simulation; the client's map is a render container.
    this.map = new GameMap(s.sky, s.mapSize || 2048);
    this.half = this.map.size / 2;
    this.map.rng = lcg(123456789);
    this.skyHsb = SKY_HSB[s.sky] ?? [0, 1, 1];
    await this.rc.preload(s.models, SCENE_TEXTURES);
    const sky = this.rc.model('Sky1');
    if (sky) {
      const lod0 = sky.solid[0] ?? sky.color[0];
      if (lod0) {
        this.skyGpu = lod0;
        this.skyTex = sky.tex;
      }
    }
    this.modelsByIndex = s.models.map((alias) => this.rc.model(alias));
    this.teams.clear();
    this.teamsByIndex = [];
    for (const t of s.teams) {
      const team = new Team(t.name, [t.color[0], t.color[1], t.color[2]]);
      this.teams.set(t.name, team);
      this.teamsByIndex.push(team);
    }
    // The factions came over the wire (the level's team lists are server-side).
    for (let i = 0; i < this.teamsByIndex.length; i++) {
      const mask = s.teams[i]?.enemies ?? 0;
      for (let j = 0; j < this.teamsByIndex.length; j++) {
        if (j !== i && (mask & (1 << j)) !== 0) this.teamsByIndex[i].enemys.push(this.teamsByIndex[j]);
      }
    }
    if (s.sun) this.map.sun = { pos: vec3.fromValues(s.sun.x, s.sun.y, s.sun.z), radius: s.sun.radius };
    if (s.region) this.map.region = { pos: vec3.fromValues(s.region.x, s.region.y, s.region.z), radius: s.region.radius };
    if (this.rc.options.billboards) {
      const tex = this.rc.tex('flare1');
      const ambient = this.teams.get('ambient') ?? this.teamsByIndex[0];
      if (ambient) {
        for (const d of s.decor) {
          new Billboard(this.map, ambient, vec3.fromValues(d.x, d.y, d.z), tex, d.scale, 1);
        }
      }
    }
  }

  private teamAt(index: number): Team | null {
    if (index === NO_INDEX) return this.teams.get('ambient') ?? this.teamsByIndex[0] ?? null;
    return this.teamsByIndex[index] ?? null;
  }

  private modelAt(index: number): ModelData | null {
    if (index === NO_INDEX) return null;
    return this.modelsByIndex[index] ?? null;
  }

  private applySnapshot(snap: NetSnapshot): void {
    for (const sp of snap.spawns) this.applySpawn(sp);
    this.flushPendingFlags();
    for (const p of snap.poses) this.applyPose(p);
    for (const id of snap.removals) this.applyRemoval(id);
  }

  private applySpawn(sp: NetSpawn): void {
    // A destroyed respawning ship keeps its id: the server spawns it again.
    const existing = this.ids.get(sp.id);
    if (existing) {
      const o = existing as Object3D;
      if (existing instanceof SpaceObject) {
        existing.restoreLife();
        // The wreck's stale segment velocity must not trail smoke on revive.
        vec3.set(existing.vel, 0, 0, 0);
      }
      vec3.set(o.pos, sp.x, sp.y, sp.z);
      quat.set(o.rot, sp.rx, sp.ry, sp.rz, sp.rw);
      o.scale = sp.scale;
      o.markPrev();
      this.map.insertObject(o);
      return;
    }
    const model = this.modelAt(sp.modelIdx);
    const team = this.teamAt(sp.teamIdx);
    const pos = vec3.fromValues(sp.x, sp.y, sp.z);
    let obj: Abstract3D | null = null;
    switch (sp.kind) {
      case WireKind.Ship: {
        if (!model || !team) break;
        const ship = new SpaceShip(
          (sp.state & 1) !== 0 ? P.SS1R : P.SS1, this, team, pos, model, new Life1(100),
          this.rc.model('Base'),
        );
        ship.isPlayer = sp.id === this.playerId;
        this.ships.push(ship);
        if ((sp.state & 1) !== 0) this.respawnShips.add(sp.id);
        if (ship.isPlayer) this.selectedObject = ship;
        obj = ship;
        break;
      }
      case WireKind.Asteroid: {
        if (!model || !team) break;
        obj = new Asteroid(this.map, team, pos, model, null);
        break;
      }
      case WireKind.Addon: {
        if (!model || !team) break;
        const conf: Record<number, { model: string; color: [number, number, number]; kind: 'homing' | 'life' | 'nitro' | 'shield' }> = {
          [WireAddon.homing]: { model: 'adHomingMissile', color: [1, 0, 0], kind: 'homing' },
          [WireAddon.life]: { model: 'adRepair', color: [0.2, 1, 0.2], kind: 'life' },
          [WireAddon.nitro]: { model: 'adNitro', color: [1, 0.55, 0], kind: 'nitro' },
          [WireAddon.shield]: { model: 'adShield', color: [0.4, 0.6, 1], kind: 'shield' },
        };
        const c = conf[sp.state] ?? conf[WireAddon.homing];
        obj = new Addon(this, team, pos, c.model, c.color, c.kind, this.map);
        break;
      }
      case WireKind.Base: {
        if (!model || !team) break;
        obj = new Base(this.map, team, pos, model, 1);
        break;
      }
      case WireKind.Flag: {
        if (!model || !team) break;
        if (!team.base) {
          // The base did not spawn yet (level order): retry after the batch.
          this.pendingFlags.push(sp);
          break;
        }
        const flag = new Flag(this, team.base, model);
        flag.setOwner(sp.state === WireFlag.AtBase ? team.base : null);
        this.flags.push(flag);
        obj = flag;
        break;
      }
      case WireKind.Bullet: {
        if (!model || !team) break;
        obj = new Bullet(this, model, this.launcherFor(team, model), { pos, dir: vec3.fromValues(0, 0, 1) });
        break;
      }
      case WireKind.Missile: {
        if (!model || !team) break;
        obj = new HomingMissile(this, model, this.launcherFor(team, model), pos, 2000);
        break;
      }
      case WireKind.Ark: {
        if (!model || !team) break;
        const ark = new Ark(this.map, team, pos, model);
        this.map.path.push(ark);
        obj = ark;
        break;
      }
      case WireKind.Billboard: {
        if (!team) break;
        obj = new Billboard(this.map, team, pos, this.rc.tex('flare1'), sp.scale, 1);
        break;
      }
      default:
        break;  // Sun/Region travel in the Scene frame
    }
    if (!obj) return;
    if (obj instanceof Object3D) {
      // Spawned statics carry their pose; dynamics refine it every tick.
      quat.set(obj.rot, sp.rx, sp.ry, sp.rz, sp.rw);
      obj.scale = sp.scale;
      obj.update();
    }
    this.ids.set(sp.id, obj);
  }

  private flushPendingFlags(): void {
    if (this.pendingFlags.length === 0) return;
    const pending = this.pendingFlags;
    this.pendingFlags = [];
    for (const sp of pending) this.applySpawn(sp);
  }

  private launcherFor(team: Team, model: ModelData): SpaceObject {
    let l = this.launchers.get(team);
    if (!l) {
      l = new SpaceObject(P.EMPTY, team, vec3.create(), model, null, 1);
      this.launchers.set(team, l);
    }
    return l;
  }

  private applyPose(p: NetPose): void {
    const tr = this.tracks.get(p.id);
    if (!tr) {
      if (!(this.ids.get(p.id) instanceof Object3D)) return;
      const fresh = new Track();
      fresh.prevPos[0] = fresh.curPos[0] = p.x;
      fresh.prevPos[1] = fresh.curPos[1] = p.y;
      fresh.prevPos[2] = fresh.curPos[2] = p.z;
      fresh.prevRot[0] = fresh.curRot[0] = p.rx;
      fresh.prevRot[1] = fresh.curRot[1] = p.ry;
      fresh.prevRot[2] = fresh.curRot[2] = p.rz;
      fresh.prevRot[3] = fresh.curRot[3] = p.rw;
      fresh.prevScale = fresh.curScale = p.scale;
      this.tracks.set(p.id, fresh);
      return;
    }
    // Freeze the pose currently drawn as the new segment's start.
    const a = tr.t >= TICK_MS ? 1 : tr.t / TICK_MS;
    if (a >= 1) {
      tr.prevPos[0] = tr.curPos[0];
      tr.prevPos[1] = tr.curPos[1];
      tr.prevPos[2] = tr.curPos[2];
      tr.prevRot.set(tr.curRot);
      tr.prevScale = tr.curScale;
    } else {
      tr.prevPos[0] += (tr.curPos[0] - tr.prevPos[0]) * a;
      tr.prevPos[1] += (tr.curPos[1] - tr.prevPos[1]) * a;
      tr.prevPos[2] += (tr.curPos[2] - tr.prevPos[2]) * a;
      quat.slerp(tr.prevRot, tr.prevRot, tr.curRot, a);
      tr.prevScale += (tr.curScale - tr.prevScale) * a;
    }
    tr.curPos[0] = p.x;
    tr.curPos[1] = p.y;
    tr.curPos[2] = p.z;
    tr.curRot[0] = p.rx;
    tr.curRot[1] = p.ry;
    tr.curRot[2] = p.rz;
    tr.curRot[3] = p.rw;
    tr.curScale = p.scale;
    tr.t = 0;
  }

  private applyRemoval(id: number): void {
    this.tracks.delete(id);
    const obj = this.ids.get(id);
    if (!obj) return;
    if (this.respawnShips.has(id)) {
      // Destroyed but respawning: hidden until its new spawn record arrives.
      this.map.removeObject(obj);
      return;
    }
    this.ids.delete(id);
    if (obj instanceof SpaceShip) {
      const i = this.ships.indexOf(obj);
      if (i >= 0) this.ships.splice(i, 1);
      const j = obj.team.objects.indexOf(obj);
      if (j >= 0) obj.team.objects.splice(j, 1);
    } else if (obj instanceof Flag) {
      const i = this.flags.indexOf(obj);
      if (i >= 0) this.flags.splice(i, 1);
    } else if (obj instanceof Ark) {
      const i = this.map.path.indexOf(obj);
      if (i >= 0) this.map.path.splice(i, 1);
    }
    this.map.removeObject(obj);
  }

  private applyEvents(events: NetEvent[]): void {
    for (const e of events) {
      if (e.type === 'voice') {
        const field = VOICE_FIELDS[e.id];
        if (field) this.setNotification(field);
      } else if (e.type === 'sound') {
        const name = SFX_NAMES[e.id];
        if (name) this.rc.playSfx(name, e.volume, e.pan);
      } else {
        const model = this.modelAt(e.modelIdx);
        const pos = vec3.fromValues(e.x, e.y, e.z);
        const team = this.teams.get('ambient') ?? this.teamsByIndex[0] ?? null;
        const launcher = e.debris > 0 && model && team ? new SpaceObject(P.EMPTY, team, pos, model, null, 1) : null;
        // The event carries its own seed: the burst looks the same on every
        // client and never disturbs the session's shared RNG.
        const old = this.map.rng;
        this.map.rng = lcg(e.seed);
        try {
          spawnExplosion(this.map, pos, e.scale, {
            smoke: e.smoke,
            debris: launcher ? e.debris : 0,
            launcher,
            life: e.life,
          });
        } finally {
          this.map.rng = old;
        }
      }
    }
  }

  private applyHud(h: NetHud): void {
    this.startCountdownMs = h.countdownSec * 1000;
    this.deathCause = h.deathCause;
    this.finished = h.finished;
    this.netMissileWarn = h.missileWarn;
    this.netLockOn = h.lockOn;
    this.control.homings = h.homings;
    this.control.nitroFrac = h.nitroPct / 100;
    for (const t of h.teams) {
      const team = this.teams.get(t.name);
      if (!team) continue;
      team.points = t.points;
      team.kills = t.kills;
      team.hillMs = t.hillMs;
      team.timeMs = t.timeMs;
    }
    const sel = this.selectedObject;
    this.netSpeed = sel ? h.speed : 0;
    if (sel) {
      if (h.life.length === 3) {
        const life = new Life3(h.life[0].max, h.life[1].max, h.life[2].max);
        life.left = h.life[0].value;
        life.center = h.life[1].value;
        life.right = h.life[2].value;
        sel.life = life;
      } else if (h.life.length === 1) {
        const life = new Life1(h.life[0].max);
        life.center = h.life[0].value;
        sel.life = life;
      }
      sel.insideMap = !h.outside;
      this.map.outsideObjects = h.outside
        ? [{ obj: sel, elapsed: h.outside.total - h.outside.left, max: h.outside.total }]
        : [];
      this.map.respawned = h.respawn
        ? [{ obj: sel, elapsed: h.respawn.total - h.respawn.left, max: h.respawn.total }]
        : [];
    }
    // Marker labels: the life percentage of every other ship.
    for (const s of h.ships) {
      const obj = this.ids.get(s.id);
      if (obj instanceof SpaceShip && obj.life instanceof Life1 && !obj.isPlayer) {
        obj.life.center = s.pct;
      }
    }
  }

  // --------------------------------------------------------------- render
  override missileLocked(): boolean {
    return this.netMissileWarn;
  }

  override lockCandidate(): boolean {
    return this.netLockOn;
  }

  override update(dtMs: number): void {
    // Pre-match hold: the world stands still; only the camera is placed.
    if (this.startCountdownMs > 0) {
      if (this.selectedObject) {
        const o = this.selectedObject;
        this.renderer.camera.lookAtObject(
          o.pos, o.dir, o.side, o.rot, { stickX: 0, stickY: 0 },
          this.rc.options.axisX, this.rc.options.axisY, this.rc.options.distance,
        );
      }
      return;
    }
    this.dtMs = dtMs;
    if (this.finished) return;
    this.control.update(this.canvasW, this.canvasH);
    this.sendInput();
    this.notificationTime -= dtMs;
    if (this.notificationTime < 0) {
      this.notificationTime = 0;
      this.notificationText = '';
    }
    this.stepTracks(dtMs);
    this.map.updateVisuals(this, dtMs);
    this.updateFlagOwners();
    if (this.selectedObject) {
      const o = this.selectedObject;
      this.renderer.camera.lookAtObject(
        o.pos, o.dir, o.side, o.rot,
        { stickX: this.control.analogStick.value.x, stickY: this.control.analogStick.value.y },
        this.rc.options.axisX, this.rc.options.axisY, this.rc.options.distance,
      );
    }
  }

  private sendInput(): void {
    if (!this.joined) return;
    const c = this.control;
    const input: InputState = {
      stickX: c.analogStick.value.x,
      stickY: c.analogStick.value.y,
      throttle: c.analogAcel.value,
      fire: c.fireButton.value,
      homing: c.homingButton.value,
      nitro: c.nitroButton.value,
    };
    this.lastInputAt = performance.now();
    this.send(GameMsg.Input, encodeInput(input));
  }

  /** One interpolation step per posed object, then refresh its octree cell. */
  private stepTracks(dtMs: number): void {
    for (const [id, tr] of this.tracks) {
      const obj = this.ids.get(id);
      if (!obj) {
        this.tracks.delete(id);
        continue;
      }
      tr.t += dtMs;
      const o = obj as Object3D;
      vec3.copy(o.lastPos, o.pos);
      o.markPrev();
      if (tr.t >= TICK_MS) {
        vec3.set(o.pos, tr.curPos[0], tr.curPos[1], tr.curPos[2]);
        quat.copy(o.rot, tr.curRot);
        o.scale = tr.curScale;
      } else {
        const a = tr.t / TICK_MS;
        vec3.set(
          o.pos,
          tr.prevPos[0] + (tr.curPos[0] - tr.prevPos[0]) * a,
          tr.prevPos[1] + (tr.curPos[1] - tr.prevPos[1]) * a,
          tr.prevPos[2] + (tr.curPos[2] - tr.prevPos[2]) * a,
        );
        quat.slerp(o.rot, tr.prevRot, tr.curRot, a);
        o.scale = tr.prevScale + (tr.curScale - tr.prevScale) * a;
      }
      o.update();
      this.map.octree.refresh(o as unknown as OctItem);
      if (o instanceof SpaceObject) {
        // The wire only carries poses: derive the drawn velocity from the
        // segment being interpolated (units/s), then pin the selected ship to
        // the authoritative Hud speed - the HUD readout and the zoom blur read
        // `vel` exactly as they do in the local simulation.
        vec3.subtract(o.vel, tr.curPos, tr.prevPos);
        vec3.scale(o.vel, o.vel, 1000 / TICK_MS);
        if (o === this.selectedObject && this.netSpeed > 0) {
          const len = vec3.length(o.vel);
          if (len > 0) vec3.scale(o.vel, o.vel, this.netSpeed / len);
        }
        // Engine trails: the same puffs the local simulation emits.
        if (o instanceof SpaceShip || o instanceof HomingMissile) {
          if (vec3.length(o.vel) > 0) o.createSmoke(this);
        }
      }
    }
  }

  /**
   * The flag pointer rule needs to know who carries a flag; the wire only
   * sends poses, so the carried flag is the one sitting on a ship.
   */
  private updateFlagOwners(): void {
    for (const f of this.flags) {
      if (!f.active) continue;
      let best: SpaceObject | null = null;
      let bestD = 16;  // 4 units squared
      for (const s of this.ships) {
        if (!s.active) continue;
        const d = sqDist(s.pos, f.pos);
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (!best && f.team.base) {
        best = sqDist(f.team.base.pos, f.pos) < 16 ? f.team.base : null;
      }
      if (f.getOwner() !== best) f.setOwner(best);
    }
  }
}
