// Game channel codec: binary payloads of the authoritative C++ server
// (server/src/session.cpp), framed by net.ts (8-byte header, gzip flag).
//
// | 0 version | 1 flags (bit0 gzip) | 2-3 type | 4-7 payload length |
//
// Little-endian throughout, strings are u16 byte length + UTF-8. Quantised
// transforms: positions scale to +-mapSize/2 as i16, rotations to +-1, scale
// as u16 * 256.

import { SFX, VOICES } from './config';
import { textDecoder, textEncoder } from './net';

export enum GameMsg {
  // Server -> client.
  Scene = 100,     // level metadata + static entities + decor
  Snapshot = 101,  // spawns, dynamic poses, removals - every tick
  Events = 102,    // sounds, voices, explosions
  Hud = 103,       // match clock, team stats, player ship status
  Result = 104,    // match finished
  Pong = 105,
  // Client -> server.
  Join = 110,
  Input = 111,
  Leave = 112,
  Ping = 113,
  // Both.
  Error = 0xffff,
}

/** Object kinds on the wire (server proto.h ObKindWire). */
export const WireKind = {
  Ship: 0,
  Asteroid: 1,
  Addon: 2,
  Base: 3,
  Flag: 4,
  Bullet: 5,
  Missile: 6,
  Ark: 7,
  Billboard: 8,
  Sun: 9,
  Region: 10,
} as const;

/** Addon kinds (spawn `state` of a WireKind.Addon). */
export const WireAddon = { homing: 0, life: 1, nitro: 2, shield: 3 } as const;

/** Flag states (spawn `state` of a WireKind.Flag). */
export const WireFlag = { AtBase: 0, Carried: 1, Free: 2 } as const;

export const NO_INDEX = 0xffff;
/** Server tick interval: snapshots are one step of this apart. */
export const TICK_MS = 1000 / 30;
export const JOIN_SMART_AI = 0x01;

export const SFX_NAMES: readonly string[] = SFX;
export const VOICE_FIELDS: readonly string[] = VOICES.map((v) => v.field);

export interface NetTransform {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  rw: number;
  scale: number;
}

export interface NetSpawn extends NetTransform {
  id: number;
  kind: number;
  /** Addon kind / flag state / ship respawn flag, by kind. */
  state: number;
  modelIdx: number;
  teamIdx: number;
}

export interface NetPose extends NetTransform {
  id: number;
}

export interface NetSnapshot {
  tick: number;
  spawns: NetSpawn[];
  poses: NetPose[];
  removals: number[];
}

export interface NetTeam {
  name: string;
  color: [number, number, number];
  /** Bitmask over the Scene team list: bit i = team i is an enemy. */
  enemies: number;
}

export interface NetDecor {
  x: number;
  y: number;
  z: number;
  scale: number;
}

export interface NetSphere {
  x: number;
  y: number;
  z: number;
  radius: number;
}

export interface NetScene {
  gameType: number;
  levelKey: string;
  title: string;
  text: string;
  mapSize: number;
  sky: string;
  matchTimeMs: number;
  playerId: number;
  models: string[];
  teams: NetTeam[];
  decor: NetDecor[];
  sun: NetSphere | null;
  region: NetSphere | null;
}

export type NetEvent =
  | { type: 'sound'; id: number; volume: number; pan: number }
  | { type: 'voice'; id: number }
  | {
      type: 'explosion';
      x: number; y: number; z: number;
      scale: number;
      life: number;
      smoke: number;
      debris: number;
      modelIdx: number;
      seed: number;
    };

export interface NetLifeBar {
  value: number;
  max: number;
}

export interface NetHudTeam {
  name: string;
  points: number;
  kills: number;
  hillMs: number;
  timeMs: number;
}

export interface NetHud {
  tick: number;
  /** Milliseconds left of the match, -1 when untimed. */
  matchLeft: number;
  countdownSec: number;
  deathCause: string;
  life: NetLifeBar[];
  outside: { left: number; total: number } | null;
  respawn: { left: number; total: number } | null;
  speed: number;
  missileWarn: boolean;
  lockOn: boolean;
  homings: number;
  nitroPct: number;
  teams: NetHudTeam[];
  /** Life percentage of every live ship (HUD marker labels). */
  ships: { id: number; pct: number }[];
  selectedId: number;
  finished: boolean;
}

export interface NetResult {
  won: boolean;
  reward: string;
  message: string;
}

export interface NetPong {
  id: number;
  serverMs: number;
}

// ------------------------------------------------------------- primitives
/** Little-endian payload reader; every read validates the bounds. */
export class Reader {
  private view: DataView;
  private ofs = 0;

  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.ofs;
  }

  private need(n: number): void {
    if (this.ofs + n > this.bytes.length) throw new Error('protocol: truncated payload');
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.ofs++);
  }

  i8(): number {
    this.need(1);
    return this.view.getInt8(this.ofs++);
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.ofs, true);
    this.ofs += 2;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.ofs, true);
    this.ofs += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.ofs, true);
    this.ofs += 4;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.ofs, true);
    this.ofs += 4;
    return v;
  }

  str(): string {
    const len = this.u16();
    this.need(len);
    const s = textDecoder.decode(this.bytes.subarray(this.ofs, this.ofs + len));
    this.ofs += len;
    return s;
  }
}

/** Little-endian payload writer with a growable buffer. */
export class Writer {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private len = 0;

  private need(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.need(1);
    this.view.setUint8(this.len, v & 0xff);
    this.len += 1;
    return this;
  }

  i8(v: number): this {
    this.need(1);
    this.view.setInt8(this.len, v < -128 ? -128 : v > 127 ? 127 : Math.round(v));
    this.len += 1;
    return this;
  }

  u16(v: number): this {
    this.need(2);
    this.view.setUint16(this.len, v & 0xffff, true);
    this.len += 2;
    return this;
  }

  i16(v: number): this {
    this.need(2);
    this.view.setInt16(this.len, v < -32768 ? -32768 : v > 32767 ? 32767 : Math.round(v), true);
    this.len += 2;
    return this;
  }

  u32(v: number): this {
    this.need(4);
    this.view.setUint32(this.len, v >>> 0, true);
    this.len += 4;
    return this;
  }

  f32(v: number): this {
    this.need(4);
    this.view.setFloat32(this.len, v, true);
    this.len += 4;
    return this;
  }

  str(s: string): this {
    const bytes = textEncoder.encode(s);
    this.u16(bytes.length);
    this.need(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
    return this;
  }

  data(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

// ------------------------------------------------------------ quantisation
export function dequantPos(v: number, half: number): number {
  return v * (half / 32767);
}

export function dequantRot(v: number): number {
  return v / 32767;
}

export function dequantScale(v: number): number {
  return v / 256;
}

/** Quantisers mirrored from server/src/session.cpp (truncate, clamp). */
export function quantPos(v: number, half: number): number {
  const s = 32767 / (half <= 0 ? 1 : half);
  const q = v * s;
  return Math.trunc(q < -32767 ? -32767 : q > 32767 ? 32767 : q);
}

export function quantRot(v: number): number {
  const q = v * 32767;
  return Math.trunc(q < -32767 ? -32767 : q > 32767 ? 32767 : q);
}

export function quantScale(v: number): number {
  const c = v < 0 ? 0 : v > 255 ? 255 : v;
  return Math.round(c * 256) & 0xffff;
}

function clampF(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function writeTransform(w: Writer, t: NetTransform, half: number): void {
  w.u16(quantScale(t.scale));
  w.u16(quantPos(t.x, half) & 0xffff);
  w.u16(quantPos(t.y, half) & 0xffff);
  w.u16(quantPos(t.z, half) & 0xffff);
  w.u16(quantRot(t.rx) & 0xffff);
  w.u16(quantRot(t.ry) & 0xffff);
  w.u16(quantRot(t.rz) & 0xffff);
  w.u16(quantRot(t.rw) & 0xffff);
}

function readTransform(r: Reader, half: number): NetTransform {
  const scale = dequantScale(r.u16());
  const x = dequantPos(r.i16(), half);
  const y = dequantPos(r.i16(), half);
  const z = dequantPos(r.i16(), half);
  const rx = dequantRot(r.i16());
  const ry = dequantRot(r.i16());
  const rz = dequantRot(r.i16());
  const rw = dequantRot(r.i16());
  return { x, y, z, rx, ry, rz, rw, scale };
}

// -------------------------------------------------------------- outbound
export interface JoinOptions {
  smartAI: boolean;
  /** Player camera distance: the server uses it for AI aim ranges/sfx pans. */
  distance: number;
  axisX: boolean;
  axisY: boolean;
}

export function encodeJoin(levelKey: string, opts: JoinOptions): Uint8Array {
  const w = new Writer();
  w.str(levelKey);
  w.u8(opts.smartAI ? JOIN_SMART_AI : 0);
  w.f32(opts.distance);
  w.u8(opts.axisX ? 1 : 0);
  w.u8(opts.axisY ? 1 : 0);
  return w.data();
}

export interface InputState {
  stickX: number;
  stickY: number;
  throttle: number;
  fire: boolean;
  homing: boolean;
  nitro: boolean;
}

export function encodeInput(input: InputState): Uint8Array {
  const w = new Writer();
  w.f32(input.stickX);
  w.f32(input.stickY);
  w.f32(input.throttle);
  let bits = 0;
  if (input.fire) bits |= 0x01;
  if (input.homing) bits |= 0x02;
  if (input.nitro) bits |= 0x04;
  w.u8(bits);
  return w.data();
}

export function encodePing(id: number): Uint8Array {
  return new Writer().u32(id).data();
}

export function encodeLeave(): Uint8Array {
  return new Uint8Array(0);
}

// ---------------------------------------------- outbound (browser game host)
// The browser-hosted match (mp/host.ts) streams the exact frames the C++
// session sends; these encoders mirror server/src/session.cpp.

/** Game-type wire order (server GameType enum / netgame.ts mapping). */
export const GAME_TYPE_ORDER: readonly string[] = ['CTF', 'TT', 'BACK', 'KOTS', 'SURV'];

export function gameTypeIndex(name: string): number {
  const i = GAME_TYPE_ORDER.indexOf(name);
  return i >= 0 ? i : 2; // BACK
}

export function encodeScene(s: NetScene): Uint8Array {
  const w = new Writer();
  w.u8(s.gameType);
  w.str(s.levelKey);
  w.str(s.title);
  w.str(s.text);
  w.f32(s.mapSize);
  w.str(s.sky);
  w.f32(s.matchTimeMs);
  w.u32(s.playerId);
  w.u16(s.models.length);
  for (const m of s.models) w.str(m);
  w.u8(s.teams.length);
  for (const t of s.teams) {
    w.str(t.name);
    w.f32(t.color[0]);
    w.f32(t.color[1]);
    w.f32(t.color[2]);
    w.u8(t.enemies);
  }
  w.u16(s.decor.length);
  for (const d of s.decor) {
    w.f32(d.x);
    w.f32(d.y);
    w.f32(d.z);
    w.f32(d.scale);
  }
  w.u8(s.sun ? 1 : 0);
  if (s.sun) {
    w.f32(s.sun.x);
    w.f32(s.sun.y);
    w.f32(s.sun.z);
    w.f32(s.sun.radius);
  }
  w.u8(s.region ? 1 : 0);
  if (s.region) {
    w.f32(s.region.x);
    w.f32(s.region.y);
    w.f32(s.region.z);
    w.f32(s.region.radius);
  }
  return w.data();
}

export function encodeSnapshot(s: NetSnapshot, half: number): Uint8Array {
  const w = new Writer();
  w.u32(s.tick);
  w.u16(s.spawns.length);
  for (const sp of s.spawns) {
    w.u32(sp.id);
    w.u8(sp.kind);
    w.u8(sp.state);
    w.u16(sp.modelIdx);
    w.u16(sp.teamIdx);
    writeTransform(w, sp, half);
  }
  w.u16(s.poses.length);
  for (const p of s.poses) {
    w.u32(p.id);
    writeTransform(w, p, half);
  }
  w.u16(s.removals.length);
  for (const id of s.removals) w.u32(id);
  return w.data();
}

export function encodeEvents(events: NetEvent[], half: number): Uint8Array {
  const w = new Writer();
  w.u16(events.length);
  for (const e of events) {
    if (e.type === 'sound') {
      w.u8(0);
      w.u8(e.id);
      w.u8(Math.round(clampF(e.volume, 0, 1) * 255));
      w.i8(Math.round(clampF(e.pan, -1, 1) * 127));
    } else if (e.type === 'voice') {
      w.u8(1);
      w.u8(e.id);
    } else {
      w.u8(2);
      w.u16(quantPos(e.x, half) & 0xffff);
      w.u16(quantPos(e.y, half) & 0xffff);
      w.u16(quantPos(e.z, half) & 0xffff);
      w.f32(e.scale);
      w.u16(Math.max(0, Math.min(65535, Math.round(e.life))));
      w.u8(Math.max(0, Math.min(255, e.smoke | 0)));
      w.u8(Math.max(0, Math.min(255, e.debris | 0)));
      w.u16(e.modelIdx);
      w.u32(e.seed >>> 0);
    }
  }
  return w.data();
}

export function encodeHud(h: NetHud): Uint8Array {
  const w = new Writer();
  w.u32(h.tick);
  w.f32(h.matchLeft);
  w.u8(h.countdownSec & 0xff);
  w.str(h.deathCause);
  w.u8(h.life.length);
  for (const seg of h.life) {
    w.f32(seg.value);
    w.f32(seg.max);
  }
  w.u8(h.outside ? 1 : 0);
  if (h.outside) {
    w.f32(h.outside.left);
    w.f32(h.outside.total);
  }
  w.u8(h.respawn ? 1 : 0);
  if (h.respawn) {
    w.f32(h.respawn.left);
    w.f32(h.respawn.total);
  }
  w.f32(h.speed);
  w.u8(h.missileWarn ? 1 : 0);
  w.u8(h.lockOn ? 1 : 0);
  w.u8(h.homings & 0xff);
  w.u8(h.nitroPct & 0xff);
  w.u8(h.teams.length);
  for (const t of h.teams) {
    w.str(t.name);
    w.f32(t.points);
    w.f32(t.kills);
    w.f32(t.hillMs);
    w.f32(t.timeMs);
  }
  w.u8(h.ships.length & 0xff);
  for (const s of h.ships) {
    w.u32(s.id);
    w.u8(s.pct & 0xff);
  }
  w.u32(h.selectedId);
  w.u8(h.finished ? 1 : 0);
  return w.data();
}

export function encodeResult(res: NetResult): Uint8Array {
  const w = new Writer();
  w.u8(res.won ? 1 : 0);
  w.str(res.reward);
  w.str(res.message);
  return w.data();
}

export function encodeError(message: string): Uint8Array {
  const w = new Writer();
  w.str(message);
  return w.data();
}

// --------------------------------------------------------------- inbound
export function decodeScene(r: Reader): NetScene {
  const gameType = r.u8();
  const levelKey = r.str();
  const title = r.str();
  const text = r.str();
  const mapSize = r.f32();
  const sky = r.str();
  const matchTimeMs = r.f32();
  const playerId = r.u32();

  const modelCount = r.u16();
  const models: string[] = [];
  for (let i = 0; i < modelCount; i++) models.push(r.str());

  const teamCount = r.u8();
  const teams: NetTeam[] = [];
  for (let i = 0; i < teamCount; i++) {
    const name = r.str();
    const color: [number, number, number] = [r.f32(), r.f32(), r.f32()];
    teams.push({ name, color, enemies: r.u8() });
  }

  const decorCount = r.u16();
  const decor: NetDecor[] = [];
  for (let i = 0; i < decorCount; i++) {
    decor.push({ x: r.f32(), y: r.f32(), z: r.f32(), scale: r.f32() });
  }

  let sun: NetSphere | null = null;
  if (r.u8()) {
    sun = { x: r.f32(), y: r.f32(), z: r.f32(), radius: r.f32() };
  }
  let region: NetSphere | null = null;
  if (r.u8()) {
    region = { x: r.f32(), y: r.f32(), z: r.f32(), radius: r.f32() };
  }
  return {
    gameType, levelKey, title, text, mapSize, sky, matchTimeMs, playerId,
    models, teams, decor, sun, region,
  };
}

export function decodeSnapshot(r: Reader, half: number): NetSnapshot {
  const tick = r.u32();
  const spawnCount = r.u16();
  const spawns: NetSpawn[] = [];
  for (let i = 0; i < spawnCount; i++) {
    const id = r.u32();
    const kind = r.u8();
    const state = r.u8();
    const modelIdx = r.u16();
    const teamIdx = r.u16();
    spawns.push({ id, kind, state, modelIdx, teamIdx, ...readTransform(r, half) });
  }
  const poseCount = r.u16();
  const poses: NetPose[] = [];
  for (let i = 0; i < poseCount; i++) {
    const id = r.u32();
    poses.push({ id, ...readTransform(r, half) });
  }
  const removeCount = r.u16();
  const removals: number[] = [];
  for (let i = 0; i < removeCount; i++) removals.push(r.u32());
  return { tick, spawns, poses, removals };
}

export function decodeEvents(r: Reader, half: number): NetEvent[] {
  const count = r.u16();
  const out: NetEvent[] = [];
  for (let i = 0; i < count; i++) {
    const type = r.u8();
    if (type === 0) {
      out.push({ type: 'sound', id: r.u8(), volume: r.u8() / 255, pan: r.i8() / 127 });
    } else if (type === 1) {
      out.push({ type: 'voice', id: r.u8() });
    } else {
      const x = dequantPos(r.i16(), half);
      const y = dequantPos(r.i16(), half);
      const z = dequantPos(r.i16(), half);
      const scale = r.f32();
      const life = r.u16();
      const smoke = r.u8();
      const debris = r.u8();
      const modelIdx = r.u16();
      const seed = r.u32();
      out.push({ type: 'explosion', x, y, z, scale, life, smoke, debris, modelIdx, seed });
    }
  }
  return out;
}

export function decodeHud(r: Reader): NetHud {
  const tick = r.u32();
  const matchLeft = r.f32();
  const countdownSec = r.u8();
  const deathCause = r.str();
  const lifeCount = r.u8();
  const life: NetLifeBar[] = [];
  for (let i = 0; i < lifeCount; i++) life.push({ value: r.f32(), max: r.f32() });
  let outside: { left: number; total: number } | null = null;
  if (r.u8()) outside = { left: r.f32(), total: r.f32() };
  let respawn: { left: number; total: number } | null = null;
  if (r.u8()) respawn = { left: r.f32(), total: r.f32() };
  const speed = r.f32();
  const missileWarn = r.u8() !== 0;
  const lockOn = r.u8() !== 0;
  const homings = r.u8();
  const nitroPct = r.u8();
  const teamCount = r.u8();
  const teams: NetHudTeam[] = [];
  for (let i = 0; i < teamCount; i++) {
    teams.push({
      name: r.str(),
      points: r.f32(),
      kills: r.f32(),
      hillMs: r.f32(),
      timeMs: r.f32(),
    });
  }
  const shipCount = r.u8();
  const ships: { id: number; pct: number }[] = [];
  for (let i = 0; i < shipCount; i++) ships.push({ id: r.u32(), pct: r.u8() });
  const selectedId = r.u32();
  const finished = r.u8() !== 0;
  return {
    tick, matchLeft, countdownSec, deathCause, life, outside, respawn, speed,
    missileWarn, lockOn, homings, nitroPct, teams, ships, selectedId, finished,
  };
}

export function decodeResult(r: Reader): NetResult {
  return { won: r.u8() !== 0, reward: r.str(), message: r.str() };
}

export function decodePong(r: Reader): NetPong {
  return { id: r.u32(), serverMs: r.u32() };
}

export function decodeError(r: Reader): string {
  return r.str();
}
