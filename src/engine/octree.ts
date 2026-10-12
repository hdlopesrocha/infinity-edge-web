// Octree spatial partition, port of IE3D_API/OcTree.cs.
// Cubic bounds, fragments while size > 48, 8 children with slight overlap,
// three buckets by ObjectType (mirrors UNC.../ENVIRONMENT/INTERACTIVE split).
// Used for frustum + sphere queries on large maps (CTF: 8000 asteroids).

import { vec3 } from 'gl-matrix';
import type { FrustumPlanes } from './frustum';
import { boxVisible, sphereVisible } from './frustum';

export enum ObType {
  Uncollidable = 0,
  Environment = 1,
  Interactive = 2,
}

export interface SpatialItem {
  id: number;
  type: ObType;
  /** World-space bounding sphere. */
  center: vec3;
  radius: number;
  min: vec3;
  max: vec3;
}

const FRAG_SIZE = 48;
const OVERLAP = 0.05;

export class Octree {
  min: vec3;
  max: vec3;
  center: vec3;
  size: number;
  children: Octree[] | null = null;
  buckets: SpatialItem[][] = [[], [], []];
  count = 0;

  constructor(min: vec3, max: vec3) {
    this.min = vec3.clone(min);
    this.max = vec3.clone(max);
    this.center = vec3.create();
    vec3.add(this.center, min, max);
    vec3.scale(this.center, this.center, 0.5);
    this.size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  }

  private static contains(box: { min: vec3; max: vec3 }, it: SpatialItem): boolean {
    return (
      it.min[0] >= box.min[0] && it.max[0] <= box.max[0] &&
      it.min[1] >= box.min[1] && it.max[1] <= box.max[1] &&
      it.min[2] >= box.min[2] && it.max[2] <= box.max[2]
    );
  }

  private fragment(): void {
    const { min, max, center } = this;
    this.children = [];
    for (let xi = 0; xi < 2; xi++) {
      for (let yi = 0; yi < 2; yi++) {
        for (let zi = 0; zi < 2; zi++) {
          const cmin = vec3.fromValues(
            xi === 0 ? min[0] : center[0] - this.size * OVERLAP,
            yi === 0 ? min[1] : center[1] - this.size * OVERLAP,
            zi === 0 ? min[2] : center[2] - this.size * OVERLAP,
          );
          const cmax = vec3.fromValues(
            xi === 0 ? center[0] + this.size * OVERLAP : max[0],
            yi === 0 ? center[1] + this.size * OVERLAP : max[1],
            zi === 0 ? center[2] + this.size * OVERLAP : max[2],
          );
          // Clamp to parent bounds.
          for (let k = 0; k < 3; k++) {
            if (cmin[k] < min[k]) cmin[k] = min[k];
            if (cmax[k] > max[k]) cmax[k] = max[k];
          }
          this.children.push(new Octree(cmin, cmax));
        }
      }
    }
  }

  insert(it: SpatialItem): void {
    if (this.children) {
      for (const ch of this.children) {
        if (Octree.contains(ch, it)) {
          ch.insert(it);
          this.count++;
          return;
        }
      }
      this.buckets[it.type].push(it);
      this.count++;
      return;
    }
    this.buckets[it.type].push(it);
    this.count++;
    if (this.size > FRAG_SIZE && this.count > 12) {
      this.fragment();
      const all = [...this.buckets[0], ...this.buckets[1], ...this.buckets[2]];
      this.buckets = [[], [], []];
      const prev = this.count;
      this.count = 0;
      for (const o of all) this.insert(o);
      this.count = prev; // keep total consistent
    }
  }

  remove(id: number): boolean {
    for (const b of this.buckets) {
      const i = b.findIndex((o) => o.id === id);
      if (i >= 0) {
        b.splice(i, 1);
        this.count--;
        return true;
      }
    }
    if (this.children) {
      for (const ch of this.children) {
        if (ch.remove(id)) {
          this.count--;
          // Prune empty children like OcTree.Remove.
          if (this.children.every((c) => c.count === 0)) this.children = null;
          return true;
        }
      }
    }
    return false;
  }

  /** Reinsert helper when an object moved bounds (OcTree.Refresh). */
  refresh(it: SpatialItem, updateBounds: () => void): void {
    updateBounds();
    // Simple correct approach: remove + reinsert from root.
    this.remove(it.id);
    this.insert(it);
  }

  frustumSelect(f: FrustumPlanes, out: SpatialItem[], types = [0, 1, 2]): void {
    // Coarse box test for this node.
    if (!boxVisible(f, this.min, this.max)) return;
    for (const t of types) {
      const b = this.buckets[t];
      for (let i = 0; i < b.length; i++) {
        const it = b[i];
        if (sphereVisible(f, it.center, it.radius)) out.push(it);
      }
    }
    if (this.children) {
      for (const ch of this.children) ch.frustumSelect(f, out, types);
    }
  }

  sphereSelect(center: vec3, radius: number, out: SpatialItem[]): void {
    // Node sphere vs query sphere (coarse AABB check first).
    const cx = Math.max(this.min[0], Math.min(center[0], this.max[0]));
    const cy = Math.max(this.min[1], Math.min(center[1], this.max[1]));
    const cz = Math.max(this.min[2], Math.min(center[2], this.max[2]));
    const dx = cx - center[0];
    const dy = cy - center[1];
    const dz = cz - center[2];
    if (dx * dx + dy * dy + dz * dz > radius * radius) return;
    for (const b of this.buckets) {
      for (const it of b) {
        const ddx = it.center[0] - center[0];
        const ddy = it.center[1] - center[1];
        const ddz = it.center[2] - center[2];
        const rr = radius + it.radius;
        if (ddx * ddx + ddy * ddy + ddz * ddz <= rr * rr) out.push(it);
      }
    }
    if (this.children) for (const ch of this.children) ch.sphereSelect(center, radius, out);
  }

  clear(): void {
    this.buckets = [[], [], []];
    this.children = null;
    this.count = 0;
  }
}
