import * as THREE from "three";
import type { CityUniforms } from "@/lib/scene/materials";

// Camera-facing glow sprites drawn as instanced quads (one draw call per set).
// Per-instance attributes: aCenter (xyz), aSize, aPhase, aColor (rgb).

const VERT = /* glsl */ `
attribute vec3 aCenter;
attribute float aSize;
attribute float aPhase;
attribute vec3 aColor;
uniform float uTime;
uniform float uFogNear;
uniform float uFogFar;
uniform float uMinPixel;
uniform float uMode;
varying vec2 vUv;
varying vec3 vColor;
varying float vIntensity;
void main() {
  vUv = uv;
  vColor = aColor;
  vec4 mv = viewMatrix * modelMatrix * vec4(aCenter, 1.0);
  float dist = max(-mv.z, 0.01);
  // Keep a minimum projected size so distant lights still register.
  float minWorld = uMinPixel * dist * 2.0 / (projectionMatrix[1][1] * 900.0);
  float size = max(aSize, minWorld);
  mv.xy += position.xy * size;
  gl_Position = projectionMatrix * mv;
  float blink = 1.0;
  if (uMode > 0.5 && uMode < 1.5) {
    // Aviation obstruction lights: a short pulse every 1.6 s.
    float t = fract(uTime / 1.6 + aPhase);
    blink = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.22, 0.4, t)) * 0.95 + 0.05;
  } else if (uMode > 1.5) {
    blink = 0.75 + 0.25 * sin(uTime * 2.0 + aPhase * 6.283);
  }
  vIntensity = blink * (1.0 - smoothstep(uFogNear, uFogFar * 1.15, dist));
}`;

const FRAG = /* glsl */ `
uniform float uGain;
varying vec2 vUv;
varying vec3 vColor;
varying float vIntensity;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float core = 1.0 - smoothstep(0.0, 0.32, d);
  float halo = pow(max(1.0 - d, 0.0), 2.2);
  float a = (core * 0.85 + halo * 0.5) * vIntensity;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor * a * uGain, 1.0);
}`;

export function createSpriteMaterial(u: CityUniforms, { mode = 0, gain = 1, minPixel = 2.5 } = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: u.uTime,
      uFogNear: u.uFogNear,
      uFogFar: u.uFogFar,
      uMinPixel: { value: minPixel },
      uMode: { value: mode },
      uGain: { value: gain },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

export interface SpriteSpec {
  x: number;
  y: number;
  z: number;
  size: number;
  phase: number;
  color: [number, number, number];
}

export function createSpriteMesh(sprites: SpriteSpec[], material: THREE.Material): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(1, 1);
  const n = Math.max(1, sprites.length);
  const center = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const phase = new Float32Array(n);
  const color = new Float32Array(n * 3);
  sprites.forEach((s, i) => {
    center.set([s.x, s.y, s.z], i * 3);
    size[i] = s.size;
    phase[i] = s.phase;
    color.set(s.color, i * 3);
  });
  geo.setAttribute("aCenter", new THREE.InstancedBufferAttribute(center, 3));
  geo.setAttribute("aSize", new THREE.InstancedBufferAttribute(size, 1));
  geo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phase, 1));
  geo.setAttribute("aColor", new THREE.InstancedBufferAttribute(color, 3));
  const mesh = new THREE.InstancedMesh(geo, material, n);
  mesh.count = sprites.length;
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  // Instances are placed in the shader; never let them catch pointer events.
  mesh.raycast = () => {};
  return mesh;
}
