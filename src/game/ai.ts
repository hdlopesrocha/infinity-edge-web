// Intelligence 37_T verbatim.

import { quat, vec3, steerToward, ypr } from '../engine/math';
import { Base, Flag, setAIHomingFactory } from './objects';
import type { Command, HomingMissile, SpaceObject, SpaceShip } from './objects';
import { previewDirection } from './physics';
import type { GameInstance } from './instance';
import type { RC } from './resources';
import type { Control } from './controls';

export type { Command };

export function steerTo(obj: SpaceObject, tx: number, ty: number, tz: number, maxAngular: number): void {
  steerToward(obj.rot, obj.dir, vec3.fromValues(tx, ty, tz), obj.side, maxAngular);
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
  ) {
    void gi;
  }

  execute(): void {
    if (this.target && this.target.active) {
      new AIPoint(this.obj, this.target).execute();
    }
    vec3.scale(this.obj.accel, this.obj.dir, this.obj.physics.accelMax);
    this.obj.update();
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
    steerTo(o, want[0], want[1], want[2], o.physics.maxAngular * stickLen);
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

export function applyAction(gi: GameInstance, name: string, fromId: string, toId: string | null): void {
  const from = gi.objects.get(fromId) as SpaceShip | undefined;
  if (!from) return;
  const to = toId ? (gi.objects.get(toId) as SpaceObject | undefined) : undefined;
  if (name === 'HILocal') from.intelligence = new HILocal(gi, from, gi.control, gi.rc);
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
