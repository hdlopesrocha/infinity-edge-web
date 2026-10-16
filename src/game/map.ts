// Map 37_T verbatim: stack timer lists, outsider rule (root node + box
// disjoint), first-hit bullets, no shield special-case, walls.

import { vec3, mat4, quat, stringToVec3, getH, getV, ypr, clamp } from '../engine/math';
import { ObKind, OctNode } from '../engine/octree';
import type { OctItem } from '../engine/octree';
import type { DrawCtx } from './objects';
import {
  Abstract3D, Addon, Ark, Asteroid, Base, Billboard, Bullet, Flag, SmokePuff, SpaceObject, SpaceShip, Fragment,
  spawnExplosion,
} from './objects';
import type { AddonKind, SmokeOpts } from './objects';
import { stringToLife } from './life';
import { P } from './physics';
import type { Team } from './team';
import type { GameInstance } from './instance';

export interface LevelObjectDef {
  team: string;
  type: string;
  model: string;
  position: string | null;
  name?: string;
  life?: string;
  amount?: number;
}

export interface BulletTimer {
  obj: Bullet;
  elapsed: number;
  max: number;
}

export interface OutsideTimer {
  obj: SpaceObject;
  elapsed: number;
  max: number;
}

export class GameMap {
  rng: () => number = Math.random;
  octree: OctNode;
  size: number;
  skyName: string;
  allBullets: BulletTimer[] = [];
  respawned: OutsideTimer[] = [];
  timedBillboards: { obj: Billboard; elapsed: number; max: number }[] = [];
  /** Real smoke particles (Perlin density, soft-particle depth fade). */
  smokePuffs: SmokePuff[] = [];
  /** Live fireballs (impacts, collisions, kills). */
  explosions: import('./objects').Explosion[] = [];
  private smokeSeed = 1;
  outsideObjects: OutsideTimer[] = [];
  fragments: { obj: Fragment; elapsed: number; max: number }[] = [];
  path: Ark[] = [];
  visible: Abstract3D[] = [];
  /** King of the System: the sun at the arena centre (decor + landmark). */
  sun: { pos: vec3; radius: number } | null = null;
  /** King of the System: the scoring region (hexagon sphere, light green). */
  region: { pos: vec3; radius: number } | null = null;
  private wallQuads: import('../engine/draw').QuadMesh[] | null = null;

  constructor(skyName: string, size: number) {
    this.skyName = skyName;
    this.size = size;
    this.octree = new OctNode(size);
  }

  insertObject(obj: Abstract3D): void {
    obj.update();
    this.octree.insert(obj as unknown as OctItem);
    obj.active = true;
  }

  /** Spawn one smoke particle (see SmokePuff / SMOKE_FRAG). */
  spawnSmoke(position: vec3, vel: vec3, opts: SmokeOpts): SmokePuff {
    this.smokeSeed = (this.smokeSeed * 1664525 + 1013904223) >>> 0;
    const seed = (this.smokeSeed % 1000) / 37;
    const puff = new SmokePuff(this, position, vel, opts, seed);
    this.smokePuffs.push(puff);
    return puff;
  }

  removeObject(obj: Abstract3D): void {
    this.octree.remove(obj as unknown as OctItem);
    obj.active = false;
  }

  refreshObject(obj: Abstract3D): void {
    obj.update();
    this.octree.refresh(obj as unknown as OctItem);
    if (obj instanceof SpaceObject) this.refreshSpaceObject(obj);
  }

  /** Outsider rule verbatim: at root node AND sphere disjoint from box. */
  private refreshSpaceObject(obj: SpaceObject): void {
    const node = (obj as unknown as OctItem)._octNode;
    const box = this.octree;
    const intersectsBox =
      obj.sx + obj.sradius >= box.minx && obj.sx - obj.sradius <= box.maxx &&
      obj.sy + obj.sradius >= box.miny && obj.sy - obj.sradius <= box.maxy &&
      obj.sz + obj.sradius >= box.minz && obj.sz - obj.sradius <= box.maxz;
    if (node === box && !intersectsBox) {
      if (obj.insideMap === true && obj.physics.objectType !== ObKind.Uncollidable) {
        obj.insideMap = false;
        if (!(obj instanceof Flag)) {
          this.outsideObjects.push({ obj, elapsed: 0, max: 10000 });
        }
      }
    } else {
      obj.insideMap = true;
    }
  }

  randomPosition(): vec3 {
    const border = 20;
    const h = this.size / 2 - border;
    const c = () => Math.floor(this.rng() * (h * 2 + 1)) - h;
    return vec3.fromValues(c(), c(), c());
  }

  positionInside(p: vec3): boolean {
    const h = this.size / 2;
    return !(p[0] < -h || p[1] < -h || p[2] < -h || p[0] > h || p[1] > h || p[2] > h);
  }

  setRotationPath(): void {
    let prev: Ark | null = null;
    for (const ark of this.path) {
      if (prev) {
        const dx = ark.pos[0] - prev.pos[0];
        const dy = ark.pos[1] - prev.pos[1];
        const dz = ark.pos[2] - prev.pos[2];
        const l = Math.hypot(dx, dy, dz) || 1;
        const d = vec3.fromValues(dx / l, dy / l, dz / l);
        ypr(ark.rot, getH(d), getV(d), 0);
        ark.update();
        ypr(prev.rot, getH(d), getV(d), 0);
        prev.update();
      }
      prev = ark;
    }
  }

  parsePosition(str: string | null, team: Team): vec3 {
    if (str == null) return vec3.create();
    if (str === 'random') return this.randomPosition();
    if (str === 'around') return team.base ? team.base.randomAround(this.rng) : vec3.create();
    return stringToVec3(str);
  }

  buildObject(def: LevelObjectDef, gi: GameInstance): SpaceObject | null {
    const team = gi.teams.get(def.team);
    if (!team) return null;
    const pos = this.parsePosition(def.position, team);
    const life = stringToLife(def.life ?? null);
    const modelOf = (n: string) => gi.rc.model(n);
    let obj: SpaceObject | null = null;
    const t = def.type;
    if (t === 'sun') {
      // King of the System landmark: a glowing sphere at the arena centre.
      this.sun = { pos: vec3.clone(pos), radius: def.amount ?? 60 };
      return null;
    }
    if (t === 'region') {
      // King of the System scoring sphere (drawn with the hexagon texture).
      this.region = { pos: vec3.clone(pos), radius: def.amount ?? 300 };
      return null;
    }
    if (t === 'spaceShip') {
      const mdl = modelOf(def.model);
      if (mdl) obj = new SpaceShip(P.SS1, gi, team, pos, mdl, life, modelOf('Base'));
    } else if (t === 'spaceShipRespawn') {
      const mdl = modelOf(def.model);
      if (mdl) obj = new SpaceShip(P.SS1R, gi, team, pos, mdl, life, modelOf('Base'));
    } else if (t === 'ark') {
      const mdl = modelOf(def.model);
      if (mdl) {
        const ark = new Ark(this, team, pos, mdl);
        this.path.push(ark);
        obj = ark;
      }
    } else if (t === 'base') {
      const mdl = modelOf(def.model);
      if (mdl) obj = new Base(this, team, pos, mdl, 1);
    } else if (t === 'flag') {
      const mdl = modelOf(def.model);
      if (mdl && team.base) obj = new Flag(gi, team.base, mdl);
    } else if (t === 'addonHoming' || t === 'addonRepair' || t === 'addonNitro' || t === 'addonShield') {
      const conf: Record<string, { model: string; color: [number, number, number]; kind: AddonKind }> = {
        addonHoming: { model: 'adHomingMissile', color: [1, 0, 0], kind: 'homing' },
        addonRepair: { model: 'adRepair', color: [0.2, 1, 0.2], kind: 'life' },
        addonNitro: { model: 'adNitro', color: [1, 0.55, 0], kind: 'nitro' },
        addonShield: { model: 'adShield', color: [0.4, 0.6, 1], kind: 'shield' },
      };
      const c = conf[t];
      obj = new Addon(gi, team, stringToVec3(def.position), c.model, c.color, c.kind, this);
    } else if (t === 'asteroid') {
      const mdl = modelOf(def.model);
      const qtt = def.amount ?? 1;
      if (mdl) {
        for (let i = 0; i < qtt; i++) {
          new Asteroid(this, team, this.parsePosition(def.position, team), mdl, stringToLife(def.life ?? null));
        }
      }
      obj = null;
    } else if (t === 'miniStar') {
      if (gi.rc.options.billboards) {
        const qtt = def.amount ?? 1;
        const tex = gi.rc.tex('flare1');
        for (let i = 0; i < qtt; i++) {
          new Billboard(this, team, this.parsePosition(def.position, team), tex, 2, 1);
        }
      }
      obj = null;
    } else if (t === 'cloud') {
      if (gi.rc.options.billboards) {
        const qtt = def.amount ?? 1;
        const tex = gi.rc.tex('holoSmoke' + (1 + Math.floor(gi.rc.random() * 7)));
        for (let i = 0; i < qtt; i++) {
          new Billboard(this, team, this.parsePosition(def.position, team), tex, 100, 0.2);
        }
      }
      obj = null;
    }
    if (obj && def.name) gi.objects.set(def.name, obj);
    return obj;
  }

  update(gi: GameInstance, dtMs: number): void {
    const rc = gi.rc;
    // MANAGE RESPAWNS (Stack + Swap equivalent)
    {
      const keep: OutsideTimer[] = [];
      for (const timer of this.respawned) {
        timer.elapsed += dtMs;
        if (timer.elapsed >= timer.max) {
          const obj = timer.obj;
          obj.restoreLife();
          if (obj.team.base) vec3.copy(obj.pos, obj.team.base.randomAround(rc.random));
          // Respawn is a teleport: the new pose is the new history, so the
          // frame does not report the jump from the death spot as motion.
          obj.markPrev();
          vec3.set(obj.vel, 0, 0, 0);
          let foundLookAt = false;
          for (const t of obj.team.enemys) {
            if (t.base) {
              const dx = t.base.pos[0] - obj.pos[0];
              const dy = t.base.pos[1] - obj.pos[1];
              const dz = t.base.pos[2] - obj.pos[2];
              const l = Math.hypot(dx, dy, dz) || 1;
              const d = vec3.fromValues(dx / l, dy / l, dz / l);
              ypr(obj.rot, getH(d), getV(d), 0);
              foundLookAt = true;
              break;
            }
          }
          if (!foundLookAt && obj.team.base) {
            const b = obj.team.base;
            const dx = b.pos[0] - obj.pos[0];
            const dy = b.pos[1] - obj.pos[1];
            const dz = b.pos[2] - obj.pos[2];
            const l = Math.hypot(dx, dy, dz) || 1;
            const d = vec3.fromValues(dx / l, dy / l, dz / l);
            ypr(obj.rot, getH(d), getV(d), 0);
          }
          obj.update();
          this.insertObject(obj);
        } else {
          keep.push(timer);
        }
      }
      this.respawned = keep;
    }
    // SET_COLOR_OF_PATH
    if (this.path.length > 0) {
      this.path[0].alpha = 1;
      this.path[0].color = [0.2, 1, 0.2];
    }
    // MOVE_BULLETS (first hit only, no shield branch)
    {
      const keep: BulletTimer[] = [];
      for (const timer of this.allBullets) {
        const bullet = timer.obj;
        let collide = false;
        timer.elapsed += dtMs;
        bullet.automaticAction(gi, dtMs);
        const collisions: OctItem[] = [];
        const found: SpaceObject[] = [];
        this.octree.sphereSelect(bullet.sx, bullet.sy, bullet.sz, bullet.sradius, collisions);
        for (const o of collisions) {
          if (!(o instanceof SpaceObject)) continue;
          const obj = o;
          if (obj.team !== bullet.launcher.team && !(obj instanceof Ark)) {
            const inter = obj.bulletHit(bullet);
            if (inter !== null) {
              found.push(obj);
              // Impact puff: real smoke burst at the hit point.
              const hp = vec3.fromValues(
                bullet.pos[0] - inter * bullet.dir[0],
                bullet.pos[1] - inter * bullet.dir[1],
                bullet.pos[2] - inter * bullet.dir[2],
              );
              const drift = vec3.create();
              vec3.scale(drift, bullet.dir, 2.5);
              this.spawnSmoke(hp, drift, {
                size0: 0.5, size1: 3.2, life: 900, alpha: 1, turbulence: 0.75,
              });
              // Weapon impact: a small fireball right at the hit point.
              spawnExplosion(this, hp, 1.7, { smoke: 4, life: 520 });
              collide = true;
              break;
            }
          }
        }
        for (const obj of found) {
          obj.receiveDamage(gi, bullet.totalLife(), vec3.clone(bullet.dir), bullet.launcher);
        }
        if (timer.elapsed < timer.max && !collide) keep.push(timer);
        else this.removeObject(bullet);
      }
      this.allBullets = keep;
    }
    // EXPLOSIONS (fireballs expand and fade, then leave the octree)
    {
      const keep: import('./objects').Explosion[] = [];
      for (const ex of this.explosions) {
        if (ex.step(dtMs)) {
          this.refreshObject(ex);
          keep.push(ex);
        } else {
          this.removeObject(ex);
        }
      }
      this.explosions = keep;
    }
    // SMOKE PARTICLES (Perlin-driven puffs: grow, drift, dissolve)
    {
      const keep: SmokePuff[] = [];
      for (const puff of this.smokePuffs) {
        if (puff.step(dtMs)) {
          this.refreshObject(puff);
          keep.push(puff);
        } else {
          this.removeObject(puff);
        }
      }
      this.smokePuffs = keep;
    }
    // MANAGE_SMOKE (legacy sprite billboards: alpha drains per 30 fps frame)
    {
      const keep: { obj: Billboard; elapsed: number; max: number }[] = [];
      for (const timer of this.timedBillboards) {
        const bill = timer.obj;
        timer.elapsed += dtMs;
        if (timer.elapsed < timer.max) {
          // The original drains per fixed 30 fps frame; scale by real dt.
          bill.alpha = clamp(bill.alpha - 0.075 * (dtMs / (1000 / 30)), 0, 1);
          this.refreshObject(bill);
          keep.push(timer);
        } else {
          this.removeObject(bill);
        }
      }
      this.timedBillboards = keep;
    }
    // MANAGE_FRAGMENTS
    {
      const keep: { obj: Fragment; elapsed: number; max: number }[] = [];
      for (const timer of this.fragments) {
        const frag = timer.obj;
        frag.step(dtMs, () => this.refreshObject(frag));
        timer.elapsed += dtMs;
        if (timer.elapsed < timer.max) {
          this.refreshObject(frag);
          keep.push(timer);
        } else {
          this.removeObject(frag);
        }
      }
      this.fragments = keep;
    }
    // MANAGE_OUTSIDERS (only while !insideMap)
    {
      const keep: OutsideTimer[] = [];
      for (const timer of this.outsideObjects) {
        const obj = timer.obj;
        timer.elapsed += dtMs;
        if (!obj.insideMap) {
          if (timer.elapsed < timer.max) {
            keep.push(timer);
          } else {
            obj.destroyObject(gi);
            this.refreshObject(obj);
          }
        }
      }
      this.outsideObjects = keep;
    }
    // AUTOMATIC_ACTION (visible asteroids + addons)
    for (const obj of this.visible) {
      if ((obj instanceof Asteroid || obj instanceof Addon) && obj.active) {
        obj.automaticAction(gi, dtMs);
      }
    }
  }

  draw(d: DrawCtx): void {
    const draw = d.draw;
    const r = d.rc.renderer;
    const items: OctItem[] = [];
    // Hierarchical frustum culling; the rejected-object count is reported in
    // the renderer stats (no allocations, subtree rejects counted in bulk).
    this.octree.frustumSelect(r.frustum, items, r.cullStats);
    r.stats.culled = r.cullStats.culled;
    const list = (items as Abstract3D[]).filter(
      (o) => o.physics.objectType !== ObKind.Uncollidable || o.active,
    );
    // ObjectDistanceComparer is anchored at Zero (verbatim quirk): far-to-near from origin.
    list.sort((a, b) => {
      const da = a.sx * a.sx + a.sy * a.sy + a.sz * a.sz;
      const db = b.sx * b.sx + b.sy * b.sy + b.sz * b.sz;
      return db - da;
    });
    this.visible = list;
    draw.setOpaque();
    for (const o of list) o.solidDraw(d);
    draw.setTransparent();
    for (const o of list) o.alphaDraw(d);
    draw.setOpaque();
    this.drawWalls(d, list.length);
    this.drawSun(d);
    this.drawRegion(d);
  }

  /** King of the System: the sun — a solid core with warm additive shells. */
  private drawSun(d: DrawCtx): void {
    if (!this.sun) return;
    const sphere = d.rc.model('Sky1')?.solid[0] ?? null;
    if (!sphere) return;
    const r = sphere.boundingSphere.radius || 1;
    const s = this.sun.radius / r;
    const m = mat4.create();
    mat4.fromRotationTranslationScale(m, quat.create(), this.sun.pos, vec3.fromValues(s, s, s));
    d.draw.setCull('back');
    d.draw.drawUnlit(sphere, null, m, d.view, d.proj, [1, 0.95, 0.78], 1, m);
    d.rc.renderer.trackDraws(sphere.meshes.length);
    const shells: [number, [number, number, number], number][] = [
      [1.5, [1, 0.86, 0.5], 1.0],
      [2.6, [1, 0.62, 0.24], 0.6],
      [4.2, [1, 0.44, 0.14], 0.32],
    ];
    for (const [scale, color, intensity] of shells) {
      const g = mat4.create();
      mat4.fromRotationTranslationScale(g, quat.create(), this.sun.pos, vec3.fromValues(s * scale, s * scale, s * scale));
      d.draw.drawGlow(g, g, d.view, d.proj, d.camPos, color, intensity, 1.6);
      d.rc.renderer.trackDraws();
    }
  }

  /** King of the System: the scoring region — a light-green hexagon sphere. */
  private drawRegion(d: DrawCtx): void {
    if (!this.region) return;
    const sphere = d.rc.model('Sky1')?.solid[0] ?? null;
    if (!sphere) return;
    const r = sphere.boundingSphere.radius || 1;
    const s = this.region.radius / r;
    const m = mat4.create();
    mat4.fromRotationTranslationScale(m, quat.create(), this.region.pos, vec3.fromValues(s, s, s));
    // Seen from inside and outside (players fly through it), so no culling.
    d.draw.setTransparent();
    d.draw.setCull('none');
    d.draw.drawUnlit(sphere, d.rc.tex('hexagon'), m, d.view, d.proj, [0.5, 1, 0.6], 0.18, m);
    d.rc.renderer.trackDraws(sphere.meshes.length);
    d.draw.setCull('back');
    d.draw.setOpaque();
  }

  private drawWalls(d: DrawCtx, visibleCount: number): void {
    void visibleCount;
    const cam = d.rc.renderer.camera.position;
    const mult = this.size / 2;
    const dist = 64;
    const faces: { dif: number; corners: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]] }[] = [
      { dif: cam[1] + mult, corners: [[-mult, -mult, -mult], [mult, -mult, -mult], [mult, -mult, mult], [-mult, -mult, mult]] },
      { dif: -cam[1] + mult, corners: [[-mult, mult, -mult], [mult, mult, -mult], [mult, mult, mult], [-mult, mult, mult]] },
      { dif: cam[0] + mult, corners: [[-mult, -mult, -mult], [-mult, mult, -mult], [-mult, mult, mult], [-mult, -mult, mult]] },
      { dif: -cam[0] + mult, corners: [[mult, -mult, -mult], [mult, mult, -mult], [mult, mult, mult], [mult, -mult, mult]] },
      { dif: cam[2] + mult, corners: [[-mult, -mult, -mult], [-mult, mult, -mult], [mult, mult, -mult], [mult, -mult, -mult]] },
      { dif: -cam[2] + mult, corners: [[-mult, -mult, mult], [-mult, mult, mult], [mult, mult, mult], [mult, -mult, mult]] },
    ];
    if (!this.wallQuads) {
      this.wallQuads = faces.map((f) => d.draw.createQuad(f.corners[0], f.corners[1], f.corners[2], f.corners[3], mult));
    }
    const tex = d.rc.tex('hexagon');
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      if (f.dif < dist) {
        d.draw.setTransparent();
        d.draw.drawQuad(this.wallQuads[i], tex, d.view, d.proj, [1, 1, 1], clamp(1 - f.dif / dist, 0, 1) * 0.1);
        d.draw.setOpaque();
        d.rc.renderer.trackDraws();
      }
    }
  }
}
