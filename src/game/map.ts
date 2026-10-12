// Map port: object store + octree + full Update (6 regions) + Draw
// (two passes + hexagon walls) + XM_Objects factory + position grammars.

import { vec3, stringToVec3, getH, getV, ypr, clamp } from '../engine/math';
import { ObKind, OctNode } from '../engine/octree';
import type { OctItem } from '../engine/octree';
import { sphereVisible } from '../engine/frustum';
import type { DrawCtx } from './objects';
import {
  Abstract3D, Addon, Ark, Asteroid, Base, Billboard, Bullet, Flag, Fragment,
  Shield, SpaceObject, SpaceShip, TimedBillboard,
} from './objects';
import type { AddonKind } from './objects';
import { stringToLife } from './life';
import { P } from './physics';
import type { Team } from './team';
import type { GameInstance } from './instance';
import type { RC } from './resources';

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
  respawned: SpaceObject[] = [];
  timedBillboards: TimedBillboard[] = [];
  outsideObjects: OutsideTimer[] = [];
  fragments: Fragment[] = [];
  path: Ark[] = [];
  visible: Abstract3D[] = [];
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

  removeObject(obj: Abstract3D): void {
    this.octree.remove(obj as unknown as OctItem);
    obj.active = false;
  }

  refreshObject(obj: Abstract3D): void {
    // Abstract3D overload: update + reinsert check
    obj.update();
    this.octree.refresh(obj as unknown as OctItem);
    if (obj instanceof SpaceObject) this.refreshSpaceObject(obj);
  }

  /** RefreshObject(SpaceObject) verbatim: leaving-map detector. */
  private refreshSpaceObject(obj: SpaceObject): void {
    const node = (obj as unknown as OctItem)._octNode;
    if (node === this.octree) {
      if (obj.insideMap === true && obj.physics.objectType !== ObKind.Uncollidable) {
        obj.insideMap = false;
        if (!(obj instanceof Flag)) {
          this.outsideObjects.unshift({ obj, elapsed: 0, max: 10000 });
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

  /** SetRotationPath verbatim: orient consecutive Ark gates toward next. */
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

  /** GameInstance.StringToVector3 grammar: null/random/around/x|y|z. */
  parsePosition(str: string | null, team: Team): vec3 {
    if (str == null) return vec3.create();
    if (str === 'random') return this.randomPosition();
    if (str === 'around') return team.base ? team.base.randomAround(this.rng) : vec3.create();
    return stringToVec3(str);
  }

  /** XM_Objects factory verbatim (type -> class mapping). */
  buildObject(def: LevelObjectDef, gi: GameInstance): SpaceObject | null {
    const rc = gi.rc;
    void rc;
    const team = gi.teams.get(def.team);
    if (!team) return null;
    const pos = this.parsePosition(def.position, team);
    const life = stringToLife(def.life ?? null);
    const modelOf = (n: string) => rc.model(n);
    let obj: SpaceObject | null = null;
    const t = def.type;
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
          new Asteroid(this, team, this.parsePosition(def.position, team), mdl, stringToLife(def.life ?? null), this.rng);
        }
      }
      obj = null; // asteroid-loop objects never named (original quirk)
    } else if (t === 'miniStar') {
      if (rc.options.billboards) {
        const qtt = def.amount ?? 1;
        for (let i = 0; i < qtt; i++) {
          new Billboard(this, team, this.parsePosition(def.position, team), 2);
        }
      }
      obj = null;
    }
    if (obj && def.name) gi.objects.set(def.name, obj);
    return obj;
  }

  // ------------------------------------------------------------- Update
  update(gi: GameInstance, dtMs: number): void {
    const rc = gi.rc;
    // A. MANAGE RESPAWNS
    for (let i = this.respawned.length - 1; i >= 0; i--) {
      const obj = this.respawned[i];
      obj.waitTime -= dtMs;
      if (obj.waitTime <= 0) {
        obj.restoreLife();
        if (obj.team.base) vec3.copy(obj.pos, obj.team.base.randomAround(rc.random));
        vec3.set(obj.vel, 0, 0, 0);
        let foundLookAt = false;
        for (const t of obj.team.enemys) {
          if (t.base) {
            const dx = t.base.pos[0] - obj.pos[0];
            const dy = t.base.pos[1] - obj.pos[1];
            const dz = t.base.pos[2] - obj.pos[2];
            const l = Math.hypot(dx, dy, dz) || 1;
            ypr(obj.rot, getH(vec3.fromValues(dx / l, dy / l, dz / l)), getV(vec3.fromValues(dx / l, dy / l, dz / l)), 0);
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
          ypr(obj.rot, getH(vec3.fromValues(dx / l, dy / l, dz / l)), getV(vec3.fromValues(dx / l, dy / l, dz / l)), 0);
        }
        obj.update();
        this.insertObject(obj);
        this.respawned.splice(i, 1);
      }
    }
    // B. SET_COLOR_OF_PATH
    if (this.path.length > 0) {
      this.path[0].alpha = 1;
      this.path[0].color = [0.2, 1, 0.2]; // LimeGreen
    }
    // C. MOVE_BULLETS
    for (let i = this.allBullets.length - 1; i >= 0; i--) {
      const timer = this.allBullets[i];
      const bullet = timer.obj;
      let collide = false;
      let damage = true;
      timer.elapsed += dtMs;
      bullet.automaticAction(gi, dtMs);
      const f = gi.renderer.frustum;
      let inView = true;
      for (let k = 0; k < 6; k++) {
        if (f[k * 4] * bullet.sx + f[k * 4 + 1] * bullet.sy + f[k * 4 + 2] * bullet.sz + f[k * 4 + 3] < -bullet.sradius) {
          inView = false;
          break;
        }
      }
      void inView;
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
            const hx = bullet.pos[0] - inter * bullet.dir[0];
            const hy = bullet.pos[1] - inter * bullet.dir[1];
            const hz = bullet.pos[2] - inter * bullet.dir[2];
            new TimedBillboard(
              this, obj.team, vec3.fromValues(hx, hy, hz),
              'holoSmoke' + (1 + Math.floor(rc.random() * 7)), 2, 1000, 1,
            );
            collide = true;
            if (obj.shield > 0) {
              damage = false;
              break;
            }
          }
        }
      }
      if (damage) {
        for (const obj of found) {
          const d = vec3.clone(bullet.dir);
          obj.receiveDamage(gi, bullet.totalLife(), d);
        }
      }
      if (timer.elapsed >= timer.max || collide) {
        this.removeObject(bullet);
        this.allBullets.splice(i, 1);
      }
    }
    // D. MANAGE_SMOKE
    for (let i = this.timedBillboards.length - 1; i >= 0; i--) {
      const bill = this.timedBillboards[i];
      bill.lifeTime += dtMs;
      if (bill.lifeTime < bill.timeToLive) {
        this.refreshObject(bill);
      } else {
        this.removeObject(bill);
        this.timedBillboards.splice(i, 1);
      }
    }
    // E. MANAGE_FRAGMENTS
    for (let i = this.fragments.length - 1; i >= 0; i--) {
      const frag = this.fragments[i];
      vec3.copy(frag.lastPos, frag.pos);
      const m = frag.multiplier;
      void m;
      // NextPosition inline (FRAG physics, friction 1)
      const dt = dtMs / 1000;
      const ax = frag.accel[0] * frag.multiplier - frag.model.friction * frag.vel[0];
      const ay = frag.accel[1] * frag.multiplier - frag.model.friction * frag.vel[1];
      const az = frag.accel[2] * frag.multiplier - frag.model.friction * frag.vel[2];
      frag.vel[0] += ax * dt;
      frag.vel[1] += ay * dt;
      frag.vel[2] += az * dt;
      frag.pos[0] += frag.vel[0] * dt;
      frag.pos[1] += frag.vel[1] * dt;
      frag.pos[2] += frag.vel[2] * dt;
      frag.update();
      frag.lifeTime += dtMs;
      if (frag.lifeTime < frag.timeToLive) {
        this.refreshObject(frag);
      } else {
        this.removeObject(frag);
        this.fragments.splice(i, 1);
      }
    }
    // F. MANAGE_OUTSIDERS
    for (let i = this.outsideObjects.length - 1; i >= 0; i--) {
      const timer = this.outsideObjects[i];
      timer.elapsed += dtMs;
      if (timer.obj.insideMap) {
        this.outsideObjects.splice(i, 1);
      } else if (timer.elapsed >= timer.max) {
        this.outsideObjects.splice(i, 1);
        timer.obj.destroyObject(gi);
        this.refreshObject(timer.obj);
      }
    }
    // G. AUTOMATIC_ACTION (visible asteroids + addons; ships tick in instance)
    for (const obj of this.visible) {
      if ((obj instanceof Asteroid || obj instanceof Addon) && obj.active) {
        obj.automaticAction(gi, dtMs);
      }
    }
  }

  // --------------------------------------------------------------- Draw
  draw(d: DrawCtx): void {
    const draw = d.draw;
    const r = d.rc.renderer;
    // FrustumSelect into fresh far-to-near list
    const items: OctItem[] = [];
    this.octree.frustumSelect(r.frustum, items);
    const cp = r.camera.position;
    // FrustumSelect: only uncollidables require active (verbatim)
    const list = (items as Abstract3D[]).filter(
      (o) => o.physics.objectType !== ObKind.Uncollidable || o.active,
    );
    list.sort((a, b) => {
      const dax = a.sx - cp[0], day = a.sy - cp[1], daz = a.sz - cp[2];
      const dbx = b.sx - cp[0], dby = b.sy - cp[1], dbz = b.sz - cp[2];
      return dbx * dbx + dby * dby + dbz * dbz - (dax * dax + day * day + daz * daz);
    });
    this.visible = list;
    draw.setOpaque();
    for (const o of list) o.solidDraw(d);
    draw.setTransparent();
    for (const o of list) o.alphaDraw(d);
    draw.setOpaque();
    // walls
    this.drawWalls(d);
  }

  private drawWalls(d: DrawCtx): void {
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
    const tex = d.rc.tex('hexagon');
    if (!this.wallQuads) {
      this.wallQuads = faces.map((f) => d.draw.createQuad(f.corners[0], f.corners[1], f.corners[2], f.corners[3], mult));
    }
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      if (f.dif < dist) {
        const a = clamp(1 - f.dif / dist, 0, 1) * 0.1;
        d.draw.setTransparent();
        d.draw.drawQuad(this.wallQuads[i], tex, d.view, d.proj, [1, 1, 1], a);
        d.draw.setOpaque();
        d.rc.renderer.trackDraws();
      }
    }
  }
}
