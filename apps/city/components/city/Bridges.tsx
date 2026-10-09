"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { BridgeModel } from "@/lib/scene/bridges";
import { NO_REFLECTION_LAYER } from "@/lib/scene/layout";
import { useCity } from "./cityContext";
import { createSpriteMaterial, createSpriteMesh } from "./sprites";

// The East River bridges: floodlit towers, dark decks, fine cables and the
// necklace of lights along the main cables (which also reflect in the water).

const KIND_COLOR: [number, number, number][] = [
  [0.035, 0.035, 0.04], // deck
  [0.26, 0.23, 0.19], // stone towers
  [0.12, 0.16, 0.2], // steel towers
];

export function Bridges({ model }: { model: BridgeModel }) {
  const { uniforms } = useCity();
  const parts = useMemo(() => {
    const geos = model.boxes.map((b) => {
      const g = new THREE.BoxGeometry(b.w, b.h, b.d).translate(b.x, b.y, b.z).toNonIndexed();
      g.deleteAttribute("uv");
      const n = g.attributes.position!.count;
      const col = new Float32Array(n * 3);
      const glow = new Float32Array(n);
      const c = KIND_COLOR[b.kind]!;
      const pos = g.attributes.position!;
      for (let i = 0; i < n; i++) {
        col.set(c, i * 3);
        // Floodlights wash the towers from below.
        glow[i] = b.kind === 0 ? 0 : Math.pow(Math.max(0, 1 - (pos.getY(i) - b.y + b.h / 2) / Math.max(1, b.h)), 1.6) * 0.75 + 0.06;
      }
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      g.setAttribute("aGlow", new THREE.BufferAttribute(glow, 1));
      return g;
    });
    const geo = mergeGeometries(geos)!;
    geos.forEach((g) => g.dispose());
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.1 });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uLightGain = uniforms.uLightGain;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aGlow; varying float vGlow;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlow = aGlow;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform float uLightGain; varying float vGlow;")
        .replace(
          "#include <emissivemap_fragment>",
          "#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.82, 0.6) * vGlow * 0.9 * uLightGain;",
        );
    };
    mat.customProgramCacheKey = () => "city-bridge-v1";
    const body = new THREE.Mesh(geo, mat);
    body.name = "bridges";

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.Float32BufferAttribute(model.lines, 3));
    const lineMat = new THREE.LineBasicMaterial({ color: new THREE.Color(0.32, 0.34, 0.38), transparent: true, opacity: 0.75 });
    const cables = new THREE.LineSegments(lineGeo, lineMat);
    cables.layers.set(NO_REFLECTION_LAYER);
    cables.raycast = () => {};

    const lightMat = createSpriteMaterial(uniforms, { mode: 0, gain: 2.3, minPixel: 2.2 });
    const lights = createSpriteMesh(
      model.lights.map((l, i) => ({ x: l.x, y: l.y, z: l.z, size: 0.32, phase: i * 0.13, color: [1, 0.86, 0.62] as [number, number, number] })),
      lightMat,
    );
    return { body, cables, lights, mats: [mat, lineMat, lightMat] as THREE.Material[] };
  }, [model, uniforms]);

  useEffect(
    () => () => {
      parts.body.geometry.dispose();
      parts.cables.geometry.dispose();
      parts.lights.geometry.dispose();
      parts.mats.forEach((m) => m.dispose());
    },
    [parts],
  );

  return (
    <group name="bridges">
      <primitive object={parts.body} />
      <primitive object={parts.cables} />
      <primitive object={parts.lights} />
    </group>
  );
}
