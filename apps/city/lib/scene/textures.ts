import * as THREE from "three";
import { ISLAND, PARK, POND, distToPolyline, pointInPolygon } from "./layout";
import type { ParkModel } from "./parkGen";

// Procedural textures, generated once in the browser (no network fetches).

export const SDF_BOUNDS = { x0: -82, z0: -162, x1: 82, z1: 126 } as const;

/** Signed distance to the island shore (positive on land), as a half-float texture. */
export function createShoreSdf(): THREE.DataTexture {
  const w = 192;
  const h = Math.round((w * (SDF_BOUNDS.z1 - SDF_BOUNDS.z0)) / (SDF_BOUNDS.x1 - SDF_BOUNDS.x0));
  const data = new Uint16Array(w * h);
  for (let j = 0; j < h; j++) {
    const z = SDF_BOUNDS.z0 + ((j + 0.5) / h) * (SDF_BOUNDS.z1 - SDF_BOUNDS.z0);
    for (let i = 0; i < w; i++) {
      const x = SDF_BOUNDS.x0 + ((i + 0.5) / w) * (SDF_BOUNDS.x1 - SDF_BOUNDS.x0);
      const d = distToPolyline(x, z, ISLAND, true);
      const s = pointInPolygon(x, z, ISLAND) ? d : -d;
      data[j * w + i] = THREE.DataUtils.toHalfFloat(Math.max(-30, Math.min(30, s)));
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Central Park ground: lawns, woodland floor, paths and the pavilion plaza. */
export function createParkTexture(park: ParkModel): THREE.CanvasTexture {
  const pxPerUnit = 18;
  const W = Math.round((PARK.x1 - PARK.x0) * pxPerUnit);
  const H = Math.round((PARK.z1 - PARK.z0) * pxPerUnit);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const X = (x: number) => (x - PARK.x0) * pxPerUnit;
  const Z = (z: number) => (z - PARK.z0) * pxPerUnit;

  // Woodland floor with mottled variation.
  ctx.fillStyle = "#1c2a19";
  ctx.fillRect(0, 0, W, H);
  const rnd = mulberry(4417);
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const r = 6 + rnd() * 22;
    ctx.fillStyle = rnd() < 0.5 ? "rgba(40,58,32,0.18)" : "rgba(14,22,13,0.22)";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Lawns.
  for (const e of park.lawns) {
    const g = ctx.createRadialGradient(X(e.x), Z(e.z), 2, X(e.x), Z(e.z), Math.max(e.rx, e.rz) * pxPerUnit);
    g.addColorStop(0, "#3a5631");
    g.addColorStop(1, "#30482a");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(X(e.x), Z(e.z), e.rx * pxPerUnit, e.rz * pxPerUnit, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Pond bank.
  ctx.fillStyle = "#2a2a22";
  ctx.beginPath();
  POND.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Z(p[1])) : ctx.moveTo(X(p[0]), Z(p[1]))));
  ctx.closePath();
  ctx.lineWidth = 1.2 * pxPerUnit;
  ctx.strokeStyle = "#2b3326";
  ctx.stroke();
  ctx.fill();

  const stroke = (pts: readonly (readonly [number, number])[], width: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width * pxPerUnit;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Z(p[1])) : ctx.moveTo(X(p[0]), Z(p[1]))));
    ctx.stroke();
  };
  for (const d of park.drives) {
    stroke(d, 1.25, "#3d3b37");
    stroke(d, 0.95, "#2b2a28");
  }
  for (const p of park.paths) stroke(p, 0.5, "#6d6556");
  // Pavilion plaza.
  const pl = park.plaza;
  const g = ctx.createRadialGradient(X(pl.x), Z(pl.z), 4, X(pl.x), Z(pl.z), pl.r * pxPerUnit);
  g.addColorStop(0, "#77705f");
  g.addColorStop(0.85, "#6a6354");
  g.addColorStop(1, "#4d483e");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(X(pl.x), Z(pl.z), pl.r * pxPerUnit, 0, Math.PI * 2);
  ctx.fill();
  // Low wall around the park.
  ctx.strokeStyle = "#5a5246";
  ctx.lineWidth = 0.22 * pxPerUnit;
  ctx.strokeRect(0.15 * pxPerUnit, 0.15 * pxPerUnit, W - 0.3 * pxPerUnit, H - 0.3 * pxPerUnit);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

/** Tileable ripple normal map for the rivers. */
export function createRippleNormals(size = 256): THREE.DataTexture {
  const height = new Float32Array(size * size);
  const waves: [number, number, number, number][] = [];
  // Integer wave vectors keep the pattern tileable.
  const rnd = mulberry(91);
  for (let i = 0; i < 26; i++) {
    const kx = Math.round((rnd() * 2 - 1) * (4 + i * 0.9));
    const ky = Math.round((rnd() * 2 - 1) * (2 + i * 0.5)) + 1;
    waves.push([kx, ky, rnd() * Math.PI * 2, 1 / (1 + i * 0.35)]);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h = 0;
      for (const [kx, ky, ph, a] of waves) h += Math.sin(((kx * x + ky * y) / size) * Math.PI * 2 + ph) * a;
      height[y * size + x] = h;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const s = 0.9;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hL = height[y * size + ((x - 1 + size) % size)]!;
      const hR = height[y * size + ((x + 1) % size)]!;
      const hD = height[((y - 1 + size) % size) * size + x]!;
      const hU = height[((y + 1) % size) * size + x]!;
      let nx = (hL - hR) * s;
      let ny = (hD - hU) * s;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const o = (y * size + x) * 4;
      data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
