import * as THREE from "three";

// Aerial perspective: distant geometry fades into the colour of the dusk sky
// behind it (warm toward the sunset, deep blue elsewhere) instead of a flat
// fog colour. Implemented by swapping three's fog shader chunks once; every
// built-in material with fog picks it up. The same GLSL drives the sky dome's
// horizon so the two always meet seamlessly.

/** Direction the sunset glow comes from (west, a little south). */
export const SUN_DIR = new THREE.Vector3(-1, 0, 0.42).normalize();

export const GLSL_DUSK_HORIZON = /* glsl */ `
vec3 cityDuskHorizon(vec3 dir, vec3 base) {
  vec2 az = normalize(dir.xz + vec2(1e-5));
  float sunSide = max(dot(az, normalize(vec2(${SUN_DIR.x.toFixed(4)}, ${SUN_DIR.z.toFixed(4)}))), 0.0);
  float low = 1.0 - smoothstep(0.0, 0.32, max(dir.y, 0.0));
  vec3 col = base;
  col += vec3(0.20, 0.07, 0.035) * pow(sunSide, 2.2) * low;
  col += vec3(0.022, 0.032, 0.085) * low;
  return col;
}
`;

let installed = false;

export function installDuskFog() {
  if (installed) return;
  installed = true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  chunks.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldDir;
#endif`;
  chunks.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // View matrices are rigid: the transpose of the rotation brings view space back to world space.
  vFogWorldDir = transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif`;
  chunks.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWorldDir;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  ${GLSL_DUSK_HORIZON}
#endif`;
  chunks.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  vec3 fogDir = normalize( vFogWorldDir );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, cityDuskHorizon( fogDir, fogColor ), fogFactor );
#endif`;
}
