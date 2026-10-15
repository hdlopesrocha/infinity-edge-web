// Intelligence 37_T verbatim.

import { quat, vec3, steerToward, ypr } from '../engine/math';
import { Addon, Base, Flag, SpaceObject as SpaceObjectCls, setAIHomingFactory } from './objects';
import type { Command, HomingMissile, SpaceObject, SpaceShip } from './objects';
import { previewDirection } from './physics';
import type { GameInstance } from './instance';
import type { RC } from './resources';
import type { Control } from './controls';

export type { Command };

/**
 * Steer toward a world *point* (the original AIPoint did
 * `Normalize(target.Position - obj.Position)`; passing the absolute position
 * into the direction normaliser aimed every ship at the direction of the
 * target's position vector — radially out of the origin — which sent bots out
 * of the map and made homing missiles unable to converge).
 */
export function steerTo(obj: SpaceObject, tx: number, ty: number, tz: number, maxAngular: number): void {
  const desired = vec3.fromValues(tx - obj.pos[0], ty - obj.pos[1], tz - obj.pos[2]);
  steerToward(obj.rot, obj.dir, desired, obj.side, maxAngular);
  obj.update();
}

export class AIPoint implements Command {
  constructor(private obj: SpaceObject, private target: SpaceObject) {}

  execute(): void {
    steerTo(this.obj, this.target.pos[0], this.target.pos[1], this.target.pos[2], this.obj.physics.maxAngular);
  }
}

export class AIGoPoint implements Command {
  constructor(private gi: GameInstance, private obj: SpaceObject, private target: SpaceObject) {
    void gi;
  }

  execute(): void {
    new AIPoint(this.obj, this.target).execute();
    vec3.scale(this.obj.accel, this.obj.dir, this.obj.physics.accelMax);
    const dx = this.obj.pos[0] - this.target.pos[0];
    const dy = this.obj.pos[1] - this.target.pos[1];
    const dz = this.obj.pos[2] - this.target.pos[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 32) {
      vec3.scale(this.obj.accel, this.obj.accel, Math.max(0.01, Math.min(0.3, dist / 32)));
    }
    this.obj.update();
  }
}

export class AIGoRandom implements Command {
  target = vec3.create();

  constructor(private gi: GameInstance, private obj: SpaceObject) {
    vec3.copy(this.target, gi.map.randomPosition());
  }

  execute(): void {
    steerTo(this.obj, this.target[0], this.target[1], this.target[2], this.obj.physics.maxAngular);
    this.obj.update();
    const dx = this.target[0] - this.obj.pos[0];
    const dy = this.target[1] - this.obj.pos[1];
    const dz = this.target[2] - this.obj.pos[2];
    if (Math.hypot(dx, dy, dz) > 32) {
      vec3.scale(this.obj.accel, this.obj.dir, this.obj.physics.accelMax);
    } else {
      vec3.copy(this.target, this.gi.map.randomPosition());
    }
    this.obj.update();
    new AIFreePath(this.gi, this.obj, 64).execute();
  }
}

export class AIGoSphere implements Command {
  constructor(
    private gi: GameInstance, private obj: SpaceObject,
    private target: SpaceObject, private radius: number,
  ) {}

  execute(): void {
    new AIPoint(this.obj, this.target).execute();
    vec3.scale(this.obj.accel, this.obj.dir, this.obj.physics.accelMax);
    const dx = this.target.pos[0] - this.obj.pos[0];
    const dy = this.target.pos[1] - this.obj.pos[1];
    const dz = this.target.pos[2] - this.obj.pos[2];
    if (Math.hypot(dx, dy, dz) > this.radius) {
      vec3.scale(this.obj.accel, this.obj.dir, this.obj.physics.accelMax);
    } else {
      vec3.set(this.obj.accel, 0, 0, 0);
    }
    this.obj.update();
    new AIFreePath(this.gi, this.obj, 64).execute();
  }
}

export class AIOffensive implements Command {
  executed = false;
  private target: SpaceObject | null = null;

  constructor(private gi: GameInstance, private obj: SpaceObject, private radius: number) {}

  execute(): void {
    this.executed = false;
    if (this.obj.canLaunchBullet()) {
      const found: SpaceObject[] = [];
      this.gi.map.octree.sphereSelectInteractive(
        this.obj.sx, this.obj.sy, this.obj.sz, this.radius, found as unknown as import('../engine/octree').OctItem[],
      );
      this.target = null;
      for (const t of found) {
        if (!(t instanceof Base) && !(t instanceof Flag) && this.obj.team.enemys.includes(t.team)) {
          this.target = t;
          break;
        }
      }
    }
    if (this.target) {
      this.executed = true;
      new AIGoPoint(this.gi, this.obj, this.target).execute();
      if (this.obj.canLaunchBullet()) {
        const dir = vec3.create();
        previewDirection(dir, this.obj.pos, this.obj.dir, this.target.pos, this.target.vel);
        this.obj.launchBullet(this.gi, dir);
      }
    }
  }
}

export class AIFreePath implements Command {
  constructor(private gi: GameInstance, private obj: SpaceObject, private radius: number) {}

  execute(): void {
    if (!this.obj.canLaunchBullet()) return;
    const found: SpaceObject[] = [];
    const d = this.obj.dir;
    this.gi.map.octree.raySelect(
      this.obj.pos[0], this.obj.pos[1], this.obj.pos[2], d[0], d[1], d[2],
      this.radius, found as unknown as import('../engine/octree').OctItem[],
    );
    for (const o of found) {
      if (o.team !== this.obj.team) {
        this.obj.launchBullet(this.gi, this.obj.dir);
        break;
      }
    }
  }
}

export class AIFollow implements Command {
  private aio: AIOffensive;

  constructor(
    private gi: GameInstance, private obj: SpaceObject,
    private who: SpaceObject, offensiveRadius: number, private targetRadius: number,
  ) {
    this.aio = new AIOffensive(gi, obj, offensiveRadius);
  }

  execute(): void {
    this.aio.execute();
    if (!this.aio.executed) {
      if (this.obj.flag && this.obj.team.base) {
        new AIGoPoint(this.gi, this.obj, this.obj.team.base).execute();
      } else {
        new AIGoSphere(this.gi, this.obj, this.who, this.targetRadius).execute();
      }
    }
  }
}

export class AIFlagCap implements Command {
  private aio: AIOffensive;

  constructor(private gi: GameInstance, private obj: SpaceObject, offensiveRadius: number) {
    this.aio = new AIOffensive(gi, obj, offensiveRadius);
  }

  execute(): void {
    this.aio.execute();
    if (!this.aio.executed) {
      let target: Flag | null = null;
      for (const t of this.obj.team.enemys) {
        if (t.flag) target = t.flag;
      }
      if (target) {
        const owner = target.getOwner();
        if (owner === null || owner.team !== this.obj.team) {
          new AIGoPoint(this.gi, this.obj, target).execute();
        } else if (owner === this.obj) {
          if (this.obj.team.base) new AIGoPoint(this.gi, this.obj, this.obj.team.base).execute();
        } else {
          if (target.team.base) new AIGoPoint(this.gi, this.obj, target.team.base).execute();
        }
      }
    }
  }
}

export class AIGoRandomOffensive implements Command {
  private goOffensive: AIOffensive;
  private goRandom: AIGoRandom;

  constructor(private gi: GameInstance, private obj: SpaceObject) {
    this.goOffensive = new AIOffensive(gi, obj, 128);
    this.goRandom = new AIGoRandom(gi, obj);
  }

  execute(): void {
    if (this.obj.flag) {
      new AIFlagCap(this.gi, this.obj, 128).execute();
    } else {
      this.goOffensive.execute();
      if (!this.goOffensive.executed) this.goRandom.execute();
    }
  }
}

export class AIBreak implements Command {
  intelligence: Command;
  private dummy: AIGoRandom;
  private intel = true;
  private timeMs = 0;
  private waitOffset = 0;

  constructor(private gi: GameInstance, obj: SpaceObject, intelligence: Command) {
    this.intelligence = intelligence;
    this.dummy = new AIGoRandom(gi, obj);
  }

  execute(): void {
    this.timeMs += this.gi.dtMs;
    const seconds = Math.floor(this.timeMs / 1000) % 60;
    const r = this.gi.rc.random;
    if (this.intel) {
      this.intelligence.execute();
      if (seconds >= 10 + this.waitOffset) {
        this.waitOffset = Math.floor(r() * 5);
        this.timeMs = 0;
        this.intel = !this.intel;
      }
    } else {
      this.dummy.execute();
      if (seconds >= 5 + this.waitOffset) {
        this.waitOffset = Math.floor(r() * 10);
        this.timeMs = 0;
        this.intel = !this.intel;
      }
    }
  }
}

export class AIHoming implements Command {
  constructor(
    private gi: GameInstance, private obj: SpaceObject, private target: SpaceObject | null,
  ) {}

  execute(): void {
    const o = this.obj;
    if (this.target && this.target.active) {
      // Intercept, not pure pursuit: the missile travels at 1024 u/s while the
      // ships do 64, so aiming at the target's *current* position (what the 2013
      // AIHoming did) orbits it forever — at Physics.MISSILE.maxAngular
      // (0.1 rad/frame) the turn radius is ~170 units, wider than the miss
      // distance, and every shot flies past. Aim at the intercept point (solved
      // iteratively like a gun lead) and turn hard enough to follow it.
      const t = this.target;
      const speed = o.physics.velMax || 1;
      let lead = 0;
      for (let i = 0; i < 3; i++) {
        const px = t.pos[0] + t.vel[0] * lead - o.pos[0];
        const py = t.pos[1] + t.vel[1] * lead - o.pos[1];
        const pz = t.pos[2] + t.vel[2] * lead - o.pos[2];
        lead = Math.hypot(px, py, pz) / speed;
      }
      const turn = 0.35 * (this.gi.dtMs / (1000 / 60));
      steerTo(
        o,
        t.pos[0] + t.vel[0] * lead, t.pos[1] + t.vel[1] * lead, t.pos[2] + t.vel[2] * lead,
        turn,
      );
    }
    vec3.scale(o.accel, o.dir, o.physics.accelMax);
    o.update();
  }
}

setAIHomingFactory(
  (gi: GameInstance, target: SpaceObject | null, self: HomingMissile) => new AIHoming(gi, self, target),
);

export class AITimeTrial implements Command {
  constructor(private gi: GameInstance, private obj: SpaceObject) {}

  execute(): void {
    if (this.gi.map.path.length > 0) {
      new AIGoPoint(this.gi, this.obj, this.gi.map.path[0]).execute();
    }
  }
}

export class HILocal implements Command {
  warning = false;
  inside = true;

  constructor(
    private gi: GameInstance, private obj: SpaceObject,
    private control: Control, private rc: RC,
  ) {}

  execute(): void {
    const o = this.obj;
    const c = this.control;
    const opts = this.rc.options;
    vec3.scale(o.accel, o.dir, o.physics.accelMax * c.analogAcel.value);
    const q = quat.create();
    ypr(
      q,
      -c.analogStick.value.x * (opts.axisX ? -1 : 1) * (Math.PI / 2),
      -c.analogStick.value.y * (opts.axisY ? -1 : 1) * (Math.PI / 2),
      0,
    );
    quat.multiply(q, o.rot, q);
    const want = vec3.fromValues(0, 0, 1);
    vec3.transformQuat(want, want, q);
    vec3.normalize(want, want);
    const stickLen = Math.hypot(c.analogStick.value.x, c.analogStick.value.y);
    steerTo(o, o.pos[0] + want[0] * 100, o.pos[1] + want[1] * 100, o.pos[2] + want[2] * 100, o.physics.maxAngular * stickLen);
    o.update();
    if (!o.insideMap) {
      if (!this.warning) this.gi.setNotification('leavingFieldOfBattle');
      this.warning = true;
    } else {
      this.warning = false;
    }
    if (o.teleported) {
      o.teleported = false;
      this.gi.setNotification('youWereTeleported');
    }
    this.inside = o.insideMap;
    if (c.fireButton.value && o.canLaunchBullet()) {
      let executed = false;
      const found: SpaceObject[] = [];
      this.gi.map.octree.sphereSelectInteractive(
        o.sx, o.sy, o.sz, opts.distance, found as unknown as import('../engine/octree').OctItem[],
      );
      for (const t of found) {
        if (!(t instanceof Base) && !(t instanceof Flag) && o.team.enemys.includes(t.team)) {
          const dir = vec3.create();
          previewDirection(dir, o.pos, o.dir, t.pos, t.vel);
          o.launchBullet(this.gi, dir);
          executed = true;
          break;
        }
      }
      if (!executed) o.launchBullet(this.gi, o.dir);
    }
    if (c.homingButton.value) o.launchHoming(this.gi);
  }
}

/**
 * Experimental "smart" brain (web addition, opt-in with `?ai=smart`): it keeps
 * the ship's original strategy as its core but layers the tactics the 2013 AI
 * lacks — retreat when badly damaged and break away when an enemy is on its
 * tail. (Addon hunting and weapons live in AIAddonSeek, which wraps it; the
 * shared arena guard keeps everyone inside.)
 */
export class AISmart implements Command {
  private jinkTime = 0;
  private jinkSign = 1;

  constructor(private gi: GameInstance, private obj: SpaceObject, private inner: Command) {}

  execute(): void {
    const o = this.obj;
    const base = o.team.base;
    const life = o.lifePercentage();

    // 1. badly damaged: run home and keep the base between us and the enemy
    if (life < 0.35 && base) {
      new AIGoPoint(this.gi, o, base).execute();
      return;
    }

    // 2. someone on our tail (and we just took fire): break away for a moment
    if (this.evade()) return;

    // 3. otherwise: the ship's own strategy, verbatim
    this.inner.execute();
  }

  /** Barrel away when an enemy sits behind us right after taking damage. */
  private evade(): boolean {
    const o = this.obj;
    if (this.jinkTime > 0) {
      this.jinkTime -= this.gi.dtMs / 1000;
      const side = this.jinkSign >= 0 ? o.side : [-o.side[0], -o.side[1], -o.side[2]];
      steerTo(o, o.pos[0] + o.dir[0] * 200 + side[0] * 160, o.pos[1] + o.dir[1] * 200 + side[1] * 160,
        o.pos[2] + o.dir[2] * 200 + side[2] * 160, o.physics.maxAngular);
      vec3.scale(o.accel, o.dir, o.physics.accelMax);
      o.update();
      return true;
    }
    if (o.hitAge > 1.2) return false;
    const found: SpaceObject[] = [];
    this.gi.map.octree.sphereSelectInteractive(
      o.sx, o.sy, o.sz, 220, found as unknown as import('../engine/octree').OctItem[],
    );
    for (const f of found) {
      if (f === o || f instanceof Base || f instanceof Flag || !(f instanceof SpaceObjectCls)) continue;
      if (!o.team.enemys.includes(f.team) || !f.active) continue;
      const dx = f.pos[0] - o.pos[0], dy = f.pos[1] - o.pos[1], dz = f.pos[2] - o.pos[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      const behind = (dx * o.dir[0] + dy * o.dir[1] + dz * o.dir[2]) / l;
      if (behind < -0.35 && l < 200) {
        this.jinkTime = 0.9;
        this.jinkSign = this.gi.rc.random() < 0.5 ? -1 : 1;
        return this.evade();
      }
    }
    return false;
  }
}

/**
 * Addon hunting + weapons for every AI ship (web addition). The 2013 brains
 * collected addons only by flying through them and never fired the homing
 * missiles they were carrying, so this wrapper keeps the ship's own strategy
 * as the core but, before delegating to it:
 *
 *  - diverts to a nearby addon the ship can actually use (repair when hurt,
 *    nitro when the tank is empty, missiles when low, shield when unshielded),
 *  - launches a homing missile as soon as it has a lock (an enemy ship inside
 *    the launcher's own 256 u / dot > 0.75 seek cone — firing blind would just
 *    throw the missile away, which is what the launch does with no target),
 *  - burns nitro to travel when nothing is close, or to run when badly hurt.
 *
 * Shields and repairs need no decision: picking them up applies them.
 */
export class AIAddonSeek implements Command {
  constructor(private gi: GameInstance, private obj: SpaceShip, private inner: Command) {}

  execute(): void {
    this.useWeapons();
    if (!this.grabAddon()) this.inner.execute();
  }

  private useWeapons(): void {
    const o = this.obj;
    if (o.homings > 0 && this.enemyAhead(256, 0.75)) o.launchHoming(this.gi);
    if (o.nitro > 0 && (!this.enemyAhead(350, -1) || o.lifePercentage() < 0.35)) {
      o.launchNitro(this.gi.dtMs);
    }
  }

  /** Any live enemy inside `range`; with `minDot` also inside the nose cone. */
  private enemyAhead(range: number, minDot: number): boolean {
    const o = this.obj;
    const found: SpaceObject[] = [];
    this.gi.map.octree.sphereSelectInteractive(o.sx, o.sy, o.sz, range, found as unknown as import('../engine/octree').OctItem[]);
    for (const t of found) {
      if (!(t instanceof SpaceObjectCls) || t === o || !t.active) continue;
      if (t instanceof Base || t instanceof Flag) continue;
      if (!o.team.enemys.includes(t.team)) continue;
      if (minDot <= -1) return true;
      const dx = t.pos[0] - o.pos[0];
      const dy = t.pos[1] - o.pos[1];
      const dz = t.pos[2] - o.pos[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      const dot = (o.dir[0] * dx + o.dir[1] * dy + o.dir[2] * dz) / l;
      if (dot > minDot) return true;
    }
    return false;
  }

  /** Steer to the closest addon this ship has a use for. */
  private grabAddon(): boolean {
    const o = this.obj;
    // Addons are ObKind.Environment, so they live in the octree's environment
    // list: sphereSelectInteractive (enemies only) never returns them, the
    // broad sphereSelect (what ship-vs-object collisions use) does.
    const found: SpaceObject[] = [];
    this.gi.map.octree.sphereSelect(o.sx, o.sy, o.sz, 320, found as unknown as import('../engine/octree').OctItem[]);
    let best: Addon | null = null;
    let bestD = Infinity;
    for (const f of found) {
      if (!(f instanceof Addon) || !f.active || !this.wants(f)) continue;
      const d = Math.hypot(f.pos[0] - o.pos[0], f.pos[1] - o.pos[1], f.pos[2] - o.pos[2]);
      if (d < bestD) { bestD = d; best = f; }
    }
    if (!best) return false;
    // A ship carrying the enemy flag runs home; only a repair detours it, and
    // nobody breaks off a knife fight for a pickup.
    if (o.flag && best.addonKind !== 'life') return false;
    if (this.enemyAhead(180, -1)) return false;
    new AIGoPoint(this.gi, o, best).execute();
    return true;
  }

  private wants(a: Addon): boolean {
    const o = this.obj;
    const life = o.lifePercentage();
    if (life < 0.35) return a.addonKind === 'life';
    switch (a.addonKind) {
      case 'life': return life < 0.99;
      case 'nitro': return o.nitro <= 0;
      case 'homing': return o.homings < 4;
      case 'shield': return o.shield <= 0;
      default: return false;
    }
  }
}

/**
 * Wrap every AI ship's brain (web addition). The player's HILocal is left
 * alone, and `?ai=smart` keeps its experimental brain *inside* the wrapper so
 * addon hunting and weapons run even while that brain retreats or evades.
 */
export function upgradeAIShips(gi: GameInstance): void {
  const smart = smartAIRequested();
  for (const o of gi.objects.values()) {
    const ship = o as SpaceShip;
    if (!ship.intelligence || ship.isPlayer) continue;
    const inner = smart ? new AISmart(gi, ship, ship.intelligence) : ship.intelligence;
    ship.intelligence = new AIAddonSeek(gi, ship, inner);
  }
}

/** `?ai=smart` upgrades every AI ship to the AISmart brain. */
export function smartAIRequested(): boolean {
  const hash = typeof window !== 'undefined' ? window.location.hash : '';
  const q = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  try {
    return new URLSearchParams(q).get('ai') === 'smart';
  } catch {
    return false;
  }
}

export function applyAction(gi: GameInstance, name: string, fromId: string, toId: string | null): void {
  const from = gi.objects.get(fromId) as SpaceShip | undefined;
  if (!from) return;
  const to = toId ? (gi.objects.get(toId) as SpaceObject | undefined) : undefined;
  if (name === 'HILocal') {
    from.intelligence = new HILocal(gi, from, gi.control, gi.rc);
    from.isPlayer = true;
  }
  else if (name === 'AIBodyGuard' && to) from.intelligence = new AIBreak(gi, from, new AIFollow(gi, from, to, 128, 32));
  else if (name === 'AIFlagCap') from.intelligence = new AIBreak(gi, from, new AIFlagCap(gi, from, 128));
  else if (name === 'AIFlagProt' && from.team.flag) {
    from.intelligence = new AIBreak(gi, from, new AIFollow(gi, from, from.team.flag, 128, 32));
  } else if (name === 'AISpawnKiller' && to) {
    from.intelligence = new AIBreak(gi, from, new AIFollow(gi, from, to, 128, 32));
  } else if (name === 'AIGoRandomOffensive') {
    from.intelligence = new AIBreak(gi, from, new AIGoRandomOffensive(gi, from));
  }
}
