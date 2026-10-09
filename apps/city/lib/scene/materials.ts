import * as THREE from "three";
import { GLSL_HASH, GLSL_PULSE, GLSL_WINDOW_COLORS } from "./glsl";

// Shared, frame-updated uniforms for the whole city.
export interface CityUniforms {
  uTime: { value: number };
  /** Multiplier on each building's lit-window ratio (busier city: more lights). */
  uLitScale: { value: number };
  /** Window / sign brightness multiplier (dims when paused). */
  uLightGain: { value: number };
  /** Warm sodium bounce light on the lower floors and street furniture. */
  uStreetGlow: { value: number };
  /** Fog range, mirrored from the scene fog (for additive sprites). */
  uFogNear: { value: number };
  uFogFar: { value: number };
}

export function createCityUniforms(): CityUniforms {
  return {
    uTime: { value: 0 },
    uLitScale: { value: 1 },
    uLightGain: { value: 1 },
    uStreetGlow: { value: 1 },
    uFogNear: { value: 120 },
    uFogFar: { value: 420 },
  };
}

function patch(
  shader: THREE.WebGLProgramParametersWithUniforms,
  {
    vertexHeader = "",
    vertexBody = "",
    fragmentHeader = "",
    fragmentColor = "",
    fragmentRough = "",
    fragmentMetal = "",
    fragmentEmissive = "",
  }: {
    vertexHeader?: string;
    vertexBody?: string;
    fragmentHeader?: string;
    fragmentColor?: string;
    fragmentRough?: string;
    fragmentMetal?: string;
    fragmentEmissive?: string;
  },
) {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${vertexHeader}`)
    .replace("#include <begin_vertex>", `#include <begin_vertex>\n${vertexBody}`);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${fragmentHeader}`)
    .replace("#include <color_fragment>", `#include <color_fragment>\n${fragmentColor}`)
    .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${fragmentRough}`)
    .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>\n${fragmentMetal}`)
    .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${fragmentEmissive}`);
}

// --- Filler buildings --------------------------------------------------------

/**
 * Instanced box tiers with a procedural facade: a per-floor window grid with
 * random lit cells (warm and cool mixes), storefronts, billboards, floodlit
 * crowns and warm street glow on the lower floors.
 *
 * Per-instance attributes:
 *   aStyle = (style id, floor height, lit ratio, seed)
 *   aTint  = facade colour (linear)
 *   aFlags = (unused, flood 0/1/2, storefront 0/1, billboard band top)
 */
export function createBuildingMaterial(u: CityUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, envMapIntensity: 1 });
  mat.name = "CityFacade";
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = u.uTime;
    shader.uniforms.uLitScale = u.uLitScale;
    shader.uniforms.uLightGain = u.uLightGain;
    shader.uniforms.uStreetGlow = u.uStreetGlow;
    patch(shader, {
      vertexHeader: /* glsl */ `
        attribute vec4 aStyle; attribute vec3 aTint; attribute vec4 aFlags;
        varying vec3 vObjPos; varying vec3 vObjNormal; varying vec3 vScale;
        varying float vWorldY; varying float vTierTop; varying float vTierBase;
        varying vec4 vStyle; varying vec3 vTint; varying vec4 vFlags;`,
      vertexBody: /* glsl */ `
        vObjPos = position; vObjNormal = normal;
        vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vWorldY = (modelMatrix * instanceMatrix * vec4(position, 1.0)).y;
        vTierTop = instanceMatrix[3].y + 0.5 * vScale.y;
        vTierBase = instanceMatrix[3].y - 0.5 * vScale.y;
        vStyle = aStyle; vTint = aTint; vFlags = aFlags;`,
      fragmentHeader: /* glsl */ `
        uniform float uTime; uniform float uLitScale; uniform float uLightGain; uniform float uStreetGlow;
        varying vec3 vObjPos; varying vec3 vObjNormal; varying vec3 vScale;
        varying float vWorldY; varying float vTierTop; varying float vTierBase;
        varying vec4 vStyle; varying vec3 vTint; varying vec4 vFlags;
        ${GLSL_HASH}
        ${GLSL_PULSE}
        ${GLSL_WINDOW_COLORS}
        const vec3 AD_PALETTE[8] = vec3[8](
          vec3(1.0, 0.04, 0.12), vec3(1.0, 0.62, 0.0), vec3(0.0, 0.55, 1.0), vec3(1.0, 0.08, 0.7),
          vec3(0.05, 1.0, 0.35), vec3(0.95, 0.95, 1.0), vec3(1.0, 0.28, 0.0), vec3(0.3, 0.12, 1.0));`,
      fragmentColor: /* glsl */ `
        vec3 facadeEmissive = vec3(0.0);
        float facadeRough = 0.86;
        float facadeMetal = 0.0;
        {
          int style = int(vStyle.x + 0.5);
          float floorH = vStyle.y;
          float seed = vStyle.w;
          vec3 wall = vTint * 0.72;
          bool zFace = abs(vObjNormal.z) > 0.5;
          float faceW = zFace ? vScale.x : vScale.z;
          float u = (zFace ? vObjPos.x : vObjPos.z) + 0.5;
          float faceId = zFace ? (vObjNormal.z > 0.0 ? 1.0 : 2.0) : (vObjNormal.x > 0.0 ? 3.0 : 4.0);

          float bayW = 0.4; float winW = 0.5; float sill = 0.22; float head = 0.78;
          float glassy = 0.0; float warmBias = 0.4; float office = 0.0;
          float panes = 1.0; float piers = 0.0;
          if (style == 0) { bayW = 0.32; winW = 0.42; sill = 0.2; head = 0.8; warmBias = 0.12; }
          else if (style == 1) { bayW = 0.31; winW = 0.4; sill = 0.16; head = 0.84; warmBias = 0.0; }
          else if (style == 2) { bayW = 0.35; winW = 0.4; sill = 0.2; head = 0.82; warmBias = 0.25; }
          else if (style == 3) { bayW = 0.27; winW = 0.5; sill = 0.14; head = 0.88; warmBias = 0.35; office = 0.65; piers = 1.0; }
          else if (style == 4) { bayW = 0.3; winW = 0.93; sill = 0.06; head = 0.96; glassy = 1.0; warmBias = 0.72; office = 1.0; panes = 2.0; }
          else if (style == 5) { bayW = 0.34; winW = 0.9; sill = 0.08; head = 0.94; glassy = 0.85; warmBias = 0.18; office = 1.0; panes = 2.0; }
          else if (style == 6) { bayW = 0.5; winW = 0.95; sill = 0.34; head = 0.86; warmBias = 0.68; office = 1.0; panes = 3.0; }
          else if (style == 7) { bayW = 0.58; winW = 0.72; sill = 0.14; head = 0.86; warmBias = 0.78; panes = 3.0; }
          else if (style == 8) { bayW = 0.42; winW = 0.82; sill = 0.12; head = 0.88; glassy = 0.6; warmBias = 0.6; office = 1.0; panes = 2.0; }
          else if (style == 10) { bayW = 0.4; winW = 0.5; sill = 0.22; head = 0.8; warmBias = 0.3; }

          // Grid coordinates and their screen-space footprints (computed in uniform control flow).
          float nCols = max(1.0, floor(faceW / bayW + 0.5));
          float cx = u * nCols;
          float fy = vWorldY / floorH;
          float dcx = fwidth(cx);
          float dfy = fwidth(fy);
          // Mullions split each window into panes; warehouses also get a transom bar.
          float paneX = cityPulse(cx * panes, 0.08, 0.92, dcx * panes);
          float paneY = style == 7 ? cityPulse(fy * 2.0, 0.06, 0.94, dfy * 2.0) : 1.0;
          float mullions = mix(1.0, paneX * paneY, step(1.5, panes) * 0.85 + step(6.5, float(style)) * step(float(style), 7.5) * 0.15);
          float shopCols = max(1.0, floor(faceW / 0.75 + 0.5));
          float sx = u * shopCols;
          float dsx = fwidth(sx);
          float pc = max(1.0, floor(faceW / mix(1.6, 2.6, fract(seed * 5.3)) + 0.5));
          float px = u * pc;
          float py = (vWorldY - 0.5) / mix(1.4, 2.2, fract(seed * 9.1));
          float dpx = fwidth(px);
          float dpy = fwidth(py);
          vec2 rp = vObjPos.xz * vScale.xz;

          if (vObjNormal.y > 0.5) {
            // Roof: tar and gravel, a lighter parapet edge.
            float n = cityNoise(rp * 2.5 + seed * 50.0);
            // Tar, gravel, the odd pale membrane roof or rooftop garden.
            float rk = fract(seed * 13.17);
            vec3 roofBase = rk < 0.62 ? vec3(0.012, 0.012, 0.014) : rk < 0.82 ? vec3(0.03, 0.03, 0.032) : rk < 0.92 ? vec3(0.018, 0.026, 0.014) : vec3(0.05, 0.05, 0.052);
            vec3 roofCol = mix(roofBase, wall * 0.1, 0.25) * (0.75 + 0.5 * n);
            vec2 e = (0.5 - abs(vObjPos.xz)) * vScale.xz;
            float edge = 1.0 - smoothstep(0.03, 0.08, min(e.x, e.y));
            diffuseColor.rgb = mix(roofCol, wall * 0.3, edge * 0.8);
            facadeRough = 0.95;
          } else if (vObjNormal.y < -0.5) {
            diffuseColor.rgb = vec3(0.02);
          } else {
            float mx = cityPulse(cx, 0.5 - winW * 0.5, 0.5 + winW * 0.5, dcx);
            float my = cityPulse(fy, sill, head, dfy);
            float win = mx * my;
            float parapet = smoothstep(vTierTop - 0.25, vTierTop - 0.2, vWorldY);
            win *= 1.0 - parapet;
            if (style == 9) win = 0.0;

            vec2 cell = vec2(floor(cx), floor(fy));
            // Homes light a few neighbouring windows together (one apartment); offices go by floor.
            float groupW = office > 0.5 ? 1.0 : 2.0 + floor(fract(seed * 3.3) * 2.0);
            vec2 litCell = vec2(floor(floor(cx) / groupW), floor(fy));
            float rWin = mix(cityHash13(vec3(litCell, faceId * 7.13 + seed * 113.0)), cityHash13(vec3(cell, faceId * 7.13 + seed * 113.0)), 0.3);
            float rFloor = cityHash12(vec2(floor(fy), seed * 71.0 + faceId * 0.37));
            float lp = clamp(vStyle.z * uLitScale, 0.0, 1.0);
            float floorOn = step(rFloor, 0.32 + 0.28 * uLitScale);
            lp = mix(lp, floorOn * min(1.0, lp * 1.65) + (1.0 - floorOn) * lp * 0.18, office);
            float lit = step(rWin, lp);
            float tiny = smoothstep(0.35, 0.85, max(dcx, dfy));
            lit = mix(lit, lp, tiny);

            float wy = fract(fy);
            vec3 wc = cityWindowColor(cityHash12(cell * 1.31 + seed * 31.0 + faceId), warmBias);
            float rb = cityHash12(cell.yx + seed * 17.0 + faceId);
            float bright = 0.4 + 1.25 * rb * rb;
            float ceiling = mix(0.75, 1.2, smoothstep(sill, head, wy));
            // Some homes have half-drawn blinds.
            float blind = step(0.8, cityHash12(cell + seed * 9.0)) * step(mix(sill, head, 0.55), wy);
            vec3 glow = wc * bright * ceiling * lit * (1.0 - blind * 0.75 * (1.0 - tiny)) * mix(1.0, mullions, 1.0 - tiny);

            float n = cityNoise(vec2(u * faceW * 1.7, vWorldY * 1.3) + seed * 40.0);
            vec3 wallCol = wall * (0.82 + 0.3 * n);
            // Art Deco: lighter limestone piers between the window columns, darker spandrels.
            if (piers > 0.5) {
              float pier = 1.0 - cityPulse(cx, 0.5 - winW * 0.5 - 0.06, 0.5 + winW * 0.5 + 0.06, dcx);
              wallCol *= mix(0.72, 1.18, pier);
            }
            // Glass facades: dark mullions and spandrels, tinted glass.
            vec3 glassCol = mix(vec3(0.016, 0.02, 0.026), wall * 0.32, glassy * 0.6);
            if (glassy > 0.5) wallCol = wall * 0.45;

            // Storefronts on the ground floor.
            if (vFlags.z > 0.5 && fy < 1.0 && vTierBase < 0.05) {
              float sw = cityPulse(sx, 0.07, 0.93, dsx);
              float sh = smoothstep(0.06, 0.1, wy) * (1.0 - smoothstep(0.66, 0.7, wy));
              float rs = cityHash12(vec2(floor(sx), faceId + seed * 5.0));
              vec3 shop = mix(vec3(1.0, 0.66, 0.36), vec3(1.0, 0.86, 0.62), rs);
              if (rs > 0.9) shop = vec3(0.35, 1.0, 0.65);
              else if (rs > 0.8) shop = vec3(1.0, 0.32, 0.38);
              else if (rs > 0.72) shop = vec3(0.55, 0.75, 1.0);
              float on = rs < 0.12 ? 0.12 : 1.0;
              float sign = smoothstep(0.72, 0.74, wy) * (1.0 - smoothstep(0.86, 0.88, wy)) * step(0.45, cityHash12(vec2(floor(sx) + 3.1, seed)));
              win = sw * sh;
              glow = shop * on * 1.5;
              facadeEmissive += AD_PALETTE[int(rs * 7.99)] * sign * sw * 1.6 * uLightGain;
              glassCol = vec3(0.03, 0.028, 0.025);
            }

            // Billboard band (Times Square): framed screens with abstract ads.
            if (style == 8 && vWorldY < vFlags.w) {
              vec2 pcell = vec2(floor(px), floor(py));
              float pr = cityHash13(vec3(pcell, faceId + seed * 19.0));
              float slot = floor(uTime / (5.0 + pr * 8.0) + pr * 10.0);
              float pr2 = cityHash12(pcell + slot * 1.37 + seed * 3.0);
              vec3 c1 = AD_PALETTE[int(pr2 * 7.99)];
              vec3 c2 = AD_PALETTE[int(fract(pr2 * 7.3) * 7.99)] * 0.35;
              vec2 pf = vec2(fract(px), fract(py));
              float frame = cityPulse(px, 0.07, 0.93, dpx) * cityPulse(py, 0.09, 0.91, dpy);
              float kind = fract(pr2 * 3.7);
              vec3 ad;
              if (kind < 0.34) {
                ad = mix(c1, c2, pf.y);
                float circ = 1.0 - smoothstep(0.24, 0.27, length((pf - vec2(0.66, 0.5)) * vec2(1.3, 1.0)));
                ad = mix(ad, c1 * 0.15 + 0.55, circ * 0.85);
              } else if (kind < 0.67) {
                float row = floor(pf.y * 5.0);
                float bar = step(0.45, fract(pf.y * 5.0)) * step(0.12, pf.x) * step(pf.x, 0.18 + 0.66 * cityHash12(vec2(row, pr2 * 31.0)));
                ad = mix(c1 * 0.12, mix(c1, vec3(1.0), 0.45), bar);
              } else {
                ad = c1 * (0.65 + 0.35 * step(0.5, fract(pf.x * 2.0 + uTime * 0.15 + pr)));
              }
              float live = step(0.3, pr) * step(0.0, py);
              facadeEmissive += ad * frame * live * 1.25 * uLightGain;
              win *= 1.0 - live;
              wallCol = mix(wallCol, vec3(0.012), live);
            }

            diffuseColor.rgb = mix(wallCol, glassCol, win);
            facadeRough = mix(0.88, mix(0.2, 0.07, glassy), win);
            facadeMetal = win * mix(0.05, 0.55, glassy);
            facadeEmissive += glow * win * uLightGain;

            // Sodium bounce light from the street on the lower floors.
            float street = (1.0 - smoothstep(0.0, 3.6, vWorldY)) * uStreetGlow;
            facadeEmissive += wallCol * vec3(1.0, 0.5, 0.2) * street * 0.42 * (1.0 - win * 0.6);
            // Floodlit crowns.
            if (vFlags.y > 0.5) {
              float fh = min(4.5, vScale.y * 0.55);
              float t = clamp((vWorldY - (vTierTop - fh)) / fh, 0.0, 1.0);
              float flood = smoothstep(0.0, 0.3, t) * (1.0 - 0.55 * t);
              vec3 fc = vFlags.y > 1.5 ? vec3(0.62, 0.78, 1.0) : vec3(1.0, 0.74, 0.45);
              facadeEmissive += (wallCol * 0.9 + 0.05) * fc * flood * 1.15 * uLightGain * (1.0 - win * 0.5);
            }
          }
        }`,
      fragmentRough: "roughnessFactor = facadeRough;",
      fragmentMetal: "metalnessFactor = facadeMetal;",
      fragmentEmissive: "totalEmissiveRadiance += facadeEmissive;",
    });
  };
  mat.customProgramCacheKey = () => "city-facade-v1";
  return mat;
}

// --- Generic street-glow patch -----------------------------------------------

/**
 * Adds the warm sodium bounce light (from streetlamps below) to any standard
 * material, plus an optional per-instance emissive strength (aGlow).
 */
export function withStreetGlow<T extends THREE.MeshStandardMaterial>(
  mat: T,
  u: CityUniforms,
  { instancedGlow = false, glowColor = "vec3(1.0, 0.72, 0.42)", key = "glow" } = {},
): T {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uStreetGlow = u.uStreetGlow;
    shader.uniforms.uLightGain = u.uLightGain;
    patch(shader, {
      vertexHeader: `varying float vGlowY; ${instancedGlow ? "attribute float aGlow; varying float vGlow; varying float vLocalY;" : ""}`,
      vertexBody: `
        #ifdef USE_INSTANCING
          vGlowY = (modelMatrix * instanceMatrix * vec4(position, 1.0)).y;
        #else
          vGlowY = (modelMatrix * vec4(position, 1.0)).y;
        #endif
        ${instancedGlow ? "vGlow = aGlow; vLocalY = position.y;" : ""}`,
      fragmentHeader: `uniform float uStreetGlow; uniform float uLightGain; varying float vGlowY; ${instancedGlow ? "varying float vGlow; varying float vLocalY;" : ""}`,
      fragmentEmissive: `
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.5, 0.2) * (1.0 - smoothstep(0.0, 3.6, vGlowY)) * uStreetGlow * 0.6;
        ${instancedGlow ? `totalEmissiveRadiance += (diffuseColor.rgb + 0.04) * ${glowColor} * vGlow * (1.15 - 0.85 * clamp(vLocalY, 0.0, 1.0)) * uLightGain;` : ""}`,
    });
  };
  mat.customProgramCacheKey = () => `street-${key}-${instancedGlow ? 1 : 0}`;
  return mat;
}
