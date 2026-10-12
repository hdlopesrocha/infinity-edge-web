// Faithful port of IE3D_API/OcTree.cs.
// Cubic root (size/2 extents), 10% child overlap clamped to parent,
// fragments while X-extent > 48, per-node _count/_interactiveCount,
// prune-on-empty, RefreshObject reinsertion, typed select queries.
// Sim objects register themselves via node refs (obj._octNode).

import { boxVisible, rayBox, raySphere, sphereContainsBox, spheresIntersect } from './frustum';
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
  // world bounding sphere (updated by obj.update())
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
  constructor(min: number[], max: number[], parent: OctNode, index: number);
  constructor(a: number | number[], b?: number[] | OctNode, c?: OctNode | number, d?: number) {
    if (typeof a === 'number') {
      const size = a / 2;
      this.minx = -size; this.miny = -size; this.minz = -size;
      this.maxx = size; this.maxy = size; this.maxz = size;
      this.parent = null;
    } else {
      const min = a, max = b as number[];
      const parent = c as OctNode;
      // 10% overlap, clamped to parent
      const vx = (max[0] - min[0]) * 0.1;
      const vy = (max[1] - min[1]) * 0.1;
      const vz = (max[2] - min[2]) * 0.1;
      this.minx = Math.max(min[0] - vx, parent.minx);
      this.miny = Math.max(min[1] - vy, parent.miny);
      this.minz = Math.max(min[2] - vz, parent.minz);
      this.maxx = Math.min(max[0] + vx, parent.maxx);
      this.maxy = Math.min(max[1] + vy, parent.maxy);
      this.maxz = Math.min(max[2] + vz, parent.maxz);
      this.parent = parent;
      this.index = d as number;
    }
  }

  canFrag(): boolean {
    return this.maxx - this.minx > 48;
  }

  private fragment(index: number): OctNode {
    const cx = (this.minx + this.maxx) / 2;
    const cy = (this.miny + this.maxy) / 2;
    const cz = (this.minz + this.maxz) / 2;
    const mn = this, mx = this;
    switch (index) {
      case 0: return new OctNode([cx, cy, cz], [mx.maxx, mx.maxy, mx.maxz], this, 0);
      case 1: return new OctNode([mn.minx, cy, cz], [cx, mx.maxy, mx.maxz], this, 1);
      case 2: return new OctNode([mn.minx, cy, mn.minz], [cx, mx.maxy, cz], this, 2);
      case 3: return new OctNode([cx, cy, mn.minz], [mx.maxx, mx.maxy, cz], this, 3);
      case 4: return new OctNode([cx, mn.miny, cz], [mx.maxx, cy, mx.maxz], this, 4);
      case 5: return new OctNode([mn.minx, mn.miny, cz], [cx, cy, mx.maxz], this, 5);
      case 6: return new OctNode([mn.minx, mn.miny, mn.minz], [cx, cy, cz], this, 6);
      default: return new OctNode([cx, mn.miny, mn.minz], [mx.maxx, cy, cz], this, 7);
    }
  }

  private boxContainsSphere(sx: number, sy: number, sz: number, r: number): boolean {
    // BoundingBox.Contains(BoundingSphere): sphere fully inside the box.
    return (
      sx - r >= this.minx && sx + r <= this.maxx &&
      sy - r >= this.miny && sy + r <= this.maxy &&
      sz - r >= this.minz && sz + r <= this.maxz
    );
  }

  private static nodeContains(node: OctNode, sx: number, sy: number, sz: number, r: number): boolean {
    return (
      sx - r >= node.minx && sx + r <= node.maxx &&
      sy - r >= node.miny && sy + r <= node.maxy &&
      sz - r >= node.minz && sz + r <= node.maxz
    );
  }

  childContains(sx: number, sy: number, sz: number, r: number): boolean {
    if (!this.canFrag()) return false;
    for (let i = 0; i < 8; i++) {
      const n = this.childs[i] ?? this.fragment(i);
      if (OctNode.nodeContains(n, sx, sy, sz, r)) return true;
    }
    return false;
  }

  insert(obj: OctItem): void {
    let ptr: OctNode = this;
    ptr.count++;
    if (obj.kind === ObKind.Interactive) ptr.interactiveCount++;
    for (;;) {
      let contains = false;
      if (ptr.canFrag()) {
        for (let i = 0; i < 8; i++) {
          const n = ptr.childs[i] ?? ptr.fragment(i);
          if (n.boxContainsSphere(obj.sx, obj.sy, obj.sz, obj.sradius)) {
            ptr.childs[i] = n;
            contains = true;
            ptr = n;
            ptr.count++;
            if (obj.kind === ObKind.Interactive) ptr.interactiveCount++;
            break;
          }
        }
      }
      if (!contains || !ptr.canFrag()) break;
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
    const thisCon = ptr.boxContainsSphere(obj.sx, obj.sy, obj.sz, obj.sradius);
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
      if (
        ch &&
        ch.interactiveCount > 0 &&
        spheresIntersect(sx, sy, sz, r, (ch.minx + ch.maxx) / 2, (ch.miny + ch.maxy) / 2, (ch.minz + ch.maxz) / 2,
          Math.hypot(ch.maxx - ch.minx, ch.maxy - ch.miny, ch.maxz - ch.minz) / 2)
      ) {
        // note: original tests sphere-vs-box; sphere-vs-bounds-sphere is a
        // conservative superset — refine with the exact box test below.
        if (sphereBoxIntersect(sx, sy, sz, r, ch)) ch.sphereSelectInteractive(sx, sy, sz, r, out);
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
