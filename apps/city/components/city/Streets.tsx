"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { lampGeometry } from "@/lib/scene/geometries";
import { NO_REFLECTION_LAYER, type Vec2 } from "@/lib/scene/layout";
import type { CityUniforms } from "@/lib/scene/materials";
import type { Lamp, Pool } from "@/lib/scene/streetGen";
import { GLSL_HASH } from "@/lib/scene/glsl";
import { useCity } from "./cityContext";

// Streetlamps (one instanced mesh with glowing heads), the warm sodium light
// pools they cast on the asphalt (additive decals, one draw call) and steam
// rising from a few manholes.

function lampMaterial(u: CityUniforms) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.5 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLightGain = u.uLightGain;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aPart; varying float vPart;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPart = aPart;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uLightGain; varying float vPart;")
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.66, 0.34) * vPart * 6.0 * (0.4 + 0.6 * uLightGain);",
      );
  };
  mat.customProgramCacheKey = () => "city-lamp-v1";
  return mat;
}

const POOL_VERT = /* glsl */ `
attribute float aIntensity;
uniform float uFogNear;
uniform float uFogFar;
varying vec2 vUv;
varying float vI;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * wp;
  vI = aIntensity * (1.0 - smoothstep(uFogNear, uFogFar * 1.1, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;

const POOL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uGain;
uniform float uStreetGlow;
varying vec2 vUv;
varying float vI;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  // Soft sodium falloff with a hot spot under the lamp head.
  float a = exp(-d * d * 4.2) * (1.0 - smoothstep(0.7, 1.0, d)) * 0.8;
  a += exp(-d * d * 30.0) * 0.45;
  gl_FragColor = vec4(uColor * a * vI * uGain * uStreetGlow, 1.0);
}`;

export function StreetLights({ lamps, pools, parkLamps }: { lamps: Lamp[]; pools: Pool[]; parkLamps: Vec2[] }) {
  const { uniforms } = useCity();
  const { lampMesh, poolMesh } = useMemo(() => {
    const all: Lamp[] = [...lamps, ...parkLamps.map(([x, z]) => ({ x, z, dx: 0, dz: 0, kind: 1 as const }))];
    const allPools: Pool[] = [...pools, ...parkLamps.map(([x, z]) => ({ x, z, r: 0.95, intensity: 0.85 }))];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    const lampMesh = new THREE.InstancedMesh(lampGeometry(), lampMaterial(uniforms), all.length);
    all.forEach((l, i) => {
      const angle = l.kind === 0 ? Math.atan2(-l.dz, l.dx) : 0;
      q.setFromAxisAngle(up, angle);
      if (l.kind === 0) s.set(1, 1, 1);
      else s.set(0.18, 0.5, 1.2);
      m4.compose(p.set(l.x, 0, l.z), q, s);
      lampMesh.setMatrixAt(i, m4);
    });
    lampMesh.computeBoundingSphere();
    lampMesh.name = "streetlamps";

    const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const intensity = new Float32Array(allPools.length);
    const poolMat = new THREE.ShaderMaterial({
      vertexShader: POOL_VERT,
      fragmentShader: POOL_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(1.0, 0.5, 0.17) },
        uGain: { value: 0.55 },
        uStreetGlow: uniforms.uStreetGlow,
        uFogNear: uniforms.uFogNear,
        uFogFar: uniforms.uFogFar,
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const poolMesh = new THREE.InstancedMesh(poolGeo, poolMat, allPools.length);
    allPools.forEach((pl, i) => {
      m4.makeScale(pl.r * 2.5, 1, pl.r * 2.5);
      m4.setPosition(pl.x, 0.02, pl.z);
      poolMesh.setMatrixAt(i, m4);
      intensity[i] = pl.intensity;
    });
    poolGeo.setAttribute("aIntensity", new THREE.InstancedBufferAttribute(intensity, 1));
    poolMesh.computeBoundingSphere();
    poolMesh.renderOrder = 2;
    poolMesh.name = "light-pools";
    lampMesh.layers.set(NO_REFLECTION_LAYER);
    poolMesh.layers.set(NO_REFLECTION_LAYER);
    return { lampMesh, poolMesh };
  }, [lamps, pools, parkLamps, uniforms]);

  useEffect(
    () => () => {
      for (const m of [lampMesh, poolMesh]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
    [lampMesh, poolMesh],
  );

  return (
    <>
      <primitive object={lampMesh} />
      <primitive object={poolMesh} />
    </>
  );
}

// --- Steam -------------------------------------------------------------------

const STEAM_VERT = /* glsl */ `
attribute vec3 aVent;
attribute float aSeed;
uniform float uTime;
uniform float uFogNear;
uniform float uFogFar;
varying vec2 vUv;
varying float vA;
varying float vSeed;
void main() {
  vUv = uv;
  vSeed = aSeed;
  float life = 5.5 + aSeed * 2.5;
  float t = fract(uTime / life + aSeed * 7.13);
  vec3 c = aVent;
  c.y += 0.12 + t * (2.4 + aSeed);
  c.x += sin(t * 3.0 + aSeed * 20.0) * 0.18 + t * 0.9;
  c.z += cos(t * 2.3 + aSeed * 11.0) * 0.14 - t * 0.35;
  float size = 0.35 + t * 1.5;
  vec4 mv = viewMatrix * vec4(c, 1.0);
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;
  vA = smoothstep(0.0, 0.12, t) * (1.0 - t) * (1.0 - smoothstep(uFogNear, uFogFar, -mv.z));
}`;

const STEAM_FRAG = /* glsl */ `
uniform float uStreetGlow;
varying vec2 vUv;
varying float vA;
varying float vSeed;
${GLSL_HASH}
void main() {
  vec2 p = vUv - 0.5;
  float d = length(p) * 2.0;
  float n = cityNoise(vUv * 4.0 + vSeed * 13.0);
  float a = smoothstep(1.0, 0.2, d) * (0.55 + 0.45 * n) * vA;
  if (a < 0.003) discard;
  vec3 col = mix(vec3(1.0, 0.62, 0.32), vec3(0.85, 0.85, 0.95), 0.45);
  gl_FragColor = vec4(col * a * 0.32 * (0.5 + 0.5 * uStreetGlow), 1.0);
}`;

function stackGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const bands = 5;
  for (let i = 0; i < bands; i++) {
    const g = new THREE.CylinderGeometry(0.1, 0.11, 0.12, 10, 1, i !== bands - 1).translate(0, 0.06 + i * 0.12, 0);
    const n = g.attributes.position!.count;
    const c = new Float32Array(n * 3);
    const color = i % 2 === 0 ? [1.0, 0.32, 0.04] : [0.9, 0.9, 0.88];
    for (let k = 0; k < n; k++) c.set(color, k * 3);
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    g.deleteAttribute("uv");
    parts.push(g.toNonIndexed());
  }
  return mergeGeometries(parts)!;
}

export function SteamVents({ vents }: { vents: Vec2[] }) {
  const { uniforms } = useCity();
  const { puffs, stacks } = useMemo(() => {
    const per = 10;
    const n = vents.length * per;
    const geo = new THREE.PlaneGeometry(1, 1);
    const vent = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    let k = 0;
    vents.forEach(([x, z], vi) => {
      for (let i = 0; i < per; i++) {
        vent.set([x, 0, z], k * 3);
        seed[k] = (i + vi * 0.37) / per;
        k++;
      }
    });
    geo.setAttribute("aVent", new THREE.InstancedBufferAttribute(vent, 3));
    geo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: STEAM_VERT,
      fragmentShader: STEAM_FRAG,
      uniforms: { uTime: uniforms.uTime, uFogNear: uniforms.uFogNear, uFogFar: uniforms.uFogFar, uStreetGlow: uniforms.uStreetGlow },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const puffs = new THREE.InstancedMesh(geo, mat, n);
    puffs.frustumCulled = false;
    puffs.renderOrder = 6;

    const stackMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, emissive: "#2a1206" });
    const stacks = new THREE.InstancedMesh(stackGeometry(), stackMat, vents.length);
    const m4 = new THREE.Matrix4();
    vents.forEach(([x, z], i) => {
      m4.makeTranslation(x, 0, z);
      stacks.setMatrixAt(i, m4);
    });
    stacks.computeBoundingSphere();
    puffs.layers.set(NO_REFLECTION_LAYER);
    stacks.layers.set(NO_REFLECTION_LAYER);
    return { puffs, stacks };
  }, [vents, uniforms]);

  useEffect(
    () => () => {
      for (const m of [puffs, stacks]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
    [puffs, stacks],
  );

  return (
    <>
      <primitive object={puffs} />
      <primitive object={stacks} />
    </>
  );
}
