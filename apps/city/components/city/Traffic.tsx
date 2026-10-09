"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { carGeometry } from "@/lib/scene/geometries";
import { NO_REFLECTION_LAYER } from "@/lib/scene/layout";
import { mulberry32 } from "@/lib/scene/random";
import type { LaneSeg } from "@/lib/scene/streetGen";
import { useCity } from "./cityContext";

// Instanced traffic, animated entirely on the GPU: every car knows its lane
// segment, speed and phase; the vertex shader places it. Density hides cars
// by rank, so changing ambience.trafficDensity never reallocates anything.

const LANE_CHUNK = /* glsl */ `
  vec2 laneA = aLane.xy;
  vec2 laneAB = aLane.zw - aLane.xy;
  float laneLen = max(length(laneAB), 0.001);
  vec2 laneDir = laneAB / laneLen;
  float laneS = fract(aCar.x + uTime * aCar.y / laneLen) * laneLen;
  vec2 carP = laneA + laneDir * laneS;
  vec2 carRight = vec2(laneDir.y, -laneDir.x);
  float carVis = step(aCar.z, uDensity) * smoothstep(0.0, 0.6, laneS) * (1.0 - smoothstep(laneLen - 0.6, laneLen, laneS));
  // Bridge lanes climb onto the deck over their first and last 9 units.
  float carY = aCar.w * clamp(min(laneS, laneLen - laneS) / 9.0, 0.0, 1.0) + (aCar.w > 0.0 ? 0.16 : 0.0);
`;

function carMaterial(uniforms: { uTime: { value: number } }, density: { value: number }) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.45 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uDensity = density;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uTime; uniform float uDensity;
        attribute vec4 aLane; attribute vec4 aCar; attribute vec3 aColor; attribute float aPart;
        varying vec3 vCarColor; varying float vCarPart;`,
      )
      .replace(
        "#include <beginnormal_vertex>",
        `${LANE_CHUNK}
        vec3 objectNormal = vec3(carRight.x, 0.0, carRight.y) * normal.x + vec3(0.0, normal.y, 0.0) + vec3(laneDir.x, 0.0, laneDir.y) * normal.z;
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3( tangent.xyz );
        #endif`,
      )
      .replace(
        "#include <begin_vertex>",
        `vec3 lp = position * min(carVis * 2.0, 1.0);
        vec3 transformed = vec3(carP.x, carY, carP.y) + vec3(carRight.x, 0.0, carRight.y) * lp.x + vec3(0.0, lp.y, 0.0) + vec3(laneDir.x, 0.0, laneDir.y) * lp.z;
        vCarColor = aColor; vCarPart = aPart;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCarColor; varying float vCarPart;")
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\ndiffuseColor.rgb = mix(vCarColor, vec3(0.02, 0.025, 0.03), vCarPart);",
      );
  };
  mat.customProgramCacheKey = () => "city-car-v1";
  return mat;
}

const LIGHT_VERT = /* glsl */ `
attribute vec4 aLane;
attribute vec4 aCar;
attribute float aEnd;
uniform float uTime;
uniform float uDensity;
uniform float uFogNear;
uniform float uFogFar;
varying vec2 vUv;
varying vec3 vColor;
varying float vI;
void main() {
  ${LANE_CHUNK}
  vUv = uv;
  vec3 fwd = vec3(laneDir.x, 0.0, laneDir.y);
  vec3 lightPos = vec3(carP.x, 0.075 + carY, carP.y) + fwd * (0.235 * aEnd);
  vec4 mv = viewMatrix * vec4(lightPos, 1.0);
  vec3 fwdV = (viewMatrix * vec4(fwd, 0.0)).xyz;
  vec2 a = fwdV.xy;
  float al = length(a);
  a = al > 1e-3 ? a / al : vec2(1.0, 0.0);
  vec2 b = vec2(-a.y, a.x);
  float dist = max(-mv.z, 0.01);
  float px = dist * 2.0 / (projectionMatrix[1][1] * 900.0);
  float W = max(0.09, px * 2.6);
  float L = W + max(0.38, px * 3.0) * al;
  mv.xy += a * position.x * L + b * position.y * W;
  gl_Position = projectionMatrix * mv;
  vec3 toCam = normalize(cameraPosition - lightPos);
  float facing = dot(fwd * aEnd, toCam);
  vI = carVis * (0.35 + 0.65 * smoothstep(-0.25, 0.45, facing)) * (1.0 - smoothstep(uFogNear, uFogFar * 1.15, dist));
  vColor = aEnd > 0.0 ? vec3(1.0, 0.9, 0.72) * 2.6 : vec3(1.0, 0.07, 0.03) * 2.4;
}`;

const LIGHT_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying float vI;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float d = length(p);
  float a = pow(max(1.0 - d, 0.0), 1.6);
  if (a * vI < 0.003) discard;
  gl_FragColor = vec4(vColor * a * vI, 1.0);
}`;

const TAXI = new THREE.Color("#f2b707");
const CAR_COLORS = ["#121316", "#1c1f24", "#d9dadc", "#8a8d92", "#5b6066", "#2a3550", "#6e1414", "#3a3d40", "#b8b9bb", "#19304a"].map(
  (c) => new THREE.Color(c),
);

export function Traffic({ lanes, density, lowGraphics }: { lanes: LaneSeg[]; density: number; lowGraphics: boolean }) {
  const { uniforms } = useCity();
  const densityU = useMemo(() => ({ value: density }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const { cars, lights } = useMemo(() => {
    const rng = mulberry32(31337);
    type Car = { lane: LaneSeg; phase: number; speed: number; rank: number; color: THREE.Color };
    const list: Car[] = [];
    for (const lane of lanes) {
      const len = Math.hypot(lane.bx - lane.ax, lane.bz - lane.az);
      const n = Math.max(1, Math.round(len / lane.spacing));
      // Platoons: cars bunch up behind lights.
      let phase = rng();
      for (let i = 0; i < n; i++) {
        phase = (phase + (lane.spacing / len) * (0.45 + rng() * 1.1)) % 1;
        const taxi = rng() < 0.33;
        list.push({
          lane,
          phase,
          speed: lane.speed * (0.9 + rng() * 0.2),
          rank: rng(),
          color: taxi ? TAXI : CAR_COLORS[Math.floor(rng() * CAR_COLORS.length)]!,
        });
      }
    }
    const n = list.length;
    const laneA = new Float32Array(n * 4);
    const carA = new Float32Array(n * 4);
    const colA = new Float32Array(n * 3);
    list.forEach((c, i) => {
      laneA.set([c.lane.ax, c.lane.az, c.lane.bx, c.lane.bz], i * 4);
      carA.set([c.phase, c.speed, c.rank, c.lane.deckY ?? 0], i * 4);
      colA.set([c.color.r, c.color.g, c.color.b], i * 3);
    });
    const geo = carGeometry();
    geo.setAttribute("aLane", new THREE.InstancedBufferAttribute(laneA, 4));
    geo.setAttribute("aCar", new THREE.InstancedBufferAttribute(carA, 4));
    geo.setAttribute("aColor", new THREE.InstancedBufferAttribute(colA, 3));
    const cars = new THREE.InstancedMesh(geo, carMaterial(uniforms, densityU), n);
    cars.frustumCulled = false;
    cars.name = "traffic";
    // Car bodies stay out of the water reflection; their lights still reflect.
    cars.layers.set(NO_REFLECTION_LAYER);

    const lgeo = new THREE.PlaneGeometry(1, 1);
    const l2 = new Float32Array(n * 2 * 4);
    const c2 = new Float32Array(n * 2 * 4);
    const end = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 2; k++) {
        const j = i * 2 + k;
        l2.set(laneA.subarray(i * 4, i * 4 + 4), j * 4);
        c2.set(carA.subarray(i * 4, i * 4 + 4), j * 4);
        end[j] = k === 0 ? 1 : -1;
      }
    }
    lgeo.setAttribute("aLane", new THREE.InstancedBufferAttribute(l2, 4));
    lgeo.setAttribute("aCar", new THREE.InstancedBufferAttribute(c2, 4));
    lgeo.setAttribute("aEnd", new THREE.InstancedBufferAttribute(end, 1));
    const lmat = new THREE.ShaderMaterial({
      vertexShader: LIGHT_VERT,
      fragmentShader: LIGHT_FRAG,
      uniforms: { uTime: uniforms.uTime, uDensity: densityU, uFogNear: uniforms.uFogNear, uFogFar: uniforms.uFogFar },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const lights = new THREE.InstancedMesh(lgeo, lmat, n * 2);
    lights.frustumCulled = false;
    lights.renderOrder = 4;
    lights.name = "traffic-lights";
    return { cars, lights };
  }, [lanes, uniforms, densityU]);

  useEffect(
    () => () => {
      for (const m of [cars, lights]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
    [cars, lights],
  );

  useFrame((_, dt) => {
    const target = (0.1 + 0.9 * Math.max(0, Math.min(1, density))) * (lowGraphics ? 0.45 : 1);
    densityU.value += (target - densityU.value) * Math.min(1, dt * 1.5);
  });

  return (
    <>
      <primitive object={cars} />
      <primitive object={lights} />
    </>
  );
}
