// Street furniture and traffic paths derived from the grid in layout.ts.

import {
  AVENUE_HALF,
  AVENUE_XS,
  BROADWAY,
  BROADWAY_HALF,
  ISLAND,
  SHORE_ROAD,
  STREET_HALF,
  STREET_ZS,
  TIMES_SQUARE,
  avenueExists,
  inPark,
  inTimesSquare,
  pointInPolygon,
  shoreDistance,
  type Vec2,
} from "./layout";
import { mulberry32, range } from "./random";

export interface Lamp {
  x: number;
  z: number;
  /** Arm direction (unit vector on the ground plane), pointing over the road. */
  dx: number;
  dz: number;
  /** 0 = cobra-head street lamp, 1 = short park lamp. */
  kind: 0 | 1;
  /** On the waterfront (its light reflects in the river). */
  shore?: boolean;
}

export interface Pool {
  x: number;
  z: number;
  r: number;
  intensity: number;
}

export interface LaneSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Average spacing between cars at full density. */
  spacing: number;
  speed: number;
  /** Bridge deck height: cars ramp up over the first and last 9 units of the lane. */
  deckY?: number;
}

const LAMP_INSET = 0.16;
const SOUTH_LIMIT = 92;

function nearStreet(z: number, pad: number): boolean {
  for (const sz of STREET_ZS) if (Math.abs(z - sz) < STREET_HALF + pad) return true;
  return false;
}

function nearAvenue(x: number, pad: number): boolean {
  for (const ax of AVENUE_XS) if (Math.abs(x - ax) < AVENUE_HALF + pad) return true;
  return false;
}

function onLand(x: number, z: number, minShore: number): boolean {
  return z < SOUTH_LIMIT && shoreDistance(x, z) > minShore;
}

/** Points along the shore polyline offset inland by `d`, from north to south. */
function shoreOffset(side: "west" | "east", d: number, step = 2.5): Vec2[] {
  // Take the island outline vertices of one side (north -> south), densify, offset inward.
  const n = ISLAND.length;
  const pts: Vec2[] = [];
  if (side === "west") {
    for (let i = 0; i < n; i++) {
      const p = ISLAND[i]!;
      if (p[0] < 0 && p[1] < 100) pts.push(p);
    }
  } else {
    for (let i = n - 1; i >= 0; i--) {
      const p = ISLAND[i]!;
      if (p[0] > 0 && p[1] < 96) pts.push(p);
    }
  }
  const dense: Vec2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.ceil(len / step));
    for (let j = 0; j < k; j++) dense.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  }
  dense.push(pts[pts.length - 1]!);
  const out: Vec2[] = [];
  for (let i = 0; i < dense.length; i++) {
    const prev = dense[Math.max(0, i - 1)]!;
    const next = dense[Math.min(dense.length - 1, i + 1)]!;
    let tx = next[0] - prev[0];
    let tz = next[1] - prev[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    // Inward normal: whichever perpendicular lands on the island.
    let nx = -tz;
    let nz = tx;
    const p = dense[i]!;
    if (!pointInPolygon(p[0] + nx * 1.5, p[1] + nz * 1.5, ISLAND)) {
      nx = -nx;
      nz = -nz;
    }
    const q: Vec2 = [p[0] + nx * d, p[1] + nz * d];
    if (q[1] > -150 && q[1] < SOUTH_LIMIT - 1) out.push(q);
  }
  return out;
}

export interface StreetModel {
  lamps: Lamp[];
  pools: Pool[];
  lanes: LaneSeg[];
  vents: Vec2[];
}

export function generateStreets(): StreetModel {
  const rng = mulberry32(4242);
  const lamps: Lamp[] = [];
  const pools: Pool[] = [];
  const addLamp = (x: number, z: number, dx: number, dz: number, kind: 0 | 1 = 0, poolScale = 1, shore = false) => {
    lamps.push({ x, z, dx, dz, kind, shore });
    const reach = kind === 0 ? 0.62 : 0.05;
    pools.push({
      x: x + dx * reach,
      z: z + dz * reach,
      r: (kind === 0 ? range(rng, 1.45, 1.75) : range(rng, 0.85, 1.05)) * poolScale,
      intensity: range(rng, 0.8, 1.1),
    });
  };

  // Avenue lamps, staggered on both sides.
  for (const ax of AVENUE_XS) {
    for (const side of [-1, 1] as const) {
      const x = ax + side * (AVENUE_HALF + LAMP_INSET);
      for (let z = -150 + (side > 0 ? 1.75 : 0); z < SOUTH_LIMIT; z += 3.5) {
        if (nearStreet(z, 0.45)) continue;
        if (!avenueExists(ax, z)) continue;
        if (inPark(x, z, -0.2)) continue;
        if (!onLand(x, z, SHORE_ROAD.outer + 0.3)) continue;
        addLamp(x, z, -side, 0);
      }
    }
  }
  // Street lamps.
  for (const sz of STREET_ZS) {
    for (const side of [-1, 1] as const) {
      const z = sz + side * (STREET_HALF + LAMP_INSET);
      for (let x = -70 + (side > 0 ? 2.3 : 0); x < 70; x += 4.6) {
        if (nearAvenue(x, 0.5)) continue;
        if (inPark(x, z, -0.2)) continue;
        if (inTimesSquare(x, z, 0.2)) continue;
        if (!onLand(x, z, SHORE_ROAD.outer + 0.3)) continue;
        addLamp(x, z, 0, -side);
      }
    }
  }
  // Broadway lamps.
  for (let i = 0; i < BROADWAY.length - 1; i++) {
    const a = BROADWAY[i]!;
    const b = BROADWAY[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const tx = (b[0] - a[0]) / len;
    const tz = (b[1] - a[1]) / len;
    for (const side of [-1, 1] as const) {
      const nx = -tz * side;
      const nz = tx * side;
      for (let s = side > 0 ? 1.75 : 0; s < len; s += 3.5) {
        const x = a[0] + tx * s + nx * (BROADWAY_HALF + LAMP_INSET);
        const z = a[1] + tz * s + nz * (BROADWAY_HALF + LAMP_INSET);
        if (nearStreet(z, 0.4) || nearAvenue(x, 0.4)) continue;
        if (!onLand(x, z, SHORE_ROAD.outer + 0.3) || inPark(x, z)) continue;
        addLamp(x, z, -nx, -nz);
      }
    }
  }
  // Shore drives and the waterfront promenade.
  for (const side of ["west", "east"] as const) {
    const inner = shoreOffset(side, SHORE_ROAD.outer + 0.18, 3.6);
    for (const p of inner) {
      // The arm reaches back over the drive, toward the river (down the shore-distance gradient).
      const gx = shoreDistance(p[0] + 0.1, p[1]) - shoreDistance(p[0] - 0.1, p[1]);
      const gz = shoreDistance(p[0], p[1] + 0.1) - shoreDistance(p[0], p[1] - 0.1);
      const gl = Math.hypot(gx, gz) || 1;
      addLamp(p[0], p[1], -gx / gl, -gz / gl, 0, 0.72, true);
    }
    const prom = shoreOffset(side, 0.45, 4.6);
    for (const p of prom) addLamp(p[0], p[1], 0, 0, 1, 0.9, true);
  }

  // --- Traffic lanes ---
  const lanes: LaneSeg[] = [];
  const addLane = (ax: number, az: number, bx: number, bz: number, spacing: number, speed: number) => {
    if (Math.hypot(bx - ax, bz - az) < 2) return;
    lanes.push({ ax, az, bx, bz, spacing, speed });
  };
  AVENUE_XS.forEach((ax, i) => {
    const south = i % 2 === 0;
    // Find the avenue's extent on land: from the far north to where it meets the shore road.
    let zEnd = -150;
    for (let z = -150; z < SOUTH_LIMIT; z += 0.5) {
      if (shoreDistance(ax, z) < SHORE_ROAD.outer + 0.2) break;
      zEnd = z;
    }
    const spans: [number, number][] =
      Math.abs(ax) < 20
        ? [
            [-150, -112.8],
            [-62.2, zEnd],
          ]
        : [[-150, zEnd]];
    for (const off of [-0.95, -0.32, 0.32, 0.95]) {
      for (const [z0, z1] of spans) {
        if (south) addLane(ax + off, z0, ax + off, z1, 2.6, range(rng, 2.2, 3.0));
        else addLane(ax + off, z1, ax + off, z0, 2.6, range(rng, 2.2, 3.0));
      }
    }
  });
  STREET_ZS.forEach((sz, k) => {
    const twoWay = k % 5 === 2;
    // x extent on land
    let x0 = 0;
    let x1 = 0;
    for (let x = 0; x > -75; x -= 0.5) {
      if (shoreDistance(x, sz) < SHORE_ROAD.outer + 0.2) break;
      x0 = x;
    }
    for (let x = 0; x < 75; x += 0.5) {
      if (shoreDistance(x, sz) < SHORE_ROAD.outer + 0.2) break;
      x1 = x;
    }
    if (sz > SOUTH_LIMIT - 1) return;
    const parkRow = sz > -112.5 && sz < -63.5;
    const spans: [number, number][] = parkRow
      ? [
          [x0, -31.4],
          [31.4, x1],
        ]
      : [[x0, x1]];
    const offs = twoWay ? [-0.36, 0.36] : [0];
    for (const off of offs) {
      const east = twoWay ? off > 0 : k % 2 === 0;
      for (const [a, b] of spans) {
        if (b - a < 2) continue;
        if (east) addLane(a, sz + off, b, sz + off, 5.5, range(rng, 1.6, 2.4));
        else addLane(b, sz + off, a, sz + off, 5.5, range(rng, 1.6, 2.4));
      }
    }
  });
  // Broadway, southbound; the bowtie through Times Square is a pedestrian plaza.
  for (let i = BROADWAY.length - 1; i > 0; i--) {
    const a = BROADWAY[i]!;
    const b = BROADWAY[i - 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const tx = (b[0] - a[0]) / len;
    const tz = (b[1] - a[1]) / len;
    const pieces: [number, number][] = [];
    let start: number | null = null;
    for (let s = 0; s <= len; s += 0.5) {
      const x = a[0] + tx * s;
      const z = a[1] + tz * s;
      const ok = !inTimesSquare(x, z, 0.5) && onLand(x, z, SHORE_ROAD.outer + 0.2) && z < SOUTH_LIMIT - 1;
      if (ok && start === null) start = s;
      if (!ok && start !== null) {
        pieces.push([start, s - 0.5]);
        start = null;
      }
    }
    if (start !== null) pieces.push([start, len]);
    for (const off of [-0.45, 0.45]) {
      const nx = -tz * off;
      const nz = tx * off;
      for (const [s0, s1] of pieces) {
        addLane(a[0] + tx * s0 + nx, a[1] + tz * s0 + nz, a[0] + tx * s1 + nx, a[1] + tz * s1 + nz, 3.2, range(rng, 1.8, 2.5));
      }
    }
  }
  // Shore drives: two lanes each way.
  for (const side of ["west", "east"] as const) {
    for (const [d, southbound] of [
      [2.15, side === "west"],
      [2.62, side === "west"],
      [3.18, side !== "west"],
      [3.65, side !== "west"],
    ] as const) {
      const line = shoreOffset(side, d, 6);
      const speed = range(rng, 3.4, 4.2);
      for (let i = 0; i < line.length - 1; i++) {
        const p = line[i]!;
        const q = line[i + 1]!;
        if (southbound) addLane(p[0], p[1], q[0], q[1], 3.0, speed);
        else addLane(q[0], q[1], p[0], p[1], 3.0, speed);
      }
    }
  }

  const vents: Vec2[] = [
    [TIMES_SQUARE.x + 1.9, TIMES_SQUARE.z + 3.2],
    [-11.6, 56.4],
    [11.4, 77.3],
    [10.6, -28.2],
    [-11.3, -35.2],
    [33.5, 63.2],
    [-32.6, 21.3],
    [11.2, 6.8],
    [-10.8, -7.3],
    [32.7, -49.1],
  ];

  return { lamps, pools, lanes, vents };
}
