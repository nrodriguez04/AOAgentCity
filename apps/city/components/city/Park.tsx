"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { treeGeometry } from "@/lib/scene/geometries";
import { NO_REFLECTION_LAYER } from "@/lib/scene/layout";
import { withStreetGlow } from "@/lib/scene/materials";
import type { Tree } from "@/lib/scene/parkGen";
import { mulberry32 } from "@/lib/scene/random";
import { useCity } from "./cityContext";

/** Low-poly instanced trees: Central Park, the Battery and the street trees. */
export function Trees({ trees }: { trees: Tree[] }) {
  const { uniforms } = useCity();
  const mesh = useMemo(() => {
    const mat = withStreetGlow(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 }), uniforms, {
      key: "trees",
    });
    const m = new THREE.InstancedMesh(treeGeometry(), mat, trees.length);
    const rng = mulberry32(5150);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const c = new THREE.Color();
    trees.forEach((t, i) => {
      q.setFromAxisAngle(up, rng() * Math.PI * 2);
      m4.compose(p.set(t.x, 0, t.z), q, s.set(t.r, t.h, t.r));
      m.setMatrixAt(i, m4);
      m.setColorAt(i, c.set(t.color));
    });
    m.computeBoundingSphere();
    m.name = "trees";
    m.layers.set(NO_REFLECTION_LAYER);
    return m;
  }, [trees, uniforms]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    },
    [mesh],
  );
  return <primitive object={mesh} />;
}
