import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// Small low-poly meshes shared by the instanced props. Each is built in its
// final local units so instance matrices only translate, rotate and scale.

function colored(geo: THREE.BufferGeometry, color: [number, number, number], glow = 0): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position!.count;
  const c = new Float32Array(n * 3);
  const gl = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    c[i * 3] = color[0];
    c[i * 3 + 1] = color[1];
    c[i * 3 + 2] = color[2];
    gl[i] = glow;
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  g.setAttribute("aPart", new THREE.BufferAttribute(gl, 1));
  if (g.attributes.uv) g.deleteAttribute("uv");
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error("mergeGeometries failed");
  merged.computeBoundingSphere();
  return merged;
}

/** Classic NYC rooftop water tank on steel legs (radius ~0.2 at scale 1). */
export function waterTowerGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const steel: [number, number, number] = [0.13, 0.12, 0.115];
  for (const [x, z] of [
    [-0.12, -0.12],
    [0.12, -0.12],
    [-0.12, 0.12],
    [0.12, 0.12],
  ] as const) {
    parts.push(colored(new THREE.BoxGeometry(0.026, 0.25, 0.026).translate(x, 0.125, z), steel));
  }
  parts.push(colored(new THREE.CylinderGeometry(0.225, 0.225, 0.025, 10).translate(0, 0.255, 0), steel));
  parts.push(colored(new THREE.CylinderGeometry(0.2, 0.2, 0.34, 12, 1, false).translate(0, 0.437, 0), [0.4, 0.28, 0.18]));
  parts.push(colored(new THREE.CylinderGeometry(0.206, 0.206, 0.02, 12, 1, true).translate(0, 0.35, 0), [0.1, 0.09, 0.085]));
  parts.push(colored(new THREE.CylinderGeometry(0.206, 0.206, 0.02, 12, 1, true).translate(0, 0.52, 0), [0.1, 0.09, 0.085]));
  parts.push(colored(new THREE.ConeGeometry(0.218, 0.14, 12).translate(0, 0.677, 0), [0.11, 0.1, 0.095]));
  return merge(parts);
}

/** Cobra-head street lamp: pole, arm along +x and a glowing head (aPart = 1). */
export function lampGeometry(): THREE.BufferGeometry {
  const metal: [number, number, number] = [0.09, 0.095, 0.1];
  return merge([
    colored(new THREE.BoxGeometry(0.035, 0.86, 0.035).translate(0, 0.43, 0), metal),
    colored(new THREE.BoxGeometry(0.42, 0.024, 0.024).translate(0.2, 0.85, 0), metal),
    colored(new THREE.BoxGeometry(0.17, 0.034, 0.075).translate(0.41, 0.83, 0), [1, 1, 1], 1),
  ]);
}

/** A small car: body + cabin (aPart = 1 marks the glass cabin). Length along +z. */
export function carGeometry(): THREE.BufferGeometry {
  return merge([
    colored(new THREE.BoxGeometry(0.18, 0.07, 0.44).translate(0, 0.055, 0), [1, 1, 1], 0),
    colored(new THREE.BoxGeometry(0.162, 0.062, 0.22).translate(0, 0.12, -0.02), [1, 1, 1], 1),
  ]);
}

/** Low-poly tree in unit space: scale (radius, height, radius). */
export function treeGeometry(): THREE.BufferGeometry {
  const canopy = new THREE.IcosahedronGeometry(1, 0);
  canopy.scale(1, 0.42, 1).translate(0, 0.6, 0);
  const canopy2 = new THREE.IcosahedronGeometry(0.62, 0);
  canopy2.scale(1, 0.42, 1).rotateY(0.6).translate(0.28, 0.82, -0.12);
  return merge([
    colored(new THREE.CylinderGeometry(0.05, 0.07, 0.38, 5).translate(0, 0.19, 0), [0.16, 0.11, 0.08]),
    colored(canopy, [1, 1, 1]),
    colored(canopy2, [0.85, 0.9, 0.85]),
  ]);
}

/** Tapered mast: radius 0.5 at the base, 0.15 at the top, height 1 (base at y = 0). */
export function needleGeometry(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(0.15, 0.5, 1, 6, 1).translate(0, 0.5, 0);
}

/** Four-sided pyramid with a 1x1 base at y = 0 and its apex at y = 1. */
export function pyramidGeometry(): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0);
  const ng = g.toNonIndexed();
  ng.computeVertexNormals();
  return ng;
}

/** Unit box with its base at y = 0 (for instanced props placed on roofs). */
export function baseBoxGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
}
