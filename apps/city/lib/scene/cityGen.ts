// Procedural Manhattan: deterministic lots, buildings (stacked box tiers with
// setbacks), cornices, crowns and rooftop props. Pure data; the React layer
// packs it into instanced meshes.

import {
  DOWNTOWN_CENTER,
  MIDTOWN_CENTER,
  SHORE_LOT_MARGIN,
  SIDEWALK,
  TIMES_SQUARE,
  BROADWAY_HALF,
  type Rect,
  broadwayXAt,
  cityBlocks,
  distToBroadway,
  inPark,
  inTimesSquare,
  rectsOverlap,
  shoreDistance,
  FAR_SHORES,
  HARBOR_ISLAND,
  pointInPolygon,
  distToPolyline,
} from "./layout";
import { clamp, hashSeed, mulberry32, pick, range, smoothstep, weighted, type Rng } from "./random";

export const STYLE = {
  BRICK: 0,
  BROWNSTONE: 1,
  LIMESTONE: 2,
  DECO: 3,
  GLASS: 4,
  DARKGLASS: 5,
  CONCRETE: 6,
  WAREHOUSE: 7,
  BILLBOARD: 8,
  MECH: 9,
  FAR: 10,
} as const;
export type StyleId = (typeof STYLE)[keyof typeof STYLE];

const PALETTE: Record<StyleId, readonly string[]> = {
  [STYLE.BRICK]: ["#7c4636", "#6e3e31", "#86513e", "#633a2f", "#8c5c48", "#784a3b", "#6a473d", "#8a6452", "#7f5a4b"],
  [STYLE.BROWNSTONE]: ["#5e3f30", "#6b4636", "#553a2d", "#73503c", "#614434"],
  [STYLE.LIMESTONE]: ["#a89c86", "#b5a88f", "#9a8e79", "#c2b59c", "#8f8576", "#aa9a80", "#b9ae9a"],
  [STYLE.DECO]: ["#a39784", "#958a7a", "#b0a28a", "#8a837b", "#9d917e", "#7f7a74", "#b7a98f"],
  [STYLE.GLASS]: ["#3d5866", "#2f4a57", "#4a6672", "#2c3f4c", "#577783", "#3b5560"],
  [STYLE.DARKGLASS]: ["#1d242c", "#232a33", "#1a1f26", "#262b2f"],
  [STYLE.CONCRETE]: ["#8d8a84", "#7f7d79", "#9a968e", "#6f6e6b", "#a39f96"],
  [STYLE.WAREHOUSE]: ["#7a4a38", "#6c4434", "#857060", "#5f4a3f", "#8a5a44", "#74503f"],
  [STYLE.BILLBOARD]: ["#2a2a30", "#33302e", "#2c2d33"],
  [STYLE.MECH]: ["#4a4a4c", "#3e3f42", "#55524e"],
  [STYLE.FAR]: ["#5a5550", "#4e4c4a", "#6a5d52", "#57514c", "#48494c"],
};

const LIT_BASE: Record<StyleId, number> = {
  [STYLE.BRICK]: 0.3,
  [STYLE.BROWNSTONE]: 0.34,
  [STYLE.LIMESTONE]: 0.32,
  [STYLE.DECO]: 0.36,
  [STYLE.GLASS]: 0.42,
  [STYLE.DARKGLASS]: 0.44,
  [STYLE.CONCRETE]: 0.34,
  [STYLE.WAREHOUSE]: 0.14,
  [STYLE.BILLBOARD]: 0.45,
  [STYLE.MECH]: 0,
  [STYLE.FAR]: 0.26,
};

export interface Tier {
  cx: number;
  cz: number;
  w: number;
  d: number;
  y0: number;
  h: number;
  style: StyleId;
  floorH: number;
  lit: number;
  seed: number;
  color: string;
  /** 0 none, 1 warm floodlit crown, 2 cool floodlit crown. */
  flood: number;
  storefront: boolean;
  /** Top of the billboard band (BILLBOARD style), else 0. */
  billboardTop: number;
}

export interface Box {
  cx: number;
  cz: number;
  y0: number;
  w: number;
  d: number;
  h: number;
  color: string;
  /** Emissive strength (floodlit pyramid caps). */
  glow?: number;
}

export interface Needle {
  x: number;
  z: number;
  y0: number;
  h: number;
  r: number;
}

export interface Point3 {
  x: number;
  y: number;
  z: number;
  /** Blink phase / size factor. */
  p: number;
}

export interface WaterTower {
  x: number;
  z: number;
  y0: number;
  s: number;
  rot: number;
  tint: number;
}

export interface HeroLot {
  id: string;
  x: number;
  z: number;
  rotation: number;
  /** Footprint (local width x, depth z) incl. margin. */
  w: number;
  d: number;
  height: number;
}

export interface CityModel {
  tiers: Tier[];
  cornices: Box[];
  caps: Box[];
  boxes: Box[]; // AC units, bulkheads
  waterTowers: WaterTower[];
  needles: Needle[];
  aviation: Point3[];
  stats: { buildings: number; tiers: number };
}

// --- Zoning -----------------------------------------------------------------

function gauss(x: number, z: number, c: readonly [number, number], sx: number, sz: number): number {
  const dx = (x - c[0]) / sx;
  const dz = (z - c[1]) / sz;
  return Math.exp(-(dx * dx + dz * dz));
}

/** Potential building height at a location: two skyline clusters over low neighbourhoods. */
export function heightPotential(x: number, z: number): number {
  const down = gauss(x, z, DOWNTOWN_CENTER, 28, 18);
  const mid = gauss(x, z, MIDTOWN_CENTER, 40, 21);
  let base = 2.3;
  if (z < -112) base = 3.4; // north of the park: walk-ups and prewar apartments
  else if (z < -56 && Math.abs(x) > 30) base = 5.2; // park-side prewar apartments
  else if (z > 40) base = 3.2;
  let h = base + 36 * down + 38 * mid;
  // Very few tall buildings at the park edge.
  const parkEdge = z < -52 && z > -118 && Math.abs(x) < 42;
  if (parkEdge) h = Math.min(h, 9);
  return h;
}

function isIndustrial(x: number, z: number): boolean {
  const sd = shoreDistance(x, z);
  return sd < 14 && z > -60 && z < 55;
}

// --- Generation -------------------------------------------------------------

interface Ctx {
  model: CityModel;
  heroRects: { rect: Rect; lot: HeroLot }[];
  buildings: number;
}

function colorOf(rng: Rng, style: StyleId): string {
  return pick(rng, PALETTE[style]);
}

function lotValid(r: Rect): boolean {
  const corners: [number, number][] = [
    [r.x0, r.z0],
    [r.x1, r.z0],
    [r.x0, r.z1],
    [r.x1, r.z1],
  ];
  for (const [x, z] of corners) if (shoreDistance(x, z) < SHORE_LOT_MARGIN) return false;
  if (r.z1 > 92.6) return false; // Battery Park at the tip
  return true;
}

/** Shrink a lot horizontally until it sits fully inland; null when too small. */
function clipToShore(r: Rect): Rect | null {
  if (lotValid(r)) return r;
  // Try shrinking from the west side, then from the east side.
  for (const side of [0, 1] as const) {
    const cand = { ...r };
    for (let i = 0; i < 40; i++) {
      if (side === 0) cand.x0 += 0.35;
      else cand.x1 -= 0.35;
      if (cand.x1 - cand.x0 < 1.0) break;
      if (lotValid(cand)) return cand;
    }
  }
  return null;
}

/** Remove the Broadway band (and the Times Square plaza) from a lot. */
function clipToBroadway(r: Rect): Rect | null {
  const margin = BROADWAY_HALF + SIDEWALK + 0.15;
  const bx0 = broadwayXAt(r.z0);
  const bx1 = broadwayXAt(r.z1);
  const bmin = Math.min(bx0, bx1) - margin;
  const bmax = Math.max(bx0, bx1) + margin;
  // quick reject when far away
  const cx = (r.x0 + r.x1) / 2;
  const cz = (r.z0 + r.z1) / 2;
  if (r.x1 <= bmin || r.x0 >= bmax) {
    if (distToBroadway(cx, cz) > 0) return r;
  }
  if (r.x1 <= bmin || r.x0 >= bmax) return r;
  const westPart: Rect = { ...r, x1: Math.min(r.x1, bmin) };
  const eastPart: Rect = { ...r, x0: Math.max(r.x0, bmax) };
  const ww = westPart.x1 - westPart.x0;
  const ew = eastPart.x1 - eastPart.x0;
  if (ww < 0.9 && ew < 0.9) return null;
  return ww >= ew ? westPart : eastPart;
}

function clipToPlaza(r: Rect): Rect | null {
  const cz = (r.z0 + r.z1) / 2;
  if (Math.abs(cz - TIMES_SQUARE.z) > TIMES_SQUARE.halfLength + 4) return r;
  const samples = [r.z0, cz, r.z1];
  let lo = Infinity;
  let hi = -Infinity;
  let touched = false;
  for (const z of samples) {
    if (Math.abs(z - TIMES_SQUARE.z) > TIMES_SQUARE.halfLength) continue;
    const bx = broadwayXAt(z);
    lo = Math.min(lo, Math.min(bx, TIMES_SQUARE.x) - 1.1 - SIDEWALK - 0.2);
    hi = Math.max(hi, Math.max(bx, TIMES_SQUARE.x) + 1.1 + SIDEWALK + 0.2);
    touched = true;
  }
  if (!touched || r.x1 <= lo || r.x0 >= hi) return r;
  const westPart: Rect = { ...r, x1: Math.min(r.x1, lo) };
  const eastPart: Rect = { ...r, x0: Math.max(r.x0, hi) };
  const ww = westPart.x1 - westPart.x0;
  const ew = eastPart.x1 - eastPart.x0;
  if (ww < 0.9 && ew < 0.9) return null;
  return ww >= ew ? westPart : eastPart;
}

/** Split a lot around hero reservations; returns the remaining pieces. */
function clipToHeroes(ctx: Ctx, r: Rect): Rect[] {
  let pieces: Rect[] = [r];
  for (const { rect } of ctx.heroRects) {
    const next: Rect[] = [];
    for (const p of pieces) {
      if (!rectsOverlap(p, rect)) {
        next.push(p);
        continue;
      }
      // Keep the parts to the west/east, and north/south slivers when deep enough.
      if (rect.x0 - p.x0 >= 0.9) next.push({ ...p, x1: rect.x0 - 0.15 });
      if (p.x1 - rect.x1 >= 0.9) next.push({ ...p, x0: rect.x1 + 0.15 });
      const xs0 = Math.max(p.x0, rect.x0);
      const xs1 = Math.min(p.x1, rect.x1);
      if (rect.z0 - p.z0 >= 1.6) next.push({ x0: xs0, x1: xs1, z0: p.z0, z1: rect.z0 - 0.15 });
      if (p.z1 - rect.z1 >= 1.6) next.push({ x0: xs0, x1: xs1, z0: rect.z1 + 0.15, z1: p.z1 });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.x1 - p.x0 >= 0.8 && p.z1 - p.z0 >= 0.8);
}

/**
 * Height cap in front of low hero towers so they stay visible from the
 * overview camera (which looks from the south-east and above). Only lots in a
 * narrow corridor along the line of sight are capped; everything else, and
 * all lots behind a hero, keep their height as a backdrop.
 */
const CAMERA_DIR: readonly [number, number] = (() => {
  const l = Math.hypot(0.55, 0.83);
  return [0.55 / l, 0.83 / l];
})();

function heroCap(ctx: Ctx, x: number, z: number): number {
  let cap = Infinity;
  for (const { lot } of ctx.heroRects) {
    if (lot.height > 30 || inPark(lot.x, lot.z)) continue;
    const dx = x - lot.x;
    const dz = z - lot.z;
    const along = dx * CAMERA_DIR[0] + dz * CAMERA_DIR[1];
    if (along <= 0 || along > 40) continue;
    const lateral = Math.abs(dx * CAMERA_DIR[1] - dz * CAMERA_DIR[0]);
    const halfW = Math.max(lot.w, lot.d) * 0.5;
    if (lateral > halfW + 3.5) continue;
    // Keep a low forecourt right in front, then let heights rise with the sight line.
    const c = along < 5 ? 1.4 : lot.height * 0.35 + along * 0.42;
    cap = Math.min(cap, c);
  }
  return cap;
}

function pushTier(ctx: Ctx, t: Omit<Tier, "lit" | "billboardTop"> & { lit?: number; billboardTop?: number }) {
  if (t.w < 0.2 || t.d < 0.2 || t.h < 0.05) return;
  ctx.model.tiers.push({ lit: LIT_BASE[t.style], billboardTop: 0, ...t });
}

function cornice(ctx: Ctx, cx: number, cz: number, w: number, d: number, top: number, color: string, size = 0.07) {
  ctx.model.cornices.push({ cx, cz, y0: top - size, w: w + size * 2, d: d + size * 2, h: size, color });
}

function waterTower(ctx: Ctx, rng: Rng, cx: number, cz: number, w: number, d: number, top: number) {
  if (w < 0.9 || d < 0.9) return;
  const s = range(rng, 0.85, 1.25);
  const mx = Math.max(0, w / 2 - 0.35);
  const mz = Math.max(0, d / 2 - 0.35);
  ctx.model.waterTowers.push({
    x: cx + range(rng, -mx, mx),
    z: cz + range(rng, -mz, mz),
    y0: top,
    s,
    rot: rng() * Math.PI,
    tint: rng(),
  });
}

function roofClutter(ctx: Ctx, rng: Rng, cx: number, cz: number, w: number, d: number, top: number, n: number) {
  for (let i = 0; i < n; i++) {
    const bw = range(rng, 0.14, Math.min(0.55, w * 0.35));
    const bd = range(rng, 0.14, Math.min(0.5, d * 0.35));
    const bh = range(rng, 0.08, 0.26);
    const mx = Math.max(0, w / 2 - bw / 2 - 0.1);
    const mz = Math.max(0, d / 2 - bd / 2 - 0.1);
    ctx.model.boxes.push({
      cx: cx + range(rng, -mx, mx),
      cz: cz + range(rng, -mz, mz),
      y0: top,
      w: bw,
      d: bd,
      h: bh,
      color: pick(rng, ["#5b5d60", "#6c6e70", "#4c4f53", "#7a7a76"]),
    });
  }
}

function antenna(ctx: Ctx, rng: Rng, x: number, z: number, top: number, tall: boolean) {
  const h = tall ? range(rng, 3.5, 7.5) : range(rng, 1.2, 2.6);
  ctx.model.needles.push({ x, z, y0: top, h, r: tall ? 0.09 : 0.05 });
  ctx.model.aviation.push({ x, y: top + h + 0.05, z, p: rng() });
}

function aviationCorners(ctx: Ctx, rng: Rng, cx: number, cz: number, w: number, d: number, top: number) {
  const ph = rng();
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    ctx.model.aviation.push({ x: cx + (sx * w) / 2, y: top + 0.08, z: cz + (sz * d) / 2, p: ph });
  }
}

// --- Archetypes -----------------------------------------------------------------

interface Lot extends Rect {
  /** Building faces this street side (for half-depth residential lots): -1 north, +1 south, 0 both. */
  face: -1 | 0 | 1;
  onAvenue: boolean;
}

function lotCenter(l: Rect) {
  return { cx: (l.x0 + l.x1) / 2, cz: (l.z0 + l.z1) / 2, w: l.x1 - l.x0, d: l.z1 - l.z0 };
}

function rowhouses(ctx: Ctx, rng: Rng, lot: Lot, hBase: number, commercial: boolean) {
  const { w } = lotCenter(lot);
  const n = Math.max(1, Math.round(w / range(rng, 0.68, 0.95)));
  const each = w / n;
  const brown = rng() < 0.45;
  const depth = Math.min(lot.z1 - lot.z0, range(rng, 1.55, 1.95));
  // Row houses front their street; the rest of the half-block is back yard.
  const z0 = lot.face === 1 ? lot.z1 - depth : lot.z0;
  const z1 = z0 + depth;
  let familyColor = colorOf(rng, brown ? STYLE.BROWNSTONE : STYLE.BRICK);
  for (let i = 0; i < n; i++) {
    if (rng() < 0.3) familyColor = colorOf(rng, brown ? STYLE.BROWNSTONE : STYLE.BRICK);
    const h = clamp(hBase * range(rng, 0.85, 1.15), 0.9, 2.2);
    const cx = lot.x0 + each * (i + 0.5);
    const style = brown ? STYLE.BROWNSTONE : STYLE.BRICK;
    const ww = each - 0.02;
    pushTier(ctx, {
      cx,
      cz: (z0 + z1) / 2,
      w: ww,
      d: depth,
      y0: 0,
      h,
      style,
      floorH: range(rng, 0.33, 0.37),
      seed: rng(),
      color: familyColor,
      flood: 0,
      storefront: commercial && rng() < 0.6,
    });
    cornice(ctx, cx, (z0 + z1) / 2, ww - 0.04, depth - 0.04, h + 0.05, "#3a2c26", 0.05);
    ctx.buildings++;
  }
}

function walkup(ctx: Ctx, rng: Rng, lot: Lot, h: number, commercial: boolean, industrial: boolean) {
  const { cx, w } = lotCenter(lot);
  const fullDepth = lot.face === 0;
  const depth = fullDepth ? lot.z1 - lot.z0 : Math.min(lot.z1 - lot.z0, range(rng, 2.0, 2.45));
  const z0 = lot.face === 1 ? lot.z1 - depth : lot.z0;
  const cz = z0 + depth / 2;
  const style = industrial ? STYLE.WAREHOUSE : rng() < 0.75 ? STYLE.BRICK : STYLE.LIMESTONE;
  const color = colorOf(rng, style);
  pushTier(ctx, {
    cx,
    cz,
    w: w - 0.04,
    d: depth,
    y0: 0,
    h,
    style,
    floorH: industrial ? range(rng, 0.46, 0.55) : range(rng, 0.34, 0.38),
    seed: rng(),
    color,
    flood: 0,
    storefront: commercial || lot.onAvenue,
  });
  cornice(ctx, cx, cz, w - 0.04, depth, h + 0.06, style === STYLE.LIMESTONE ? "#d8ccb4" : "#4a352c", 0.06);
  if (industrial) {
    roofClutter(ctx, rng, cx, cz, w, depth, h, 1 + Math.floor(rng() * 4));
    if (rng() < 0.3) waterTower(ctx, rng, cx, cz, w, depth, h);
  } else if (rng() < 0.38) waterTower(ctx, rng, cx, cz, w, depth, h);
  else if (rng() < 0.4) roofClutter(ctx, rng, cx, cz, w, depth, h, 1 + Math.floor(rng() * 2));
  ctx.buildings++;
}

function warehouse(ctx: Ctx, rng: Rng, lot: Lot, h: number) {
  const { cx, cz, w, d } = lotCenter(lot);
  const style = rng() < 0.75 ? STYLE.WAREHOUSE : STYLE.CONCRETE;
  pushTier(ctx, {
    cx,
    cz,
    w: w - 0.06,
    d: d - 0.06,
    y0: 0,
    h,
    style,
    floorH: range(rng, 0.5, 0.62),
    seed: rng(),
    color: colorOf(rng, style),
    flood: 0,
    storefront: false,
  });
  cornice(ctx, cx, cz, w - 0.06, d - 0.06, h + 0.05, "#3c322c", 0.05);
  roofClutter(ctx, rng, cx, cz, w, d, h, 2 + Math.floor(rng() * 5));
  if (rng() < 0.35) waterTower(ctx, rng, cx, cz, w, d, h);
  ctx.buildings++;
}

function prewar(ctx: Ctx, rng: Rng, lot: Lot, h: number, commercial: boolean) {
  const { cx, cz, w, d } = lotCenter(lot);
  const style = weighted(rng, [
    [STYLE.LIMESTONE, 0.45],
    [STYLE.BRICK, 0.4],
    [STYLE.DECO, 0.15],
  ] as const);
  const color = colorOf(rng, style);
  const floorH = range(rng, 0.36, 0.4);
  const withPenthouse = h > 4 && rng() < 0.55;
  const baseH = withPenthouse ? h * range(rng, 0.78, 0.9) : h;
  const ww = w - 0.05;
  const dd = d - 0.05;
  pushTier(ctx, { cx, cz, w: ww, d: dd, y0: 0, h: baseH, style, floorH, seed: rng(), color, flood: 0, storefront: commercial || lot.onAvenue });
  const corniceColor = style === STYLE.BRICK ? "#cdbfa5" : "#e0d6c2";
  cornice(ctx, cx, cz, ww, dd, baseH + 0.08, corniceColor, 0.08);
  let top = baseH;
  let tw = ww;
  let td = dd;
  if (withPenthouse) {
    const inset = range(rng, 0.25, Math.min(0.9, Math.min(ww, dd) * 0.25));
    tw = ww - inset * 2;
    td = dd - inset * 2;
    pushTier(ctx, { cx, cz, w: tw, d: td, y0: baseH, h: h - baseH, style, floorH, seed: rng(), color, flood: rng() < 0.12 ? 1 : 0, storefront: false });
    cornice(ctx, cx, cz, tw, td, h + 0.05, corniceColor, 0.05);
    top = h;
  }
  if (rng() < 0.68) waterTower(ctx, rng, cx, cz, tw, td, top);
  if (rng() < 0.5) roofClutter(ctx, rng, cx, cz, tw, td, top, 1 + Math.floor(rng() * 3));
  ctx.buildings++;
}

function decoTower(ctx: Ctx, rng: Rng, lot: Lot, h: number, commercial: boolean) {
  const { cx, cz, w, d } = lotCenter(lot);
  const style = rng() < 0.7 ? STYLE.DECO : STYLE.LIMESTONE;
  const color = colorOf(rng, style);
  const floorH = range(rng, 0.38, 0.42);
  const nTiers = h > 22 ? 4 : h > 14 ? 3 : 2;
  const fracs = nTiers === 4 ? [0.4, 0.28, 0.2, 0.12] : nTiers === 3 ? [0.5, 0.32, 0.18] : [0.7, 0.3];
  const insetStep = Math.min(w, d) * range(rng, 0.09, 0.15);
  let y = 0;
  let tw = w - 0.06;
  let td = d - 0.06;
  const seed = rng();
  const flood = rng() < 0.6 ? 1 : rng() < 0.3 ? 2 : 0;
  for (let i = 0; i < nTiers; i++) {
    const th = h * fracs[i]!;
    const last = i === nTiers - 1;
    pushTier(ctx, {
      cx,
      cz,
      w: tw,
      d: td,
      y0: y,
      h: th,
      style,
      floorH,
      seed,
      color,
      flood: last ? flood : 0,
      storefront: i === 0 && (commercial || lot.onAvenue),
    });
    if (!last && rng() < 0.5) cornice(ctx, cx, cz, tw, td, y + th + 0.06, "#d6ccb6", 0.06);
    y += th;
    if (!last) {
      // Setback roofs collect water tanks and plant.
      const nw = Math.max(0.8, tw - insetStep * 2);
      const nd = Math.max(0.8, td - insetStep * 2);
      if (rng() < 0.25) roofClutter(ctx, rng, cx + (tw - nw) * 0.5 * (rng() < 0.5 ? -1 : 1) * 0.8, cz, (tw - nw) * 0.5, td * 0.8, y, 1);
      tw = nw;
      td = nd;
    }
  }
  const capRoll = rng();
  if (capRoll < 0.3) {
    const capH = Math.min(tw, td) * range(rng, 0.55, 1.1);
    const copper = rng() < 0.6;
    ctx.model.caps.push({
      cx,
      cz,
      y0: y,
      w: tw * 0.98,
      d: td * 0.98,
      h: capH,
      color: copper ? "#4f8f7a" : "#3c3f45",
      glow: copper ? 0.55 : 0.25,
    });
    if (h > 18 && rng() < 0.7) antenna(ctx, rng, cx, cz, y + capH * 0.85, h > 28);
  } else if (capRoll < 0.55 && h > 16) {
    ctx.model.needles.push({ x: cx, z: cz, y0: y, h: range(rng, 2.5, 6), r: 0.14 });
    ctx.model.aviation.push({ x: cx, y: y + 0.1, z: cz, p: rng() });
  } else {
    if (h > 24) antenna(ctx, rng, cx, cz, y, true);
    roofClutter(ctx, rng, cx, cz, tw, td, y, 1 + Math.floor(rng() * 2));
  }
  if (h > 22) aviationCorners(ctx, rng, cx, cz, tw, td, y);
  ctx.buildings++;
}

function glassTower(ctx: Ctx, rng: Rng, lot: Lot, h: number, commercial: boolean, billboardBase = false) {
  const { cx, cz, w, d } = lotCenter(lot);
  const dark = rng() < 0.35;
  const style = dark ? STYLE.DARKGLASS : STYLE.GLASS;
  const color = colorOf(rng, style);
  const floorH = range(rng, 0.37, 0.41);
  const seed = rng();
  let y = 0;
  let tw = w - 0.06;
  let td = d - 0.06;
  let tx = cx;
  let tz = cz;
  const podium = billboardBase || (h > 9 && rng() < 0.55);
  if (podium) {
    const ph = billboardBase ? range(rng, 2.6, 4.4) : range(rng, 0.9, 2.2);
    pushTier(ctx, {
      cx,
      cz,
      w: tw,
      d: td,
      y0: 0,
      h: ph,
      style: billboardBase ? STYLE.BILLBOARD : rng() < 0.5 ? STYLE.CONCRETE : style,
      floorH: billboardBase ? 0.42 : floorH * 1.15,
      seed: rng(),
      color: billboardBase ? colorOf(rng, STYLE.BILLBOARD) : colorOf(rng, STYLE.CONCRETE),
      flood: 0,
      storefront: true,
      billboardTop: billboardBase ? ph : 0,
    });
    y = ph;
    const sw = tw * range(rng, 0.66, 0.92);
    const sd = td * range(rng, 0.66, 0.92);
    tx = cx + (tw - sw) * 0.5 * range(rng, -1, 1);
    tz = cz + (td - sd) * 0.5 * range(rng, -1, 1);
    tw = sw;
    td = sd;
  }
  const slender = h > 28 && rng() < 0.35;
  if (slender) {
    tw = Math.min(tw, range(rng, 2.8, 3.8));
    td = Math.min(td, range(rng, 2.8, 3.6));
  }
  const crownStep = h > 18 && rng() < 0.45;
  const mainTop = crownStep ? h * range(rng, 0.88, 0.94) : h;
  pushTier(ctx, {
    cx: tx,
    cz: tz,
    w: tw,
    d: td,
    y0: y,
    h: mainTop - y,
    style,
    floorH,
    seed,
    color,
    flood: crownStep ? 0 : rng() < 0.22 ? 2 : 0,
    storefront: !podium && (commercial || lot.onAvenue),
  });
  let top = mainTop;
  if (crownStep) {
    const cw = tw * range(rng, 0.62, 0.8);
    const cd = td * range(rng, 0.62, 0.8);
    pushTier(ctx, { cx: tx, cz: tz, w: cw, d: cd, y0: mainTop, h: h - mainTop, style, floorH, seed, color, flood: rng() < 0.5 ? 2 : 1, storefront: false });
    top = h;
    tw = cw;
    td = cd;
  }
  // Mechanical bulkhead on the roof.
  const mw = tw * range(rng, 0.35, 0.6);
  const md = td * range(rng, 0.35, 0.6);
  const mh = range(rng, 0.35, 0.8);
  pushTier(ctx, { cx: tx, cz: tz, w: mw, d: md, y0: top, h: mh, style: STYLE.MECH, floorH: 1, seed: rng(), color: colorOf(rng, STYLE.MECH), flood: 0, storefront: false });
  roofClutter(ctx, rng, tx, tz, tw, td, top, 1 + Math.floor(rng() * 3));
  if (h > 27) antenna(ctx, rng, tx + mw * 0.25, tz, top + mh, true);
  if (h > 20) aviationCorners(ctx, rng, tx, tz, tw, td, top);
  ctx.buildings++;
}

function slab(ctx: Ctx, rng: Rng, lot: Lot, h: number, commercial: boolean) {
  const { cx, cz, w, d } = lotCenter(lot);
  const style = STYLE.CONCRETE;
  const color = colorOf(rng, style);
  const tw = w - 0.08;
  const td = d - 0.08;
  pushTier(ctx, { cx, cz, w: tw, d: td, y0: 0, h, style, floorH: range(rng, 0.36, 0.4), seed: rng(), color, flood: 0, storefront: commercial || lot.onAvenue });
  pushTier(ctx, {
    cx,
    cz,
    w: tw * 0.4,
    d: td * 0.45,
    y0: h,
    h: range(rng, 0.3, 0.6),
    style: STYLE.MECH,
    floorH: 1,
    seed: rng(),
    color: colorOf(rng, STYLE.MECH),
    flood: 0,
    storefront: false,
  });
  roofClutter(ctx, rng, cx, cz, tw, td, h, 2 + Math.floor(rng() * 3));
  if (h > 20) aviationCorners(ctx, rng, cx, cz, tw, td, h);
  ctx.buildings++;
}

function billboardBlock(ctx: Ctx, rng: Rng, lot: Lot, h: number) {
  // Times Square: billboard-clad podium with a tower above.
  if (h < 6 || lot.x1 - lot.x0 < 2.2) {
    const { cx, cz, w, d } = lotCenter(lot);
    const hh = Math.max(h, range(rng, 3, 5.5));
    pushTier(ctx, {
      cx,
      cz,
      w: w - 0.06,
      d: d - 0.06,
      y0: 0,
      h: hh,
      style: STYLE.BILLBOARD,
      floorH: 0.42,
      seed: rng(),
      color: colorOf(rng, STYLE.BILLBOARD),
      flood: 0,
      storefront: true,
      billboardTop: hh * range(rng, 0.7, 1.0),
    });
    roofClutter(ctx, rng, cx, cz, w, d, hh, 2);
    ctx.buildings++;
    return;
  }
  glassTower(ctx, rng, lot, h, true, true);
}

// --- Main ---------------------------------------------------------------------

function partition(rng: Rng, x0: number, x1: number, minW: number, maxW: number): [number, number][] {
  const out: [number, number][] = [];
  let x = x0;
  while (x < x1 - 0.01) {
    let w = range(rng, minW, maxW);
    if (x1 - (x + w) < minW * 0.75) w = x1 - x;
    out.push([x, Math.min(x1, x + w)]);
    x += w;
  }
  return out;
}

function buildLot(ctx: Ctx, rng: Rng, lot: Lot, residentialMode: boolean) {
  const { cx, cz, w } = lotCenter(lot);
  const pot = heightPotential(cx, cz);
  const industrial = isIndustrial(cx, cz);
  const tsDist = Math.hypot(cx - TIMES_SQUARE.x, (cz - TIMES_SQUARE.z) * 0.8);
  const commercial = pot > 9 || tsDist < 20;

  let h: number;
  if (residentialMode) {
    h = pot * range(rng, 0.45, 0.85);
    if (lot.onAvenue && rng() < 0.55) h = Math.max(h, range(rng, 2.6, 6.5) + pot * 0.3);
  } else {
    h = pot * (0.26 + 0.74 * Math.pow(rng(), 1.1));
    if (rng() < 0.09) h = pot * range(rng, 0.88, 1.08);
  }
  if (industrial) h = Math.min(h, range(rng, 1.5, 4.2));
  // Lower blocks near the rivers (except the downtown cluster).
  const sd = shoreDistance(cx, cz);
  if (sd < 16 && cz < 50) h = Math.min(h, 3 + (sd - 5) * 0.9);
  h = Math.min(h, heroCap(ctx, cx, cz));
  h = clamp(h, 0.9, 41);

  if (tsDist < 15 && !residentialMode) {
    billboardBlock(ctx, rng, lot, Math.max(h, range(rng, 4, 16)));
    return;
  }
  if (residentialMode && lot.face !== 0 && h < 2.4 && w > 1.4 && !lot.onAvenue && !industrial) {
    rowhouses(ctx, rng, lot, h, commercial);
    return;
  }
  if (industrial && lot.face === 0 && h < 4.5) {
    warehouse(ctx, rng, lot, h);
    return;
  }
  if (h < 3.2 || lot.face !== 0) {
    walkup(ctx, rng, lot, Math.min(h, lot.face !== 0 ? 3.6 : h), commercial, industrial);
    return;
  }
  const inCluster = pot > 14;
  if (h < 11) {
    const kind = weighted(rng, [
      ["prewar", inCluster ? 0.45 : 0.75],
      ["slab", inCluster ? 0.3 : 0.12],
      ["glass", inCluster ? 0.25 : 0.13],
    ] as const);
    if (kind === "prewar") prewar(ctx, rng, lot, h, commercial);
    else if (kind === "slab") slab(ctx, rng, lot, h, commercial);
    else glassTower(ctx, rng, lot, h, commercial);
    return;
  }
  const kind = weighted(rng, [
    ["deco", cz > 40 ? 0.55 : 0.42],
    ["glass", cz > 40 ? 0.35 : 0.48],
    ["slab", 0.1],
  ] as const);
  if (kind === "deco") decoTower(ctx, rng, lot, h, commercial);
  else if (kind === "glass") glassTower(ctx, rng, lot, h, commercial);
  else slab(ctx, rng, lot, h, commercial);
}

function heroRect(lot: HeroLot): Rect {
  const c = Math.abs(Math.cos(lot.rotation));
  const s = Math.abs(Math.sin(lot.rotation));
  const hw = (lot.w * c + lot.d * s) / 2;
  const hd = (lot.w * s + lot.d * c) / 2;
  return { x0: lot.x - hw, x1: lot.x + hw, z0: lot.z - hd, z1: lot.z + hd };
}

export function generateCity(heroLots: HeroLot[]): CityModel {
  const model: CityModel = { tiers: [], cornices: [], caps: [], boxes: [], waterTowers: [], needles: [], aviation: [], stats: { buildings: 0, tiers: 0 } };
  const ctx: Ctx = { model, heroRects: heroLots.map((lot) => ({ rect: heroRect(lot), lot })), buildings: 0 };

  for (const block of cityBlocks()) {
    const bcx = (block.x0 + block.x1) / 2;
    const bcz = (block.z0 + block.z1) / 2;
    if (inPark(bcx, bcz, 0.5)) continue;
    // Quick reject for blocks entirely in the river.
    if (
      shoreDistance(block.x0, bcz) < SHORE_LOT_MARGIN &&
      shoreDistance(block.x1, bcz) < SHORE_LOT_MARGIN &&
      shoreDistance(bcx, bcz) < SHORE_LOT_MARGIN
    ) {
      continue;
    }
    const rng = mulberry32(hashSeed(block.x0, block.z0, 7));
    const pot = heightPotential(bcx, bcz);
    const residentialMode = pot < 7.5 && !isIndustrial(bcx, bcz);
    const avenueEdges = [block.x0, block.x1];
    const touchesAvenue = (x0: number, x1: number) =>
      avenueEdges.some((e) => Math.abs(x0 - e) < 0.05 || Math.abs(x1 - e) < 0.05) && Math.abs(block.x0) < 69 && Math.abs(block.x1) < 69;

    const lots: Lot[] = [];
    const inset = SIDEWALK;
    const bx0 = block.x0 + inset;
    const bx1 = block.x1 - inset;
    const bz0 = block.z0 + inset;
    const bz1 = block.z1 - inset;
    if (residentialMode) {
      const mid = (bz0 + bz1) / 2;
      for (const face of [-1, 1] as const) {
        const z0 = face === -1 ? bz0 : mid + 0.08;
        const z1 = face === -1 ? mid - 0.08 : bz1;
        for (const [x0, x1] of partition(rng, bx0, bx1, 1.6, 4.6)) {
          const onAvenue = touchesAvenue(x0 - inset, x1 + inset);
          lots.push({ x0, x1, z0, z1, face, onAvenue });
        }
      }
      // Corner apartment buildings span the full depth at avenue ends.
      for (const l of lots) {
        if (l.onAvenue && rng() < 0.35) {
          l.face = 0;
          l.z0 = bz0;
          l.z1 = bz1;
        }
      }
    } else {
      const cluster = pot > 14;
      for (const [x0, x1] of partition(rng, bx0, bx1, cluster ? 2.6 : 2.0, cluster ? 7.2 : 5.0)) {
        const onAvenue = touchesAvenue(x0 - inset, x1 + inset);
        if (!cluster && rng() < 0.3) {
          const mid = (bz0 + bz1) / 2;
          lots.push({ x0, x1, z0: bz0, z1: mid - 0.06, face: 0, onAvenue });
          lots.push({ x0, x1, z0: mid + 0.06, z1: bz1, face: 0, onAvenue });
        } else {
          lots.push({ x0, x1, z0: bz0, z1: bz1, face: 0, onAvenue });
        }
      }
    }
    // Dedupe full-depth corner lots that now overlap.
    const kept: Lot[] = [];
    for (const l of lots) {
      if (kept.some((k) => rectsOverlap(k, l))) continue;
      kept.push(l);
    }
    for (const raw of kept) {
      let r: Rect | null = raw;
      r = clipToBroadway(r);
      if (!r) continue;
      r = clipToPlaza(r);
      if (!r) continue;
      r = clipToShore(r);
      if (!r) continue;
      if (inPark((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, 0.5)) continue;
      for (const piece of clipToHeroes(ctx, r)) {
        if (inTimesSquare((piece.x0 + piece.x1) / 2, (piece.z0 + piece.z1) / 2)) continue;
        buildLot(ctx, rng, { ...raw, ...piece }, residentialMode);
      }
    }
  }

  farShores(ctx);
  model.stats = { buildings: ctx.buildings, tiers: model.tiers.length };
  return model;
}

// --- Across the rivers ----------------------------------------------------------

function farShores(ctx: Ctx) {
  const rng = mulberry32(99173);
  // New Jersey and Brooklyn waterfronts: low lit buildings fading into the fog,
  // with a couple of mid-rise clusters facing downtown.
  const clusters: { x: number; z: number; r: number; h: number }[] = [
    { x: -132, z: 62, r: 22, h: 22 },
    { x: -124, z: -40, r: 18, h: 9 },
    { x: 122, z: 88, r: 20, h: 16 },
    { x: 118, z: 10, r: 18, h: 8 },
  ];
  for (let gx = -230; gx <= 230; gx += 4.2) {
    for (let gz = -250; gz <= 190; gz += 5.0) {
      if (Math.abs(gx) < 90) continue;
      const jx = gx + range(rng, -0.6, 0.6);
      const jz = gz + range(rng, -0.8, 0.8);
      const shore = FAR_SHORES.find((poly) => pointInPolygon(jx, jz, poly));
      if (!shore) continue;
      const sd = distToPolyline(jx, jz, shore, true);
      if (sd < 2.2) continue;
      // Thin out with distance from Manhattan (all fogged anyway).
      const far = Math.abs(jx) - 95;
      if (rng() < smoothstep(10, 100, far) * 0.94) continue;
      if (rng() < 0.3) continue; // streets and gaps
      let h = range(rng, 0.8, 2.6);
      for (const c of clusters) {
        const g = Math.exp(-((jx - c.x) ** 2 + (jz - c.z) ** 2) / (c.r * c.r));
        h += g * c.h * Math.pow(rng(), 1.5);
      }
      if (sd < 8 && rng() < 0.4) h = Math.max(h, range(rng, 1.5, 3.5)); // waterfront warehouses
      const w = range(rng, 1.6, 3.1);
      const d = range(rng, 1.8, 3.6);
      const tall = h > 6;
      pushTier(ctx, {
        cx: jx,
        cz: jz,
        w,
        d,
        y0: 0,
        h,
        style: tall && rng() < 0.5 ? STYLE.GLASS : STYLE.FAR,
        floorH: range(rng, 0.36, 0.42),
        seed: rng(),
        color: colorOf(rng, STYLE.FAR),
        flood: tall && rng() < 0.3 ? 2 : 0,
        storefront: false,
      });
      if (h > 14) ctx.model.aviation.push({ x: jx, y: h + 0.1, z: jz, p: rng() });
      ctx.buildings++;
    }
  }
  // A few low buildings on the harbour island.
  for (let i = 0; i < 14; i++) {
    const x = range(rng, 21, 38);
    const z = range(rng, 144, 157);
    if (!pointInPolygon(x, z, HARBOR_ISLAND)) continue;
    pushTier(ctx, { cx: x, cz: z, w: range(rng, 1.2, 2.4), d: range(rng, 1.2, 2.4), y0: 0, h: range(rng, 0.6, 1.4), style: STYLE.BRICK, floorH: 0.4, seed: rng(), color: colorOf(rng, STYLE.BRICK), flood: 0, storefront: false });
  }
}
