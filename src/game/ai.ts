// Intelligence port: AIPoint/AIGoPoint/AIGoRandom/AIGoSphere/AIOffensive/
// AIFreePath/AIFollow/AIFlagCap/AIGoRandomOffensive/AIBreak/AIBullet/
// AIHoming/AITimeTrial/HILocal + XM_Actions factories (AIBodyGuard,
// AIFlagProt, AISpawnKiller are AIBreak∘AIFollow compositions, not classes).
// Every radius, threshold, timer, and quirk preserved.

import { quat, vec3, steerToward, ypr } from '../engine/math';
import { Base, Flag, setAIHomingFactory } from './objects';
import type { Command, HomingMissile, SpaceObject } from './objects';
import { P, previewDirection } from './physics';
import type { GameInstance } from './instance';
import type { RC } from './resources';
import type { Control } from './controls';

export type { Command };

/** Shared steering primitive (AIPoint verbatim). */
export function steerTo(obj: SpaceObject, tx: number, ty: number, tz: number, maxAngular: number): void {
  const t = vec3.fromValues(tx, ty, tz);
  const o = vec3.clone(obj.dir);
  steerToward(obj.rot, o, t, obj.side, maxAngular);
  obj.update();
}

// --------------------------------------------------------------- AIPoint
export class AIPoint implements Command {
  constructor(
    private obj: SpaceObject,
    private tx: number, private ty: number, private tz: number,
  ) {}

  execute(): void {
    steerTo(this.obj, this.tx, this.ty, this.tz, this.obj.physics.maxAngular);
  }
}

export function aiPointTo(obj: SpaceObject, target: SpaceObject): AIPoint {
  return new AIPoint(obj, target.pos[0], target.pos[1], target.pos[2]);
}

// ------------------------------------------------------------- AIGoPoint
export class AIGoPoint implements Command {
  constructor(private gi: GameInstance, private obj: SpaceObject, private target: SpaceObject) {
    void gi;
  }

  execute(): void {
    aiPointTo(this.obj, this.target).execute();
    vec3.scale(this.obj.accel, this.obj.dir, this.obj.physics.accelMax);
    const dx = this.obj.pos[0] - this.target.pos[0];
    const dy = this.obj.pos[1] - this.target.pos[1];
    const dz = this.obj.pos[2] - this.target.pos[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 32) {
      const s = Math.max(0.01, Math.min(0.3, dist / 32));
      vec3.scale(this.obj.accel, this.obj.accel, s);
    }
    this.obj.update();
  }
}

// ------------------------------------------------------------ AIGoRandom
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

// ------------------------------------------------------------ AIGoSphere
export class AIGoSphere implements Command {
  constructor(
    private gi: GameInstance, private obj: SpaceObject,
    private target: SpaceObject, private radius: number,
  ) {}

  execute(): void {
    aiPointTo(this.obj, this.target).execute();
    vec3.scale(this.obj.accel, this.obj.dir, this.obj.physics.accelMax);
    const dx = this.target.pos[0] - this.obj.pos[0];
    const dy = this.target.pos[1] - this.obj.pos[1];
    const dz = this.target.pos[2] - this.obj.pos[2];
    if (Math.hypot(dx, dy, dz) <= this.radius) {
      vec3.set(this.obj.accel, 0, 0, 0);
    }
    this.obj.update();
    new AIFreePath(this.gi, this.obj, 64).execute();
  }
}

// ----------------------------------------------------------- AIOffensive
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

// ------------------------------------------------------------ AIFreePath
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

// -------------------------------------------------------------- AIFollow
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
      if (this.obj.flag) {
        const base = this.obj.team.base;
        if (base) new AIGoPoint(this.gi, this.obj, base).execute();
      } else {
        new AIGoSphere(this.gi, this.obj, this.who, this.targetRadius).execute();
      }
    }
  }
}

// ------------------------------------------------------------- AIFlagCap
export class AIFlagCap implements Command {
  private aio: AIOffensive;

  constructor(private gi: GameInstance, private obj: SpaceObject, offensiveRadius: number) {
    this.aio = new AIOffensive(gi, obj, offensiveRadius);
  }

  execute(): void {
    this.aio.execute();
    if (this.aio.executed) return;
    let target: Flag | null = null;
    for (const t of this.obj.team.enemys) {
      if (t.flag) target = t.flag; // last enemy team with a flag wins
    }
    if (!target) return;
    const owner = target.getOwner();
    if (!owner || owner.team !== this.obj.team) {
      new AIGoPoint(this.gi, this.obj, target).execute();
    } else if (owner === this.obj) {
      const base = this.obj.team.base;
      if (base) new AIGoPoint(this.gi, this.obj, base).execute();
    } else {
      const base = target.team.base;
      if (base) new AIGoPoint(this.gi, this.obj, base).execute();
    }
  }
}

// --------------------------------------------------- AIGoRandomOffensive
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

// ---------------------------------------------------------------- AIBreak
export class AIBreak implements Command {
  intelligence: Command;
  private dummy: AIGoRandom;
  private intel = true;
  private timeMs = 0;
  private waitOffset: number;

  constructor(private gi: GameInstance, obj: SpaceObject, intelligence: Command) {
    this.waitOffset = 0;
    this.intel = true;
    this.timeMs = 0;
    this.intelligence = intelligence;
    this.dummy = new AIGoRandom(gi, obj);
  }

  execute(): void {
    this.timeMs += this.gi.dtMs;
    const seconds = Math.floor(this.timeMs / 1000) % 60; // TimeSpan.Seconds component
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

// -------------------------------------------------------------- AIBullet
export class AIBullet implements Command {
  constructor(private gi: GameInstance, private obj: SpaceObject) {}

  execute(): void {
    let target: SpaceObject | null = null;
    let distTarget = 0;
    const found: SpaceObject[] = [];
    this.gi.map.octree.sphereSelectInteractive(
      this.obj.sx, this.obj.sy, this.obj.sz, 8, found as unknown as import('../engine/octree').OctItem[],
    );
    for (const o of found) {
      if (o !== this.obj && o.team !== this.obj.team) {
        if (!target) {
          target = o;
          const dx = this.obj.pos[0] - o.pos[0];
          const dy = this.obj.pos[1] - o.pos[1];
          const dz = this.obj.pos[2] - o.pos[2];
          distTarget = dx * dx + dy * dy + dz * dz;
        } else {
          const dx = this.obj.pos[0] - o.pos[0];
          const dy = this.obj.pos[1] - o.pos[1];
          const dz = this.obj.pos[2] - o.pos[2];
          const distTemp = dx * dx + dy * dy + dz * dz;
          if (distTemp < distTarget) {
            distTarget = distTemp; // (original assigns swapped; equivalent outcome)
            target = o;
          }
        }
      }
    }
    if (target && target.active) {
      steerTo(this.obj, target.pos[0], target.pos[1], target.pos[2], this.obj.physics.maxAngular);
    }
    vec3.scale(this.obj.accel, this.obj.dir, this.obj.physics.accelMax);
    this.obj.update();
  }
}

// -------------------------------------------------------------- AIHoming
export class AIHoming implements Command {
  constructor(
    private gi: GameInstance, private obj: SpaceObject, private target: SpaceObject | null,
  ) {
    void gi;
  }

  execute(): void {
    if (this.target && this.target.active) {
      steerTo(this.obj, this.target.pos[0], this.target.pos[1], this.target.pos[2], this.obj.physics.maxAngular);
    }
    vec3.scale(this.obj.accel, this.obj.dir, this.obj.physics.accelMax);
    this.obj.update();
  }
}

setAIHomingFactory(
  (gi: GameInstance, target: SpaceObject | null, self: HomingMissile) => new AIHoming(gi, self, target),
);

// ----------------------------------------------------------- AITimeTrial
export class AITimeTrial implements Command {
  constructor(private gi: GameInstance, private obj: SpaceObject) {}

  execute(): void {
    if (this.gi.map.path.length > 0) {
      new AIGoPoint(this.gi, this.obj, this.gi.map.path[0]).execute();
    }
  }
}

// --------------------------------------------------------------- HILocal
export class HILocal implements Command {
  warning = false;
  private inside = true;

  constructor(
    private gi: GameInstance,
    private obj: SpaceObject,
    private control: Control,
    private rc: RC,
  ) {}

  execute(): void {
    const o = this.obj;
    const c = this.control;
    const opts = this.rc.options;
    // thrust
    vec3.scale(o.accel, o.dir, o.physics.accelMax * c.analogAcel.value);
    // desired facing: current rot composed with stick yaw/pitch (±pi/2)
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
    steerTo(o, want[0], want[1], want[2], o.physics.maxAngular * stickLen);
    o.update();
    // leaving-field warning + teleport voice
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
    void this.inside;
    // fire: lead first non-Base/non-Flag enemy in _distance, else dumbfire
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

// ------------------------------------------------------- XM_Actions factories
export function applyAction(gi: GameInstance, name: string, fromId: string, toId: string | null): void {
  const from = gi.objects.get(fromId) as SpaceObject | undefined;
  if (!from) return;
  const to = toId ? (gi.objects.get(toId) as SpaceObject | undefined) : undefined;
  const rc = gi.rc;
  if (name === 'HILocal') from.intelligence = new HILocal(gi, from, gi.control, rc);
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
