"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { CityModel } from "@/lib/scene/cityGen";
import { baseBoxGeometry, needleGeometry, pyramidGeometry, waterTowerGeometry } from "@/lib/scene/geometries";
import { NO_REFLECTION_LAYER } from "@/lib/scene/layout";
import { createBuildingMaterial, withStreetGlow } from "@/lib/scene/materials";
import { useCity } from "./cityContext";
import { createSpriteMaterial, createSpriteMesh } from "./sprites";

// Procedural filler: ~1500 buildings as instanced box tiers (one draw call),
// plus cornices, crowns and rooftop props (one draw call each).

function disposeMesh(mesh: THREE.Mesh) {
  mesh.geometry.dispose();
  const m = mesh.material;
  if (Array.isArray(m)) m.forEach((x) => x.dispose());
  else m.dispose();
}

export function CityGrid({ model }: { model: CityModel }) {
  const { uniforms } = useCity();

  const meshes = useMemo(() => {
    const out: THREE.Object3D[] = [];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const col = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);

    // Buildings.
    {
      const n = model.tiers.length;
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const style = new Float32Array(n * 4);
      const tint = new Float32Array(n * 3);
      const flags = new Float32Array(n * 4);
      const mesh = new THREE.InstancedMesh(geo, createBuildingMaterial(uniforms), n);
      model.tiers.forEach((t, i) => {
        m4.makeScale(t.w, t.h, t.d);
        m4.setPosition(t.cx, t.y0 + t.h / 2, t.cz);
        mesh.setMatrixAt(i, m4);
        const litJitter = 0.8 + 0.4 * ((t.seed * 7.31) % 1);
        style.set([t.style, t.floorH, t.lit * litJitter, t.seed], i * 4);
        col.set(t.color);
        tint.set([col.r, col.g, col.b], i * 3);
        flags.set([0, t.flood, t.storefront ? 1 : 0, t.billboardTop], i * 4);
      });
      geo.setAttribute("aStyle", new THREE.InstancedBufferAttribute(style, 4));
      geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tint, 3));
      geo.setAttribute("aFlags", new THREE.InstancedBufferAttribute(flags, 4));
      mesh.computeBoundingSphere();
      mesh.name = "filler-buildings";
      out.push(mesh);
    }

    // Cornices.
    {
      const n = Math.max(1, model.cornices.length);
      const mat = withStreetGlow(new THREE.MeshStandardMaterial({ roughness: 0.8 }), uniforms, { key: "cornice" });
      const mesh = new THREE.InstancedMesh(baseBoxGeometry(), mat, n);
      model.cornices.forEach((b, i) => {
        m4.makeScale(b.w, b.h, b.d);
        m4.setPosition(b.cx, b.y0, b.cz);
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, col.set(b.color));
      });
      mesh.count = model.cornices.length;
      mesh.computeBoundingSphere();
      out.push(mesh);
    }

    // Pyramid crowns (copper and slate), floodlit from below.
    {
      const n = Math.max(1, model.caps.length);
      const geo = pyramidGeometry();
      const glow = new Float32Array(n);
      const mat = withStreetGlow(new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.2 }), uniforms, {
        instancedGlow: true,
        key: "caps",
        glowColor: "vec3(1.0, 0.78, 0.5)",
      });
      const mesh = new THREE.InstancedMesh(geo, mat, n);
      model.caps.forEach((b, i) => {
        m4.makeScale(b.w, b.h, b.d);
        m4.setPosition(b.cx, b.y0, b.cz);
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, col.set(b.color));
        glow[i] = b.glow ?? 0;
      });
      geo.setAttribute("aGlow", new THREE.InstancedBufferAttribute(glow, 1));
      mesh.count = model.caps.length;
      mesh.computeBoundingSphere();
      out.push(mesh);
    }

    // AC units and bulkheads.
    {
      const n = Math.max(1, model.boxes.length);
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.3 });
      const mesh = new THREE.InstancedMesh(baseBoxGeometry(), mat, n);
      model.boxes.forEach((b, i) => {
        m4.makeScale(b.w, b.h, b.d);
        m4.setPosition(b.cx, b.y0, b.cz);
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, col.set(b.color));
      });
      mesh.count = model.boxes.length;
      mesh.computeBoundingSphere();
      out.push(mesh);
    }

    // Water towers.
    {
      const n = Math.max(1, model.waterTowers.length);
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
      const mesh = new THREE.InstancedMesh(waterTowerGeometry(), mat, n);
      model.waterTowers.forEach((w, i) => {
        q.setFromAxisAngle(up, w.rot);
        m4.compose(pos.set(w.x, w.y0, w.z), q, scl.setScalar(w.s));
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, col.setHSL(0.07 + w.tint * 0.03, 0.25 + w.tint * 0.2, 0.42 + w.tint * 0.18));
      });
      mesh.count = model.waterTowers.length;
      mesh.computeBoundingSphere();
      out.push(mesh);
    }

    // Antennas and spires.
    {
      const n = Math.max(1, model.needles.length);
      const mat = new THREE.MeshStandardMaterial({ color: "#5a5f66", roughness: 0.35, metalness: 0.8 });
      const mesh = new THREE.InstancedMesh(needleGeometry(), mat, n);
      model.needles.forEach((nd, i) => {
        m4.makeScale(nd.r * 2, nd.h, nd.r * 2);
        m4.setPosition(nd.x, nd.y0, nd.z);
        mesh.setMatrixAt(i, m4);
      });
      mesh.count = model.needles.length;
      mesh.computeBoundingSphere();
      out.push(mesh);
    }

    // Blinking red aviation lights.
    {
      const mat = createSpriteMaterial(uniforms, { mode: 1, gain: 3.2, minPixel: 3 });
      const mesh = createSpriteMesh(
        model.aviation.map((a) => ({ x: a.x, y: a.y, z: a.z, size: 0.45, phase: a.p, color: [1, 0.08, 0.04] as [number, number, number] })),
        mat,
      );
      out.push(mesh);
    }
    // Everything but the building masses is too small to matter in the water reflection.
    for (const o of out) if (o.name !== "filler-buildings") o.layers.set(NO_REFLECTION_LAYER);
    return out;
  }, [model, uniforms]);

  useEffect(
    () => () => {
      for (const o of meshes) if (o instanceof THREE.Mesh) disposeMesh(o);
    },
    [meshes],
  );

  return (
    <group name="city-grid">
      {meshes.map((o) => (
        <primitive key={o.uuid} object={o} />
      ))}
    </group>
  );
}
