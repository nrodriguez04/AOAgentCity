"use client";

import { Environment, Lightformer } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { GLSL_DUSK_HORIZON, SUN_DIR } from "@/lib/scene/fog";
import { GLSL_HASH } from "@/lib/scene/glsl";
import { useCity } from "./cityContext";

// Dusk: a deep blue-indigo dome with a warm orange-pink glow low in the west,
// faint stars, adaptive fog for depth and an environment built from
// Lightformers (no HDRI downloads).

export const FOG_COLOR = new THREE.Color("#0b1020");

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform float uStars;
uniform vec3 uFogColor;
varying vec3 vDir;
${GLSL_HASH}
${GLSL_DUSK_HORIZON}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec2 az = normalize(d.xz + 1e-5);
  float sunSide = max(dot(az, normalize(uSunDir.xz)), 0.0);
  float hp = max(h, 0.0);

  vec3 zenith = vec3(0.004, 0.008, 0.03);
  vec3 mid = vec3(0.012, 0.026, 0.085);
  vec3 low = vec3(0.05, 0.055, 0.13);
  vec3 col = mix(low, mid, smoothstep(0.0, 0.22, hp));
  col = mix(col, zenith, smoothstep(0.18, 0.9, hp));

  // Sunset glow, hugging the horizon on the western side.
  float glow = pow(sunSide, 2.5) * exp(-hp * 7.0);
  col += vec3(0.85, 0.3, 0.1) * glow * 0.9;
  col += vec3(0.5, 0.16, 0.22) * pow(sunSide, 1.2) * exp(-hp * 16.0) * 0.55;
  // A violet band all around the horizon.
  col += vec3(0.1, 0.06, 0.16) * exp(-hp * 22.0);

  // Thin cirrus lit from below near the horizon.
  vec2 cp = vec2(atan(d.z, d.x) * 6.0, hp * 40.0);
  float c = cityFbm(cp * vec2(0.6, 1.0) + vec2(uTime * 0.004, 0.0));
  float cloud = smoothstep(0.55, 0.8, c) * smoothstep(0.02, 0.06, hp) * (1.0 - smoothstep(0.12, 0.3, hp));
  col = mix(col, vec3(0.7, 0.32, 0.25) * (0.25 + 0.75 * pow(sunSide, 2.0)) * 0.6, cloud * 0.55);

  // Stars.
  if (uStars > 0.0 && h > 0.12) {
    vec3 sp = d * 220.0;
    vec3 cell = floor(sp);
    float r = cityHash13(cell);
    if (r > 0.992) {
      vec3 f = fract(sp) - 0.5;
      float s = 1.0 - smoothstep(0.0, 0.22, length(f));
      float tw = 0.6 + 0.4 * sin(uTime * (1.0 + r * 3.0) + r * 50.0);
      col += vec3(0.75, 0.8, 1.0) * s * tw * smoothstep(0.12, 0.45, h) * 0.9 * uStars;
    }
  }

  // Below the horizon: the same haze the fog fades distant water and land into.
  vec3 haze = cityDuskHorizon(d, uFogColor);
  col = mix(col, haze, smoothstep(0.015, -0.02, h));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function useSkyMaterial(stars: number) {
  return useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uSunDir: { value: SUN_DIR },
          uStars: { value: stars },
          uFogColor: { value: FOG_COLOR.clone() },
        },
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    [stars],
  );
}

export function SkyDome() {
  const mat = useSkyMaterial(1);
  const { uniforms } = useCity();
  useFrame(() => {
    mat.uniforms.uTime!.value = uniforms.uTime.value;
  });
  return (
    <mesh material={mat} renderOrder={-10} frustumCulled={false} scale={800}>
      <sphereGeometry args={[1, 48, 24]} />
    </mesh>
  );
}

/** Fog that scales with the camera's distance to its target, so depth reads at every zoom. */
export function AdaptiveFog() {
  const { scene } = useThree();
  const { uniforms } = useCity();
  const fog = useMemo(() => new THREE.Fog(FOG_COLOR, 120, 420), []);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  useFrame((state) => {
    if (scene.fog !== fog) scene.fog = fog;
    const controls = state.controls as unknown as { target?: THREE.Vector3 } | null;
    const target = controls?.target ?? tmp.set(0, 0, 0);
    const dist = state.camera.position.distanceTo(target);
    fog.near = THREE.MathUtils.lerp(fog.near, Math.max(30, dist * 0.55), 0.1);
    fog.far = THREE.MathUtils.lerp(fog.far, Math.max(150, dist * 2.0 + 30), 0.1);
    uniforms.uFogNear.value = fog.near;
    uniforms.uFogFar.value = fog.far;
  });
  return null;
}

export function Lights() {
  return (
    <>
      <hemisphereLight args={["#4a64b8", "#1c130c", 0.5]} />
      <directionalLight position={[-220, 34, 92]} color="#ff8a5c" intensity={0.42} />
      <directionalLight position={[90, 220, -140]} color="#5f78c0" intensity={0.16} />
    </>
  );
}

export function DuskEnvironment() {
  const sky = useSkyMaterial(0);
  return (
    <Environment resolution={256} frames={1}>
      <mesh material={sky} scale={100}>
        <sphereGeometry args={[1, 32, 16]} />
      </mesh>
      {/* Warm sunset strip low in the west. */}
      <Lightformer form="rect" intensity={2.2} color="#ff8a55" position={[-60, 2, 18]} scale={[16, 3, 1]} target={[0, 0, 0]} />
      <Lightformer form="rect" intensity={0.9} color="#ff6f8f" position={[-50, 8, -30]} scale={[30, 4, 1]} target={[0, 0, 0]} />
      {/* Cool sky fill from above. */}
      <Lightformer form="circle" intensity={0.16} color="#5f78c8" position={[0, 60, 0]} scale={30} target={[0, 0, 0]} />
      {/* City glow from below: lit streets and windows reflected in glass. */}
      <Lightformer form="ring" intensity={0.65} color="#ff9b52" position={[0, -12, 0]} scale={70} rotation-x={Math.PI / 2} />
      <Lightformer form="rect" intensity={0.35} color="#9fb6ff" position={[55, 6, 40]} scale={[30, 3, 1]} target={[0, 0, 0]} />
    </Environment>
  );
}
