// Central Park (paths, lawns, trees), the Battery at the southern tip and
// street trees in the low-rise neighbourhoods.

import {
  AVENUE_XS,
  PARK,
  POND,
  SHORE_ROAD,
  STREET_HALF,
  STREET_ZS,
  distToPolyline,
  pointInPolygon,
  shoreDistance,
  type Vec2,
} from "./layout";
import { mulberry32, range, type Rng } from "./random";

export interface Tree {
  x: number;
  z: number;
  /** Canopy radius. */
  r: number;
  /** Overall height. */
  h: number;
  /** Packed sRGB colour of the canopy. */
  color: string;
}

export interface Ellipse {
  x: number;
  z: number;
  rx: number;
  rz: number;
}

export interface ParkModel {
  paths: Vec2[][];
  /** Paths drawn wider (the loop drive). */
  drives: Vec2[][];
  lawns: Ellipse[];
  plaza: { x: number; z: number; r: number };
  trees: Tree[];
  pathLamps: Vec2[];
}

const PAVILION: Vec2 = [0, -76];

function smoothPath(points: Vec2[], rng: Rng, wobble: number, step = 1.2): Vec2[] {
  // Catmull-Rom through the control points, plus a little lateral wobble.
  const out: Vec2[] = [];
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(n - 1, i + 2)]!;
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const k = Math.max(2, Math.ceil(len / step));
    for (let j = 0; j < k; j++) {
      const t = j / k;
      const t2 = t * t;
      const t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(points[n - 1]!);
  if (wobble > 0) {
    const phase = rng() * 10;
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1]!;
      const b = out[i + 1]!;
      const tx = b[0] - a[0];
      const tz = b[1] - a[1];
      const tl = Math.hypot(tx, tz) || 1;
      const w = Math.sin(i * 0.35 + phase) * wobble;
      const p = out[i]!;
      out[i] = [p[0] + (-tz / tl) * w, p[1] + (tx / tl) * w];
    }
  }
  return out;
}

function nearPaths(x: number, z: number, paths: Vec2[][], pad: number): boolean {
  for (const p of paths) if (distToPolyline(x, z, p) < pad) return true;
  return false;
}

function inEllipse(x: number, z: number, e: Ellipse, pad = 0): boolean {
  const dx = (x - e.x) / (e.rx + pad);
  const dz = (z - e.z) / (e.rz + pad);
  return dx * dx + dz * dz < 1;
}

const GREENS = ["#2f4a2a", "#36522c", "#2a4426", "#3d5a30", "#2c4a34", "#41603a", "#334d2b"];
const AUTUMN = ["#6a4a24", "#7a5428", "#5e3a20", "#7f6430", "#56401f"];

function treeColor(rng: Rng, autumnBias = 0.14): string {
  return rng() < autumnBias ? AUTUMN[Math.floor(rng() * AUTUMN.length)]! : GREENS[Math.floor(rng() * GREENS.length)]!;
}

export function generatePark(): ParkModel {
  const rng = mulberry32(777);
  const cx = (PARK.x0 + PARK.x1) / 2;
  const cz = (PARK.z0 + PARK.z1) / 2;
  const hx = (PARK.x1 - PARK.x0) / 2 - 3.4;
  const hz = (PARK.z1 - PARK.z0) / 2 - 3.2;

  // The loop drive: a squarish superellipse.
  const loop: Vec2[] = [];
  for (let i = 0; i <= 96; i++) {
    const t = (i / 96) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const e = 0.28;
    const x = cx + hx * Math.sign(c) * Math.pow(Math.abs(c), e) + Math.sin(t * 5) * 0.5;
    const z = cz + hz * Math.sign(s) * Math.pow(Math.abs(s), e) + Math.cos(t * 4) * 0.45;
    loop.push([x, z]);
  }

  const plaza = { x: PAVILION[0], z: PAVILION[1], r: 6.6 };
  const ring: Vec2[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = (i / 40) * Math.PI * 2;
    ring.push([plaza.x + Math.cos(t) * plaza.r, plaza.z + Math.sin(t) * plaza.r]);
  }

  const raw: Vec2[][] = [
    [[PARK.x0 + 0.3, PARK.z1 - 0.4], [-14, -66.5], [-6.2, -72.6]],
    [[PARK.x1 - 0.3, PARK.z1 - 0.4], [14, -66.8], [6.2, -72.6]],
    [[0, -82.6], [2.5, -88], [-2, -93], [-5.6, -95.8]],
    [[-6.6, -76.4], [-15, -79.5], [-24, -81], [PARK.x0 + 0.3, -84.5]],
    [[6.6, -76.8], [16, -81.5], [24, -86.5], [PARK.x1 - 0.3, -89]],
    [[PARK.x0 + 0.3, -103.5], [-24, -104.5], [-12, -103.6], [0, -100.8], [12, -102.2], [24, -101], [PARK.x1 - 0.3, -100]],
    [[-26, -96], [-24.5, -91], [-27, -86], [-26.5, -80]],
    [[3.5, -91], [9, -88.5], [20, -91.5], [25.5, -96], [25, -104]],
    [[-9, -108.5], [-4, -105], [4, -106.5], [10, -110.5]],
    [[-4.5, -64.3], [-3, -67.5], [-2.8, -69.6]],
  ];
  const paths = raw.map((pts) => smoothPath(pts, rng, 0.25));
  // A path around the pond.
  const pondLoop: Vec2[] = [];
  const pcx = POND.reduce((s, p) => s + p[0], 0) / POND.length;
  const pcz = POND.reduce((s, p) => s + p[1], 0) / POND.length;
  for (const p of POND) {
    const dx = p[0] - pcx;
    const dz = p[1] - pcz;
    const l = Math.hypot(dx, dz) || 1;
    pondLoop.push([p[0] + (dx / l) * 1.3, p[1] + (dz / l) * 1.3]);
  }
  pondLoop.push(pondLoop[0]!);
  paths.push(smoothPath(pondLoop, rng, 0));
  paths.push(ring);
  const drives = [loop];

  const lawns: Ellipse[] = [
    { x: 14, z: -95, rx: 8.2, rz: 5.6 },
    { x: -16.5, z: -71.5, rx: 7.6, rz: 3.6 },
    { x: 9.5, z: -106.2, rx: 6.5, rz: 2.8 },
    { x: 17.5, z: -71, rx: 4.6, rz: 2.6 },
  ];

  const trees: Tree[] = [];
  const cell = 1.08;
  for (let x = PARK.x0 + 0.6; x < PARK.x1 - 0.4; x += cell) {
    for (let z = PARK.z0 + 0.6; z < PARK.z1 - 0.4; z += cell) {
      const tx = x + range(rng, -0.42, 0.42);
      const tz = z + range(rng, -0.42, 0.42);
      if (Math.hypot(tx - plaza.x, tz - plaza.z) < plaza.r + 1.4) continue;
      if (pointInPolygon(tx, tz, POND) || distToPolyline(tx, tz, POND, true) < 0.9) continue;
      if (nearPaths(tx, tz, drives, 1.05) || nearPaths(tx, tz, paths, 0.62)) continue;
      const lawn = lawns.some((e) => inEllipse(tx, tz, e));
      if (lawn && rng() > 0.04) continue;
      const edge = Math.min(tx - PARK.x0, PARK.x1 - tx, tz - PARK.z0, PARK.z1 - tz);
      const keep = edge < 2.5 ? 0.92 : 0.66;
      if (rng() > keep) continue;
      const r = range(rng, 0.5, 0.95);
      trees.push({ x: tx, z: tz, r, h: r * range(rng, 1.7, 2.3), color: treeColor(rng) });
    }
  }

  // The Battery: a waterfront park at the southern tip.
  for (let x = -40; x < 40; x += 1.35) {
    for (let z = 93.6; z < 112; z += 1.35) {
      const tx = x + range(rng, -0.4, 0.4);
      const tz = z + range(rng, -0.4, 0.4);
      const sd = shoreDistance(tx, tz);
      if (sd < 2.6) continue;
      if (Math.abs(tx + 4) < 1.6) continue; // Broadway's end
      if (rng() > 0.55) continue;
      const r = range(rng, 0.45, 0.8);
      trees.push({ x: tx, z: tz, r, h: r * range(rng, 1.8, 2.3), color: treeColor(rng, 0.12) });
    }
  }

  // Street trees in the low-rise neighbourhoods.
  for (const sz of STREET_ZS) {
    const villageRow = sz > -2 && sz < 52;
    const uptownRow = sz < -56 && sz > -133;
    if (!villageRow && !uptownRow) continue;
    for (const side of [-1, 1] as const) {
      const z = sz + side * (STREET_HALF + 0.3);
      for (let x = -68; x < 68; x += 1.55) {
        if (AVENUE_XS.some((ax) => Math.abs(x - ax) < 2.8)) continue;
        if (z > PARK.z0 - 1 && z < PARK.z1 + 1 && x > PARK.x0 - 1 && x < PARK.x1 + 1) continue;
        if (shoreDistance(x, z) < SHORE_ROAD.outer + 1.2) continue;
        // keep clear of the street lamps (every 4.6, staggered)
        const lampPhase = (((x + 70 - (side > 0 ? 2.3 : 0)) % 4.6) + 4.6) % 4.6;
        if (lampPhase < 0.6 || lampPhase > 4.0) continue;
        if (rng() > (villageRow ? 0.62 : 0.4)) continue;
        const r = range(rng, 0.3, 0.42);
        trees.push({ x: x + range(rng, -0.2, 0.2), z, r, h: r * range(rng, 2.6, 3.2), color: treeColor(rng, 0.25) });
      }
    }
  }

  const pathLamps: Vec2[] = [];
  for (const p of [...paths, ...drives]) {
    let acc = 0;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1]!;
      const b = p[i]!;
      acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (acc > 3.3) {
        acc = 0;
        pathLamps.push([b[0] + 0.45, b[1]]);
      }
    }
  }

  return { paths, drives, lawns, plaza, trees, pathLamps };
}
