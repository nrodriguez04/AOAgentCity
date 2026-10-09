// East River suspension bridges: deck, towers, catenary cables, suspenders,
// the "necklace" lights along the main cables, and traffic lanes on the deck.

import { shoreDistance, STREET_ZS, WATER_LEVEL, FAR_SHORES, distToPolyline, pointInPolygon } from "./layout";
import type { LaneSeg } from "./streetGen";

export interface BridgeSpec {
  z: number;
  /** Where the deck leaves Manhattan and lands in Brooklyn. */
  x0: number;
  x1: number;
  deckY: number;
  towerH: number;
  style: "stone" | "steel";
}

export interface BridgeModel {
  bridges: BridgeSpec[];
  /** Box parts: deck, ramps, towers (center x/y/z, size w/h/d, colour index). */
  boxes: { x: number; y: number; z: number; w: number; h: number; d: number; kind: 0 | 1 | 2 }[];
  /** Line segments (cables, suspenders) as flat xyz pairs. */
  lines: number[];
  /** Necklace lights. */
  lights: { x: number; y: number; z: number }[];
  lanes: LaneSeg[];
}

function landingX(from: number, dir: 1 | -1, onLand: (x: number) => boolean): number {
  let x = from;
  for (let i = 0; i < 400; i++) {
    if (onLand(x)) return x;
    x += dir * 0.25;
  }
  return x;
}

export function generateBridges(): BridgeModel {
  // Bridges run along streets so their Manhattan approaches meet the grid.
  const streetNear = (z: number) => STREET_ZS.reduce((best, s) => (Math.abs(s - z) < Math.abs(best - z) ? s : best), STREET_ZS[0]!);
  const brooklyn = FAR_SHORES[1]!;
  const specs: BridgeSpec[] = [
    { z: streetNear(77), x0: 0, x1: 0, deckY: 4.2, towerH: 13.5, style: "stone" },
    { z: streetNear(42), x0: 0, x1: 0, deckY: 4.6, towerH: 15.5, style: "steel" },
  ];
  const model: BridgeModel = { bridges: [], boxes: [], lines: [], lights: [], lanes: [] };
  for (const s of specs) {
    // Manhattan shore going east from the island, Brooklyn shore going west from the far land.
    const manhattan = landingX(75, -1, (x) => shoreDistance(x, s.z) > 0);
    const bk = landingX(90, 1, (x) => pointInPolygon(x, s.z, brooklyn) && distToPolyline(x, s.z, brooklyn, true) > 0.5);
    const x0 = manhattan - 7; // approach ramp starts inland
    const x1 = bk + 7;
    const b: BridgeSpec = { ...s, x0, x1 };
    model.bridges.push(b);
    const span0 = manhattan + 2;
    const span1 = bk - 2;
    const deckW = 2.2;
    const deckT = 0.28;
    // Deck over the water.
    model.boxes.push({ x: (span0 + span1) / 2, y: s.deckY, z: s.z, w: span1 - span0, h: deckT, d: deckW, kind: 0 });
    // Approach ramps, sloping down to the street.
    const rampLen = 9;
    for (const [from, dir] of [
      [span0, -1],
      [span1, 1],
    ] as const) {
      const steps = 6;
      for (let i = 0; i < steps; i++) {
        const t0 = i / steps;
        const t1 = (i + 1) / steps;
        const xa = from + dir * rampLen * t0;
        const xb = from + dir * rampLen * t1;
        const y = s.deckY * (1 - (t0 + t1) / 2);
        model.boxes.push({ x: (xa + xb) / 2, y: Math.max(0.15, y), z: s.z, w: Math.abs(xb - xa) + 0.05, h: deckT, d: deckW, kind: 0 });
      }
    }
    // Towers at a quarter of the span from each shore.
    const L = span1 - span0;
    const towers = [span0 + L * 0.24, span1 - L * 0.24];
    for (const tx of towers) {
      const legW = s.style === "stone" ? 0.9 : 0.5;
      const top = s.deckY + s.towerH;
      const y0 = WATER_LEVEL;
      for (const side of [-1, 1] as const) {
        model.boxes.push({ x: tx, y: (y0 + top) / 2, z: s.z + side * (deckW / 2 + legW * 0.35), w: legW, h: top - y0, d: legW, kind: s.style === "stone" ? 1 : 2 });
      }
      // Cross beams.
      for (const fy of [0.55, 0.92]) {
        const y = s.deckY + s.towerH * fy;
        model.boxes.push({ x: tx, y, z: s.z, w: legW * 0.8, h: s.style === "stone" ? 1.1 : 0.45, d: deckW + legW * 1.4, kind: s.style === "stone" ? 1 : 2 });
      }
      // Pier in the water.
      model.boxes.push({ x: tx, y: WATER_LEVEL + 0.3, z: s.z, w: legW * 2.2, h: 1.2, d: deckW + legW * 3, kind: 1 });
    }
    // Main cables: anchor -> tower -> sag -> tower -> anchor, on both sides of the deck.
    const anchorY = s.deckY + 0.6;
    const topY = s.deckY + s.towerH * 0.97;
    const sagY = s.deckY + 1.2;
    const cable = (x: number): number => {
      const [ta, tb] = towers as [number, number];
      if (x <= ta) {
        const t = (x - span0) / (ta - span0);
        return anchorY + (topY - anchorY) * t * t;
      }
      if (x >= tb) {
        const t = (span1 - x) / (span1 - tb);
        return anchorY + (topY - anchorY) * t * t;
      }
      const t = (x - ta) / (tb - ta);
      const p = 4 * t * (1 - t);
      return topY - (topY - sagY) * p;
    };
    for (const side of [-1, 1] as const) {
      const z = s.z + side * (deckW / 2 + 0.05);
      const n = 120;
      for (let i = 0; i < n; i++) {
        const xa = span0 + (L * i) / n;
        const xb = span0 + (L * (i + 1)) / n;
        model.lines.push(xa, cable(xa), z, xb, cable(xb), z);
      }
      // Suspenders.
      for (let x = span0 + 0.6; x < span1; x += 0.7) {
        const y = cable(x);
        if (y - s.deckY > 0.4) model.lines.push(x, s.deckY + deckT / 2, z, x, y, z);
      }
      // Necklace lights along the cable.
      for (let x = span0 + 0.4; x < span1; x += 1.1) model.lights.push({ x, y: cable(x) + 0.06, z });
    }
    // Traffic: two lanes each way on the deck and ramps (straight in plan view).
    for (const [off, east] of [
      [-0.75, true],
      [-0.3, true],
      [0.3, false],
      [0.75, false],
    ] as const) {
      const z = s.z + off;
      if (east) model.lanes.push({ ax: x0, az: z, bx: x1, bz: z, spacing: 2.6, speed: 3.2 });
      else model.lanes.push({ ax: x1, az: z, bx: x0, bz: z, spacing: 2.6, speed: 3.2 });
    }
  }
  return model;
}

/** Deck height along a bridge (for cars driving over it). */
export function bridgeDeckY(b: BridgeSpec, x: number): number {
  const rampLen = 9;
  const manhattan = b.x0 + 7 + 2;
  const bk = b.x1 - 7 - 2;
  if (x < manhattan) return Math.max(0, b.deckY * (1 - (manhattan - x) / rampLen));
  if (x > bk) return Math.max(0, b.deckY * (1 - (x - bk) / rampLen));
  return b.deckY;
}
