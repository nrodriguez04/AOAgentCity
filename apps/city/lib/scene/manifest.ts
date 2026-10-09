import type { BuildingModel } from "@agent-city/core";
import { HERO_SPECS, type HeroSpec, type ScreenSpec, type V3 } from "./heroSpecs";

// /models/manifest.json is written by assets/blender/build_hero_towers.py:
//   { "<model>": { height, roofHeight, floors, floorHeight, baseHeight,
//                  footprint: { w, d }, beacon: [x,y,z], label: [x,y,z],
//                  searchlight?: [x,y,z], screens?: ..., led?: ..., nodes: [...] } }
// Everything is parsed defensively: a missing or odd field falls back to the
// built-in spec so a half-finished manifest never breaks the scene.

export type HeroManifest = Partial<Record<BuildingModel, HeroSpec & { nodes: string[] }>>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function vec3(v: unknown): V3 | null {
  if (Array.isArray(v) && v.length >= 3 && v.every((c) => typeof c === "number")) {
    return [v[0] as number, v[1] as number, v[2] as number];
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const x = num(o.x);
    const y = num(o.y);
    const z = num(o.z);
    if (x !== null && y !== null && z !== null) return [x, y, z];
  }
  return null;
}

function parseScreens(v: unknown, fallback: ScreenSpec[]): ScreenSpec[] {
  const out: ScreenSpec[] = [];
  const push = (name: string, s: unknown) => {
    if (!s || typeof s !== "object") return;
    const o = s as Record<string, unknown>;
    const size = Array.isArray(o.size) ? (o.size as unknown[]) : null;
    const width = num(o.width) ?? num(o.w) ?? (size ? num(size[0]) : null);
    const height = num(o.height) ?? num(o.h) ?? (size ? num(size[1]) : null);
    if (width && height) out.push({ name, width, height });
  };
  if (Array.isArray(v)) {
    v.forEach((s, i) => {
      const name = s && typeof s === "object" && typeof (s as { name?: unknown }).name === "string"
        ? (s as { name: string }).name
        : `Screen_${i}`;
      push(name, s);
    });
  } else if (v && typeof v === "object") {
    for (const [name, s] of Object.entries(v as Record<string, unknown>)) push(name, s);
  }
  return out.length ? out : fallback;
}

function parseLed(v: unknown, fallback: HeroSpec["ledBand"]): HeroSpec["ledBand"] {
  if (!v || typeof v !== "object") return fallback;
  const o = v as Record<string, unknown>;
  const length = num(o.length) ?? num(o.circumference) ?? num(o.width) ?? num(o.w);
  const height = num(o.height) ?? num(o.h);
  const y = num(o.y) ?? num(o.y0) ?? num(o.bottom) ?? (fallback ? fallback.y : 0);
  if (length && height) return { length, height, y };
  return fallback;
}

export function mergeSpec(model: BuildingModel, raw: unknown): HeroSpec & { nodes: string[] } {
  const fb = HERO_SPECS[model];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const fp = o.footprint as Record<string, unknown> | undefined;
  const fw = fp ? num(fp.w) ?? num(fp.width) : null;
  const fd = fp ? num(fp.d) ?? num(fp.depth) : null;
  const height = num(o.height) ?? fb.height;
  const footprint: [number, number] = [fw ?? fb.footprint[0], fd ?? fb.footprint[1]];
  const roofHeight = num(o.roofHeight) ?? Math.min(fb.roofHeight, height);
  return {
    ...fb,
    height,
    roofHeight,
    floors: num(o.floors) || fb.floors,
    floorHeight: num(o.floorHeight) ?? fb.floorHeight,
    footprint,
    beacon: vec3(o.beacon) ?? fb.beacon,
    label: vec3(o.label) ?? fb.label,
    searchlight: vec3(o.searchlight) ?? fb.searchlight,
    screens: parseScreens(o.screens, fb.screens),
    ledBand: parseLed(o.led ?? o.ledBand, fb.ledBand),
    lot: [Math.max(fb.lot[0], footprint[0] + 0.6), Math.max(fb.lot[1], Math.min(footprint[1] + 0.4, 5.4))],
    frameHeight: Math.max(height, roofHeight),
    nodes: Array.isArray(o.nodes) ? (o.nodes.filter((n) => typeof n === "string") as string[]) : [],
  };
}

export function parseManifest(json: unknown): HeroManifest {
  const out: HeroManifest = {};
  if (!json || typeof json !== "object") return out;
  const root = json as Record<string, unknown>;
  const models = (root.models && typeof root.models === "object" ? root.models : root) as Record<string, unknown>;
  for (const key of Object.keys(HERO_SPECS) as BuildingModel[]) {
    if (models[key]) out[key] = mergeSpec(key, models[key]);
  }
  return out;
}

let manifestPromise: Promise<HeroManifest> | null = null;

/** Fetches /models/manifest.json once per page. Resolves to {} when it is missing. */
export function loadManifest(): Promise<HeroManifest> {
  if (!manifestPromise) {
    manifestPromise = fetch("/models/manifest.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => parseManifest(j))
      .catch(() => ({}));
  }
  return manifestPromise;
}
