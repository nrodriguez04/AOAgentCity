// The Agent City street grid: a compact, Manhattan-like island.
//
// City units: 1 unit is about 10 m. +x is east, +z is south, y is up.
// Avenues run north-south, streets run east-west, blocks are long east-west.
// One diagonal "Broadway" cuts across the grid; where it crosses the avenue at
// x = -33 it opens into the Times Square bowtie. Central Park is a cut-out in
// the north; the island tapers to a point (the Battery) in the south.

export type Vec2 = readonly [number, number];

export const AVENUE_XS = [-55, -33, -11, 11, 33, 55] as const;
export const AVENUE_HALF = 1.6;
export const STREET_SPACING = 7;
/** Streets run from the far north (lost in the fog) down to the Battery. */
export const STREET_ZS: readonly number[] = Array.from({ length: 33 }, (_, i) => -133 + i * STREET_SPACING);
export const STREET_HALF = 0.8;
export const SIDEWALK = 0.45;
export const BROADWAY_HALF = 1.2;

/** Broadway: straight down the spine of downtown, then the long diagonal through midtown. */
export const BROADWAY: readonly Vec2[] = [
  [-5.5, 140],
  [-5.5, 38],
  [-38, -56],
  [-67, -139.9],
];

/** Central Park: between the avenues at x = +-33, from the street at z = -63 north to z = -112. */
export const PARK = {
  x0: -33 + AVENUE_HALF,
  x1: 33 - AVENUE_HALF,
  z0: -112 + STREET_HALF,
  z1: -63 - STREET_HALF,
} as const;

/** The park pond ("the lake"), an irregular loop of points. */
export const POND: readonly Vec2[] = [
  [-21, -97.5], [-17, -100.5], [-11.5, -101], [-7, -98.8], [-6.2, -95.2], [-9.2, -92.4],
  [-13.5, -93.4], [-16.5, -91], [-20.5, -91.2], [-23, -93.8],
];

/** Times Square: where Broadway crosses the avenue at x = -33. */
export const TIMES_SQUARE = (() => {
  const a = BROADWAY[1]!;
  const b = BROADWAY[2]!;
  const t = (-33 - a[0]) / (b[0] - a[0]);
  return { x: -33, z: a[1] + (b[1] - a[1]) * t, halfLength: 13 };
})();

/**
 * Island outline (world x, z), clockwise when seen from above with north up:
 * down the west shore, around the southern tip, back up the east shore.
 */
export const ISLAND: readonly Vec2[] = [
  [-67, -260], [-67.6, -150], [-66.8, -100], [-67.4, -50], [-66.6, -10], [-67.1, 25],
  [-66.4, 45], [-64.6, 57], [-61.2, 68], [-56, 79], [-49, 89], [-40.5, 97.5],
  [-30.5, 104.5], [-18.5, 109.5], [-6, 111.6], [6, 110.2], [17.5, 106], [28.5, 99.5],
  [38.5, 91.5], [47.5, 82], [55.5, 72.5], [62, 62], [66.4, 50], [68, 36],
  [68.2, 15], [67.4, -20], [68, -60], [67.2, -110], [67.8, -260],
];

/** Land across the rivers: New Jersey to the west, Brooklyn and Queens to the east. */
export const FAR_SHORES: readonly (readonly Vec2[])[] = [
  [
    [-104, -320], [-103, -150], [-105.5, -60], [-102.5, 10], [-104.5, 70], [-108, 120],
    [-116, 175], [-300, 175], [-300, -320],
  ],
  [
    [97, -320], [99, -150], [95.5, -80], [98, -20], [96, 40], [99.5, 85], [106, 125],
    [116, 165], [128, 200], [300, 200], [300, -320],
  ],
];

/** A small harbour island south of the Battery. */
export const HARBOR_ISLAND: readonly Vec2[] = [
  [18, 146], [26, 141], [36, 142.5], [41, 149], [38, 157], [28, 160], [19, 156],
];

export const WATER_LEVEL = -0.32;

/** Camera layer for small props that the water reflection skips (the main camera sees layers 0 and 1). */
export const NO_REFLECTION_LAYER = 1;

// --- Geometry helpers ------------------------------------------------------

export function pointInPolygon(x: number, z: number, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(px: number, pz: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / len2)) : 0;
  const cx = a[0] + dx * t - px;
  const cz = a[1] + dz * t - pz;
  return Math.sqrt(cx * cx + cz * cz);
}

export function distToPolyline(px: number, pz: number, line: readonly Vec2[], closed = false): number {
  let d = Infinity;
  const n = line.length;
  for (let i = 0; i < n - (closed ? 0 : 1); i++) {
    d = Math.min(d, distToSegment(px, pz, line[i]!, line[(i + 1) % n]!));
  }
  return d;
}

/** Signed distance to the island shore: positive on land, negative in the water. */
export function shoreDistance(x: number, z: number): number {
  const d = distToPolyline(x, z, ISLAND, true);
  return pointInPolygon(x, z, ISLAND) ? d : -d;
}

/** Broadway's centre-line x at a given z (only meaningful inside its z range). */
export function broadwayXAt(z: number): number {
  for (let i = 0; i < BROADWAY.length - 1; i++) {
    const a = BROADWAY[i]!;
    const b = BROADWAY[i + 1]!;
    const zMax = Math.max(a[1], b[1]);
    const zMin = Math.min(a[1], b[1]);
    if (z <= zMax && z >= zMin) {
      const t = (z - a[1]) / (b[1] - a[1]);
      return a[0] + (b[0] - a[0]) * t;
    }
  }
  return BROADWAY[BROADWAY.length - 1]![0];
}

export function distToBroadway(x: number, z: number): number {
  return distToPolyline(x, z, BROADWAY);
}

export function inPark(x: number, z: number, margin = 0): boolean {
  return x > PARK.x0 - margin && x < PARK.x1 + margin && z > PARK.z0 - margin && z < PARK.z1 + margin;
}

/** The Times Square bowtie: the pedestrian plaza between Broadway and the avenue. */
export function inTimesSquare(x: number, z: number, margin = 0): boolean {
  const dz = z - TIMES_SQUARE.z;
  if (Math.abs(dz) > TIMES_SQUARE.halfLength + margin) return false;
  const bx = broadwayXAt(z);
  const lo = Math.min(bx, TIMES_SQUARE.x) - 1.1 - margin;
  const hi = Math.max(bx, TIMES_SQUARE.x) + 1.1 + margin;
  return x > lo && x < hi;
}

/** Does an avenue exist at this z (avenues inside the park are removed)? */
export function avenueExists(ax: number, z: number): boolean {
  if (Math.abs(ax) < 20 && z > PARK.z0 - 0.5 && z < PARK.z1 + 0.5) return false;
  return true;
}

/** Shore road (West Side Highway / FDR Drive) band, as distances inland from the shore. */
export const SHORE_ROAD = { inner: 1.5, outer: 4.3 } as const;
/** Lots must stay this far inland from the shore. */
export const SHORE_LOT_MARGIN = SHORE_ROAD.outer + SIDEWALK + 0.25;

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;
}

/** City blocks: the land between streets and avenues (before Broadway and park cuts). */
export function cityBlocks(): Rect[] {
  const xs = [-70, ...AVENUE_XS, 70];
  const blocks: Rect[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const xa = xs[i]!;
    const xb = xs[i + 1]!;
    const x0 = i === 0 ? -70 : xa + AVENUE_HALF;
    const x1 = i === xs.length - 2 ? 70 : xb - AVENUE_HALF;
    for (let k = 0; k < STREET_ZS.length - 1; k++) {
      const z0 = STREET_ZS[k]! + STREET_HALF;
      const z1 = STREET_ZS[k + 1]! - STREET_HALF;
      blocks.push({ x0, x1, z0, z1 });
    }
    // The strip south of the last street, down to the Battery.
    const last = STREET_ZS[STREET_ZS.length - 1]!;
    blocks.push({ x0, x1, z0: last + STREET_HALF, z1: last + 22 });
  }
  return blocks;
}

/** Overview framing used by the camera rig: both skyline clusters as a diorama. */
export const OVERVIEW = {
  position: [91, 74, 161] as [number, number, number],
  target: [0, 5, 16] as [number, number, number],
};

export const DOWNTOWN_CENTER: Vec2 = [2, 70];
export const MIDTOWN_CENTER: Vec2 = [4, -31];
