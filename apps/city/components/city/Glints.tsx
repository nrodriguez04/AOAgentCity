"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { BridgeModel } from "@/lib/scene/bridges";
import { FAR_SHORES, NO_REFLECTION_LAYER, WATER_LEVEL } from "@/lib/scene/layout";
import { mulberry32, range } from "@/lib/scene/random";
import type { Lamp } from "@/lib/scene/streetGen";
import { useCity } from "./cityContext";

// Light streaks on the rivers. For every light near the water, the vertex
// shader finds where its mirror image meets the water surface as seen from
// the camera and lays a rippling streak there, stretched toward the viewer.

const VERT = /* glsl */ `
attribute vec3 aSrc;
attribute float aSeed;
attribute vec3 aColor;
uniform float uWater;
uniform float uTime;
uniform float uFogNear;
uniform float uFogFar;
varying vec2 vUv;
varying float vI;
varying vec3 vColor;
varying float vSeed;
void main() {
  vec3 m = vec3(aSrc.x, 2.0 * uWater - aSrc.y, aSrc.z);
  vec3 C = cameraPosition;
  float t = (uWater - C.y) / (m.y - C.y);
  vec3 R = C + t * (m - C);
  vec2 toCam = C.xz - R.xz;
  float lc = max(length(toCam), 1e-3);
  toCam /= lc;
  vec2 side = vec2(-toCam.y, toCam.x);
  float dist = length(C - R);
  float L = (0.9 + 1.8 * aSeed) * (0.7 + dist * 0.01) * (aSrc.y * 0.35 + 0.7);
  float W = 0.16 + dist * 0.0018;
  vec2 p = R.xz + side * position.x * W + toCam * (position.y + 0.35) * L;
  vec4 mv = viewMatrix * vec4(p.x, uWater + 0.03, p.y, 1.0);
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vSeed = aSeed;
  vColor = aColor;
  float flick = 0.65 + 0.35 * sin(uTime * (1.3 + aSeed * 2.2) + aSeed * 40.0);
  vI = flick * (1.0 - smoothstep(uFogNear, uFogFar * 1.1, -mv.z)) * step(0.0, t) * step(t, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying float vI;
varying vec3 vColor;
varying float vSeed;
void main() {
  vec2 q = (vUv - 0.5) * 2.0;
  float across = exp(-q.x * q.x * 3.5);
  float along = smoothstep(-1.0, -0.6, q.y) * (1.0 - smoothstep(-0.2, 1.0, q.y));
  // Broken into ripples.
  float rip = 0.55 + 0.45 * sin(vUv.y * 46.0 - uTime * 2.4 + vSeed * 30.0) * sin(vUv.y * 17.0 + uTime * 1.1);
  float a = across * along * rip * vI;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
}`;

export function WaterGlints({ lamps, bridges, low }: { lamps: Lamp[]; bridges: BridgeModel; low: boolean }) {
  const { uniforms } = useCity();
  const mesh = useMemo(() => {
    const rng = mulberry32(8080);
    const src: { x: number; y: number; z: number; c: [number, number, number] }[] = [];
    for (const l of lamps) {
      if (!l.shore) continue;
      src.push({ x: l.x, y: l.kind === 0 ? 0.85 : 0.45, z: l.z, c: [1.0, 0.55, 0.2] });
    }
    for (const [i, l] of bridges.lights.entries()) if (i % 2 === 0) src.push({ x: l.x, y: l.y, z: l.z, c: [1.0, 0.8, 0.55] });
    // Lit windows along the far waterfronts.
    for (const shore of FAR_SHORES) {
      for (let i = 0; i < shore.length - 1; i++) {
        const a = shore[i]!;
        const b = shore[i + 1]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (Math.abs(a[0]) > 200 || Math.abs(b[0]) > 200) continue;
        for (let s = 0; s < len; s += 2.6) {
          if (rng() < 0.35) continue;
          const t = s / len;
          const warm = rng() < 0.75;
          src.push({
            x: a[0] + (b[0] - a[0]) * t,
            y: range(rng, 0.6, 3.2),
            z: a[1] + (b[1] - a[1]) * t,
            c: warm ? [1.0, 0.62, 0.3] : [0.65, 0.78, 1.0],
          });
        }
      }
    }
    const list = low ? src.filter((_, i) => i % 2 === 0) : src;
    const n = list.length;
    const geo = new THREE.PlaneGeometry(1, 1);
    const a = new Float32Array(n * 3);
    const sd = new Float32Array(n);
    const col = new Float32Array(n * 3);
    list.forEach((g, i) => {
      a.set([g.x, g.y, g.z], i * 3);
      sd[i] = rng();
      col.set(g.c.map((v) => v * 0.42), i * 3);
    });
    geo.setAttribute("aSrc", new THREE.InstancedBufferAttribute(a, 3));
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(sd, 1));
    geo.setAttribute("aColor", new THREE.InstancedBufferAttribute(col, 3));
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uWater: { value: WATER_LEVEL }, uTime: uniforms.uTime, uFogNear: uniforms.uFogNear, uFogFar: uniforms.uFogFar },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const m = new THREE.InstancedMesh(geo, mat, n);
    m.frustumCulled = false;
    m.renderOrder = 3;
    m.layers.set(NO_REFLECTION_LAYER);
    m.raycast = () => {};
    m.name = "water-glints";
    return m;
  }, [lamps, bridges, low, uniforms]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    },
    [mesh],
  );
  return <primitive object={mesh} />;
}
