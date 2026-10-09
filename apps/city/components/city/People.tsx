"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { AVENUE_HALF, NO_REFLECTION_LAYER, SIDEWALK, TIMES_SQUARE, broadwayXAt, inTimesSquare } from "@/lib/scene/layout";
import { mulberry32, range } from "@/lib/scene/random";
import { useCity } from "./cityContext";

// Times Square crowds: tiny figures strolling back and forth on the bowtie
// plaza and its sidewalks. Positions are animated in the vertex shader, so the
// whole crowd is one instanced draw call.

function personGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(0.055, 0.12, 0.04).translate(0, 0.085, 0);
  const legs = new THREE.BoxGeometry(0.045, 0.05, 0.03).translate(0, 0.025, 0);
  const head = new THREE.BoxGeometry(0.035, 0.035, 0.035).translate(0, 0.165, 0);
  for (const g of [body, legs, head]) g.deleteAttribute("uv");
  return mergeGeometries([body, legs, head])!;
}

const CLOTHES = ["#1b1d22", "#2a2f3a", "#3b2a24", "#5c1f24", "#e0d8c8", "#2e4a6b", "#b23a2e", "#d9a32f", "#3f5c3a", "#111111", "#6b6e75"];

export function TimesSquareCrowd({ count = 520 }: { count?: number }) {
  const { uniforms } = useCity();
  const mesh = useMemo(() => {
    const rng = mulberry32(2026);
    const walk = new Float32Array(count * 4); // start x, z, dir angle, length
    const gait = new Float32Array(count * 2); // speed, phase
    const color = new Float32Array(count * 3);
    const c = new THREE.Color();
    let n = 0;
    let guard = 0;
    while (n < count && guard++ < count * 40) {
      const z = TIMES_SQUARE.z + range(rng, -TIMES_SQUARE.halfLength - 4, TIMES_SQUARE.halfLength + 4);
      const bx = broadwayXAt(z);
      const lo = Math.min(bx, TIMES_SQUARE.x) - 2.4;
      const hi = Math.max(bx, TIMES_SQUARE.x) + 2.4;
      const x = range(rng, lo, hi);
      const onPlaza = inTimesSquare(x, z) && Math.abs(x - TIMES_SQUARE.x) > AVENUE_HALF + 0.1;
      const onSidewalk = !inTimesSquare(x, z, 0.2) && Math.abs(Math.abs(x - TIMES_SQUARE.x) - AVENUE_HALF - SIDEWALK / 2) < SIDEWALK / 2;
      if (!onPlaza && !onSidewalk) continue;
      const along = onSidewalk || rng() < 0.6;
      walk.set([x, z, along ? (rng() < 0.5 ? 0 : Math.PI) + range(rng, -0.25, 0.25) : rng() * Math.PI * 2, range(rng, 0.6, 2.6)], n * 4);
      gait.set([range(rng, 0.18, 0.42), rng()], n * 2);
      c.set(CLOTHES[Math.floor(rng() * CLOTHES.length)]!);
      color.set([c.r, c.g, c.b], n * 3);
      n++;
    }
    const geo = personGeometry();
    geo.setAttribute("aWalk", new THREE.InstancedBufferAttribute(walk, 4));
    geo.setAttribute("aGait", new THREE.InstancedBufferAttribute(gait, 2));
    geo.setAttribute("aCloth", new THREE.InstancedBufferAttribute(color, 3));
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.8 });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = uniforms.uTime;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform float uTime; attribute vec4 aWalk; attribute vec2 aGait; attribute vec3 aCloth; varying vec3 vCloth;`,
        )
        .replace(
          "#include <beginnormal_vertex>",
          `vec2 wDir = vec2(sin(aWalk.z), cos(aWalk.z));
          float wT = uTime * aGait.x / aWalk.w + aGait.y;
          float wPing = abs(fract(wT) * 2.0 - 1.0);
          float wSign = fract(wT) < 0.5 ? 1.0 : -1.0;
          vec2 wP = aWalk.xy + wDir * (wPing - 0.5) * aWalk.w;
          vec2 fwd = wDir * wSign;
          vec2 side = vec2(fwd.y, -fwd.x);
          vec3 objectNormal = vec3(side.x, 0.0, side.y) * normal.x + vec3(0.0, normal.y, 0.0) + vec3(fwd.x, 0.0, fwd.y) * normal.z;
          #ifdef USE_TANGENT
            vec3 objectTangent = vec3(tangent.xyz);
          #endif`,
        )
        .replace(
          "#include <begin_vertex>",
          `float bob = abs(sin(uTime * 7.0 * aGait.x + aGait.y * 20.0)) * 0.012;
          vec3 transformed = vec3(wP.x, bob, wP.y) + vec3(side.x, 0.0, side.y) * position.x + vec3(0.0, position.y, 0.0) + vec3(fwd.x, 0.0, fwd.y) * position.z;
          vCloth = aCloth;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vCloth;")
        .replace(
          "#include <color_fragment>",
          "#include <color_fragment>\ndiffuseColor.rgb = vCloth;",
        )
        .replace(
          "#include <emissivemap_fragment>",
          // Lit by the screens all around: a colourful wash.
          "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vCloth * 0.25 + vec3(0.06, 0.03, 0.05);",
        );
    };
    mat.customProgramCacheKey = () => "city-crowd-v1";
    const m = new THREE.InstancedMesh(geo, mat, n);
    m.frustumCulled = false;
    m.layers.set(NO_REFLECTION_LAYER);
    m.name = "times-square-crowd";
    return m;
  }, [count, uniforms]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    },
    [mesh],
  );
  return <primitive object={mesh} />;
}
