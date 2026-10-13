// OcTree verbatim: root ±size/2, child halves +10% clamped, frag > 32,
// counts, prune, refresh, typed selects.

import { boxVisible, rayBox, raySphere, spheresIntersect } from './frustum';
import type { FrustumPlanes } from './frustum';

export enum ObKind {
  Uncollidable = 0,
  Environment = 1,
  Interactive = 2,
}

export interface OctItem {
  _octNode: OctNode | null;
  kind: ObKind;
  active: boolean;
  sx: number;
  sy: number;
  sz: number;
  sradius: number;
}

export class OctNode {
  minx: number;
  miny: number;
  minz: number;
  maxx: number;
  maxy: number;
  maxz: number;
  childs: (OctNode | null)[] = [null, null, null, null, null, null, null, null];
  parent: OctNode | null = null;
  index = 0;
  environment: OctItem[] = [];
  uncollidable: OctItem[] = [];
  interactive: OctItem[] = [];
  count = 0;
  interactiveCount = 0;

  constructor(size: number);
  constructor(parent: OctNode, index: number);
  constructor(a: number | OctNode, b?: OctNode | number, c?: number) {
    if (typeof a === 'number') {
      const size = a / 2;
      this.minx = -size; this.miny = -size; this.minz = -size;
      this.maxx = size; this.maxy = size; this.maxz = size;
      this.parent = null;
    } else {
      const parent = a;
      const index = b as number;
      const size = [(parent.maxx - parent.minx) * 0.5, (parent.maxy - parent.miny) * 0.5, (parent.maxz - parent.minz) * 0.5];
      const bit = [(index & 4) !== 0 ? 1 : 0, (index & 2) !== 0 ? 1 : 0, (index & 1) !== 0 ? 1 : 0];
      const mn = [
        parent.minx + bit[0] * size[0],
        parent.miny + bit[1] * size[1],
        parent.minz + bit[2] * size[2],
      ];
      const mx = [mn[0] + size[0], mn[1] + size[1], mn[2] + size[2]];
      this.minx = Math.max(mn[0] - size[0] * 0.1, parent.minx);
      this.miny = Math.max(mn[1] - size[1] * 0.1, parent.miny);
      this.minz = Math.max(mn[2] - size[2] * 0.1, parent.minz);
      this.maxx = Math.min(mx[0] + size[0] * 0.1, parent.maxx);
      this.maxy = Math.min(mx[1] + size[1] * 0.1, parent.maxy);
      this.maxz = Math.min(mx[2] + size[2] * 0.1, parent.maxz);
      this.parent = parent;
      this.index = index;
    }
  }

  canFrag(): boolean {
    return this.maxx - this.minx > 32;
  }

  private fragment(index: number): OctNode {
    return new OctNode(this, index);
  }

  containsSphere(sx: number, sy: number, sz: number, r: number): boolean {
    return (
      sx - r >= this.minx && sx + r <= this.maxx &&
      sy - r >= this.miny && sy + r <= this.maxy &&
      sz - r >= this.minz && sz + r <= this.maxz
    );
  }

  static nodeContains(n: OctNode, sx: number, sy: number, sz: number, r: number): boolean {
    return (
      sx - r >= n.minx && sx + r <= n.maxx &&
      sy - r >= n.miny && sy + r <= n.maxy &&
      sz - r >= n.minz && sz + r <= n.maxz
    );
  }

  childContains(sx: number, sy: number, sz: number, r: number): boolean {
    if (!this.canFrag()) return false;
    for (let i = 0; i < 8; i++) {
      if (OctNode.childBoxContains(this, i, sx, sy, sz, r)) return true;
    }
    return false;
  }

  private static childBoxContains(p: OctNode, i: number, sx: number, sy: number, sz: number, r: number): boolean {
    if (p.childs[i]) return p.childs[i]!.containsSphere(sx, sy, sz, r);
    const size = [(p.maxx - p.minx) * 0.5, (p.maxy - p.miny) * 0.5, (p.maxz - p.minz) * 0.5];
    const bit = [(i & 4) !== 0 ? 1 : 0, (i & 2) !== 0 ? 1 : 0, (i & 1) !== 0 ? 1 : 0];
    const mn = [p.minx + bit[0] * size[0], p.miny + bit[1] * size[1], p.minz + bit[2] * size[2]];
    const mx = [mn[0] + size[0], mn[1] + size[1], mn[2] + size[2]];
    const lox = Math.max(mn[0] - size[0] * 0.1, p.minx);
    const loy = Math.max(mn[1] - size[1] * 0.1, p.miny);
    const loz = Math.max(mn[2] - size[2] * 0.1, p.minz);
    const hix = Math.min(mx[0] + size[0] * 0.1, p.maxx);
    const hiy = Math.min(mx[1] + size[1] * 0.1, p.maxy);
    const hiz = Math.min(mx[2] + size[2] * 0.1, p.maxz);
    return sx - r >= lox && sx + r <= hix && sy - r >= loy && sy + r <= hiy && sz - r >= loz && sz + r <= hiz;
  }

  insert(obj: OctItem): void {
    let ptr: OctNode = this;
    ptr.count++;
    if (obj.kind === ObKind.Interactive) ptr.interactiveCount++;
    for (;;) {
      let contains = false;
      if (ptr.canFrag()) {
        for (let i = 0; i < 8; i++) {
          const has = ptr.childs[i] !== null;
          const ok = has
            ? ptr.childs[i]!.containsSphere(obj.sx, obj.sy, obj.sz, obj.sradius)
            : OctNode.childBoxContains(ptr, i, obj.sx, obj.sy, obj.sz, obj.sradius);
          if (ok) {
            if (!has) ptr.childs[i] = ptr.fragment(i);
            contains = true;
            ptr = ptr.childs[i]!;
            ptr.count++;
            if (obj.kind === ObKind.Interactive) ptr.interactiveCount++;
            break;
          }
        }
      } else break;
      if (!contains) break;
    }
    if (obj.kind === ObKind.Interactive) ptr.interactive.push(obj);
    else if (obj.kind === ObKind.Environment) ptr.environment.push(obj);
    else ptr.uncollidable.push(obj);
    obj._octNode = ptr;
  }

  remove(obj: OctItem): void {
    const ptr = obj._octNode;
    if (!ptr) return;
    removeFrom(ptr, obj);
    obj._octNode = null;
    let p: OctNode | null = ptr;
    while (p) {
      p.count--;
      if (obj.kind === ObKind.Interactive) p.interactiveCount--;
      if (p.count === 0 && p.parent) p.parent.childs[p.index] = null;
      p = p.parent;
    }
  }

  refresh(obj: OctItem): void {
    const ptr = obj._octNode;
    if (!ptr) return;
    const chCon = ptr.childContains(obj.sx, obj.sy, obj.sz, obj.sradius);
    const thisCon = ptr.containsSphere(obj.sx, obj.sy, obj.sz, obj.sradius);
    if (!thisCon || chCon) {
      removeFrom(ptr, obj);
      if (chCon) {
        ptr.count--;
        if (obj.kind === ObKind.Interactive) ptr.interactiveCount--;
        ptr.insert(obj);
      } else {
        let p: OctNode | null = ptr;
        while (p && !OctNode.nodeContains(p, obj.sx, obj.sy, obj.sz, obj.sradius)) {
          p.count--;
          if (obj.kind === ObKind.Interactive) p.interactiveCount--;
          if (p.count === 0 && p.parent) p.parent.childs[p.index] = null;
          p = p.parent;
        }
        if (!p) this.insert(obj);
        else {
          p.count--;
          if (obj.kind === ObKind.Interactive) p.interactiveCount--;
          p.insert(obj);
        }
      }
    }
  }

  frustumSelect(f: FrustumPlanes, out: OctItem[]): void {
    for (const o of this.uncollidable) {
      if (o.active && sphereVisibleFrustum(f, o)) out.push(o);
    }
    for (const o of this.environment) {
      if (sphereVisibleFrustum(f, o)) out.push(o);
    }
    for (const o of this.interactive) {
      if (sphereVisibleFrustum(f, o)) out.push(o);
    }
    for (const ch of this.childs) {
      if (ch && boxVisible(f, ch.minx, ch.miny, ch.minz, ch.maxx, ch.maxy, ch.maxz)) {
        ch.frustumSelect(f, out);
      }
    }
  }

  sphereSelectInteractive(sx: number, sy: number, sz: number, r: number, out: OctItem[]): void {
    for (const o of this.interactive) {
      if (o.active && spheresIntersect(sx, sy, sz, r, o.sx, o.sy, o.sz, o.sradius)) out.push(o);
    }
    for (const ch of this.childs) {
      if (ch && ch.interactiveCount > 0 && sphereBoxIntersect(sx, sy, sz, r, ch)) {
        ch.sphereSelectInteractive(sx, sy, sz, r, out);
      }
    }
  }

  sphereSelect(sx: number, sy: number, sz: number, r: number, out: OctItem[]): void {
    for (const o of this.interactive) {
      if (o.active && spheresIntersect(sx, sy, sz, r, o.sx, o.sy, o.sz, o.sradius)) out.push(o);
    }
    for (const o of this.environment) {
      if (o.active && spheresIntersect(sx, sy, sz, r, o.sx, o.sy, o.sz, o.sradius)) out.push(o);
    }
    for (const ch of this.childs) {
      if (ch && sphereBoxIntersect(sx, sy, sz, r, ch)) ch.sphereSelect(sx, sy, sz, r, out);
    }
  }

  raySelect(
    ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, d: number, out: OctItem[],
  ): void {
    for (const o of this.interactive) {
      const t = raySphere(ox, oy, oz, dx, dy, dz, o.sx, o.sy, o.sz, o.sradius);
      if (o.active && t !== null && t <= d) out.push(o);
    }
    for (const o of this.environment) {
      const t = raySphere(ox, oy, oz, dx, dy, dz, o.sx, o.sy, o.sz, o.sradius);
      if (o.active && t !== null && t <= d) out.push(o);
    }
    for (const ch of this.childs) {
      if (!ch) continue;
      const t = rayBox(ox, oy, oz, dx, dy, dz, ch.minx, ch.miny, ch.minz, ch.maxx, ch.maxy, ch.maxz);
      if (t !== null && t <= d) ch.raySelect(ox, oy, oz, dx, dy, dz, d, out);
    }
  }
}

function removeFrom(ptr: OctNode, obj: OctItem): void {
  const arr =
    obj.kind === ObKind.Interactive
      ? ptr.interactive
      : obj.kind === ObKind.Environment
        ? ptr.environment
        : ptr.uncollidable;
  const i = arr.indexOf(obj);
  if (i >= 0) arr.splice(i, 1);
}

function sphereVisibleFrustum(f: FrustumPlanes, o: OctItem): boolean {
  for (let i = 0; i < 6; i++) {
    if (f[i * 4] * o.sx + f[i * 4 + 1] * o.sy + f[i * 4 + 2] * o.sz + f[i * 4 + 3] < -o.sradius) return false;
  }
  return true;
}

function sphereBoxIntersect(sx: number, sy: number, sz: number, r: number, ch: OctNode): boolean {
  const nx = Math.max(ch.minx, Math.min(sx, ch.maxx));
  const ny = Math.max(ch.miny, Math.min(sy, ch.maxy));
  const nz = Math.max(ch.minz, Math.min(sz, ch.maxz));
  const dx = nx - sx, dy = ny - sy, dz = nz - sz;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

export { boxVisible };
