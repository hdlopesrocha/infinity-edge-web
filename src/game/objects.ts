// Object hierarchy (37_T verbatim): GetMatrix fresh, pos-centered spheres,
// LOD + fade, model/color variants, ship starts (homings 2, nitro 0).

import { mat4, quat, vec3, ypr, dirFromQuat, sideFromQuat, upFromQuat, getH, getV, clamp, steerToward } from '../engine/math';
import { ObKind } from '../engine/octree';
import type { OctItem, OctNode } from '../engine/octree';
import { rayIntersectModel } from '../engine/model';
import type { GpuModel } from '../engine/model';
import type { TexEntry } from '../engine/texture';
import { Life, Life1 } from './life';
import { P, nextPosition, previewDirection } from './physics';
import type { Physics } from './physics';
import type { Team } from './team';
import type { GameInstance } from './instance';
import { simHooks } from './mp/bridge';
import type { RC } from './resources';
import { party, partyShiftColor } from './party';

export interface Command {
  execute(): void;
}

export type AIHomingFactory = (
  gi: import('./instance').GameInstance, target: SpaceObject | null, self: HomingMissile,
) => Command;
export let createAIHoming: AIHomingFactory | null = null;
export function setAIHomingFactory(f: AIHomingFactory): void {
  createAIHoming = f;
}

export interface FlareSet {
  engine: [number, number, number][];
  color: [number, number, number][];
}

export interface ModelData {
  name: string;
  solid: (GpuModel | null)[];
  color: (GpuModel | null)[];
  tex: TexEntry | null;
  /** Per-material textures of solid[0], aligned with gpu.materials. */
  texes: (TexEntry | null)[] | null;
  icon: TexEntry | null;
  flares: FlareSet;
  friction: number;
  detail: number;
}

export interface DrawCtx {
  draw: import('../engine/draw').Draw;
  view: mat4;
  proj: mat4;
  camPos: vec3;
  camDistance: (pos: vec3) => number;
  rc: RC;
}

export function randomTumble(r: () => number): vec3 {
  const c = () => ((Math.floor(r() * 3000) / 1000) * Math.PI) / 180;
  return vec3.fromValues(c(), c(), c());
}

export abstract class Abstract3D implements OctItem {
  _octNode: OctNode | null = null;
  abstract kind: ObKind;
  active = true;
  insideMap = true;
  sx = 0;
  sy = 0;
  sz = 0;
  sradius = 1;
  color: [number, number, number] = [0.2, 0.2, 0.2]; // Colors.Emissive
  alpha = 1;
  multiplier = 1;
  scale = 1;
  physics: Physics;

  constructor(physics: Physics) {
    this.physics = physics;
  }

  abstract setBoundingSphere(): void;
  abstract update(): void;
  abstract solidDraw(d: DrawCtx): void;
  abstract alphaDraw(d: DrawCtx): void;
}

export abstract class Object3D extends Abstract3D {
  model: ModelData;
  intelligence: Command | null = null;
  pos = vec3.create();
  lastPos = vec3.create();
  vel = vec3.create();
  accel = vec3.create();
  dir = vec3.fromValues(0, 0, 1);
  up = vec3.fromValues(0, 1, 0);
  side = vec3.fromValues(1, 0, 0);
  rot = quat.create();
  /** Previous-frame pose, for the motion-blur velocity buffer. */
  prevPos = vec3.create();
  prevRot = quat.create();

  get kind(): ObKind {
    return this.physics.objectType;
  }

  constructor(physics: Physics, position: vec3, model: ModelData, scale: number) {
    super(physics);
    this.multiplier = 1;
    this.scale = scale;
    vec3.copy(this.pos, position);
    vec3.copy(this.lastPos, position);
    this.model = model;
    this.insideMap = true;
    this.update();
    vec3.copy(this.prevPos, this.pos);
    quat.copy(this.prevRot, this.rot);
  }

  /** Snapshot the pose before this frame's integration. */
  markPrev(): void {
    vec3.copy(this.prevPos, this.pos);
    quat.copy(this.prevRot, this.rot);
  }

  /** GetMatrix() = Scale·Rot·Trans, composed fresh. */
  getMatrix(out?: mat4): mat4 {
    const m = out ?? mat4.create();
    const s = vec3.fromValues(this.scale, this.scale, this.scale);
    mat4.fromRotationTranslationScale(m, this.rot, this.pos, s);
    return m;
  }

  /** Previous-frame GetMatrix(): what the velocity buffer compares against. */
  prevMatrix(out?: mat4): mat4 {
    const m = out ?? mat4.create();
    const s = vec3.fromValues(this.scale, this.scale, this.scale);
    mat4.fromRotationTranslationScale(m, this.prevRot, this.prevPos, s);
    return m;
  }

  automaticAction(gi: GameInstance, dtMs: number): void {
    if (this.intelligence && this.active) this.intelligence.execute();
    void gi;
    void dtMs;
  }

  setBoundingSphere(): void {
    const b = (this.model.solid[0] ?? this.model.color[0])?.boundingSphere;
    this.sx = this.pos[0];
    this.sy = this.pos[1];
    this.sz = this.pos[2];
    this.sradius = (b ? b.radius : 1) * this.scale;
  }

  update(): void {
    dirFromQuat(this.dir, this.rot);
    upFromQuat(this.up, this.rot);
    sideFromQuat(this.side, this.rot);
    this.setBoundingSphere();
  }

  step(dtMs: number, refresh: () => void): void {
    vec3.copy(this.lastPos, this.pos);
    this.markPrev();
    nextPosition(
      {
        pos: this.pos, vel: this.vel, accel: this.accel,
        multiplier: this.multiplier, friction: this.model.friction, physics: this.physics,
      },
      dtMs,
    );
    this.multiplier = this.multiplier + (1 - this.multiplier) * 0.2;
    if (vec3.length(this.vel) > 0) refresh();
  }
}

export class SpaceObject extends Object3D {
  teleported = false;
  /** Seconds since the last hit (used by the experimental AISmart brain). */
  hitAge = 99;
  life: Life | null;
  team: Team;
  flag: Flag | null = null;
  destroyed = false;

  constructor(physics: Physics, team: Team, position: vec3, model: ModelData, life: Life | null, scale: number) {
    super(physics, position, model, scale);
    this.life = life;
    this.team = team;
  }

  receiveDamage(gi: GameInstance, amount: number, direction: vec3, attacker: SpaceObject | null = null): void {
    this.hitAge = 0;
    if (!this.life) return;
    this.life.receiveDamage(amount, direction, this.up, this.dir, () => this.destroyObject(gi, attacker));
  }

  restoreLife(): void {
    this.life?.restore();
  }

  lifePercentage(): number {
    return this.life ? this.life.percentage() : 1;
  }

  totalLife(): number {
    return this.life ? this.life.total() : 0;
  }

  createSmoke(_gi: GameInstance): void {
    /* base no-op */
  }

  canLaunchBullet(): boolean {
    return false;
  }

  launchBullet(_gi: GameInstance, _direction: vec3): void {
    /* only SpaceShip has weapons */
  }

  launchHoming(_gi: GameInstance): void {
    /* only SpaceShip has weapons */
  }

  launchNitro(_dtMs: number): void {
    /* only SpaceShip has nitro */
  }

  move(gi: GameInstance, dtMs: number): void {
    const map = gi.map;
    if (this.active) this.step(dtMs, () => map.refreshObject(this));
    if (vec3.length(this.vel) > 0) this.createSmoke(gi);
    map.refreshObject(this);
    if (this.physics.objectType !== ObKind.Uncollidable) {
      const stack: OctItem[] = [];
      map.octree.sphereSelect(this.sx, this.sy, this.sz, this.sradius, stack);
      for (const o of stack) {
        if (!(o instanceof SpaceObject) || o === this) continue;
        const obj = o;
        const t = obj.physics.objectType;
        if (t === ObKind.Uncollidable || obj instanceof Flag || obj instanceof Base) continue;
        if (obj instanceof Addon) {
          gi.shipSfx(this, 'addonSound');
          obj.doThings(this);
          obj.destroyObject(gi);
          continue;
        }
        if (obj instanceof Ark) {
          if (map.path.length > 0 && obj === map.path[0] && obj.team !== this.team) {
            obj.destroyObject(gi);
            map.path.shift();
          }
          continue;
        }
        if (obj.team !== this.team) {
          const a = this.totalLife();
          const b = obj.totalLife();
          const d = vec3.create();
          vec3.subtract(d, obj.pos, this.pos);
          vec3.normalize(d, d);
          this.receiveDamage(gi, b, d, obj);
          const d2 = vec3.create();
          vec3.subtract(d2, this.pos, obj.pos);
          vec3.normalize(d2, d2);
          obj.receiveDamage(gi, a, d2, this);
          // Hull-to-hull impact: fireball at the contact point, scaled by the
          // damage traded (asteroid strikes look violent, ship taps small).
          const hit = vec3.fromValues(
            (this.pos[0] + obj.pos[0]) / 2, (this.pos[1] + obj.pos[1]) / 2, (this.pos[2] + obj.pos[2]) / 2,
          );
          const heavy = Math.max(a, b) > 0;
          spawnExplosion(map, hit, heavy ? 2.2 : 1.5, { smoke: heavy ? 6 : 4, life: 540 });
        }
      }
    }
  }

  destroyObject(gi: GameInstance, attacker: SpaceObject | null = null): void {
    gi.recordDeath(this, attacker);
    const map = gi.map;
    // Survival: whoever destroyed a *ship* scores for their team (ramming
    // counts, the other hull is passed as the attacker).
    if (attacker && attacker !== this && attacker.team !== this.team && this instanceof SpaceShip) {
      attacker.team.kills++;
    }
    if (this.flag) this.flag.setOwner(null);
    if (this.physics.reSpawns) {
      map.respawned.push({ obj: this, elapsed: 0, max: 10000 });
      map.removeObject(this);
    } else {
      const i = this.team.objects.indexOf(this);
      if (i >= 0) this.team.objects.splice(i, 1);
      map.removeObject(this);
    }
    // A time-trial checkpoint (Ark) is *collected*, not destroyed: it just
    // vanishes and the path advances. Debris and a fireball there read as the
    // gate exploding in your face.
    if (!(this instanceof Ark)) {
      const frag = new Fragment(map, this, this.model, this.scale, 500);
      frag.color = [...this.color] as [number, number, number];
      vec3.set(frag.vel, 0, 0, 0);
      // Killed: a proper fireball (bigger for the player's ship) plus debris.
      const exScale = this instanceof SpaceShip ? 4.0 : 3.0;
      spawnExplosion(map, vec3.clone(this.pos), exScale, { smoke: 12, debris: 6, launcher: this, life: 750 });
    }
    gi.explosionSfx(this);
  }
  automaticAction(gi: GameInstance, dtMs: number): void {
    if (!this.active) return;
    if (this.intelligence) this.intelligence.execute();
    this.move(gi, dtMs);
  }

  bulletHit(b: Bullet): number | null {
    const dx = b.dir[0], dy = b.dir[1], dz = b.dir[2];
    const m0 = this.model.solid[0];
    const c0 = this.model.color[0];
    let inter: number | null = null;
    if (m0) {
      const t = rayIntersectModel(m0, this.getMatrix(), b.lastPos[0], b.lastPos[1], b.lastPos[2], dx, dy, dz);
      if (t !== null) inter = t;
    }
    if (c0 && c0 !== m0) {
      const t = rayIntersectModel(c0, this.getMatrix(), b.lastPos[0], b.lastPos[1], b.lastPos[2], dx, dy, dz);
      if (t !== null && (inter === null || t < inter)) inter = t;
    }
    if (inter === null) return null;
    const range = Math.hypot(b.pos[0] - b.lastPos[0], b.pos[1] - b.lastPos[1], b.pos[2] - b.lastPos[2]);
    return inter < range ? inter : null;
  }

  /** LOD + fade for a draw call over a variant array. */
  lod(d: DrawCtx, variant: 'solid' | 'color'): { gpu: GpuModel; alpha: number } | null {
    const arr = variant === 'solid' ? this.model.solid : this.model.color;
    const fallback = (variant === 'solid' ? this.model.color[0] : this.model.solid[0]) ?? arr[0];
    if (!fallback && !arr[0]) return null;
    const dist = d.camDistance(this.pos);
    const view = d.rc.options.distance;
    const models = Math.max(1, arr.length);
    // Model3D.SolidDraw verbatim: 3 * len / distance + options._detail, clamped
    // to the loaded LODs. The offset is the *player's* 3D-detail setting (0 =
    // Very High ... 4 = Very Low), not the model's LOD count -- using the count
    // pushed every draw to the last LOD and made the setting do nothing.
    const j = clamp(Math.floor((3 * dist) / view + d.rc.options.detail), 0, models - 1);
    const gpu = arr[j] ?? fallback;
    if (!gpu) return null;
    return { gpu, alpha: clamp((view - dist) / 32, 0, 1) };
  }

  solidDraw(d: DrawCtx): void {
    const L = this.lod(d, 'solid');
    if (!L) return;
    d.draw.drawModel(L.gpu, this.model.tex, this.getMatrix(), d.view, d.proj, d.camPos, {
      alpha: this.alpha * L.alpha, emissive: this.color, light: true, prevWorld: this.prevMatrix(),
    }, L.gpu === this.model.solid[0] ? this.model.texes : null);
    d.rc.renderer.trackDraws(L.gpu.meshes.length);
  }

  alphaDraw(_d: DrawCtx): void {
    /* base no-op */
  }
}

export class SpaceShip extends SpaceObject {
  shieldModel: ModelData | null;
  glow = 0;
  glowColor: [number, number, number] = [1, 1, 1];
  launchSpan = 0;
  launchs = 0;
  homings = 0;
  nitro = 0;
  shield = 0;
  /** True when HILocal drives this ship (the player may leave the arena). */
  isPlayer = false;
  /** Seconds since the last hit (used by the experimental AISmart brain). */
  hitAge = 99;
  /** Auto-aim parameters: engage when a close enemy is this aligned. */
  aimbotAngle = 0.9;
  aimbotDistance = 128;
  /** Engage only when the analog stick magnitude is <= this (barely steering). */
  aimbotThreshold = 0.35;
  /** True while the assist is steering this frame. */
  aimbotActive = false;
  aimbotTarget: SpaceObject | null = null;
  private lol = 0;

  /**
   * Closest enemy in front, inside the aimbot distance and at least
   * `aimbotAngle` dot-product aligned with the ship's direction.
   */
  findAimbotTarget(gi: GameInstance): SpaceObject | null {
    const found: OctItem[] = [];
    gi.map.octree.sphereSelectInteractive(
      this.pos[0], this.pos[1], this.pos[2], this.aimbotDistance, found,
    );
    let best: SpaceObject | null = null;
    let bestDot = this.aimbotAngle;
    for (const o of found) {
      if (!(o instanceof SpaceObject) || o === this || !o.active) continue;
      if (!this.team.enemys.includes(o.team)) continue;
      const dx = o.pos[0] - this.pos[0];
      const dy = o.pos[1] - this.pos[1];
      const dz = o.pos[2] - this.pos[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      if (l > this.aimbotDistance) continue;
      const dot = (this.dir[0] * dx + this.dir[1] * dy + this.dir[2] * dz) / l;
      if (dot > bestDot) {
        bestDot = dot;
        best = o;
      }
    }
    return best;
  }

  constructor(
    physics: Physics, gi: GameInstance, team: Team, position: vec3,
    model: ModelData, life: Life | null, shieldModel: ModelData | null,
  ) {
    super(physics, team, position, model, life, 1);
    this.shield = 0;
    this.nitro = 0;
    this.homings = 0;
    this.launchs = 0;
    this.launchSpan = 0;
    this.glow = 0;
    this.homings = 2;
    this.nitro = 0;
    this.shieldModel = shieldModel;
    team.objects.push(this);
    gi.map.insertObject(this);
  }

  override solidDraw(d: DrawCtx): void {
    const L = this.lod(d, 'solid');
    if (!L) return;
    // Party mode tints the player's hull toward the current music hue; enemy
    // ships and addons keep their normal materials. The tint strength rides the
    // overall energy *and* the bass onset envelope, so the hull flashes harder
    // on a kick while enemies stay untouched.
    const tint: [number, number, number] = [1, 1, 1];
    if (this.isPlayer && party.active) {
      const k = Math.min(1, 0.62 + 0.18 * party.energy + 0.16 * party.bassPulse);
      tint[0] = 1 + (this.team.color[0] - 1) * k;
      tint[1] = 1 + (this.team.color[1] - 1) * k;
      tint[2] = 1 + (this.team.color[2] - 1) * k;
    }
    d.draw.drawModel(L.gpu, this.model.tex, this.getMatrix(), d.view, d.proj, d.camPos, {
      alpha: this.alpha * L.alpha, emissive: this.color, light: true,
      tint, prevWorld: this.prevMatrix(),
    }, L.gpu === this.model.solid[0] ? this.model.texes : null);
    d.rc.renderer.trackDraws(L.gpu.meshes.length);
  }

  override canLaunchBullet(): boolean {
    return this.launchSpan >= 200;
  }

  override launchBullet(gi: GameInstance, direction: vec3): void {
    const mdl = gi.rc.model('Bullet');
    if (!mdl || !mdl.solid[0]) return;
    const s = this.launchs % 2 === 0 ? 1 : -1;
    new Bullet(
      gi, mdl, this,
      { pos: vec3.fromValues(this.pos[0] + (s * this.side[0]) / 2, this.pos[1] + (s * this.side[1]) / 2, this.pos[2] + (s * this.side[2]) / 2), dir: vec3.clone(direction) },
    );
    this.launchs++;
    this.launchSpan %= 200;
    gi.shipSfx(this, 'bulletSound', 0.2);
  }

  override launchNitro(dtMs: number): void {
    if (this.nitro > 0) {
      this.multiplier = 7.5;
      this.nitro -= dtMs;
      if (this.nitro < 0) this.nitro = 0;
    }
  }

  override launchHoming(gi: GameInstance): void {
    if (this.launchSpan < 200 || this.homings <= 0) return;
    let target: SpaceObject | null = null;
    let maxDot = 0.75;
    const stack: OctItem[] = [];
    gi.map.octree.sphereSelectInteractive(this.pos[0], this.pos[1], this.pos[2], 256, stack);
    for (const o of stack) {
      if (!(o instanceof SpaceObject)) continue;
      if (!this.team.enemys.includes(o.team)) continue;
      const dx = o.pos[0] - this.pos[0];
      const dy = o.pos[1] - this.pos[1];
      const dz = o.pos[2] - this.pos[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      const dot = (this.dir[0] * dx + this.dir[1] * dy + this.dir[2] * dz) / l;
      if (dot > maxDot) {
        target = o;
        maxDot = dot;
      }
    }
    const mdl = gi.rc.model('HomingMissile2');
    if (!mdl || !mdl.solid[0]) return;
    const s = this.launchs % 2 === 0 ? 1 : -1;
    const missile = new HomingMissile(
      gi, mdl, this,
      vec3.fromValues(
        this.pos[0] + (s * this.side[0] * 2) / 3 - this.up[0] / 3 - this.dir[0] / 3,
        this.pos[1] + (s * this.side[1] * 2) / 3 - this.up[1] / 3 - this.dir[1] / 3,
        this.pos[2] + (s * this.side[2] * 2) / 3 - this.up[2] / 3 - this.dir[2] / 3,
      ),
      2000,
    );
    this.homings--;
    this.launchs++;
    if (createAIHoming) missile.intelligence = createAIHoming(gi, target, missile);
    this.launchSpan %= 200;
    gi.shipSfx(this, 'missileSound');
  }

  receiveDamage(gi: GameInstance, amount: number, direction: vec3, attacker: SpaceObject | null = null): void {
    if (!this.life) return;
    this.hitAge = 0;
    if (this.shield <= 0) {
      this.life.receiveDamage(amount, direction, this.up, this.dir, () => this.destroyObject(gi, attacker));
      gi.shipSfx(this, 'hitSound');
    } else {
      this.shield--;
      gi.shipSfx(this, 'absorbSound');
    }
  }

  createSmoke(gi: GameInstance): void {
    const rc = gi.rc;
    if (!rc.options.billboards || !this.active || vec3.length(this.vel) === 0) return;
    const f = gi.renderer.frustum;
    let inside = true;
    for (let i = 0; i < 6; i++) {
      if (f[i * 4] * this.sx + f[i * 4 + 1] * this.sy + f[i * 4 + 2] * this.sz + f[i * 4 + 3] < -this.sradius) {
        inside = false;
        break;
      }
    }
    if (!inside) return;
    const speed = vec3.length(this.vel) / this.physics.velMax;
    // Real smoke: a noise-driven particle that grows, drifts and dissolves
    // instead of a fading sprite. It leaves from the engine (behind the hull,
    // where the plume is) rather than the hull centre, so the trail streams out
    // of the nozzles.
    const jitter = (rc.random() - 0.5) * 0.5;
    const pos = vec3.fromValues(
      this.lastPos[0] - this.dir[0] * 0.9 + this.side[0] * jitter - this.up[0] * 0.12,
      this.lastPos[1] - this.dir[1] * 0.9 + this.side[1] * jitter - this.up[1] * 0.12,
      this.lastPos[2] - this.dir[2] * 0.9 + this.side[2] * jitter - this.up[2] * 0.12,
    );
    const drift = vec3.create();
    vec3.scale(drift, this.vel, 0.05);
    const puff = gi.map.spawnSmoke(pos, drift, {
      size0: 0.35, size1: 2.3 + 1.5 * speed, life: 1600,
      alpha: clamp(speed, 0, 1), turbulence: 0.6,
    });
    // Every ship's plume takes its own team colour: the player's is live (party
    // mode rotates and flashes it), while enemy smoke stays the static enemy
    // colour. Explosion smoke elsewhere remains neutral.
    puff.tint = [...this.team.color] as [number, number, number];
  }

  alphaDraw(d: DrawCtx): void {
    if (!d.rc.options.billboards) return;
    const { draw, view, proj } = d;
    const f = this.model.flares;
    const r = this.model.solid[0]?.boundingSphere.radius ?? this.sradius;
    const accelFrac = vec3.length(this.accel) / this.physics.accelMax;
    const camDir = d.rc.renderer.camera.direction;
    const facing = camDir[0] * this.dir[0] + camDir[1] * this.dir[1] + camDir[2] * this.dir[2];
    const world = this.getMatrix();
    const prev = this.prevMatrix();
    // Engine flare: a real additive cone plume in the ship's frame (parallax,
    // animated with the 3D noise field) instead of a camera-facing billboard.
    const thrust = clamp(facing * accelFrac, 0, 1);
    const level = this.thrustLevel();
    const vr = vec3.create();
    const vrPrev = vec3.create();
    const rotX = mat4.create();
    mat4.fromRotation(rotX, -Math.PI / 2, vec3.fromValues(1, 0, 0));
    // The plume mesh runs along +Y, so the ship's own orientation has to be in
    // the matrix: T(nozzle) · R_ship · R_x(-90°) · S maps +Y onto the ship's
    // -Z (straight out of the tail), instead of the world -Z. The *previous*
    // pose builds the same matrix one frame back: the plume rides the ship, so
    // its velocity must be the ship's, not the camera's.
    const shipRot = mat4.create();
    mat4.fromQuat(shipRot, this.rot);
    const shipRotPrev = mat4.create();
    mat4.fromQuat(shipRotPrev, this.prevRot);
    const scale = mat4.create();
    const local = mat4.create();
    const localPrev = mat4.create();
    const glow = mat4.create();
    const glowPrev = mat4.create();
    const glowScale = mat4.create();
    for (const v of f.engine) {
      vec3.transformQuat(vr, v as unknown as vec3, this.rot);
      vec3.transformQuat(vrPrev, v as unknown as vec3, this.prevRot);
      // Turbine fire: a tapered afterburner plume a little longer than the
      // engine, blue-white at the nozzle and orange towards the tail.
      const length = 0.7 + 1.5 * (0.3 + 0.7 * level);
      const radius = 0.16;
      mat4.fromScaling(scale, vec3.fromValues(radius, length, radius));
      mat4.fromTranslation(local, vec3.fromValues(
        this.pos[0] + r * vr[0], this.pos[1] + r * vr[1], this.pos[2] + r * vr[2],
      ));
      mat4.multiply(local, local, shipRot);
      mat4.multiply(local, local, rotX);
      mat4.multiply(local, local, scale);
      mat4.fromTranslation(localPrev, vec3.fromValues(
        this.prevPos[0] + r * vrPrev[0], this.prevPos[1] + r * vrPrev[1], this.prevPos[2] + r * vrPrev[2],
      ));
      mat4.multiply(localPrev, localPrev, shipRotPrev);
      mat4.multiply(localPrev, localPrev, rotX);
      mat4.multiply(localPrev, localPrev, scale);
      draw.drawPlume(local, localPrev, view, proj, d.camPos, [1, 0.62, 0.2], 0.8 * thrust + 0.1 * level);
      // Hot core + team-coloured halo right at the nozzle (additive shells).
      const core = 0.09 + 0.04 * level;
      mat4.fromTranslation(glow, vec3.fromValues(
        this.pos[0] + r * vr[0], this.pos[1] + r * vr[1], this.pos[2] + r * vr[2],
      ));
      mat4.fromTranslation(glowPrev, vec3.fromValues(
        this.prevPos[0] + r * vrPrev[0], this.prevPos[1] + r * vrPrev[1], this.prevPos[2] + r * vrPrev[2],
      ));
      mat4.fromScaling(glowScale, vec3.fromValues(core, core, core));
      mat4.multiply(glow, glow, glowScale);
      mat4.multiply(glowPrev, glowPrev, glowScale);
      draw.drawGlow(glow, glowPrev, view, proj, d.camPos, [0.75, 0.88, 1.0], 0.3 + 0.3 * thrust);
      const halo = core * 2.2;
      mat4.fromScaling(glowScale, vec3.fromValues(halo, halo, halo));
      const haloM = mat4.create();
      mat4.multiply(haloM, glow, glowScale);
      const haloPrev = mat4.create();
      mat4.multiply(haloPrev, glowPrev, glowScale);
      draw.drawGlow(haloM, haloPrev, view, proj, d.camPos, this.team.color, 0.15 + 0.25 * thrust);
      d.rc.renderer.trackDraws(3);
    }
    // Team-colour core: small additive glow shells at the same flare offsets.
    const pulse = (1 + Math.sin(this.lol)) / 2;
    for (const v of f.color) {
      vec3.transformQuat(vr, v as unknown as vec3, this.rot);
      vec3.transformQuat(vrPrev, v as unknown as vec3, this.prevRot);
      const gl = mat4.create();
      mat4.fromTranslation(gl, vec3.fromValues(this.pos[0] + r * vr[0], this.pos[1] + r * vr[1], this.pos[2] + r * vr[2]));
      const glPrev = mat4.create();
      mat4.fromTranslation(glPrev, vec3.fromValues(
        this.prevPos[0] + r * vrPrev[0], this.prevPos[1] + r * vrPrev[1], this.prevPos[2] + r * vrPrev[2],
      ));
      const sc = mat4.create();
      const s = 0.28 + 0.1 * pulse;
      mat4.fromScaling(sc, vec3.fromValues(s, s, s));
      const m = mat4.create();
      mat4.multiply(m, gl, sc);
      const mPrev = mat4.create();
      mat4.multiply(mPrev, glPrev, sc);
      draw.drawGlow(m, mPrev, view, proj, d.camPos, this.team.color, 0.65 + 0.35 * pulse);
      d.rc.renderer.trackDraws(1);
    }
    this.lol += Math.PI / 10;
    if (this.shield > 0 && this.shieldModel) {
      const m = mat4.create();
      mat4.fromRotationTranslationScale(m, this.rot, this.pos, vec3.fromValues(0.12, 0.12, 0.12));
      const arr = this.shieldModel.color[0] ? this.shieldModel.color : this.shieldModel.solid;
      const dist = d.camDistance(this.pos);
      const view0 = d.rc.options.distance;
      const j = clamp(Math.floor((3 * dist) / view0 + d.rc.options.detail), 0, Math.max(0, arr.length - 1));
      const gpu = arr[j] ?? arr[0];
      if (gpu) {
        draw.drawModel(gpu, this.shieldModel.tex, m, view, proj, d.camPos, {
          alpha: (this.shield / 10) * clamp((view0 - dist) / 32, 0, 1), emissive: this.team.color, light: true,
          prevWorld: this.prevMatrix(),
        });
        d.rc.renderer.trackDraws(gpu.meshes.length);
      }
    }
    if (this.glow > 0) {
      const perc = Math.sin(Math.PI * this.glow);
      this.color = [
        0.2 + (this.glowColor[0] - 0.2) * perc,
        0.2 + (this.glowColor[1] - 0.2) * perc,
        0.2 + (this.glowColor[2] - 0.2) * perc,
      ];
      // Pickup flash: an expanding additive glow shell around the ship.
      const s = 1.5 + 0.6 * (1 - this.glow);
      const sc = mat4.create();
      mat4.fromTranslation(sc, this.pos);
      mat4.scale(sc, sc, vec3.fromValues(s, s, s));
      const scPrev = mat4.create();
      mat4.fromTranslation(scPrev, this.prevPos);
      mat4.scale(scPrev, scPrev, vec3.fromValues(s, s, s));
      draw.drawGlow(sc, scPrev, view, proj, d.camPos, this.glowColor, perc);
      d.rc.renderer.trackDraws(1);
      this.glow -= 0.03;
    }
    void world;
    void prev;
  }

  /** Scratch matrix for the plume transform (avoids per-frame garbage). */
  private plumeMat = mat4.create();

  /** 0..1 thrust indicator (accel fraction, boost included). */
  private thrustLevel(): number {
    return clamp(vec3.length(this.accel) / this.physics.accelMax, 0, 1);
  }

  automaticAction(gi: GameInstance, dtMs: number): void {
    if (!this.active) return;
    if (this.intelligence && this.active) this.intelligence.execute();
    // Bots keep their strategy but never leave the arena: outside the margin
    // they steer back to the centre and the border acts as a soft wall. The
    // player is exempt (the original's "leaving the field of battle" + 10 s
    // outsider rule still applies to it).
    if (!this.isPlayer) this.arenaGuard(gi);
    this.hitAge += dtMs / 1000;
    this.launchSpan += dtMs;
    this.move(gi, dtMs);
  }

  /** Turn an AI ship around near the map border and keep it inside. */
  private arenaGuard(gi: GameInstance): void {
    const half = gi.map.size / 2;
    const margin = 64;
    const p = this.pos;
    const over = Math.max(Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2])) - (half - margin);
    if (over <= 0) return;
    // Steer back to the centre a bit harder than the ship's normal turn rate.
    const target = vec3.fromValues(-p[0], -p[1], -p[2]);
    steerToward(this.rot, this.dir, target, this.side, this.physics.maxAngular * 2);
    this.update();
    vec3.scale(this.accel, this.dir, this.physics.accelMax);
    // Soft wall: clamping the position is a teleport, so reset the temporal
    // history -- otherwise this frame reports the whole jump as motion.
    this.markPrev();
    // Soft wall: clamp the position and drop the outward velocity component.
    const wall = half - 8;
    for (let i = 0; i < 3; i++) {
      if (p[i] > wall) {
        p[i] = wall;
        if (this.vel[i] > 0) this.vel[i] = 0;
      } else if (p[i] < -wall) {
        p[i] = -wall;
        if (this.vel[i] < 0) this.vel[i] = 0;
      }
    }
    this.update();
  }
}

// --------------------------------------------------------------- Asteroid
export class Asteroid extends SpaceObject {
  tumble = vec3.create();

  constructor(map: import('./map').GameMap, team: Team, position: vec3, model: ModelData, life: Life | null) {
    super(P.STATIC, team, position, model, life, 1);
    this.tumble = randomTumble(map.rng);
    map.insertObject(this);
  }

  automaticAction(gi: GameInstance, dtMs: number): void {
    if (!this.active) return;
    const e = quat.create();
    const d = 180 / Math.PI;
    quat.fromEuler(e, this.tumble[0] * d, this.tumble[1] * d, this.tumble[2] * d);
    quat.multiply(this.rot, this.rot, e);
    quat.normalize(this.rot, this.rot);
    this.step(dtMs, () => gi.map.refreshObject(this));
    this.update();
  }

  override solidDraw(d: DrawCtx): void {
    const L = this.lod(d, 'solid');
    if (!L) return;
    d.draw.drawModel(L.gpu, this.model.tex, this.getMatrix(), d.view, d.proj, d.camPos, {
      alpha: this.alpha * L.alpha, emissive: this.color, light: true,
      hue: party.active ? party.shownHue * 360 : 0,
      prevWorld: this.prevMatrix(),
    });
    d.rc.renderer.trackDraws(L.gpu.meshes.length);
  }

  destroyObject(gi: GameInstance): void {
    super.destroyObject(gi);
    const r = gi.rc.random;
    const perc = r();
    for (const t of this.team.allies) void t;
    if (perc < 0.12) new Addon(gi, this.team, vec3.clone(this.pos), 'adHomingMissile', [1, 0, 0], 'homing', gi.map);
    else if (perc < 0.24) new Addon(gi, this.team, vec3.clone(this.pos), 'adRepair', [0.2, 1, 0.2], 'life', gi.map);
    else if (perc < 0.36) new Addon(gi, this.team, vec3.clone(this.pos), 'adShield', [0.4, 0.6, 1], 'shield', gi.map);
    else if (perc < 0.48) new Addon(gi, this.team, vec3.clone(this.pos), 'adNitro', [1, 0.55, 0], 'nitro', gi.map);
    for (let i = 0; i < 10; i++) {
      new Fragment(gi.map, this, this.model, (Math.floor(r() * 40 + 20) / 100) * this.scale, 500);
    }
  }
}

// ------------------------------------------------------------------ Addon
export type AddonKind = 'homing' | 'life' | 'nitro' | 'shield';

export class Addon extends SpaceObject {
  tumble = vec3.create();
  addonKind: AddonKind;
  glowColor: [number, number, number];
  command: AddonKind;

  constructor(
    gi: GameInstance, team: Team, position: vec3,
    modelName: string, color: [number, number, number], addonKind: AddonKind,
    map: import('./map').GameMap,
  ) {
    super(P.STATIC, team, position, gi.rc.model(modelName)!, null, 1);
    this.addonKind = addonKind;
    this.command = addonKind;
    this.glowColor = color;
    this.tumble = randomTumble(gi.rc.random);
    map.insertObject(this);
  }

  automaticAction(gi: GameInstance, _dtMs: number): void {
    if (!this.active) return;
    const e = quat.create();
    const d = 180 / Math.PI;
    quat.fromEuler(e, this.tumble[0] * d, this.tumble[1] * d, this.tumble[2] * d);
    quat.multiply(this.rot, this.rot, e);
    quat.normalize(this.rot, this.rot);
    this.update();
    void gi;
  }

  doThings(obj: SpaceObject): void {
    if (obj.constructor.name !== 'SpaceShip' && !(obj instanceof SpaceShip)) return;
    if (obj instanceof SpaceShip) {
      obj.glow = 1;
      obj.glowColor = [...this.glowColor] as [number, number, number];
      if (this.command === 'homing') obj.homings += 2;
      else if (this.command === 'life') obj.restoreLife();
      else if (this.command === 'nitro') obj.nitro = 3000;
      else if (this.command === 'shield') obj.shield = 10;
    }
  }

  destroyObject(gi: GameInstance): void {
    const i = this.team.objects.indexOf(this);
    if (i >= 0) this.team.objects.splice(i, 1);
    gi.map.removeObject(this);
    const frag = new Fragment(gi.map, this, this.model, 1, 500);
    frag.color = [...this.color] as [number, number, number];
    vec3.set(frag.vel, 0, 0, 0);
    quat.copy(frag.rot, this.rot);
    frag.update();
  }

  alphaDraw(d: DrawCtx): void {
    if (!d.rc.options.billboards) return;
    const s = 2.4;
    const m = mat4.create();
    mat4.fromTranslation(m, this.pos);
    const sc = mat4.create();
    mat4.fromScaling(sc, vec3.fromValues(s, s, s));
    mat4.multiply(m, m, sc);
    d.draw.drawGlow(m, m, d.view, d.proj, d.camPos, this.glowColor, 0.75);
    d.rc.renderer.trackDraws();
  }
}

// ------------------------------------------------------------------- Base
export class Base extends SpaceObject {
  constructor(map: import('./map').GameMap, team: Team, position: vec3, model: ModelData, scale: number) {
    super(P.ISTATIC, team, position, model, null, 1);
    team.objects.push(this);
    this.scale = scale;
    team.base = this;
    this.update();
    map.insertObject(this);
  }

  randomAround(r: () => number): vec3 {
    const a = Math.floor(r() * Math.PI * 1000) / 1000;
    const b = Math.floor(r() * 2 * Math.PI * 1000) / 1000;
    const radius = this.sradius * 4;
    return vec3.fromValues(
      this.pos[0] + Math.sin(a) * Math.cos(b) * radius,
      this.pos[1] + Math.sin(a) * Math.sin(b) * radius,
      this.pos[2] + Math.cos(a) * radius,
    );
  }

  solidDraw(_d: DrawCtx): void {
    /* no opaque pass */
  }

  automaticAction(_gi: GameInstance, _dtMs: number): void {
    /* no-op */
  }

  alphaDraw(d: DrawCtx): void {
    const L = this.lod(d, 'color');
    if (!L) return;
    const gl = d.draw.gl;
    gl.cullFace(gl.FRONT);
    d.draw.drawModel(L.gpu, this.model.tex, this.getMatrix(), d.view, d.proj, d.camPos, {
      alpha: 1 * L.alpha, emissive: this.team.color, light: true, prevWorld: this.prevMatrix(),
    });
    gl.cullFace(gl.BACK);
    d.draw.drawModel(L.gpu, this.model.tex, this.getMatrix(), d.view, d.proj, d.camPos, {
      alpha: 1 * L.alpha, emissive: this.team.color, light: true, prevWorld: this.prevMatrix(),
    });
    d.rc.renderer.trackDraws(L.gpu.meshes.length * 2);
  }
}

// ------------------------------------------------------------------- Flag
export class Flag extends SpaceObject {
  tumble = vec3.create();
  sideRot = 0;
  private timeLost = 0;
  private timeToLive = 20000;
  private owner: SpaceObject | null = null;

  constructor(gi: GameInstance, base: Base, model: ModelData) {
    super(P.ISTATIC, base.team, vec3.clone(base.pos), model, null, 1);
    this.tumble = randomTumble(gi.rc.random);
    this.sideRot = 0;
    this.team.objects.push(this);
    this.team.flag = this;
    this.setOwner(base);
    this.timeLost = 0;
    this.timeToLive = 20000;
    gi.map.insertObject(this);
  }

  getOwner(): SpaceObject | null {
    return this.owner;
  }

  setOwner(o: SpaceObject | null): void {
    if (this.owner !== o) {
      if (this.owner) this.owner.flag = null;
      if (o === null) this.timeLost = 0;
      else o.flag = this;
      this.owner = o;
    }
  }

  automaticAction(gi: GameInstance, dtMs: number): void {
    if (!this.active) return;
    const map = gi.map;
    const stack: OctItem[] = [];
    let bsR = this.sradius;
    if (this.owner) bsR = this.owner.sradius;
    map.octree.sphereSelectInteractive(this.sx, this.sy, this.sz, bsR, stack);
    let scored = false;
    for (const o of stack) {
      if (!(o instanceof SpaceObject)) continue;
      const co = o;
      if (co.team !== this.team && co instanceof Base && co.flag !== null) {
        for (const t of this.team.enemys) t.sounds.push('objectiveCompleted');
        for (const t of this.team.allies) t.sounds.push('youLost');
        co.team.points++;
        scored = true;
        this.setOwner(this.team.base);
        break;
      }
    }
    if (!scored && (this.owner === null || this.owner instanceof Base)) {
      for (const o of stack) {
        if (!(o instanceof SpaceObject)) continue;
        const co = o;
        if (co.physics.collector && co.active) {
          if (co.team === this.team && this.owner !== this.team.base) {
            for (const t of this.team.enemys) t.sounds.push('enemyTeamRecoveredTheFlag');
            for (const t of this.team.allies) t.sounds.push('ourTeamRecoveredTheFlag');
            this.setOwner(this.team.base);
            break;
          } else if (co.team !== this.team) {
            for (const t of this.team.enemys) t.sounds.push('ourTeamHasTheFlag');
            for (const t of this.team.allies) t.sounds.push('ourFlagWasStolen');
            this.setOwner(co);
            break;
          }
        }
      }
    }
    if (this.owner === null) {
      this.timeLost += dtMs;
      if (this.timeLost >= this.timeToLive) {
        this.setOwner(this.team.base);
        this.timeLost = 0;
        for (const t of this.team.enemys) t.sounds.push('enemyTeamRecoveredTheFlag');
        for (const t of this.team.allies) t.sounds.push('ourTeamRecoveredTheFlag');
      }
    }
    if (this.owner) {
      vec3.copy(this.pos, this.owner.pos);
      map.refreshObject(this);
    }
    if (this.owner === null || this.owner instanceof Base) {
      const e = quat.create();
      const d = 180 / Math.PI;
      quat.fromEuler(e, this.tumble[0] * d, this.tumble[1] * d, this.tumble[2] * d);
      quat.multiply(this.rot, this.rot, e);
      quat.normalize(this.rot, this.rot);
      this.step(dtMs, () => {});
      this.scale = 1;
      if (this.owner) vec3.copy(this.pos, this.owner.pos);
    } else {
      const e = quat.create();
      ypr(e, this.sideRot, 0, 0);
      quat.multiply(this.rot, this.owner.rot, e);
      quat.normalize(this.rot, this.rot);
      this.sideRot += 0.1;
      this.scale = 0.1;
      this.pos[0] += this.owner.up[0] / 2;
      this.pos[1] += this.owner.up[1] / 2;
      this.pos[2] += this.owner.up[2] / 2;
    }
    map.refreshObject(this);
  }

  solidDraw(d: DrawCtx): void {
    const L = this.lod(d, 'solid');
    if (!L) return;
    d.draw.drawModel(L.gpu, this.model.tex, this.getMatrix(), d.view, d.proj, d.camPos, {
      alpha: 1 * L.alpha, emissive: [0.2, 0.2, 0.2], light: true, prevWorld: this.prevMatrix(),
    });
    d.rc.renderer.trackDraws(L.gpu.meshes.length);
  }

  alphaDraw(d: DrawCtx): void {
    const L = this.lod(d, 'color');
    if (!L) return;
    const gl = d.draw.gl;
    const m = this.getMatrix();
    gl.cullFace(gl.FRONT);
    d.draw.drawModel(L.gpu, this.model.tex, m, d.view, d.proj, d.camPos, {
      alpha: 0.2 * L.alpha, emissive: this.team.color, light: true, prevWorld: this.prevMatrix(),
    });
    gl.cullFace(gl.BACK);
    d.draw.drawModel(L.gpu, this.model.tex, m, d.view, d.proj, d.camPos, {
      alpha: 0.2 * L.alpha, emissive: this.team.color, light: true, prevWorld: this.prevMatrix(),
    });
    d.rc.renderer.trackDraws(L.gpu.meshes.length * 2);
    if (d.rc.options.billboards) {
      // Marker glow on the flag: additive shell instead of a billboard.
      const s = this.sradius * 0.8;
      const g = mat4.create();
      mat4.fromTranslation(g, vec3.fromValues(m[12], m[13], m[14]));
      const sc = mat4.create();
      mat4.fromScaling(sc, vec3.fromValues(s, s, s));
      mat4.multiply(g, g, sc);
      d.draw.drawGlow(g, g, d.view, d.proj, d.camPos, [1, 1, 1], 0.85);
      d.rc.renderer.trackDraws();
    }
  }
}

// ----------------------------------------------------------------- Bullet
export class Bullet extends SpaceObject {
  launcher: SpaceObject;

  constructor(gi: GameInstance, model: ModelData, launcher: SpaceObject, ray: { pos: vec3; dir: vec3 }, ttl = 3000) {
    super(P.BULLET, launcher.team, vec3.clone(ray.pos), model, new Life1(10), 1);
    this.launcher = launcher;
    ypr(this.rot, getH(ray.dir), getV(ray.dir), 0);
    this.update();
    gi.map.insertObject(this);
    gi.map.allBullets.push({ obj: this, elapsed: 0, max: ttl });
    vec3.scale(this.accel, this.dir, this.physics.accelMax);
    vec3.scale(this.vel, this.dir, this.physics.velMax);
  }

  automaticAction(gi: GameInstance, dtMs: number): void {
    if (!this.active) return;
    this.step(dtMs, () => gi.map.refreshObject(this));
    gi.map.refreshObject(this);
  }

  setBoundingSphere(): void {
    this.sx = (this.pos[0] + this.lastPos[0]) / 2;
    this.sy = (this.pos[1] + this.lastPos[1]) / 2;
    this.sz = (this.pos[2] + this.lastPos[2]) / 2;
    const moved =
      this.pos[0] !== this.lastPos[0] || this.pos[1] !== this.lastPos[1] || this.pos[2] !== this.lastPos[2];
    this.sradius = moved
      ? Math.hypot(this.lastPos[0] - this.pos[0], this.lastPos[1] - this.pos[1], this.lastPos[2] - this.pos[2]) / 2
      : 1;
  }

  solidDraw(d: DrawCtx): void {
    const L = this.lod(d, 'solid');
    if (!L) return;
    const emissive = partyShiftColor([1, 0.55, 0]);
    d.draw.drawModel(L.gpu, this.model.tex, this.getMatrix(), d.view, d.proj, d.camPos, {
      alpha: this.alpha * L.alpha, emissive, light: true, prevWorld: this.prevMatrix(),
    });
    d.rc.renderer.trackDraws(L.gpu.meshes.length);
  }

  alphaDraw(d: DrawCtx): void {
    if (!d.rc.options.billboards) return;
    const s = 0.55;
    const m = mat4.create();
    mat4.fromTranslation(m, this.pos);
    const mPrev = mat4.create();
    mat4.fromTranslation(mPrev, this.prevPos);
    const sc = mat4.create();
    mat4.fromScaling(sc, vec3.fromValues(s, s, s));
    mat4.multiply(m, m, sc);
    mat4.multiply(mPrev, mPrev, sc);
    d.draw.drawGlow(m, mPrev, d.view, d.proj, d.camPos, partyShiftColor([1, 1, 0.35]), 0.85);
    d.rc.renderer.trackDraws();
  }
}

// ---------------------------------------------------------- HomingMissile
export class HomingMissile extends Bullet {
  constructor(gi: GameInstance, model: ModelData, launcher: SpaceObject, position: vec3, ttl: number) {
    super(gi, model, launcher, { pos: position, dir: vec3.clone(launcher.dir) }, ttl);
    this.physics = P.MISSILE;
    this.life = new Life1(500);
    vec3.scale(this.accel, this.dir, this.physics.accelMax);
    vec3.copy(this.vel, launcher.vel);
    this.update();
    gi.map.refreshObject(this);
  }

  createSmoke(gi: GameInstance): void {
    if (!gi.rc.options.billboards) return;
    const drift = vec3.create();
    vec3.scale(drift, this.vel, 0.05);
    gi.map.spawnSmoke(
      vec3.fromValues(this.pos[0] - this.dir[0] * 3, this.pos[1] - this.dir[1] * 3, this.pos[2] - this.dir[2] * 3),
      drift,
      { size0: 0.2, size1: 1.3, life: 1100, alpha: 0.9, turbulence: 0.6 },
    );
  }

  automaticAction(gi: GameInstance, dtMs: number): void {
    if (!this.active) return;
    this.intelligence!.execute();
    this.move(gi, dtMs);
  }

  solidDraw(d: DrawCtx): void {
    const L = this.lod(d, 'solid');
    if (!L) return;
    d.draw.drawModel(L.gpu, this.model.tex, this.getMatrix(), d.view, d.proj, d.camPos, {
      alpha: this.alpha * L.alpha, emissive: [0.2, 0.2, 0.2], light: true, prevWorld: this.prevMatrix(),
    });
    d.rc.renderer.trackDraws(L.gpu.meshes.length);
  }

  alphaDraw(d: DrawCtx): void {
    if (!d.rc.options.billboards) return;
    const r = this.model.solid[0]?.boundingSphere.radius ?? 1;
    const s = 0.6;
    const m = mat4.create();
    mat4.fromTranslation(m, vec3.fromValues(
      this.pos[0] - this.dir[0] * r, this.pos[1] - this.dir[1] * r, this.pos[2] - this.dir[2] * r,
    ));
    const mPrev = mat4.create();
    mat4.fromTranslation(mPrev, vec3.fromValues(
      this.prevPos[0] - this.dir[0] * r, this.prevPos[1] - this.dir[1] * r, this.prevPos[2] - this.dir[2] * r,
    ));
    const sc = mat4.create();
    mat4.fromScaling(sc, vec3.fromValues(s, s, s));
    mat4.multiply(m, m, sc);
    mat4.multiply(mPrev, mPrev, sc);
    d.draw.drawGlow(m, mPrev, d.view, d.proj, d.camPos, partyShiftColor([1, 0.62, 0.2]), 0.9);
    d.rc.renderer.trackDraws();
  }
}

// ----------------------------------------------------------------- Shield
export class Shield extends SpaceObject {
  constructor(map: import('./map').GameMap, team: Team, position: vec3, model: ModelData, scale: number) {
    super(P.ISTATIC, team, position, model, null, scale);
    team.objects.push(this);
    map.insertObject(this);
  }

  randomAround(r: () => number): vec3 {
    const a = Math.floor(r() * Math.PI * 1000) / 1000;
    const b = Math.floor(r() * 2 * Math.PI * 1000) / 1000;
    const radius = this.sradius * 4;
    return vec3.fromValues(
      this.pos[0] + Math.sin(a) * Math.cos(b) * radius,
      this.pos[1] + Math.sin(a) * Math.sin(b) * radius,
      this.pos[2] + Math.cos(a) * radius,
    );
  }

  solidDraw(_d: DrawCtx): void {
    /* no opaque pass */
  }

  alphaDraw(d: DrawCtx): void {
    const L = this.lod(d, 'color');
    if (!L) return;
    d.draw.setDepthWrite(true);
    d.draw.drawModel(L.gpu, this.model.tex, this.getMatrix(), d.view, d.proj, d.camPos, {
      alpha: 0.1 * L.alpha, emissive: this.team.color, light: true, prevWorld: this.prevMatrix(),
    });
    d.rc.renderer.trackDraws(L.gpu.meshes.length);
    d.draw.setDepthWrite(false);
  }
}

// -------------------------------------------------------------------- Ark
export class Ark extends SpaceObject {
  constructor(map: import('./map').GameMap, team: Team, position: vec3, model: ModelData) {
    super(P.STATIC, team, position, model, null, 1);
    this.alpha = 0.2;
    this.color = [1, 1, 1];
    map.insertObject(this);
  }

  solidDraw(d: DrawCtx): void {
    if (this.alpha !== 1) return;
    const L = this.lod(d, 'solid');
    if (!L) return;
    d.draw.drawModel(L.gpu, this.model.tex, this.getMatrix(), d.view, d.proj, d.camPos, {
      alpha: this.alpha * L.alpha, emissive: this.color, light: true, prevWorld: this.prevMatrix(),
    });
    d.rc.renderer.trackDraws(L.gpu.meshes.length);
  }

  alphaDraw(d: DrawCtx): void {
    if (this.alpha === 1) return;
    const L = this.lod(d, 'solid');
    if (!L) return;
    d.draw.drawModel(L.gpu, this.model.tex, this.getMatrix(), d.view, d.proj, d.camPos, {
      alpha: this.alpha * L.alpha, emissive: this.color, light: true, prevWorld: this.prevMatrix(),
    });
    d.rc.renderer.trackDraws(L.gpu.meshes.length);
  }
}

// --------------------------------------------------------------- SmokePuff
// Particle of the real smoke system: no sprite texture, the density comes from
// the 3D Perlin field sampled in world space (see SMOKE_FRAG), the particle
// grows/drifts/dissolves over its lifetime, and it fades out where it meets
// geometry (soft particles against the scene depth copy).
export interface SmokeOpts {
  size0: number;
  size1: number;
  life: number;
  alpha: number;
  turbulence: number;
}

export class SmokePuff extends Abstract3D {
  pos = vec3.create();
  prevPos = vec3.create();
  vel = vec3.create();
  size0: number;
  size1: number;
  life: number;
  elapsed = 0;
  alpha0: number;
  turbulence: number;
  size: number;
  seed: number;
  /** Optional per-particle colour; player engine smoke uses the live team hue. */
  tint: [number, number, number] | null = null;

  get kind(): ObKind {
    return ObKind.Uncollidable;
  }

  constructor(
    map: import('./map').GameMap, position: vec3, vel: vec3, opts: SmokeOpts, seed: number,
  ) {
    super(P.EMPTY);
    vec3.copy(this.pos, position);
    vec3.copy(this.prevPos, position);
    vec3.copy(this.vel, vel);
    this.size0 = opts.size0;
    this.size1 = opts.size1;
    this.life = opts.life;
    this.alpha0 = opts.alpha;
    this.turbulence = opts.turbulence;
    this.size = opts.size0;
    this.seed = seed;
    this.alpha = 1;
    map.insertObject(this);
  }

  setBoundingSphere(): void {
    this.sx = this.pos[0];
    this.sy = this.pos[1];
    this.sz = this.pos[2];
    this.sradius = Math.max(this.size0, this.size1);
  }

  update(): void {
    this.setBoundingSphere();
  }

  age01(): number {
    return this.life <= 0 ? 1 : clamp(this.elapsed / this.life, 0, 1);
  }

  step(dtMs: number): boolean {
    const dt = dtMs / 1000;
    vec3.copy(this.prevPos, this.pos);
    this.elapsed += dtMs;
    vec3.scaleAndAdd(this.pos, this.pos, this.vel, dt);
    // drag + slight buoyancy so the plume slows down and rises like hot smoke
    const drag = Math.max(0, 1 - 2.2 * dt);
    vec3.scale(this.vel, this.vel, drag);
    this.vel[1] += 0.9 * dt;
    const a = this.age01();
    const ease = 1 - (1 - a) * (1 - a);
    this.size = this.size0 + (this.size1 - this.size0) * ease;
    this.setBoundingSphere();
    return this.elapsed < this.life;
  }

  solidDraw(_d: DrawCtx): void {
    /* transparent only */
  }

  alphaDraw(d: DrawCtx): void {
    d.draw.drawSmoke(
      this.pos[0], this.pos[1], this.pos[2],
      this.prevPos[0], this.prevPos[1], this.prevPos[2],
      this.size, this.alpha0, this.seed, this.age01(), this.turbulence,
      d.view, d.proj, this.tint,
    );
    d.rc.renderer.trackDraws();
  }
}

// --------------------------------------------------------------- Explosion
// Additive fireball used for weapon impacts, collisions and kills: three glow
// shells that expand and fade (white-hot core -> orange body -> dark halo),
// plus a smoke burst and optional debris spawned by spawnExplosion().
export class Explosion extends Abstract3D {
  pos = vec3.create();
  elapsed = 0;
  life: number;
  scale: number;

  get kind(): ObKind {
    return ObKind.Uncollidable;
  }

  constructor(map: import('./map').GameMap, position: vec3, scale: number, life = 650) {
    super(P.EMPTY);
    vec3.copy(this.pos, position);
    this.scale = scale;
    this.life = life;
    map.insertObject(this);
  }

  setBoundingSphere(): void {
    this.sx = this.pos[0];
    this.sy = this.pos[1];
    this.sz = this.pos[2];
    this.sradius = this.scale * 3;
  }

  update(): void {
    this.setBoundingSphere();
  }

  step(dtMs: number): boolean {
    this.elapsed += dtMs;
    return this.elapsed < this.life;
  }

  solidDraw(_d: DrawCtx): void {
    /* transparent only */
  }

  alphaDraw(d: DrawCtx): void {
    const t = clamp(this.elapsed / this.life, 0, 1);
    const ease = 1 - (1 - t) * (1 - t);          // fast initial burst
    const fade = (1 - t) * (1 - t);
    // Start already big (a flash) and keep expanding.
    const r = this.scale * (0.8 + 1.5 * ease);
    const m = mat4.create();
    mat4.fromTranslation(m, this.pos);
    const sc = mat4.create();
    const shell = (mult: number, color: [number, number, number], a: number): void => {
      const s = r * mult;
      mat4.fromScaling(sc, vec3.fromValues(s, s, s));
      const out = mat4.create();
      mat4.multiply(out, m, sc);
      // Broad fireball falloff (softness ~1) instead of the tight engine glow.
      d.draw.drawGlow(out, out, d.view, d.proj, d.camPos, color, a, 1.0);
    };
    shell(0.5, [1, 0.95, 0.85], 1.25 * fade);   // white-hot core
    shell(0.95, [1, 0.62, 0.24], 1.1 * fade);   // orange body
    shell(1.5, [0.85, 0.32, 0.1], 0.55 * fade); // dark halo
    d.rc.renderer.trackDraws(3);
  }
}

export interface ExplosionOpts {
  /** Smoke puffs in the burst (default scales with the fireball). */
  smoke?: number;
  /** Debris pieces that fly away (needs a launcher for the model). */
  debris?: number;
  /** Debris model source (defaults to none). */
  launcher?: SpaceObject | null;
  life?: number;
}

/** Fireball + smoke burst (+ optional debris) at a world position. */
export function spawnExplosion(
  map: import('./map').GameMap, position: vec3, scale: number, opts: ExplosionOpts = {},
): Explosion {
  const rnd = map.rng;
  const ex = new Explosion(map, position, scale, opts.life ?? 650);
  map.explosions.push(ex);
  const smoke = opts.smoke ?? Math.max(2, Math.round(2 + scale * 2));
  for (let i = 0; i < smoke; i++) {
    const a = rnd() * Math.PI * 2;
    const b = (rnd() - 0.5) * Math.PI;
    const dx = Math.cos(a) * Math.cos(b), dy = Math.sin(b), dz = Math.sin(a) * Math.cos(b);
    const off = scale * 0.45;
    const vel = scale * (1.2 + rnd() * 2.4);
    map.spawnSmoke(
      vec3.fromValues(position[0] + dx * off, position[1] + dy * off, position[2] + dz * off),
      vec3.fromValues(dx * vel, dy * vel, dz * vel),
      { size0: scale * 0.3, size1: scale * (1.1 + rnd() * 1.2), life: 900 + rnd() * 500, alpha: 0.95, turbulence: 0.8 },
    );
  }
  if (opts.debris && opts.launcher) {
    for (let i = 0; i < opts.debris; i++) {
      const f = new Fragment(map, opts.launcher, opts.launcher.model, scale * (0.18 + rnd() * 0.22), 700 + rnd() * 500);
      const l = Math.hypot(f.vel[0], f.vel[1], f.vel[2]) || 1;
      const v = scale * (6 + rnd() * 8);
      vec3.scale(f.vel, f.vel, v / l);
      f.update();
    }
  }
  // Multiplayer host: replay the same fireball on every client (the guests
  // have no simulation, they rebuild it from the event's seed and counts).
  simHooks.host?.explosion({
    pos: [position[0], position[1], position[2]],
    scale,
    life: opts.life ?? 650,
    smoke,
    debris: opts.debris && opts.launcher ? opts.debris : 0,
    model: opts.debris && opts.launcher ? opts.launcher.model : null,
  });
  return ex;
}

// --------------------------------------------------------------- Billboard
export class Billboard extends Abstract3D {
  pos = vec3.create();
  prevPos = vec3.create();
  team: Team;
  tex: TexEntry | null;

  get kind(): ObKind {
    return ObKind.Uncollidable;
  }

  constructor(
    map: import('./map').GameMap, team: Team, position: vec3,
    tex: TexEntry | null, scale: number, alpha: number,
  ) {
    super(P.EMPTY);
    this.team = team;
    vec3.copy(this.pos, position);
    vec3.copy(this.prevPos, position);
    this.tex = tex;
    this.scale = scale;
    this.alpha = alpha;
    map.insertObject(this);
  }

  setBoundingSphere(): void {
    this.sx = this.pos[0];
    this.sy = this.pos[1];
    this.sz = this.pos[2];
    this.sradius = this.scale;
  }

  update(): void {
    this.setBoundingSphere();
  }

  solidDraw(_d: DrawCtx): void {
    /* no-op */
  }

  alphaDraw(d: DrawCtx): void {
    if (!d.rc.options.billboards) return;
    const dist = d.camDistance(this.pos);
    const a = this.alpha * clamp((d.rc.options.distance - dist) / 32, 0, 1);
    d.draw.setBillboardPrev(this.prevPos[0], this.prevPos[1], this.prevPos[2]);
    d.draw.drawBillboard(this.tex, this.pos[0], this.pos[1], this.pos[2], this.sradius, [1, 1, 1], a, d.view, d.proj);
    d.rc.renderer.trackDraws();
  }
}

// --------------------------------------------------------------- Fragment
export class Fragment extends SpaceObject {
  timer!: { obj: Fragment; elapsed: number; max: number };

  constructor(map: import('./map').GameMap, launcher: SpaceObject, model: ModelData, scale: number, ttl: number) {
    super(P.FRAG, launcher.team, vec3.clone(launcher.pos), model, null, scale);
    const r1 = Math.random() * 2 - 1;
    const r2 = Math.random() * 2 - 1;
    const r3 = Math.random() * 2 - 1;
    const l = Math.hypot(r1, r2, r3) || 1;
    vec3.set(this.dir, r1 / l, r2 / l, r3 / l);
    vec3.set(this.vel, (r1 / l) * 30, (r2 / l) * 30, (r3 / l) * 30);
    this.update();
    this.timer = { obj: this, elapsed: 0, max: ttl };
    map.fragments.push(this.timer);
    map.insertObject(this);
  }

  /** Whole-model husk (ctor2: rot+scale copied, zero velocity). */
  static husk(map: import('./map').GameMap, launcher: SpaceObject, ttl: number): Fragment {
    const f = new Fragment(map, launcher, launcher.model, launcher.scale, ttl);
    quat.copy(f.rot, launcher.rot);
    f.scale = launcher.scale;
    vec3.set(f.vel, 0, 0, 0);
    f.update();
    map.refreshObject(f);
    return f;
  }

  solidDraw(_d: DrawCtx): void {
    /* no-op */
  }

  alphaDraw(d: DrawCtx): void {
    const a = 1 - this.timer.elapsed / this.timer.max;
    const S = this.lod(d, 'solid');
    if (S) {
      d.draw.drawModel(S.gpu, this.model.tex, this.getMatrix(), d.view, d.proj, d.camPos, {
        alpha: Math.max(0, a), emissive: this.color, light: true, prevWorld: this.prevMatrix(),
      });
      d.rc.renderer.trackDraws(S.gpu.meshes.length);
    }
    const C = this.lod(d, 'color');
    if (C && C.gpu !== S?.gpu) {
      d.draw.drawModel(C.gpu, this.model.tex, this.getMatrix(), d.view, d.proj, d.camPos, {
        alpha: Math.max(0, a), emissive: this.color, light: true, prevWorld: this.prevMatrix(),
      });
      d.rc.renderer.trackDraws(C.gpu.meshes.length);
    }
  }
}

export { Life };
export type { Physics };
