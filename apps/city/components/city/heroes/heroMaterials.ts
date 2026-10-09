import * as THREE from "three";
import { GLSL_HASH, GLSL_WINDOW_COLORS } from "@/lib/scene/glsl";
import type { CityUniforms } from "@/lib/scene/materials";

// Materials that turn BuildingVisuals into light: per-floor window bands with
// an upward sweep, crown modes, the success flash and construction looks.

export interface HeroUniforms {
  uFloorTex: { value: THREE.DataTexture };
  uFloorCount: { value: number };
  uAmbientLit: { value: number };
  uDim: { value: number };
  /** Flash progress 0..1 while a run.succeeded flash runs, -1 otherwise. */
  uFlash: { value: number };
  uHeight: { value: number };
  /** Construction progress height (model space); windows above it are dark. */
  uBuiltTo: { value: number };
}

export function createHeroUniforms(floorCount: number, height: number): HeroUniforms {
  const size = Math.max(1, floorCount);
  const data = new Uint8Array(size * 4);
  const tex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return {
    uFloorTex: { value: tex },
    uFloorCount: { value: size },
    uAmbientLit: { value: 0.2 },
    uDim: { value: 0 },
    uFlash: { value: -1 },
    uHeight: { value: height },
    uBuiltTo: { value: 1e4 },
  };
}

/**
 * Hero window glass. Uses the `_floor` / `_seed` vertex attributes written by
 * the Blender exporter: floors light by band, seeds pick which windows.
 */
export function createHeroWindowMaterial(city: CityUniforms, hero: HeroUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: "#05070a", roughness: 0.12, metalness: 0.15, envMapIntensity: 1.2 });
  mat.name = "HeroWindows";
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uTime: city.uTime,
      uLitScale: city.uLitScale,
      uLightGain: city.uLightGain,
      ...hero,
    });
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute float _floor; attribute float _seed;
        varying float vFloor; varying float vSeed; varying float vLocalY; varying vec2 vWinUv;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vFloor = _floor; vSeed = _seed;
        // Quantized GLB meshes carry a dequantization transform on their node:
        // heights must come from the world matrix (towers stand on y = 0).
        vLocalY = (modelMatrix * vec4(position, 1.0)).y;
        vWinUv = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uTime; uniform float uLitScale; uniform float uLightGain;
        uniform sampler2D uFloorTex; uniform float uFloorCount; uniform float uAmbientLit;
        uniform float uDim; uniform float uFlash; uniform float uHeight; uniform float uBuiltTo;
        varying float vFloor; varying float vSeed; varying float vLocalY; varying vec2 vWinUv;
        ${GLSL_HASH}
        ${GLSL_WINDOW_COLORS}`,
      )
      .replace(
        "#include <clipping_planes_fragment>",
        "#include <clipping_planes_fragment>\n        if (vLocalY > uBuiltTo) discard; // not built yet",
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          float level = texture2D(uFloorTex, vec2((vFloor + 0.5) / uFloorCount, 0.5)).r;
          float ambient = clamp(uAmbientLit * mix(1.0, uLitScale, 0.5), 0.0, 1.0);
          float p = mix(ambient, 0.95, level);
          float lit = step(vSeed, p);
          float pulse = 1.0 + level * 0.2 * sin(uTime * 2.3 - vFloor * 0.22) * (1.0 - uDim);
          vec3 homeCol = cityWindowColor(fract(vSeed * 13.7), 0.2);
          vec3 officeCol = vec3(1.0, 0.8, 0.54);
          vec3 col = mix(homeCol, officeCol, level * 0.7);
          float bright = (1.0 + 0.75 * fract(vSeed * 7.1)) * pulse * mix(1.0, 0.4, uDim) * uLightGain;
          // A thin dark frame around each pane.
          vec2 e = min(vWinUv, 1.0 - vWinUv);
          float pane = smoothstep(0.02, 0.09, min(e.x, e.y));
          float built = step(vLocalY, uBuiltTo);
          totalEmissiveRadiance += col * lit * bright * mix(0.55, 1.0, pane) * built;
          if (uFlash >= 0.0) {
            float y = vLocalY / max(uHeight, 1.0);
            float band = exp(-pow((y - (uFlash * 1.2 - 0.1)) * 16.0, 2.0));
            totalEmissiveRadiance += vec3(1.0, 0.98, 0.94) * band * 1.6 * (1.0 - uFlash * 0.5);
          }
        }`,
      );
  };
  mat.customProgramCacheKey = () => "hero-windows-v1";
  return mat;
}

export const CROWN_COLORS: Record<string, THREE.Color> = {
  "deco-spire": new THREE.Color(1.0, 0.76, 0.42),
  "glass-led": new THREE.Color(0.72, 0.86, 1.0),
  "ring-cylinder": new THREE.Color(0.55, 0.9, 1.0),
  neoclassical: new THREE.Color(1.0, 0.86, 0.62),
  "warehouse-loft": new THREE.Color(1.0, 0.7, 0.4),
  "twist-tower": new THREE.Color(0.85, 0.75, 1.0),
  "bank-dome": new THREE.Color(1.0, 0.82, 0.5),
  "glass-pavilion": new THREE.Color(0.75, 1.0, 0.85),
  "billboard-block": new THREE.Color(1.0, 0.55, 0.85),
};

/** Emissive material driven per frame (crown lights, accents, the Halo ring). */
export function createGlowMaterial(base: THREE.Color, opts: { side?: THREE.Side } = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: base.clone().multiplyScalar(0.25),
    emissive: base.clone(),
    emissiveIntensity: 1,
    roughness: 0.4,
    metalness: 0.1,
    side: opts.side ?? THREE.FrontSide,
    toneMapped: true,
  });
}

/** Body material patched with the warm street bounce and a success flash band. */
/**
 * @param flood Architectural floodlighting strength (0 for glass and metal, 1 for
 * masonry): a warm wash that strengthens toward the crown, so landmark towers
 * still read at night when few of their windows are lit.
 */
export function patchBodyMaterial(mat: THREE.MeshStandardMaterial, city: CityUniforms, hero: HeroUniforms, flood = 0) {
  const uFlood = { value: flood };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uStreetGlow = city.uStreetGlow;
    shader.uniforms.uFlash = hero.uFlash;
    shader.uniforms.uHeight = hero.uHeight;
    shader.uniforms.uDim = hero.uDim;
    shader.uniforms.uFlood = uFlood;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vHeroY; varying float vHeroWorldY;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vHeroY = (modelMatrix * vec4(position, 1.0)).y;
        #ifdef USE_INSTANCING
          vHeroWorldY = (modelMatrix * instanceMatrix * vec4(position, 1.0)).y;
        #else
          vHeroWorldY = (modelMatrix * vec4(position, 1.0)).y;
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uStreetGlow; uniform float uFlash; uniform float uHeight; uniform float uDim; uniform float uFlood; varying float vHeroY; varying float vHeroWorldY;",
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.5, 0.2) * (1.0 - smoothstep(0.0, 3.6, vHeroWorldY)) * uStreetGlow * 0.6;
        if (uFlood > 0.0) {
          float yn = clamp(vHeroY / max(uHeight, 1.0), 0.0, 1.0);
          float wash = 0.1 + 0.42 * smoothstep(0.3, 0.95, yn);
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.84, 0.66) * wash * uFlood * (1.0 - 0.75 * uDim);
        }
        if (uFlash >= 0.0) {
          float y = vHeroY / max(uHeight, 1.0);
          float band = exp(-pow((y - (uFlash * 1.2 - 0.1)) * 16.0, 2.0));
          totalEmissiveRadiance += (diffuseColor.rgb + 0.08) * band * 0.7 * (1.0 - uFlash * 0.5);
        }`,
      );
  };
  mat.customProgramCacheKey = () => "hero-body-v2";
  mat.needsUpdate = true;
}

/** Built part of an under-construction tower: bare concrete frame with work lights, cut at uBuiltTo. */
export function createConcreteFrameMaterial(city: CityUniforms, hero: HeroUniforms, floorHeight: number): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: "#8a8780", roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
  const floorU = { value: floorHeight };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBuiltTo = hero.uBuiltTo;
    shader.uniforms.uTime = city.uTime;
    shader.uniforms.uLightGain = city.uLightGain;
    shader.uniforms.uFloorH = floorU;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vHeroPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHeroPos = (modelMatrix * vec4(position, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\nuniform float uBuiltTo; uniform float uTime; uniform float uLightGain; uniform float uFloorH; varying vec3 vHeroPos;\n${GLSL_HASH}`,
      )
      .replace(
        "#include <clipping_planes_fragment>",
        "#include <clipping_planes_fragment>\nif (vHeroPos.y > uBuiltTo) discard;",
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float slabF = fract(vHeroPos.y / uFloorH);
        float slab = smoothstep(0.0, 0.06, slabF) * (1.0 - smoothstep(0.84, 0.9, slabF));
        diffuseColor.rgb *= mix(1.05, 0.22, slab);`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        {
          float fl = floor(vHeroPos.y / uFloorH);
          float cell = floor((vHeroPos.x + vHeroPos.z) * 1.4);
          float r = cityHash12(vec2(fl, cell));
          float flick = 0.85 + 0.15 * sin(uTime * 7.0 + r * 40.0);
          float f = fract(vHeroPos.y / uFloorH);
          float open = smoothstep(0.08, 0.2, f) * (1.0 - smoothstep(0.6, 0.8, f));
          totalEmissiveRadiance += vec3(1.0, 0.8, 0.5) * step(0.86, r) * open * 2.2 * flick * uLightGain;
          totalEmissiveRadiance += vec3(0.9, 0.55, 0.25) * open * 0.06;
        }`,
      );
  };
  mat.customProgramCacheKey = () => "hero-concrete-v2";
  return mat;
}

/** Unbuilt part: a holographic blueprint ghost above uBuiltTo. */
export function createGhostMaterial(hero: HeroUniforms, city: CityUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uBuiltTo: hero.uBuiltTo, uTime: city.uTime, uHeight: hero.uHeight, uFogNear: city.uFogNear, uFogFar: city.uFogFar },
    vertexShader: /* glsl */ `
      varying vec3 vPos; varying vec3 vN; varying vec3 vView; varying float vDist;
      void main() {
        vPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vN = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = normalize(-mv.xyz);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uBuiltTo; uniform float uTime; uniform float uHeight; uniform float uFogNear; uniform float uFogFar;
      varying vec3 vPos; varying vec3 vN; varying vec3 vView; varying float vDist;
      void main() {
        if (vPos.y < uBuiltTo) discard;
        float fres = pow(1.0 - abs(dot(normalize(vN), normalize(vView))), 2.0);
        float scan = 0.5 + 0.5 * sin(vPos.y * 3.0 - uTime * 1.6);
        float a = (0.012 + 0.11 * fres) * (0.75 + 0.25 * scan);
        a *= 1.0 - smoothstep(uFogNear, uFogFar, vDist);
        gl_FragColor = vec4(vec3(0.35, 0.72, 1.0) * a, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/** Line material for flash edges, blueprint edges and scaffolding. */
export function createLineMaterial(
  hero: HeroUniforms,
  city: CityUniforms,
  mode: "flash" | "blueprint" | "scaffold",
): THREE.ShaderMaterial {
  const m = mode === "flash" ? 0 : mode === "blueprint" ? 1 : 2;
  return new THREE.ShaderMaterial({
    uniforms: {
      uFlash: hero.uFlash,
      uHeight: hero.uHeight,
      uBuiltTo: hero.uBuiltTo,
      uTime: city.uTime,
      uLightGain: city.uLightGain,
      uFogNear: city.uFogNear,
      uFogFar: city.uFogFar,
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos; varying float vDist;
      void main() {
        vPos = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uFlash; uniform float uHeight; uniform float uBuiltTo; uniform float uTime; uniform float uLightGain;
      uniform float uFogNear; uniform float uFogFar;
      varying vec3 vPos; varying float vDist;
      void main() {
        float fog = 1.0 - smoothstep(uFogNear, uFogFar, vDist);
        vec3 col;
        #if ${m} == 0
          if (uFlash < 0.0) discard;
          float y = vPos.y / max(uHeight, 1.0);
          float band = exp(-pow((y - (uFlash * 1.2 - 0.1)) * 12.0, 2.0));
          float trail = smoothstep(0.0, 0.4, (uFlash * 1.2 - 0.1) - y) * 0.18 * (1.0 - uFlash);
          col = vec3(1.0, 0.97, 0.92) * (band * 2.4 + trail) * (1.0 - uFlash * 0.5);
        #elif ${m} == 1
          if (vPos.y < uBuiltTo - 0.02) discard;
          col = vec3(0.4, 0.78, 1.0) * (0.3 + 0.1 * sin(vPos.y * 2.0 - uTime * 2.0));
        #else
          col = vec3(1.0, 0.68, 0.28) * 0.22 * uLightGain;
        #endif
        gl_FragColor = vec4(col * fog, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}
