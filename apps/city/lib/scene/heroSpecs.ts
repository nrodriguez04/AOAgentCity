import type { BuildingModel } from "@agent-city/core";

// Fallback dimensions for each hero tower model. They drive the placeholder
// towers shown while a .glb is missing or loading, and the lot each hero
// reserves in the procedural grid. When /models/manifest.json lists a model,
// its measured values override these (see manifest.ts).

export type V3 = [number, number, number];

export interface PlaceholderPart {
  kind: "box" | "cylinder" | "dome" | "spire" | "pyramid";
  /** Centre x/z, bottom y. */
  x: number;
  z: number;
  y0: number;
  /** Box: width (x) and depth (z). Cylinder / dome / spire: radius in w. */
  w: number;
  d: number;
  h: number;
  /** Rotation around +y (radians), for the twist tower. */
  rot?: number;
  role: "body" | "crown" | "accent";
  glass?: boolean;
}

export interface ScreenSpec {
  name: string;
  width: number;
  height: number;
}

export interface HeroSpec {
  model: BuildingModel;
  /** Overall height including spires. */
  height: number;
  /** Top of the occupied floors (where the window bands end). */
  roofHeight: number;
  floors: number;
  floorHeight: number;
  /** Width (x) and depth (z) of the footprint at ground level. */
  footprint: [number, number];
  beacon: V3;
  label: V3;
  searchlight: V3 | null;
  screens: ScreenSpec[];
  /** LED band: total length around the building and its height. */
  ledBand: { length: number; height: number; y: number } | null;
  parts: PlaceholderPart[];
  /** Lot reserved in the grid (width x, depth z), at least the footprint plus a margin. */
  lot: [number, number];
  /** Approximate visible height, for camera framing and neighbour height caps. */
  frameHeight: number;
}

const box = (
  x: number,
  z: number,
  y0: number,
  w: number,
  d: number,
  h: number,
  role: PlaceholderPart["role"] = "body",
  extra: Partial<PlaceholderPart> = {},
): PlaceholderPart => ({ kind: "box", x, z, y0, w, d, h, role, ...extra });

export const HERO_SPECS: Record<BuildingModel, HeroSpec> = {
  "deco-spire": {
    model: "deco-spire",
    height: 54,
    roofHeight: 42,
    floors: 101,
    floorHeight: 0.38,
    footprint: [9.25, 5.15],
    beacon: [0, 54, 0],
    label: [0, 56, 0],
    searchlight: [0, 40.6, 0],
    screens: [],
    ledBand: null,
    parts: [
      box(0, 0, 0, 9.2, 5.0, 5.9),
      box(0, 0, 5.9, 7.0, 4.3, 15.2),
      box(0, 0, 21.1, 5.6, 3.7, 9.1),
      box(0, 0, 30.2, 4.4, 3.1, 6.1),
      box(0, 0, 36.3, 3.4, 2.5, 2.3),
      { kind: "pyramid", x: 0, z: 0, y0: 38.6, w: 2.9, d: 2.15, h: 3.4, role: "crown" },
      { kind: "spire", x: 0, z: 0, y0: 42, w: 0.14, d: 0.14, h: 12, role: "accent" },
    ],
    lot: [9.9, 5.4],
    frameHeight: 54,
  },
  "glass-led": {
    model: "glass-led",
    height: 44,
    roofHeight: 42.5,
    floors: 109,
    floorHeight: 0.38,
    footprint: [6.2, 4.8],
    beacon: [0, 44.1, -0.3],
    label: [0, 46.1, 0],
    searchlight: null,
    screens: [],
    ledBand: { length: 19.94, height: 1.84, y: 38.5 },
    parts: [box(0, 0, 0, 6.2, 4.8, 42.5, "body", { glass: true }), box(0, 0, 42.5, 4.2, 3.4, 1.5, "crown")],
    lot: [8.5, 5.4],
    frameHeight: 44,
  },
  "ring-cylinder": {
    model: "ring-cylinder",
    height: 35.2,
    roofHeight: 33,
    floors: 85,
    floorHeight: 0.38,
    footprint: [5.13, 5.13],
    beacon: [0, 35, 0],
    label: [0, 37.2, 0],
    searchlight: null,
    screens: [],
    ledBand: null,
    parts: [
      { kind: "cylinder", x: 0, z: 0, y0: 0, w: 2.56, d: 2.56, h: 33, role: "body", glass: true },
      { kind: "cylinder", x: 0, z: 0, y0: 33, w: 3.2, d: 3.2, h: 0.5, role: "crown" },
    ],
    lot: [7.5, 5.4],
    frameHeight: 35,
  },
  neoclassical: {
    model: "neoclassical",
    height: 11.4,
    roofHeight: 9.9,
    floors: 25,
    floorHeight: 0.38,
    footprint: [8.96, 5.19],
    beacon: [0, 10, -1.2],
    label: [0, 11.9, -1],
    searchlight: null,
    screens: [],
    ledBand: null,
    parts: [
      box(0, -0.3, 0, 8.9, 4.5, 9.9),
      { kind: "pyramid", x: 0, z: 2.0, y0: 7.2, w: 7.6, d: 1.0, h: 1.6, role: "crown" },
    ],
    lot: [11, 5.4],
    frameHeight: 11.4,
  },
  "warehouse-loft": {
    model: "warehouse-loft",
    height: 9.3,
    roofHeight: 7.5,
    floors: 15,
    floorHeight: 0.42,
    footprint: [9.43, 5.14],
    beacon: [-2.7, 9.3, -0.9],
    label: [0, 11.3, 0],
    searchlight: null,
    screens: [],
    ledBand: null,
    parts: [box(0, 0, 0, 9.4, 5.0, 7.5), box(-2.7, -0.9, 7.5, 2.0, 1.8, 1.7, "crown")],
    lot: [11.5, 5.4],
    frameHeight: 9.3,
  },
  "twist-tower": {
    model: "twist-tower",
    height: 48.3,
    roofHeight: 44.8,
    floors: 117,
    floorHeight: 0.38,
    footprint: [5.23, 5.23],
    beacon: [1.35, 48.3, -2.15],
    label: [0, 50.3, 0],
    searchlight: null,
    screens: [],
    ledBand: null,
    parts: Array.from({ length: 12 }, (_, i) =>
      box(0, 0, i * 3.73, 4.6, 4.6, 3.73, "body", { rot: (i * Math.PI) / 40, glass: true }),
    ).concat([box(0, 0, 44.8, 3.2, 3.2, 1.6, "crown", { rot: (12 * Math.PI) / 40 })]),
    lot: [7.5, 5.4],
    frameHeight: 48.3,
  },
  "bank-dome": {
    model: "bank-dome",
    height: 10,
    roofHeight: 4.9,
    floors: 13,
    floorHeight: 0.38,
    footprint: [9.4, 5.15],
    beacon: [0, 10, -0.3],
    label: [0, 12, -0.3],
    searchlight: null,
    screens: [],
    ledBand: null,
    parts: [
      box(0, 0, 0, 9.4, 5.0, 4.9),
      { kind: "cylinder", x: 0, z: -0.3, y0: 4.9, w: 1.9, d: 1.9, h: 1.6, role: "body" },
      { kind: "dome", x: 0, z: -0.3, y0: 6.5, w: 1.9, d: 1.9, h: 2.4, role: "crown" },
    ],
    lot: [11.5, 5.4],
    frameHeight: 10,
  },
  "glass-pavilion": {
    model: "glass-pavilion",
    height: 2.5,
    roofHeight: 2.4,
    floors: 2,
    floorHeight: 1.0,
    footprint: [9.9, 6.9],
    beacon: [0, 2.5, 0],
    label: [0, 4.5, 0],
    searchlight: null,
    screens: [],
    ledBand: null,
    parts: [box(0, 0, 0, 9.4, 6.4, 2.2, "body", { glass: true }), box(0, 0, 2.2, 9.9, 6.9, 0.2, "crown")],
    lot: [12, 9],
    frameHeight: 5,
  },
  "billboard-block": {
    model: "billboard-block",
    height: 27.2,
    roofHeight: 24.9,
    floors: 64,
    floorHeight: 0.38,
    footprint: [5.76, 4.9],
    beacon: [0, 27.2, 0],
    label: [0, 29.2, 0],
    searchlight: null,
    screens: [
      { name: "Screen_0", width: 5.1, height: 2.85 },
      { name: "Screen_1", width: 4.6, height: 6.65 },
      { name: "Screen_2", width: 5.1, height: 3.2 },
      { name: "Screen_3", width: 3.9, height: 4.1 },
      { name: "Screen_4", width: 3.38, height: 8.2 },
    ],
    ledBand: { length: 20.72, height: 0.44, y: 2.2 },
    parts: [box(0, 0, 0, 5.76, 4.9, 24.9), box(0, -0.4, 24.9, 3.4, 2.4, 1.6, "crown")],
    lot: [8, 5.4],
    frameHeight: 27.2,
  },
};

export function heroSpec(model: BuildingModel): HeroSpec {
  return HERO_SPECS[model];
}
