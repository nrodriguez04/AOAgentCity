// Deterministic randomness for the procedural city. Everything the scene
// generates (blocks, lots, buildings, props, traffic) derives from fixed seeds,
// so every visit renders the same Manhattan.

export type Rng = () => number;

/** mulberry32: small, fast, good enough for layout work. Returns [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash of a few numbers, for seeding per-block generators. */
export function hashSeed(...parts: number[]): number {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const v = Math.floor(p * 1000) | 0;
    h ^= v & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (v >>> 8) & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (v >>> 16) & 0xff;
    h = Math.imul(h, 16777619);
    h ^= (v >>> 24) & 0xff;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function range(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng();
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("pick() on empty list");
  return item;
}

/** Weighted choice: weights need not sum to 1. */
export function weighted<T>(rng: Rng, entries: readonly (readonly [T, number])[]): T {
  let total = 0;
  for (const [, w] of entries) total += Math.max(0, w);
  let r = rng() * total;
  for (const [value, w] of entries) {
    r -= Math.max(0, w);
    if (r <= 0) return value;
  }
  const last = entries[entries.length - 1];
  if (!last) throw new Error("weighted() on empty list");
  return last[0];
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
