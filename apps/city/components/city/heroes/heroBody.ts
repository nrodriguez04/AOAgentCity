import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { BuildingModel } from "@agent-city/core";
import type { HeroSpec, PlaceholderPart } from "@/lib/scene/heroSpecs";
import { NO_REFLECTION_LAYER } from "@/lib/scene/layout";
import type { CityUniforms } from "@/lib/scene/materials";
import { mulberry32 } from "@/lib/scene/random";
import {
  CROWN_COLORS,
  createConcreteFrameMaterial,
  createGhostMaterial,
  createGlowMaterial,
  createHeroWindowMaterial,
  patchBodyMaterial,
  type HeroUniforms,
} from "./heroMaterials";

// Turns either a loaded GLB scene or the placeholder spec into the same set of
// parts, with materials wired to the tower's state uniforms.

export type Role = "body" | "windows" | "crown" | "accent" | "led" | "screen" | "ring" | "flag";

export interface ScreenPart {
  name: string;
  index: number;
  mesh: THREE.Mesh;
  /** Width / height of the screen face. */
  aspect: number;
}

export interface BodyParts {
  root: THREE.Group;
  /** glTF UVs have their origin at the top-left: canvas textures need flipY = false. */
  fromGltf: boolean;
  bodyMeshes: THREE.Mesh[];
  /** Ghost copies of the body for the unbuilt part of a construction site. */
  ghost: THREE.Group;
  edges: THREE.BufferGeometry | null;
  bounds: THREE.Box3;
  crownMat: THREE.MeshStandardMaterial;
  accentMat: THREE.MeshStandardMaterial;
  ringMat: THREE.MeshStandardMaterial;
  crownMeshes: THREE.Mesh[];
  ledMeshes: THREE.Mesh[];
  screens: ScreenPart[];
  setConstruction(on: boolean): void;
  dispose(): void;
}

function roleOf(obj: THREE.Object3D, root: THREE.Object3D): Role {
  let o: THREE.Object3D | null = obj;
  while (o && o !== root) {
    const n = o.name;
    if (/^Windows?/i.test(n)) return "windows";
    if (/^Crown/i.test(n)) return "crown";
    if (/^Accent/i.test(n)) return "accent";
    if (/^LED/i.test(n)) return "led";
    if (/^Screen/i.test(n)) return "screen";
    if (/^Ring/i.test(n)) return "ring";
    if (/^Flag/i.test(n)) return "flag";
    if (/^Body/i.test(n)) return "body";
    o = o.parent;
  }
  const mat = (obj as THREE.Mesh).material as THREE.Material | undefined;
  const mn = mat && !Array.isArray(mat) ? mat.name : "";
  if (mn === "Window") return "windows";
  if (mn === "CrownLight") return "crown";
  if (mn === "Accent") return "accent";
  if (mn === "LED") return "led";
  if (mn === "Screen") return "screen";
  if (mn === "Ring") return "ring";
  if (mn === "Flag") return "flag";
  return "body";
}

function screenIndex(obj: THREE.Object3D): number {
  let o: THREE.Object3D | null = obj;
  while (o) {
    const m = /^Screen_?(\d+)/i.exec(o.name);
    if (m) return Number(m[1]);
    o = o.parent;
  }
  return 0;
}

function screenName(obj: THREE.Object3D): string {
  let o: THREE.Object3D | null = obj;
  while (o) {
    if (/^Screen/i.test(o.name)) return o.name;
    o = o.parent;
  }
  return obj.name;
}

/** Make sure window meshes carry _floor / _seed (derive them when an export lacks them). */
function ensureWindowAttributes(geo: THREE.BufferGeometry, spec: HeroSpec) {
  const pos = geo.attributes.position!;
  if (!geo.attributes._floor) {
    const fl = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) fl[i] = Math.max(0, Math.floor((pos.getY(i) - 0.05) / spec.floorHeight));
    geo.setAttribute("_floor", new THREE.BufferAttribute(fl, 1));
  }
  if (!geo.attributes._seed) {
    const sd = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i += 4) {
      const r = Math.abs(Math.sin(pos.getX(i) * 12.9898 + pos.getY(i) * 78.233 + pos.getZ(i) * 37.719) * 43758.5453) % 1;
      for (let k = 0; k < 4 && i + k < pos.count; k++) sd[i + k] = r;
    }
    geo.setAttribute("_seed", new THREE.BufferAttribute(sd, 1));
  }
  if (!geo.attributes.uv) {
    const uv = new Float32Array(pos.count * 2).fill(0.5);
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  }
}

/** Andrew's monotone chain convex hull of 2D points (x, z). */
function hull2d(points: [number, number][]): [number, number][] {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Thin a closed loop to at most `max` points, dropping the flattest corners first. */
function simplifyLoop(loop: [number, number][], max: number): [number, number][] {
  const pts = loop.slice();
  while (pts.length > max) {
    let bestI = 0;
    let bestA = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length]!;
      const b = pts[i]!;
      const c = pts[(i + 1) % pts.length]!;
      const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
      if (area < bestA) {
        bestA = area;
        bestI = i;
      }
    }
    pts.splice(bestI, 1);
  }
  return pts;
}

/**
 * A clean schematic cage around the tower, in model space: the convex outline
 * of each height band (so setbacks are followed) drawn as a ring, plus
 * vertical lines at its corners. Used for the construction blueprint and for
 * the success flash running up the building edges. Model edges would be far
 * too dense (window frames, floor rings) and read as a solid glow.
 */
function cageOf(meshes: THREE.Mesh[], root: THREE.Object3D, band: number): THREE.BufferGeometry | null {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m4 = new THREE.Matrix4();
  const v = new THREE.Vector3();
  let top = 0;
  const all: THREE.Vector3[] = [];
  for (const m of meshes) {
    m4.multiplyMatrices(inv, m.matrixWorld);
    const pos = m.geometry.attributes.position!;
    const step = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m4);
      all.push(v.clone());
      top = Math.max(top, v.y);
    }
  }
  if (!all.length) return null;
  const out: number[] = [];
  const nBands = Math.max(1, Math.ceil(top / band));
  for (let k = 0; k < nBands; k++) {
    const y0 = k * band;
    const y1 = Math.min(top, (k + 1) * band);
    const inBand = all.filter((p) => p.y >= y0 - 0.05 && p.y <= y1 + 0.05).map((p) => [p.x, p.z] as [number, number]);
    if (inBand.length < 3) continue;
    const loop = simplifyLoop(hull2d(inBand), 20);
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      out.push(a[0], y0, a[1], b[0], y0, b[1]);
      out.push(a[0], y0, a[1], a[0], y1, a[1]);
    }
    if (k === nBands - 1) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i]!;
        const b = loop[(i + 1) % loop.length]!;
        out.push(a[0], y1, a[1], b[0], y1, b[1]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  return g;
}

interface Ctx {
  model: BuildingModel;
  spec: HeroSpec;
  city: CityUniforms;
  hero: HeroUniforms;
}

function finish(
  ctx: Ctx,
  root: THREE.Group,
  meshes: { mesh: THREE.Mesh; role: Role }[],
  owned: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[] },
  fromGltf: boolean,
): BodyParts {
  const { city, hero, model, spec } = ctx;
  const crownColor = CROWN_COLORS[model] ?? new THREE.Color(1, 0.85, 0.6);
  const crownMat = createGlowMaterial(crownColor);
  const accentMat = createGlowMaterial(new THREE.Color(1.0, 0.86, 0.66));
  const ringMat = createGlowMaterial(CROWN_COLORS["ring-cylinder"]!, { side: THREE.DoubleSide });
  const windowMat = createHeroWindowMaterial(city, hero);
  const concreteMat = createConcreteFrameMaterial(city, hero, Math.max(0.3, spec.floorHeight));
  const ghostMat = createGhostMaterial(hero, city);
  owned.materials.push(crownMat, accentMat, ringMat, windowMat, concreteMat, ghostMat);

  const bodyMeshes: THREE.Mesh[] = [];
  const crownMeshes: THREE.Mesh[] = [];
  const ledMeshes: THREE.Mesh[] = [];
  const screens: ScreenPart[] = [];
  const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();

  for (const { mesh, role } of meshes) {
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    switch (role) {
      case "body": {
        const src = mesh.material as THREE.MeshStandardMaterial;
        const m = (src && "isMeshStandardMaterial" in src ? src.clone() : new THREE.MeshStandardMaterial({ color: "#9d927f" })) as THREE.MeshStandardMaterial;
        if (/glass/i.test(m.name)) {
          m.roughness = Math.min(m.roughness, 0.1);
          m.metalness = Math.max(m.metalness, 0.55);
          m.envMapIntensity = 1.4;
        } else {
          m.envMapIntensity = 0.9;
        }
        // Floodlight masonry (limestone, stone, marble, brick, copper, trim); not glass, metal or roofs.
        const flood = /limestone|stone|marble|brick|copper|trim|concrete/i.test(m.name) ? 1 : 0;
        patchBodyMaterial(m, city, hero, flood);
        owned.materials.push(m);
        mesh.material = m;
        originals.set(mesh, m);
        bodyMeshes.push(mesh);
        break;
      }
      case "windows":
        ensureWindowAttributes(mesh.geometry, spec);
        mesh.material = windowMat;
        break;
      case "crown":
        mesh.material = crownMat;
        crownMeshes.push(mesh);
        break;
      case "accent":
        mesh.material = accentMat;
        crownMeshes.push(mesh);
        break;
      case "ring":
        mesh.material = ringMat;
        crownMeshes.push(mesh);
        break;
      case "led":
        ledMeshes.push(mesh);
        break;
      case "screen": {
        mesh.geometry.computeBoundingBox();
        const bb = mesh.geometry.boundingBox!;
        const size = new THREE.Vector3();
        bb.getSize(size);
        const horiz = Math.max(size.x, size.z);
        const aspect = horiz / Math.max(0.01, size.y);
        const index = screenIndex(mesh);
        const spec2 = spec.screens.find((s) => s.name === screenName(mesh));
        screens.push({ name: screenName(mesh), index, mesh, aspect: spec2 ? spec2.width / spec2.height : aspect });
        break;
      }
      case "flag": {
        const src = mesh.material as THREE.Material;
        const m = src.clone();
        owned.materials.push(m);
        mesh.material = m;
        break;
      }
    }
  }

  const bounds = new THREE.Box3();
  root.updateMatrixWorld(true);
  for (const m of bodyMeshes) bounds.expandByObject(m);
  if (bounds.isEmpty()) bounds.setFromObject(root);

  // The water reflection only needs each tower's main masses, windows and crown:
  // trim, metalwork, flags, accents and displays stay out of it (fewer draw calls).
  const sizeOf = (m: THREE.Mesh) => new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3()).length();
  const keep = new Set(bodyMeshes.slice().sort((a, b) => sizeOf(b) - sizeOf(a)).slice(0, 2));
  for (const { mesh, role } of meshes) {
    const reflected = role === "windows" || role === "crown" || role === "ring" || (role === "body" && keep.has(mesh));
    if (!reflected) mesh.layers.set(NO_REFLECTION_LAYER);
  }

  const edges = cageOf(bodyMeshes, root, Math.max(1.6, spec.floorHeight * 7));
  if (edges) owned.geometries.push(edges);

  const ghost = new THREE.Group();
  ghost.visible = false;
  ghost.layers.set(NO_REFLECTION_LAYER);
  for (const m of bodyMeshes) {
    const g = new THREE.Mesh(m.geometry, ghostMat);
    m.updateMatrix();
    g.matrixAutoUpdate = false;
    root.updateMatrixWorld(true);
    g.matrix.copy(new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(m.matrixWorld));
    g.renderOrder = 3;
    g.layers.set(NO_REFLECTION_LAYER);
    ghost.add(g);
  }
  root.add(ghost);

  return {
    root,
    fromGltf,
    bodyMeshes,
    ghost,
    edges,
    bounds,
    crownMat,
    accentMat,
    ringMat,
    crownMeshes,
    ledMeshes,
    screens,
    setConstruction(on) {
      for (const m of bodyMeshes) m.material = on ? concreteMat : (originals.get(m) as THREE.Material);
      ghost.visible = on;
      for (const c of crownMeshes) c.visible = !on;
      for (const l of ledMeshes) l.visible = !on;
      for (const s of screens) s.mesh.visible = !on;
    },
    dispose() {
      owned.geometries.forEach((g) => g.dispose());
      owned.materials.forEach((m) => m.dispose());
    },
  };
}

/** Prepare a cloned GLB scene. */
export function buildFromGltf(scene: THREE.Object3D, ctx: Ctx): BodyParts {
  const root = new THREE.Group();
  const clone = scene.clone(true);
  root.add(clone);
  const meshes: { mesh: THREE.Mesh; role: Role }[] = [];
  clone.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes.push({ mesh, role: roleOf(mesh, clone) });
  });
  return finish(ctx, root, meshes, { geometries: [], materials: [] }, true);
}

// --- Placeholder towers -------------------------------------------------------

function partGeometry(p: PlaceholderPart): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  switch (p.kind) {
    case "box":
      g = new THREE.BoxGeometry(p.w, p.h, p.d).translate(0, p.h / 2, 0);
      break;
    case "cylinder":
      g = new THREE.CylinderGeometry(p.w, p.w, p.h, 32).translate(0, p.h / 2, 0);
      break;
    case "dome":
      g = new THREE.SphereGeometry(p.w, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, p.h / p.w, 1);
      break;
    case "spire":
      g = new THREE.ConeGeometry(p.w, p.h, 8).translate(0, p.h / 2, 0);
      break;
    case "pyramid":
      g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4).scale(p.w, p.h, p.d).translate(0, p.h / 2, 0);
      break;
  }
  if (p.rot) g.rotateY(p.rot);
  g.translate(p.x, p.y0, p.z);
  return g;
}

/** Window quads with _floor/_seed/uv for a box or cylinder part (model space). */
function windowGeometry(p: PlaceholderPart, floorH: number, rng: () => number): THREE.BufferGeometry | null {
  const pos: number[] = [];
  const uv: number[] = [];
  const fl: number[] = [];
  const sd: number[] = [];
  const idx: number[] = [];
  const glass = !!p.glass;
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, floor: number) => {
    const base = pos.length / 3;
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    const s = rng();
    fl.push(floor, floor, floor, floor);
    sd.push(s, s, s, s);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const f0 = Math.ceil(p.y0 / floorH - 0.01);
  const f1 = Math.floor((p.y0 + p.h) / floorH) - 1;
  const rot = new THREE.Matrix4().makeRotationY(p.rot ?? 0);
  const off = new THREE.Vector3(p.x, 0, p.z);
  if (p.kind === "box") {
    const faces = [
      { n: new THREE.Vector3(0, 0, 1), t: new THREE.Vector3(1, 0, 0), half: p.d / 2, len: p.w },
      { n: new THREE.Vector3(0, 0, -1), t: new THREE.Vector3(-1, 0, 0), half: p.d / 2, len: p.w },
      { n: new THREE.Vector3(1, 0, 0), t: new THREE.Vector3(0, 0, -1), half: p.w / 2, len: p.d },
      { n: new THREE.Vector3(-1, 0, 0), t: new THREE.Vector3(0, 0, 1), half: p.w / 2, len: p.d },
    ];
    for (const f of faces) {
      const n = f.n.clone().applyMatrix4(rot);
      const t = f.t.clone().applyMatrix4(rot);
      const cols = Math.max(1, Math.floor((f.len - 0.3) / 0.42));
      const bay = (f.len - 0.3) / cols;
      const ww = bay * (glass ? 0.84 : 0.56);
      for (let fl0 = Math.max(f0, 0); fl0 <= f1; fl0++) {
        const y0 = fl0 * floorH + floorH * (glass ? 0.1 : 0.2);
        const y1 = fl0 * floorH + floorH * (glass ? 0.92 : 0.8);
        for (let c = 0; c < cols; c++) {
          const s = -f.len / 2 + 0.15 + bay * (c + 0.5);
          const center = off.clone().addScaledVector(n, f.half + 0.012).addScaledVector(t, s);
          const a = center.clone().addScaledVector(t, -ww / 2).setY(y0);
          const b = center.clone().addScaledVector(t, ww / 2).setY(y0);
          const cc = center.clone().addScaledVector(t, ww / 2).setY(y1);
          const d = center.clone().addScaledVector(t, -ww / 2).setY(y1);
          quad(a, b, cc, d, fl0);
        }
      }
    }
  } else if (p.kind === "cylinder") {
    const r = p.w + 0.012;
    const cols = Math.max(6, Math.floor((Math.PI * 2 * p.w) / 0.42));
    for (let fl0 = Math.max(f0, 0); fl0 <= f1; fl0++) {
      const y0 = fl0 * floorH + floorH * 0.12;
      const y1 = fl0 * floorH + floorH * 0.9;
      for (let c = 0; c < cols; c++) {
        const a0 = (c / cols) * Math.PI * 2 + 0.02;
        const a1 = ((c + 1) / cols) * Math.PI * 2 - 0.02;
        const pa = new THREE.Vector3(Math.sin(a0) * r, 0, Math.cos(a0) * r).add(off);
        const pb = new THREE.Vector3(Math.sin(a1) * r, 0, Math.cos(a1) * r).add(off);
        quad(pa.clone().setY(y0), pb.clone().setY(y0), pb.clone().setY(y1), pa.clone().setY(y1), fl0);
      }
    }
  } else {
    return null;
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("_floor", new THREE.Float32BufferAttribute(fl, 1));
  g.setAttribute("_seed", new THREE.Float32BufferAttribute(sd, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function ledBandGeometry(w: number, d: number, y: number, h: number): THREE.BufferGeometry {
  // Four faces wrapping the box; u runs 0..1 around the perimeter.
  const P = 2 * (w + d);
  const pts: [number, number][] = [
    [-w / 2, d / 2],
    [w / 2, d / 2],
    [w / 2, -d / 2],
    [-w / 2, -d / 2],
    [-w / 2, d / 2],
  ];
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let acc = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, az] = pts[i]!;
    const [bx, bz] = pts[i + 1]!;
    const len = Math.hypot(bx - ax, bz - az);
    const nx = (bz - az) / len;
    const nz = -(bx - ax) / len;
    const o = 0.05;
    const base = pos.length / 3;
    pos.push(ax + nx * o, y, az + nz * o, bx + nx * o, y, bz + nz * o, bx + nx * o, y + h, bz + nz * o, ax + nx * o, y + h, az + nz * o);
    uv.push(acc / P, 0, (acc + len) / P, 0, (acc + len) / P, 1, acc / P, 1);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    acc += len;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildPlaceholder(ctx: Ctx): BodyParts {
  const { spec, model } = ctx;
  const root = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const meshes: { mesh: THREE.Mesh; role: Role }[] = [];
  const rng = mulberry32(model.length * 977 + 13);
  const stone = new THREE.MeshStandardMaterial({ color: "#a39784", roughness: 0.82, name: "Limestone" });
  const glass = new THREE.MeshStandardMaterial({ color: "#1f2f38", roughness: 0.1, metalness: 0.6, name: "Glass" });
  materials.push(stone, glass);
  const floorH = spec.floorHeight > 0.25 ? spec.floorHeight : 0.4;
  const windowParts: THREE.BufferGeometry[] = [];
  for (const p of spec.parts) {
    const g = partGeometry(p);
    geometries.push(g);
    const role: Role = p.role === "body" ? "body" : p.role === "crown" ? "crown" : "accent";
    const mesh = new THREE.Mesh(g, role === "body" ? (p.glass ? glass : stone) : stone);
    mesh.name = role === "body" ? "Body" : role === "crown" ? "Crown" : "Accent";
    root.add(mesh);
    meshes.push({ mesh, role });
    if (p.role === "body") {
      const wg = windowGeometry(p, floorH, rng);
      if (wg) windowParts.push(wg);
    }
  }
  if (windowParts.length) {
    const wg = mergeGeometries(windowParts, false)!;
    windowParts.forEach((w) => w.dispose());
    geometries.push(wg);
    const wm = new THREE.Mesh(wg, stone);
    wm.name = "Windows";
    root.add(wm);
    meshes.push({ mesh: wm, role: "windows" });
  }
  if (spec.ledBand) {
    const body = spec.parts.find((p) => p.role === "body" && p.kind === "box");
    if (body) {
      const g = ledBandGeometry(body.w, body.d, spec.ledBand.y, spec.ledBand.height);
      geometries.push(g);
      const m = new THREE.Mesh(g, stone);
      m.name = "LED";
      root.add(m);
      meshes.push({ mesh: m, role: "led" });
    }
  }
  if (spec.screens.length) {
    const body = spec.parts.find((p) => p.role === "body" && p.kind === "box");
    if (body) {
      const layout: { face: "s" | "e"; y: number }[] = [
        { face: "s", y: 7.4 },
        { face: "e", y: 6.8 },
        { face: "s", y: 12.0 },
        { face: "s", y: 3.9 },
        { face: "e", y: 11.0 },
      ];
      spec.screens.forEach((s, i) => {
        const l = layout[i % layout.length]!;
        const g = new THREE.PlaneGeometry(Math.min(s.width, (l.face === "s" ? body.w : body.d) - 0.3), s.height);
        if (l.face === "s") g.translate(body.x, l.y, body.z + body.d / 2 + 0.06);
        else {
          g.rotateY(Math.PI / 2);
          g.translate(body.x + body.w / 2 + 0.06, l.y, body.z);
        }
        geometries.push(g);
        const m = new THREE.Mesh(g, stone);
        m.name = s.name;
        root.add(m);
        meshes.push({ mesh: m, role: "screen" });
      });
    }
  }
  return finish(ctx, root, meshes, { geometries, materials }, false);
}
