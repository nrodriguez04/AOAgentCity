import * as THREE from "three";
import type { CityModel } from "./cityGen";

// Occlusion-aware camera framing for fly-to: several candidate viewpoints
// around a tower are scored by how many sight lines to it are blocked by the
// city's buildings, preferring the default south-east angle.

export interface FramingSubject {
  id: string;
  /** 0..1: where on the tower to aim (e.g. high for a crown or LED band). */
  aim?: number;
  x: number;
  z: number;
  /** Visible height of the tower. */
  height: number;
  /** Half the footprint diagonal. */
  radius: number;
}

export interface Framing {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

interface Occluder {
  id: string | null;
  min: THREE.Vector3;
  max: THREE.Vector3;
}

export class FramingPlanner {
  private readonly occluders: Occluder[] = [];

  constructor(city: CityModel | null, heroes: (FramingSubject & { w: number; d: number })[]) {
    if (city) {
      for (const t of city.tiers) {
        if (Math.abs(t.cx) > 80 || t.y0 + t.h < 2.5) continue;
        this.occluders.push({
          id: null,
          min: new THREE.Vector3(t.cx - t.w / 2, t.y0, t.cz - t.d / 2),
          max: new THREE.Vector3(t.cx + t.w / 2, t.y0 + t.h, t.cz + t.d / 2),
        });
      }
    }
    for (const h of heroes) {
      const r = Math.max(h.w, h.d) / 2;
      this.occluders.push({
        id: h.id,
        min: new THREE.Vector3(h.x - r, 0, h.z - r),
        max: new THREE.Vector3(h.x + r, h.height, h.z + r),
      });
    }
  }

  private blocked(a: THREE.Vector3, b: THREE.Vector3, skip: string): boolean {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    dir.divideScalar(len);
    const inv = new THREE.Vector3(1 / dir.x, 1 / dir.y, 1 / dir.z);
    for (const o of this.occluders) {
      if (o.id === skip) continue;
      // Slab test.
      let tmin = 0;
      let tmax = len;
      let hit = true;
      for (const axis of ["x", "y", "z"] as const) {
        const t1 = (o.min[axis] - a[axis]) * inv[axis];
        const t2 = (o.max[axis] - a[axis]) * inv[axis];
        const lo = Math.min(t1, t2);
        const hi = Math.max(t1, t2);
        tmin = Math.max(tmin, lo);
        tmax = Math.min(tmax, hi);
        if (tmin > tmax) {
          hit = false;
          break;
        }
      }
      if (hit && tmax > 0.5 && tmin < len - 0.5) return true;
    }
    return false;
  }

  plan(s: FramingSubject, fit = 1): Framing {
    const h = Math.max(4, s.height);
    const tall = h > 22;
    const aim = s.aim ?? (tall ? 0.5 : 0.42);
    const target = new THREE.Vector3(s.x, Math.min(h * aim, 32), s.z);
    const dist = THREE.MathUtils.clamp(h * (tall ? 1.42 : 1.2) + s.radius * 1.6 + 14, 24, 100) * fit;
    const preferredAz = THREE.MathUtils.degToRad(32);
    const azimuths = [32, 12, 52, -10, 72, -32, 95, -55, 125, 160, -140].map(THREE.MathUtils.degToRad);
    const elevations = (tall ? [21, 30, 40] : [28, 38, 50]).map(THREE.MathUtils.degToRad);
    const samples = (tall ? [0.18, 0.4, 0.62, 0.85] : [0.3, 0.6, 0.9]).map((f) => new THREE.Vector3(s.x, h * f, s.z));
    let best: { score: number; pos: THREE.Vector3 } | null = null;
    for (const az of azimuths) {
      for (const el of elevations) {
        const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
        const pos = target.clone().addScaledVector(dir, dist);
        let blocked = 0;
        for (const p of samples) if (this.blocked(pos, p, s.id)) blocked++;
        const score = blocked * 10 + Math.abs(az - preferredAz) * 1.4 + (el - elevations[0]!) * 2.2;
        if (!best || score < best.score) best = { score, pos };
      }
      if (best && best.score < 0.5) break;
    }
    return { position: best!.pos, target };
  }
}
