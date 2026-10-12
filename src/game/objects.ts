// Full SpaceObject hierarchy port: Abstract3D/Object3D + SpaceObject +
// SpaceShip/Asteroid/Addon/Base/Flag/Bullet/HomingMissile/Shield/Ark/
// Billboard/TimedBillboard/Fragment. All constants, timers, sounds, and
// quirks preserved (see module docstrings). Drawing goes through DrawCtx.

import { mat4, quat, vec3, ypr, dirFromQuat, sideFromQuat, upFromQuat, getH, getV, clamp } from '../engine/math';
import { ObKind } from '../engine/octree';
import type { OctItem, OctNode } from '../engine/octree';
import { rayIntersectModel } from '../engine/model';
import type { GpuModel } from '../engine/model';
import type { TexEntry } from '../engine/texture';
import { Life, Life1 } from './life';
import { P, nextPosition } from './physics';
import type { Physics } from './physics';
import type { Team } from './team';
import type { GameInstance } from './instance';
import type { RC } from './resources';

export interface Command {
  execute(): void;
}

/** Factory hook so LaunchHoming can attach AIHoming without a module cycle. */
export type AIHomingFactory = (
  gi: import('./instance').GameInstance,
  target: SpaceObject | null,
  self: HomingMissile,
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
  gpu: GpuModel;
  tex: TexEntry | null;
  icon: TexEntry | null;
  flares: FlareSet;
  friction: number;
}

export interface DrawCtx {
  draw: import('../engine/draw').Draw;
  view: mat4;
  proj: mat4;
  camPos: vec3;
  rc: RC;
}

/** Independent per-component tumble vector (ToRadians(Next(0,3000)/1000)). */
export function randomTumble(r: () => number): vec3 {
  const c = () => ((Math.floor(r() * 3000) / 1000) * Math.PI) / 180;
  return vec3.fromValues(c(), c(), c());
}

// ---------------------------------------------------------------- Abstract3D
export abstract class Abstract3D implements OctItem {
  _octNode: OctNode | null = null;
  abstract kind: ObKind;
  active = true;
  sx = 0;
  sy = 0;
  sz = 0;
  sradius = 1;
  color: [number, number, number] = [0, 0, 0]; // Colors.Emissive == black
  alpha = 1;
  multiplier = 1;
  scale = 1;
  physics: Physics;

  constructor(physics: Physics) {
    this.physics = physics;
  }

  get kind_(): ObKind {
    return this.physics.objectType;
  }

  abstract setBoundingSphere(): void;
  abstract update(): void;
  abstract solidDraw(d: DrawCtx): void;
  abstract alphaDraw(d: DrawCtx): void;
}

// ----------------------------------------------------------------- Object3D
export abstract class Object3D extends Abstract3D {
  model: ModelData;
  insideMap = true;
  intelligence: Command | null = null;
  pos = vec3.create();
  lastPos = vec3.create();
  vel = vec3.create();
  accel = vec3.create();
  dir = vec3.fromValues(0, 0, 1);
  up = vec3.fromValues(0, 1, 0);
  side = vec3.fromValues(1, 0, 0);
  rot = quat.create();
  matrix = mat4.create();

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
  }

  automaticAction(gi: GameInstance, dtMs: number): void {
    if (this.intelligence && this.active) this.intelligence.execute();
    void gi;
    void dtMs;
  }

  setBoundingSphere(): void {
    const b = this.model.gpu.boundingSphere;
    const m = this.matrix as unknown as Float32Array;
    this.sx = m[0] * b.center[0] + m[4] * b.center[1] + m[8] * b.center[2] + m[12];
    this.sy = m[1] * b.center[0] + m[5] * b.center[1] + m[9] * b.center[2] + m[13];
    this.sz = m[2] * b.center[0] + m[6] * b.center[1] + m[10] * b.center[2] + m[14];
    const s = Math.hypot(m[0], m[1], m[2]);
    this.sradius = b.radius * s;
  }

  /** Object3D.Update verbatim. */
  update(): void {
    dirFromQuat(this.dir, this.rot);
    upFromQuat(this.up, this.rot);
    sideFromQuat(this.side, this.rot);
    const m = this.matrix as unknown as Float32Array;
    // R * S * T (row-major) == column-major T * S * R
    const q = this.rot;
    const s = this.scale;
    // rotation matrix from quat
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    m[0] = (1 - (yy + zz)) * s; m[1] = (xy + wz) * s; m[2] = (xz - wy) * s; m[3] = 0;
    m[4] = (xy - wz) * s; m[5] = (1 - (xx + zz)) * s; m[6] = (yz + wx) * s; m[7] = 0;
    m[8] = (xz + wy) * s; m[9] = (yz - wx) * s; m[10] = (1 - (xx + yy)) * s; m[11] = 0;
    m[12] = this.pos[0]; m[13] = this.pos[1]; m[14] = this.pos[2]; m[15] = 1;
    this.setBoundingSphere();
  }

  /** Object3D.NextPosition verbatim (map.refreshObject has the side effects). */
  nextPosition(dtMs: number, refresh: () => void): void {
    vec3.copy(this.lastPos, this.pos);
    nextPosition(
      {
        pos: this.pos, vel: this.vel, accel: this.accel,
        multiplier: this.multiplier, friction: this.model.friction, physics: this.physics,
      },
      dtMs,
    );
    // nextPosition copies multiplier back? No — sync the decayed value:
    // (BodyState is a copy; re-derive: multiplier lerps toward 1 by .2)
    this.multiplier = this.multiplier + (1 - this.multiplier) * 0.2;
    refresh();
  }
}

// -------------------------------------------------------------- SpaceObject
export class SpaceObject extends Object3D {
  waitTime = 0;
  teleported = false;
  life: Life | null;
  team: Team;
  flag: Flag | null = null; // carried flag
  launchSpan = 0;
  launchs = 0;
  homings = 0;
  nitro = 0;
  shield = 0;
  destroyed = false;

  constructor(physics: Physics, team: Team, position: vec3, model: ModelData, life: Life | null, scale: number) {
    super(physics, position, model, scale);
    this.life = life;
    this.team = team;
  }

  /** Face first enemy base (Respawn orientation verbatim). */
  faceEnemyBase(): void {
    for (const t of this.team.enemys) {
      if (t.base) {
        const dx = t.base.pos[0] - this.pos[0];
        const dy = t.base.pos[1] - this.pos[1];
        const dz = t.base.pos[2] - this.pos[2];
        const l = Math.hypot(dx, dy, dz) || 1;
        const d = vec3.fromValues(dx / l, dy / l, dz / l);
        ypr(this.rot, getH(d), getV(d), 0);
        break;
      }
    }
    this.update();
  }

  /** Shield absorbs one whole hit; else life damage (+hit sound if selected). */
  receiveDamage(gi: GameInstance, amount: number, direction: vec3): void {
    if (!this.life) return;
    if (this.shield <= 0) {
      this.life.receiveDamage(amount, direction, this.up, this.dir, () => this.destroyObject(gi));
      if (this === gi.selectedObject) gi.rc.playSfx('hitSound');
    } else {
      this.shield--;
      if (this === gi.selectedObject) gi.rc.playSfx('absorbSound');
    }
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

  /** SpaceObject.Move verbatim. */
  move(gi: GameInstance, dtMs: number): void {
    const map = gi.map;
    if (this.waitTime <= 0) {
      vec3.copy(this.lastPos, this.pos);
      nextPosition(
        {
          pos: this.pos, vel: this.vel, accel: this.accel,
          multiplier: this.multiplier, friction: this.model.friction, physics: this.physics,
        },
        dtMs,
      );
      this.multiplier = this.multiplier + (1 - this.multiplier) * 0.2;
    }
    if (vec3.length(this.vel) > 0 && gi.renderer) {
      const f = gi.renderer.frustum;
      let inside = true;
      for (let i = 0; i < 6; i++) {
        if (f[i * 4] * this.sx + f[i * 4 + 1] * this.sy + f[i * 4 + 2] * this.sz + f[i * 4 + 3] < -this.sradius) {
          inside = false;
          break;
        }
      }
      if (inside) this.createSmoke(gi);
    }
    map.refreshObject(this);
    if (this.physics.objectType !== ObKind.Uncollidable) {
      const stack: SpaceObject[] = [];
      map.octree.sphereSelect(this.sx, this.sy, this.sz, this.sradius, stack as unknown as OctItem[]);
      const objs = stack.filter((o): o is SpaceObject => o instanceof SpaceObject);
      for (const obj of objs) {
        if (obj === this) continue;
        const t = obj.physics.objectType;
        if (t === ObKind.Uncollidable || obj instanceof Flag || obj instanceof Base) continue;
        if (obj instanceof Addon) {
          if (gi.selectedObject === this) gi.rc.playSfx('addonSound');
          obj.doThings(this, gi);
          obj.destroyObject(gi);
          continue;
        }
        if (obj instanceof Ark) {
          if (map.path.length > 0 && obj === map.path[0] && obj.team !== this.team) {
            obj.destroyObject(gi);
            map.path.shift();
            gi.rc.playSfx('addonSound');
          }
          continue;
        }
        if (obj.team !== this.team) {
          const a = this.totalLife();
          const b = obj.totalLife();
          const d = vec3.create();
          vec3.subtract(d, obj.pos, this.pos);
          vec3.normalize(d, d);
          this.receiveDamage(gi, b, d);
          const d2 = vec3.create();
          vec3.subtract(d2, this.pos, obj.pos);
          vec3.normalize(d2, d2);
          obj.receiveDamage(gi, a, d2);
        }
      }
    }
  }

  /** SpaceObject.DestroyObject verbatim sequence. */
  destroyObject(gi: GameInstance): void {
    const map = gi.map;
    const rc = gi.rc;
    this.destroyed = true;
    if (this.flag) this.flag.setOwner(null);
    if (this.physics.reSpawns) {
      if (this.waitTime <= 0) {
        this.waitTime = 10000;
        map.respawned.unshift(this);
        map.removeObject(this);
      }
    } else {
      const i = this.team.objects.indexOf(this);
      if (i >= 0) this.team.objects.splice(i, 1);
      map.removeObject(this);
    }
    const frag = Fragment.husk(map, this, this.model, 500);
    frag.color = [...this.color] as [number, number, number];
    const sel = gi.selectedObject;
    if (sel) {
      const vx = this.pos[0] - sel.pos[0];
      const vy = this.pos[1] - sel.pos[1];
      const vz = this.pos[2] - sel.pos[2];
      const dist = Math.hypot(vx, vy, vz) || 1;
      const pan = clamp((-8 * (sel.side[0] * (vx / dist) + sel.side[1] * (vy / dist) + sel.side[2] * (vz / dist))) as number, -1, 1);
      const volume = clamp(1 - dist / rc.options.distance, 0, 1);
      if (volume > 0) {
        if (this instanceof Ark) rc.playSfx('addonSound');
        else if (dist < rc.options.distance / 2) rc.playSfx('closeExplosion', volume, pan);
        else if (dist < rc.options.distance) rc.playSfx('farExplosion', volume, pan);
      }
    } else if (this instanceof Ark) {
      rc.playSfx('addonSound');
    }
    void frag;
  }

  automaticAction(gi: GameInstance, dtMs: number): void {
    if (!this.active) return;
    if (this.intelligence) this.intelligence.execute();
    this.launchSpan += dtMs;
    this.move(gi, dtMs);
  }

  /** BulletHit verbatim: min over meshes, range-checked. */
  bulletHit(b: Bullet): number | null {
    const dx = b.dir[0], dy = b.dir[1], dz = b.dir[2];
    let inter: number | null = null;
    const t = rayIntersectModel(
      this.model.gpu, this.matrix,
      b.lastPos[0], b.lastPos[1], b.lastPos[2], dx, dy, dz,
    );
    if (t !== null && (inter === null || t < inter)) inter = t;
    if (inter === null) return null;
    const range = Math.hypot(
      b.pos[0] - b.lastPos[0], b.pos[1] - b.lastPos[1], b.pos[2] - b.lastPos[2],
    );
    return inter < range ? inter : null;
  }

  canLaunchBullet(): boolean {
    return this.launchSpan >= 200;
  }

  /** LaunchBullet verbatim: alternating ±side/2 muzzle, Life1(10), TTL 3000. */
  launchBullet(gi: GameInstance, direction: vec3): void {
    const mdl = gi.rc.model('Bullet');
    if (!mdl) return;
    const mx = this.pos[0] + ((this.launchs % 2 === 0 ? this.side[0] : -this.side[0]) / 2);
    const my = this.pos[1] + ((this.launchs % 2 === 0 ? this.side[1] : -this.side[1]) / 2);
    const mz = this.pos[2] + ((this.launchs % 2 === 0 ? this.side[2] : -this.side[2]) / 2);
    const ray = { pos: vec3.fromValues(mx, my, mz), dir: vec3.clone(direction) };
    new Bullet(gi, mdl, this, ray);
    this.launchs++;
    this.launchSpan %= 200;
    if (this === gi.selectedObject) gi.rc.playSfx('bulletSound', 0.2, 0);
  }

  /** LaunchNitro verbatim. */
  launchNitro(dtMs: number): void {
    if (this.nitro > 0) {
      this.multiplier = 7.5;
      this.nitro -= dtMs;
      if (this.nitro < 0) this.nitro = 0;
    }
  }

  /** LaunchHoming verbatim: 200ms + ammo, 256-radius most-centered lock. */
  launchHoming(gi: GameInstance): void {
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
    if (!mdl) return;
    const s = this.launchs % 2 === 0 ? 1 : -1;
    const px = this.pos[0] + (s * this.side[0] * 2) / 3 - this.up[0] / 3 - this.dir[0] / 3;
    const py = this.pos[1] + (s * this.side[1] * 2) / 3 - this.up[1] / 3 - this.dir[1] / 3;
    const pz = this.pos[2] + (s * this.side[2] * 2) / 3 - this.up[2] / 3 - this.dir[2] / 3;
    const missile = new HomingMissile(gi, mdl, this, vec3.fromValues(px, py, pz), 2000);
    this.homings--;
    this.launchs++;
    if (createAIHoming) missile.intelligence = createAIHoming(gi, target, missile);
    this.launchSpan %= 200;
    if (this === gi.selectedObject) gi.rc.playSfx('missileSound');
  }

  solidDraw(d: DrawCtx): void {
    d.draw.drawModel(this.model.gpu, this.model.tex, this.matrix, d.view, d.proj, d.camPos, {
      alpha: this.alpha, emissive: this.color, light: true,
    });
    d.rc.renderer.trackDraws(this.model.gpu.meshes.length);
  }

  alphaDraw(_d: DrawCtx): void {
    /* base no-op */
  }
}

// --------------------------------------------------------------- SpaceShip
export class SpaceShip extends SpaceObject {
  shieldModel: ModelData | null;
  glow = 0;
  glowColor: [number, number, number] = [1, 1, 1];
  private lol = 0;

  constructor(
    physics: Physics, gi: GameInstance, team: Team, position: vec3,
    model: ModelData, life: Life | null, shieldModel: ModelData | null,
  ) {
    super(physics, team, position, model, life, 1);
    this.glow = 0;
    this.faceEnemyBase();
    this.homings = 10;
    this.nitro = 3000;
    this.shieldModel = shieldModel;
    team.objects.push(this);
    gi.map.insertObject(this);
  }

  createSmoke(gi: GameInstance): void {
    if (!this.active || vec3.length(this.vel) === 0) return;
    const r = gi.rc.random;
    const px = this.pos[0] - this.dir[0] * 3;
    const py = this.pos[1] - this.dir[1] * 3;
    const pz = this.pos[2] - this.dir[2] * 3;
    new TimedBillboard(
      gi.map, this.team, vec3.fromValues(px, py, pz),
      'holoSmoke' + (1 + Math.floor(r() * 7)),
      0.75, 500, vec3.length(this.vel) / this.physics.velMax,
    );
  }

  alphaDraw(d: DrawCtx): void {
    const { draw, view, proj } = d;
    const f = this.model.flares;
    const r = this.model.gpu.boundingSphere.radius;
    const accelFrac = vec3.length(this.accel) / this.physics.accelMax;
    const camDir = d.rc.renderer.camera.direction;
    const facing = camDir[0] * this.dir[0] + camDir[1] * this.dir[1] + camDir[2] * this.dir[2];
    const flare3 = d.rc.tex('flare3');
    for (const v of f.engine) {
      draw.drawBillboard(
        flare3,
        this.pos[0] + r * v[0], this.pos[1] + r * v[1], this.pos[2] + r * v[2],
        2, [1, 1, 1], facing * accelFrac, view, proj,
      );
      d.rc.renderer.trackDraws();
    }
    const flare1 = d.rc.tex('flare1');
    const pulse = (1 + Math.sin(this.lol)) / 2;
    for (const v of f.color) {
      draw.drawBillboard(
        flare1,
        this.pos[0] + r * v[0], this.pos[1] + r * v[1], this.pos[2] + r * v[2],
        0.35, this.team.color, pulse, view, proj,
      );
      d.rc.renderer.trackDraws();
    }
    this.lol += Math.PI / 10;
    if (this.shield > 0 && this.shieldModel) {
      const m = mat4.create();
      const s = vec3.fromValues(0.12, 0.12, 0.12);
      mat4.fromRotationTranslationScale(m, this.rot, this.pos, s);
      draw.drawModel(this.shieldModel.gpu, this.shieldModel.tex, m, view, proj, d.camPos, {
        alpha: (this.shield / 5) * 0.1, emissive: this.team.color, light: true,
      });
      d.rc.renderer.trackDraws(this.shieldModel.gpu.meshes.length);
    }
    if (this.glow > 0) {
      const perc = Math.sin(Math.PI * this.glow);
      draw.drawBillboard(flare1, this.pos[0], this.pos[1], this.pos[2], 1.5, this.glowColor, perc, view, proj);
      d.rc.renderer.trackDraws();
      this.color = [
        this.glowColor[0] * perc,
        this.glowColor[1] * perc,
        this.glowColor[2] * perc,
      ];
      this.glow -= 0.03;
    }
  }
}

// --------------------------------------------------------------- Asteroid
export class Asteroid extends SpaceObject {
  tumble = vec3.create();

  constructor(map: import('./map').GameMap, team: Team, position: vec3, model: ModelData, life: Life | null, r: () => number) {
    super(P.STATIC, team, position, model, life, 1);
    this.tumble = randomTumble(r);
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

  destroyObject(gi: GameInstance): void {
    super.destroyObject(gi);
    const r = gi.rc.random;
    const perc = r();
    const map = gi.map;
    if (perc < 0.12) {
      new Addon(gi, this.team, vec3.clone(this.pos), 'adHomingMissile', [1, 0, 0], 'homing', map);
    } else if (perc < 0.24) {
      new Addon(gi, this.team, vec3.clone(this.pos), 'adRepair', [0.2, 1, 0.2], 'life', map);
    } else if (perc < 0.36) {
      new Addon(gi, this.team, vec3.clone(this.pos), 'adShield', [0.4, 0.6, 1], 'shield', map);
    } else if (perc < 0.48) {
      new Addon(gi, this.team, vec3.clone(this.pos), 'adNitro', [1, 0.55, 0], 'nitro', map);
    }
    for (let i = 0; i < 10; i++) {
      new Fragment(map, this, this.model, (Math.floor(r() * 40 + 20) / 100) * this.scale, 500);
    }
  }

  solidDraw(d: DrawCtx): void {
    // Asteroids render unlit-ish? No — same SolidDraw path (light=true).
    super.solidDraw(d);
  }
}

// ------------------------------------------------------------------ Addon
export type AddonKind = 'homing' | 'life' | 'nitro' | 'shield';

export class Addon extends SpaceObject {
  tumble = vec3.create();
  addonKind: AddonKind;
  glowColor: [number, number, number];

  constructor(
    gi: GameInstance, team: Team, position: vec3,
    modelName: string, color: [number, number, number], addonKind: AddonKind,
    map: import('./map').GameMap,
  ) {
    const mdl = gi.rc.model(modelName);
    super(P.STATIC, team, position, mdl ?? gi.rc.model('Wheel')!, null, 1);
    this.addonKind = addonKind;
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

  /** DoThings verbatim (glow + command effect, SpaceShip only). */
  doThings(obj: SpaceObject, _gi: GameInstance): void {
    if (obj instanceof SpaceShip) {
      obj.glow = 1;
      obj.glowColor = [...this.glowColor] as [number, number, number];
      if (this.addonKind === 'homing') obj.homings += 2;
      else if (this.addonKind === 'life') obj.restoreLife();
      else if (this.addonKind === 'nitro') obj.nitro = 3000;
      else if (this.addonKind === 'shield') obj.shield = 5;
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

  solidDraw(_d: DrawCtx): void {
    /* Addon has no opaque pass */
  }

  alphaDraw(d: DrawCtx): void {
    d.draw.drawBillboard(d.rc.tex('flare1'), this.pos[0], this.pos[1], this.pos[2], 7, this.glowColor, 1, d.view, d.proj);
    d.rc.renderer.trackDraws();
    d.draw.drawModel(this.model.gpu, this.model.tex, this.matrix, d.view, d.proj, d.camPos, {
      alpha: this.alpha, emissive: this.glowColor, light: true,
    });
    d.rc.renderer.trackDraws(this.model.gpu.meshes.length);
  }
}

// ------------------------------------------------------------------- Base
export class Base extends SpaceObject {
  constructor(map: import('./map').GameMap, team: Team, position: vec3, model: ModelData, scale: number) {
    super(P.ISTATIC, team, position, model, null, 1);
    this.shield = 1;
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
    /* Base has no opaque pass */
  }

  automaticAction(_gi: GameInstance, _dtMs: number): void {
    /* no-op */
  }

  alphaDraw(d: DrawCtx): void {
    const gl = d.draw.gl;
    // double-sided team-color alpha (verbatim state order, restored after)
    gl.cullFace(gl.FRONT);
    d.draw.drawModel(this.model.gpu, this.model.tex, this.matrix, d.view, d.proj, d.camPos, {
      alpha: 1, emissive: this.team.color, light: true,
    });
    gl.cullFace(gl.BACK);
    d.draw.drawModel(this.model.gpu, this.model.tex, this.matrix, d.view, d.proj, d.camPos, {
      alpha: 1, emissive: this.team.color, light: true,
    });
    d.rc.renderer.trackDraws(this.model.gpu.meshes.length * 2);
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

  /** Flag.AutomaticAction CTF state machine verbatim. */
  automaticAction(gi: GameInstance, dtMs: number): void {
    if (!this.active) return;
    const map = gi.map;
    // score check (TRY COLISIONS WITH OTHER BASES)
    const stack: OctItem[] = [];
    map.octree.sphereSelectInteractive(this.sx, this.sy, this.sz, this.sradius, stack);
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
    // catch check (single & — both sides evaluated)
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
    // lost timer
    if (this.owner === null) {
      this.timeLost += dtMs;
      if (this.timeLost >= this.timeToLive) {
        this.setOwner(this.team.base);
        this.timeLost = 0;
        for (const t of this.team.enemys) t.sounds.push('enemyTeamRecoveredTheFlag');
        for (const t of this.team.allies) t.sounds.push('ourTeamRecoveredTheFlag');
      }
    }
    // follow
    if (this.owner) {
      vec3.copy(this.pos, this.owner.pos);
      map.refreshObject(this);
    }
    // pose
    if (this.owner === null || this.owner instanceof Base) {
      const e = quat.create();
      const d = 180 / Math.PI;
      quat.fromEuler(e, this.tumble[0] * d, this.tumble[1] * d, this.tumble[2] * d);
      quat.multiply(this.rot, this.rot, e);
      quat.normalize(this.rot, this.rot);
      vec3.copy(this.lastPos, this.pos);
      nextPosition(
        {
          pos: this.pos, vel: this.vel, accel: this.accel,
          multiplier: this.multiplier, friction: this.model.friction, physics: this.physics,
        },
        dtMs,
      );
      this.multiplier = this.multiplier + (1 - this.multiplier) * 0.2;
      map.refreshObject(this);
      this.scale = 1;
      this.update();
    } else {
      const e = quat.create();
      ypr(e, this.sideRot, 0, 0);
      quat.multiply(this.rot, this.owner.rot, e);
      quat.normalize(this.rot, this.rot);
      this.sideRot += 0.1;
      this.scale = 0.075;
      this.pos[0] += this.owner.up[0] / 2;
      this.pos[1] += this.owner.up[1] / 2;
      this.pos[2] += this.owner.up[2] / 2;
      this.update();
    }
  }

  solidDraw(d: DrawCtx): void {
    d.draw.drawModel(this.model.gpu, this.model.tex, this.matrix, d.view, d.proj, d.camPos, {
      alpha: 1, emissive: [0, 0, 0], light: true,
    });
    d.rc.renderer.trackDraws(this.model.gpu.meshes.length);
  }

  alphaDraw(d: DrawCtx): void {
    const gl = d.draw.gl;
    gl.cullFace(gl.FRONT);
    d.draw.drawModel(this.model.gpu, this.model.tex, this.matrix, d.view, d.proj, d.camPos, {
      alpha: 0.2, emissive: this.team.color, light: true,
    });
    gl.cullFace(gl.BACK);
    d.draw.drawModel(this.model.gpu, this.model.tex, this.matrix, d.view, d.proj, d.camPos, {
      alpha: 0.2, emissive: this.team.color, light: true,
    });
    d.rc.renderer.trackDraws(this.model.gpu.meshes.length * 2);
    d.draw.drawBillboard(
      d.rc.tex('flare1'), this.pos[0], this.pos[1], this.pos[2],
      this.sradius * 1.5, [1, 1, 1], 1, d.view, d.proj,
    );
    d.rc.renderer.trackDraws();
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
    gi.map.allBullets.unshift({ obj: this, elapsed: 0, max: ttl });
    vec3.scale(this.accel, this.dir, this.physics.accelMax);
    vec3.scale(this.vel, this.dir, this.physics.velMax);
  }

  automaticAction(gi: GameInstance, dtMs: number): void {
    if (!this.active) return;
    vec3.copy(this.lastPos, this.pos);
    nextPosition(
      {
        pos: this.pos, vel: this.vel, accel: this.accel,
        multiplier: this.multiplier, friction: this.model.friction, physics: this.physics,
      },
      dtMs,
    );
    this.multiplier = this.multiplier + (1 - this.multiplier) * 0.2;
    this.update();
    gi.map.refreshObject(this);
  }

  setBoundingSphere(): void {
    this.sx = (this.pos[0] + this.lastPos[0]) / 2;
    this.sy = (this.pos[1] + this.lastPos[1]) / 2;
    this.sz = (this.pos[2] + this.lastPos[2]) / 2;
    const moved =
      this.pos[0] !== this.lastPos[0] || this.pos[1] !== this.lastPos[1] || this.pos[2] !== this.lastPos[2];
    this.sradius = moved
      ? Math.hypot(
        this.lastPos[0] - this.pos[0], this.lastPos[1] - this.pos[1], this.lastPos[2] - this.pos[2],
      ) / 2
      : 1;
  }

  solidDraw(d: DrawCtx): void {
    d.draw.drawModel(this.model.gpu, this.model.tex, this.matrix, d.view, d.proj, d.camPos, {
      alpha: this.alpha, emissive: [1, 0.55, 0], light: true,
    });
    d.rc.renderer.trackDraws(this.model.gpu.meshes.length);
  }

  alphaDraw(d: DrawCtx): void {
    d.draw.drawBillboard(d.rc.tex('flare1'), this.pos[0], this.pos[1], this.pos[2], 1, [1, 1, 0], 1, d.view, d.proj);
    d.rc.renderer.trackDraws();
  }
}

// Life1 without importing life cycle (same class, local alias to avoid confusion)
// ---------------------------------------------------------- HomingMissile
export class HomingMissile extends Bullet {
  constructor(gi: GameInstance, model: ModelData, launcher: SpaceObject, position: vec3, ttl: number) {
    super(gi, model, launcher, { pos: position, dir: vec3.clone(launcher.dir) }, ttl);
    // re-base with MISSILE physics (super used BULLET)
    this.physics = P.MISSILE;
    this.life = new Life1(500);
    vec3.scale(this.accel, this.dir, this.physics.accelMax);
    vec3.copy(this.vel, launcher.vel);
    this.update();
    gi.map.refreshObject(this);
  }

  createSmoke(gi: GameInstance): void {
    new TimedBillboard(
      gi.map, this.team,
      vec3.fromValues(
        this.pos[0] - this.dir[0] * 3, this.pos[1] - this.dir[1] * 3, this.pos[2] - this.dir[2] * 3,
      ),
      'holoSmoke' + (1 + Math.floor(gi.rc.random() * 7)),
      0.25, 500, 1,
    );
  }

  automaticAction(gi: GameInstance, dtMs: number): void {
    if (!this.active) return;
    if (this.intelligence) this.intelligence.execute();
    this.launchSpan += dtMs;
    this.move(gi, dtMs);
  }

  solidDraw(d: DrawCtx): void {
    d.draw.drawModel(this.model.gpu, this.model.tex, this.matrix, d.view, d.proj, d.camPos, {
      alpha: this.alpha, emissive: [0, 0, 0], light: true,
    });
    d.rc.renderer.trackDraws(this.model.gpu.meshes.length);
  }

  alphaDraw(d: DrawCtx): void {
    const r = this.model.gpu.boundingSphere.radius;
    d.draw.drawBillboard(
      d.rc.tex('flare1'),
      this.pos[0] - this.dir[0] * r, this.pos[1] - this.dir[1] * r, this.pos[2] - this.dir[2] * r,
      1, [1, 0.55, 0], 1, d.view, d.proj,
    );
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
    d.draw.drawModel(this.model.gpu, this.model.tex, this.matrix, d.view, d.proj, d.camPos, {
      alpha: 0.1, emissive: this.team.color, light: true,
    });
    d.rc.renderer.trackDraws(this.model.gpu.meshes.length);
  }
}

// -------------------------------------------------------------------- Ark
export class Ark extends SpaceObject {
  constructor(map: import('./map').GameMap, team: Team, position: vec3, model: ModelData) {
    super(P.STATIC, team, position, model, null, 1);
    this.alpha = 0.2;
    this.color = [0, 0, 0];
    map.insertObject(this);
  }
}

// --------------------------------------------------------------- Billboard
export class Billboard extends Abstract3D {
  pos = vec3.create();
  team: Team;

  get kind(): ObKind {
    return ObKind.Uncollidable;
  }

  constructor(map: import('./map').GameMap, team: Team, position: vec3, scale: number) {
    super(P.EMPTY);
    this.team = team;
    vec3.copy(this.pos, position);
    this.scale = scale;
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
    d.draw.drawBillboard(d.rc.tex('flare1'), this.pos[0], this.pos[1], this.pos[2], this.sradius, [1, 1, 1], 1, d.view, d.proj);
    d.rc.renderer.trackDraws();
  }
}

export class TimedBillboard extends Billboard {
  lifeTime = 0;
  timeToLive: number;
  texAlias: string;

  constructor(
    map: import('./map').GameMap, team: Team, position: vec3,
    texAlias: string, scale: number, timeToLive: number, alpha: number,
  ) {
    super(map, team, position, scale);
    this.alpha = alpha;
    this.lifeTime = 0;
    this.texAlias = texAlias;
    this.timeToLive = timeToLive;
    map.timedBillboards.unshift(this);
  }

  alphaDraw(d: DrawCtx): void {
    const a = clamp(this.alpha - this.lifeTime / this.timeToLive, 0, 1);
    d.draw.drawBillboard(d.rc.tex(this.texAlias), this.pos[0], this.pos[1], this.pos[2], this.sradius, [1, 1, 1], a, d.view, d.proj);
    d.rc.renderer.trackDraws();
  }
}

// --------------------------------------------------------------- Fragment
export class Fragment extends SpaceObject {
  lifeTime = 0;
  timeToLive: number;

  constructor(map: import('./map').GameMap, launcher: SpaceObject, model: ModelData, scale: number, ttl: number) {
    super(P.FRAG, launcher.team, vec3.clone(launcher.pos), model, null, scale);
    this.lifeTime = 0;
    // random direction, velocity 30 (ctor1)
    const r = Math.random() * 2 - 1;
    const r2 = Math.random() * 2 - 1;
    const r3 = Math.random() * 2 - 1;
    const l = Math.hypot(r, r2, r3) || 1;
    vec3.set(this.dir, r / l, r2 / l, r3 / l);
    vec3.set(this.vel, (r / l) * 30, (r2 / l) * 30, (r3 / l) * 30);
    this.update();
    this.timeToLive = ttl;
    map.fragments.unshift(this);
    map.insertObject(this);
  }

  /** Ctor2 shape: whole-model husk (rot+scale copied, velocity zero). */
  static husk(map: import('./map').GameMap, launcher: SpaceObject, model: ModelData, ttl: number): Fragment {
    const f = new Fragment(map, launcher, model, launcher.scale, ttl);
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
    const a = 1 - this.lifeTime / this.timeToLive;
    d.draw.drawModel(this.model.gpu, this.model.tex, this.matrix, d.view, d.proj, d.camPos, {
      alpha: Math.max(0, a), emissive: this.color, light: true,
    });
    d.rc.renderer.trackDraws(this.model.gpu.meshes.length);
  }
}

