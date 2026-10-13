// Life1/Life3 verbatim.

import { vec3 } from '../engine/math';

export type DestroyFn = () => void;

export abstract class Life {
  abstract restore(): void;
  abstract receiveDamage(amount: number, direction: vec3, ownerUp: vec3, ownerDir: vec3, destroy: DestroyFn): void;
  abstract percentage(): number;
  abstract total(): number;
}

export class Life1 extends Life {
  maxCenter: number;
  center: number;

  constructor(center: number) {
    super();
    this.maxCenter = center;
    this.center = center;
  }

  restore(): void {
    this.center = this.maxCenter;
  }

  receiveDamage(amount: number, _d: vec3, _u: vec3, _f: vec3, destroy: DestroyFn): void {
    this.center -= amount;
    if (this.center < 0) destroy();
  }

  percentage(): number {
    return this.maxCenter === 0 ? 0 : this.center / this.maxCenter;
  }

  total(): number {
    return this.center;
  }
}

export class Life3 extends Life {
  maxLeft: number;
  maxCenter: number;
  maxRight: number;
  left: number;
  center: number;
  right: number;

  constructor(l: number, c: number, r: number) {
    super();
    this.maxLeft = l;
    this.maxCenter = c;
    this.maxRight = r;
    this.left = l;
    this.center = c;
    this.right = r;
  }

  restore(): void {
    this.left = this.maxLeft;
    this.center = this.maxCenter;
    this.right = this.maxRight;
  }

  receiveDamage(amount: number, direction: vec3, ownerUp: vec3, ownerDir: vec3, destroy: DestroyFn): void {
    const v = vec3.create();
    vec3.cross(v, ownerUp, ownerDir);
    const l = vec3.length(v) || 1;
    const dot = vec3.dot(v, direction) / l;
    if (dot > 0.2 && this.left > 0) {
      this.left -= amount;
      if (this.left < 0) this.center += this.left;
    }
    if (dot < -0.2 && this.right > 0) {
      this.right -= amount;
      if (this.right < 0) this.center += this.right;
    } else {
      this.center -= amount;
    }
    if (this.center <= 0) destroy();
  }

  percentage(): number {
    return this.maxCenter === 0 ? 0 : this.center / this.maxCenter;
  }

  total(): number {
    return this.left + this.center + this.right;
  }
}

export function stringToLife(s: string | null): Life {
  if (s == null) return new Life1(10);
  const words = s.split('|');
  if (words.length === 3) {
    return new Life3(parseInt(words[0], 10), parseInt(words[1], 10), parseInt(words[2], 10));
  }
  return new Life1(parseInt(words[0], 10));
}
