"use client";

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { V3 } from "@/lib/scene/heroSpecs";
import { NO_REFLECTION_LAYER } from "@/lib/scene/layout";
import type { CityUniforms } from "@/lib/scene/materials";
import { createSpriteMaterial, createSpriteMesh } from "../sprites";
import { createLineMaterial, type HeroUniforms } from "./heroMaterials";

// --- Beacon ------------------------------------------------------------------------

/** Amber rooftop beacon: flashes while approvals are pending. */
export function Beacon({ position, active, uniforms }: { position: V3; active: boolean; uniforms: CityUniforms }) {
  const { mesh, mat } = useMemo(() => {
    const mat = createSpriteMaterial(uniforms, { mode: 0, gain: 0, minPixel: 5 });
    const mesh = createSpriteMesh([{ x: position[0], y: position[1] + 0.25, z: position[2], size: 1.6, phase: 0, color: [1, 0.62, 0.12] }], mat);
    mesh.layers.set(NO_REFLECTION_LAYER);
    return { mesh, mat };
  }, [position, uniforms]);
  useEffect(
    () => () => {
      mesh.geometry.dispose();
      mat.dispose();
    },
    [mesh, mat],
  );
  const level = useRef(0);
  useFrame((state, dt) => {
    level.current = THREE.MathUtils.damp(level.current, active ? 1 : 0, 6, dt);
    const t = state.clock.elapsedTime % 1.1;
    const flash = t < 0.42 ? Math.sin((t / 0.42) * Math.PI) : 0;
    mat.uniforms.uGain!.value = level.current * (0.35 + flash * 5.5);
    mesh.visible = level.current > 0.01;
  });
  return <primitive object={mesh} />;
}

// --- Searchlights -------------------------------------------------------------------

const BEAM_VERT = /* glsl */ `
uniform float uLength;
varying float vT;
varying vec3 vN;
varying vec3 vV;
varying float vDist;
void main() {
  vT = position.y / uLength;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const BEAM_FRAG = /* glsl */ `
uniform float uIntensity;
uniform float uFogFar;
varying float vT;
varying vec3 vN;
varying vec3 vV;
varying float vDist;
void main() {
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float soft = pow(facing, 1.6);
  float along = pow(1.0 - vT, 1.5) * smoothstep(0.0, 0.02, vT);
  float a = soft * along * uIntensity * (1.0 - smoothstep(uFogFar * 0.6, uFogFar * 1.4, vDist));
  if (a < 0.002) discard;
  gl_FragColor = vec4(vec3(1.0, 0.94, 0.82) * a, 1.0);
}`;

export function Searchlights({
  position,
  active,
  uniforms,
  reducedMotion,
}: {
  position: V3;
  active: boolean;
  uniforms: CityUniforms;
  reducedMotion: boolean;
}) {
  const L = 120;
  const { geo, mat } = useMemo(() => {
    const geo = new THREE.CylinderGeometry(4.2, 0.16, L, 24, 1, true).translate(0, L / 2, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      uniforms: { uLength: { value: L }, uIntensity: { value: 0 }, uFogFar: uniforms.uFogFar },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    return { geo, mat };
  }, [uniforms]);
  useEffect(
    () => () => {
      geo.dispose();
      mat.dispose();
    },
    [geo, mat],
  );
  const a = useRef<THREE.Group>(null);
  const b = useRef<THREE.Group>(null);
  const ta = useRef<THREE.Group>(null);
  const tb = useRef<THREE.Group>(null);
  const root = useRef<THREE.Group>(null);
  const level = useRef(0);
  useFrame((state, dt) => {
    level.current = THREE.MathUtils.damp(level.current, active ? 1 : 0, 2.5, dt);
    mat.uniforms.uIntensity!.value = level.current * 0.05;
    if (root.current) root.current.visible = level.current > 0.005;
    const t = state.clock.elapsedTime * (reducedMotion ? 0.15 : 1);
    if (a.current) a.current.rotation.y = t * 0.55;
    if (b.current) b.current.rotation.y = -t * 0.41 + 2.4;
    if (ta.current) ta.current.rotation.z = 0.34 + Math.sin(t * 0.7) * (reducedMotion ? 0.02 : 0.12);
    if (tb.current) tb.current.rotation.z = 0.3 + Math.sin(t * 0.53 + 1.3) * (reducedMotion ? 0.02 : 0.12);
  });
  return (
    <group ref={root} position={position} visible={false}>
      <group ref={a}>
        <group ref={ta}>
          <mesh geometry={geo} material={mat} renderOrder={8} frustumCulled={false} layers={NO_REFLECTION_LAYER} />
        </group>
      </group>
      <group ref={b}>
        <group ref={tb}>
          <mesh geometry={geo} material={mat} renderOrder={8} frustumCulled={false} layers={NO_REFLECTION_LAYER} />
        </group>
      </group>
    </group>
  );
}

// --- Selection ring ---------------------------------------------------------------

const RING_FRAG = /* glsl */ `
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float d = abs(vUv.y - 0.5) * 2.0;
  float a = pow(1.0 - d, 2.0) * uOpacity;
  gl_FragColor = vec4(vec3(0.55, 0.85, 1.0) * a, 1.0);
}`;

export function SelectionRing({ radius, selected, reducedMotion }: { radius: number; selected: boolean; reducedMotion: boolean }) {
  const { geo, mat } = useMemo(() => {
    const geo = new THREE.RingGeometry(radius, radius + 0.55, 96, 1);
    // map uv.y across the ring width for a soft band
    const uv = geo.attributes.uv!;
    const pos = geo.attributes.position!;
    for (let i = 0; i < uv.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      uv.setXY(i, 0, (r - radius) / 0.55);
    }
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: RING_FRAG,
      uniforms: { uOpacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { geo, mat };
  }, [radius]);
  useEffect(
    () => () => {
      geo.dispose();
      mat.dispose();
    },
    [geo, mat],
  );
  const mesh = useRef<THREE.Mesh>(null);
  const level = useRef(0);
  useFrame((state, dt) => {
    level.current = THREE.MathUtils.damp(level.current, selected ? 1 : 0, 5, dt);
    const pulse = reducedMotion ? 1 : 0.8 + 0.2 * Math.sin(state.clock.elapsedTime * 2.2);
    mat.uniforms.uOpacity!.value = level.current * 0.7 * pulse;
    if (mesh.current) mesh.current.visible = level.current > 0.01;
  });
  return <mesh ref={mesh} geometry={geo} material={mat} position={[0, 0.06, 0]} renderOrder={3} visible={false} layers={NO_REFLECTION_LAYER} />;
}

// --- Construction: scaffolding and a tower crane -----------------------------------

function scaffoldGeometry(bounds: THREE.Box3, builtTo: number): { scaffold: THREE.BufferGeometry; crane: THREE.BufferGeometry; craneTop: THREE.Vector3; lights: THREE.Vector3[] } {
  const pts: number[] = [];
  const seg = (a: THREE.Vector3, b: THREE.Vector3) => pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
  const pad = 0.22;
  const x0 = bounds.min.x - pad;
  const x1 = bounds.max.x + pad;
  const z0 = bounds.min.z - pad;
  const z1 = bounds.max.z + pad;
  const top = Math.max(1, builtTo + 0.6);
  const lights: THREE.Vector3[] = [];
  const sides: [THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(x0, 0, z1), new THREE.Vector3(x1, 0, z1)],
    [new THREE.Vector3(x1, 0, z1), new THREE.Vector3(x1, 0, z0)],
    [new THREE.Vector3(x1, 0, z0), new THREE.Vector3(x0, 0, z0)],
    [new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x0, 0, z1)],
  ];
  const ledger = 0.9;
  for (const [a, b] of sides) {
    const len = a.distanceTo(b);
    const n = Math.max(2, Math.round(len / 1.1));
    for (let i = 0; i <= n; i++) {
      const p = a.clone().lerp(b, i / n);
      seg(p.clone().setY(0), p.clone().setY(top));
      if (i < n && i % 3 === 0) {
        // diagonal braces
        const q = a.clone().lerp(b, (i + 1) / n);
        for (let y = 0; y < top - ledger * 2; y += ledger * 4) seg(p.clone().setY(y), q.clone().setY(y + ledger * 2));
      }
    }
    for (let y = ledger; y <= top + 1e-3; y += ledger) seg(a.clone().setY(y), b.clone().setY(y));
    for (let k = 0; k < 3; k++) lights.push(a.clone().lerp(b, 0.2 + k * 0.3).setY(top * (0.25 + 0.3 * k)));
  }
  const scaffold = new THREE.BufferGeometry();
  scaffold.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));

  // Tower crane at the north-west corner, jib swinging over the building.
  const cp: number[] = [];
  const cseg = (a: THREE.Vector3, b: THREE.Vector3) => cp.push(a.x, a.y, a.z, b.x, b.y, b.z);
  const mastX = x0 - 0.9;
  const mastZ = z0 - 0.9;
  const h = top + 5.5;
  const m = 0.32;
  const corners = [
    new THREE.Vector3(mastX - m, 0, mastZ - m),
    new THREE.Vector3(mastX + m, 0, mastZ - m),
    new THREE.Vector3(mastX + m, 0, mastZ + m),
    new THREE.Vector3(mastX - m, 0, mastZ + m),
  ];
  for (let i = 0; i < 4; i++) {
    const c = corners[i]!;
    const d = corners[(i + 1) % 4]!;
    cseg(c.clone(), c.clone().setY(h));
    for (let y = 0; y < h - 0.01; y += 0.7) {
      cseg(c.clone().setY(y), d.clone().setY(y + 0.7));
      cseg(c.clone().setY(y + 0.7), d.clone().setY(y + 0.7));
    }
  }
  const jibLen = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) * 1.25 + 4;
  const dir = new THREE.Vector3(1, 0, 1).normalize();
  const back = dir.clone().multiplyScalar(-jibLen * 0.32);
  const base = new THREE.Vector3(mastX, h, mastZ);
  const tip = base.clone().addScaledVector(dir, jibLen);
  const tail = base.clone().add(back);
  const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(0.28);
  cseg(tail.clone().add(side), tip.clone().add(side));
  cseg(tail.clone().sub(side), tip.clone().sub(side));
  const apex = base.clone().setY(h + 2.2);
  cseg(base.clone(), apex);
  cseg(apex, tip.clone());
  cseg(apex, tail.clone());
  const steps = Math.round(jibLen / 0.8);
  for (let i = 0; i < steps; i++) {
    const p = tail.clone().lerp(tip, i / steps);
    const q = tail.clone().lerp(tip, (i + 1) / steps);
    cseg(p.clone().add(side), q.clone().sub(side));
  }
  // hook line
  const hook = base.clone().addScaledVector(dir, jibLen * 0.62);
  cseg(hook, hook.clone().setY(top + 1.2));
  const crane = new THREE.BufferGeometry();
  crane.setAttribute("position", new THREE.Float32BufferAttribute(cp, 3));
  return { scaffold, crane, craneTop: apex, lights };
}

const CRANE_FRAG = /* glsl */ `
uniform float uFogNear; uniform float uFogFar;
varying float vDist;
void main() {
  float fog = 1.0 - smoothstep(uFogNear, uFogFar, vDist);
  gl_FragColor = vec4(vec3(1.0, 0.7, 0.14) * 0.45 * fog, 1.0);
}`;

export function Construction({
  bounds,
  builtTo,
  hero,
  uniforms,
}: {
  bounds: THREE.Box3;
  builtTo: number;
  hero: HeroUniforms;
  uniforms: CityUniforms;
}) {
  const parts = useMemo(() => scaffoldGeometry(bounds, builtTo), [bounds, builtTo]);
  const scaffoldMat = useMemo(() => createLineMaterial(hero, uniforms, "scaffold"), [hero, uniforms]);
  const craneMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader:
          "varying float vDist; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vDist = -mv.z; gl_Position = projectionMatrix * mv; }",
        fragmentShader: CRANE_FRAG,
        uniforms: { uFogNear: uniforms.uFogNear, uFogFar: uniforms.uFogFar },
        transparent: true,
        depthWrite: false,
      }),
    [uniforms],
  );
  const lights = useMemo(() => {
    const mat = createSpriteMaterial(uniforms, { mode: 2, gain: 1.4, minPixel: 2 });
    const work = parts.lights.map((p, i) => ({ x: p.x, y: p.y, z: p.z, size: 0.5, phase: i * 0.37, color: [1, 0.86, 0.6] as [number, number, number] }));
    const mesh = createSpriteMesh(work, mat);
    const redMat = createSpriteMaterial(uniforms, { mode: 1, gain: 3.2, minPixel: 3 });
    const red = createSpriteMesh([{ x: parts.craneTop.x, y: parts.craneTop.y + 0.2, z: parts.craneTop.z, size: 0.6, phase: 0.3, color: [1, 0.08, 0.04] }], redMat);
    mesh.layers.set(NO_REFLECTION_LAYER);
    red.layers.set(NO_REFLECTION_LAYER);
    return { mesh, red, mat, redMat };
  }, [parts, uniforms]);
  useEffect(
    () => () => {
      parts.scaffold.dispose();
      parts.crane.dispose();
      scaffoldMat.dispose();
      craneMat.dispose();
      lights.mesh.geometry.dispose();
      lights.red.geometry.dispose();
      lights.mat.dispose();
      lights.redMat.dispose();
    },
    [parts, scaffoldMat, craneMat, lights],
  );
  return (
    <group>
      <lineSegments geometry={parts.scaffold} material={scaffoldMat} renderOrder={7} layers={NO_REFLECTION_LAYER} raycast={() => null} />
      <lineSegments geometry={parts.crane} material={craneMat} renderOrder={7} layers={NO_REFLECTION_LAYER} raycast={() => null} />
      <primitive object={lights.mesh} />
      <primitive object={lights.red} />
    </group>
  );
}
