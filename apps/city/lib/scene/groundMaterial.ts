import * as THREE from "three";
import { GLSL_HASH, GLSL_PULSE } from "./glsl";
import {
  AVENUE_HALF,
  AVENUE_XS,
  BROADWAY,
  BROADWAY_HALF,
  PARK,
  SHORE_ROAD,
  SIDEWALK,
  STREET_HALF,
  STREET_SPACING,
  STREET_ZS,
  TIMES_SQUARE,
} from "./layout";
import type { CityUniforms } from "./materials";
import { SDF_BOUNDS } from "./textures";

const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`);

function broadwayGlsl(): string {
  const segs: string[] = [];
  for (let i = 0; i < BROADWAY.length - 1; i++) {
    const a = BROADWAY[i]!;
    const b = BROADWAY[i + 1]!;
    segs.push(`d = min(d, segDist(p, vec2(${f(a[0])}, ${f(a[1])}), vec2(${f(b[0])}, ${f(b[1])})));`);
  }
  return /* glsl */ `
    float segDist(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a; vec2 ba = b - a;
      float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      return length(pa - ba * h);
    }
    float broadwayDist(vec2 p) { float d = 1e5; ${segs.join(" ")} return d; }
    float broadwayX(float z) {
      // Straight spine south of z=38, then the diagonal.
      vec2 a = vec2(${f(BROADWAY[1]![0])}, ${f(BROADWAY[1]![1])});
      vec2 b = vec2(${f(BROADWAY[2]![0])}, ${f(BROADWAY[2]![1])});
      if (z >= a.y) return a.x;
      return a.x + (b.x - a.x) * (z - a.y) / (b.y - a.y);
    }`;
}

export interface GroundTextures {
  shoreSdf: THREE.Texture;
  park: THREE.Texture;
}

export function createGroundMaterial(u: CityUniforms, tex: GroundTextures): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, envMapIntensity: 0.9 });
  mat.name = "CityGround";
  const avMin = AVENUE_XS[0];
  const avStep = AVENUE_XS[1] - AVENUE_XS[0];
  const stMin = STREET_ZS[0]!;
  const stCount = STREET_ZS.length - 1;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = u.uTime;
    shader.uniforms.uStreetGlow = u.uStreetGlow;
    shader.uniforms.uLightGain = u.uLightGain;
    shader.uniforms.uShoreSdf = { value: tex.shoreSdf };
    shader.uniforms.uParkTex = { value: tex.park };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vGroundXZ;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGroundXZ = (modelMatrix * vec4(position, 1.0)).xz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        uniform float uTime; uniform float uStreetGlow; uniform float uLightGain;
        uniform sampler2D uShoreSdf; uniform sampler2D uParkTex;
        varying vec2 vGroundXZ;
        ${GLSL_HASH}
        ${GLSL_PULSE}
        ${broadwayGlsl()}`,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        float groundRough = 0.85;
        vec3 groundEmissive = vec3(0.0);
        {
          vec2 p = vGroundXZ;
          vec2 sdfUv = (p - vec2(${f(SDF_BOUNDS.x0)}, ${f(SDF_BOUNDS.z0)})) / vec2(${f(SDF_BOUNDS.x1 - SDF_BOUNDS.x0)}, ${f(SDF_BOUNDS.z1 - SDF_BOUNDS.z0)});
          float sd = texture2D(uShoreSdf, sdfUv).r;
          float fwx = fwidth(p.x);
          float fwy = fwidth(p.y);
          float fw = max(fwx, fwy);
          float aa = fw * 0.75;

          float ak = clamp(floor((p.x - ${f(avMin)}) / ${f(avStep)} + 0.5), 0.0, ${f(AVENUE_XS.length - 1)});
          float ax = ${f(avMin)} + ${f(avStep)} * ak;
          float dxA = p.x - ax;
          float sk = clamp(floor((p.y - ${f(stMin)}) / ${f(STREET_SPACING)} + 0.5), 0.0, ${f(stCount)});
          float sz = ${f(stMin)} + ${f(STREET_SPACING)} * sk;
          float dzS = p.y - sz;
          float dB = broadwayDist(p);

          bool inParkZone = p.x > ${f(PARK.x0)} && p.x < ${f(PARK.x1)} && p.y > ${f(PARK.z0)} && p.y < ${f(PARK.z1)};
          bool avenueGone = abs(ax) < 20.0 && p.y > ${f(PARK.z0 - 0.5)} && p.y < ${f(PARK.z1 + 0.5)};
          bool streetGone = p.x > ${f(PARK.x0)} && p.x < ${f(PARK.x1)} && sz > ${f(PARK.z0)} && sz < ${f(PARK.z1)};
          float eA = avenueGone ? 1e3 : abs(dxA) - ${f(AVENUE_HALF)};
          float eS = streetGone ? 1e3 : abs(dzS) - ${f(STREET_HALF)};
          float eB = dB - ${f(BROADWAY_HALF)};
          float eRoad = min(min(eA, eS), eB);

          // Times Square bowtie: pedestrian plaza between Broadway and the avenue.
          float tsz = p.y - ${f(TIMES_SQUARE.z)};
          float bx = broadwayX(p.y);
          float tsLo = min(bx, ${f(TIMES_SQUARE.x)}) - 1.1;
          float tsHi = max(bx, ${f(TIMES_SQUARE.x)}) + 1.1;
          bool plaza = abs(tsz) < ${f(TIMES_SQUARE.halfLength)} && p.x > tsLo && p.x < tsHi && abs(p.x - ${f(TIMES_SQUARE.x)}) > ${f(AVENUE_HALF)};

          float n1 = cityFbm(p * 0.9);
          float n2 = cityNoise(p * 7.0);
          vec3 asphalt = vec3(0.03, 0.032, 0.036) * (0.8 + 0.45 * n1) * (0.92 + 0.16 * n2);
          vec3 col = vec3(0.034, 0.036, 0.033) * (0.8 + 0.4 * n1); // block interiors, yards
          float rough = 0.9;

          if (sd < ${f(SHORE_ROAD.inner)}) {
            // Waterfront promenade with a railing.
            float planks = cityPulse(p.x * 2.2 + p.y * 2.2, 0.0, 0.9, (fwx + fwy) * 2.2);
            col = vec3(0.11, 0.098, 0.088) * (0.85 + 0.15 * planks) * (0.9 + 0.2 * n1);
            float rail = 1.0 - smoothstep(0.06, 0.06 + aa * 2.0, sd);
            col = mix(col, vec3(0.32, 0.31, 0.3), rail);
            rough = 0.8;
          } else if (sd < ${f(SHORE_ROAD.outer)} && p.y < 92.0) {
            // Shore drive.
            col = asphalt;
            rough = 0.62 + 0.3 * n1;
            float mid = ${f((SHORE_ROAD.inner + SHORE_ROAD.outer) / 2)};
            float dbl = cityBand(abs(sd - mid) - 0.07, 0.025, aa);
            col = mix(col, vec3(0.55, 0.42, 0.1), dbl * 0.85);
            float along = (p.y + p.x * 0.2) / 1.3;
            float dash = cityPulse(along, 0.0, 0.45, (fwy + 0.2 * fwx) / 1.3);
            float lanes = max(cityBand(sd - (mid - 0.7), 0.022, aa), cityBand(sd - (mid + 0.7), 0.022, aa)) * dash;
            col = mix(col, vec3(0.5), lanes * 0.8);
          } else if (sd < ${f(SHORE_ROAD.outer + SIDEWALK)} && p.y < 92.0) {
            col = vec3(0.12, 0.116, 0.11);
            rough = 0.85;
          } else if (p.y > 92.6) {
            // The Battery: lawns and paths at the tip.
            col = vec3(0.024, 0.042, 0.022) * (0.8 + 0.5 * n1);
            float path = cityBand(sin(p.x * 0.35 + 1.3) * 3.0 + 100.0 - p.y, 0.3, aa);
            col = mix(col, vec3(0.1, 0.09, 0.08), path);
          } else if (inParkZone) {
            vec2 puv = (p - vec2(${f(PARK.x0)}, ${f(PARK.z0)})) / vec2(${f(PARK.x1 - PARK.x0)}, ${f(PARK.z1 - PARK.z0)});
            col = texture2D(uParkTex, puv).rgb;
            col *= 0.95 + 0.1 * n2;
            rough = 0.92;
          } else if (plaza) {
            // Red pedestrian plaza, washed in screen light.
            float tiles = cityPulse(p.x * 1.6, 0.05, 0.95, fwx * 1.6) * cityPulse(p.y * 1.6, 0.05, 0.95, fwy * 1.6);
            col = vec3(0.24, 0.07, 0.065) * (0.85 + 0.15 * tiles);
            rough = 0.5;
            float fall = 1.0 - smoothstep(4.0, 15.0, length(vec2((p.x - ${f(TIMES_SQUARE.x)}) * 1.6, tsz)));
            vec3 wash = mix(vec3(1.0, 0.25, 0.6), vec3(0.25, 0.7, 1.0), cityNoise(p * 0.35 + uTime * 0.15));
            wash = mix(wash, vec3(1.0, 0.85, 0.5), 0.35);
            groundEmissive += wash * fall * 0.34 * uLightGain;
          } else if (eRoad < 0.0) {
            col = asphalt;
            rough = 0.55 + 0.38 * smoothstep(0.35, 0.75, n1);
            bool atIntersection = eA < 0.0 && eS < 0.0;
            // Avenue lane lines (one-way avenues: dashed white).
            if (eA < 0.0 && eS > 0.5 && eB > 0.4) {
              float dash = cityPulse(p.y / 1.4, 0.0, 0.45, fwy / 1.4);
              float l = max(cityBand(dxA, 0.025, aa), max(cityBand(abs(dxA) - 0.64, 0.025, aa), 0.0)) * dash;
              col = mix(col, vec3(0.46), l * 0.85);
              // A red bus lane on the east side of every other avenue.
              float bus = step(0.5, mod(ak, 2.0)) * step(1.05, dxA) * step(dxA, 1.5);
              col = mix(col, vec3(0.16, 0.035, 0.03), bus * 0.85);
            }
            // Street centre lines.
            if (eS < 0.0 && eA > 0.6 && eB > 0.4) {
              bool twoWay = mod(sk, 5.0) == 2.0;
              if (twoWay) {
                float dbl = cityBand(abs(dzS) - 0.06, 0.02, aa);
                col = mix(col, vec3(0.55, 0.42, 0.1), dbl * 0.85);
              } else {
                float dash = cityPulse(p.x / 1.2, 0.0, 0.45, fwx / 1.2);
                col = mix(col, vec3(0.42), cityBand(dzS, 0.022, aa) * dash * 0.7);
              }
            }
            // Crosswalks on both roads around each intersection.
            if (eA < 0.0 && eS > 0.06 && eS < 0.5 && eB > 0.3) {
              float stripes = cityPulse(dxA / 0.22, 0.0, 0.5, fwx / 0.22);
              col = mix(col, vec3(0.5), stripes * 0.85);
            }
            if (eS < 0.0 && eA > 0.06 && eA < 0.5 && eB > 0.3) {
              float stripes = cityPulse(dzS / 0.2, 0.0, 0.5, fwy / 0.2);
              col = mix(col, vec3(0.5), stripes * 0.85);
            }
            if (eB < 0.0 && !atIntersection && eA > 0.3 && eS > 0.3) {
              float along = p.y / 1.3;
              float dash = cityPulse(along, 0.0, 0.45, fwy / 1.3);
              col = mix(col, vec3(0.44), cityBand(dB, 0.024, aa) * dash * 0.8);
            }
            // Manholes.
            vec2 mc = floor(p / 2.3);
            vec2 mo = cityHash22(mc) * 2.3;
            float man = cityBand(length(p - mc * 2.3 - mo), 0.07, aa) * step(0.7, cityHash12(mc + 4.0));
            col = mix(col, vec3(0.06, 0.058, 0.055), man);
          } else if (eRoad < ${f(SIDEWALK)}) {
            // Sidewalk slabs and a bright curb.
            float slabs = cityPulse(p.x / 0.32, 0.04, 1.0, fwx / 0.32) * cityPulse(p.y / 0.32, 0.04, 1.0, fwy / 0.32);
            col = vec3(0.13, 0.126, 0.12) * (0.88 + 0.12 * slabs) * (0.9 + 0.2 * n1);
            float curb = 1.0 - smoothstep(0.035, 0.035 + aa * 2.0, eRoad);
            col = mix(col, vec3(0.24, 0.235, 0.23), curb);
            rough = 0.82;
            groundEmissive += vec3(1.0, 0.58, 0.28) * 0.012 * uStreetGlow * (1.0 - smoothstep(0.0, ${f(SIDEWALK)}, ${f(SIDEWALK)} - eRoad));
          }
          diffuseColor.rgb = col;
          groundRough = rough;
        }`,
      )
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = groundRough;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += groundEmissive;");
  };
  mat.customProgramCacheKey = () => "city-ground-v1";
  return mat;
}

/** Cheap ground for the shores across the rivers: a dim grid of lit streets. */
export function createFarGroundMaterial(u: CityUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  mat.name = "FarGround";
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uStreetGlow = u.uStreetGlow;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vGroundXZ;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGroundXZ = (modelMatrix * vec4(position, 1.0)).xz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nuniform float uStreetGlow; varying vec2 vGroundXZ;\n${GLSL_HASH}\n${GLSL_PULSE}`)
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        vec3 farEmissive = vec3(0.0);
        {
          vec2 p = vGroundXZ;
          float n = cityFbm(p * 0.25);
          float gx = cityPulse(p.x / 3.4, 0.0, 0.16, fwidth(p.x / 3.4));
          float gz = cityPulse(p.y / 4.2, 0.0, 0.14, fwidth(p.y / 4.2));
          float road = max(gx, gz);
          diffuseColor.rgb = mix(vec3(0.03, 0.032, 0.03) * (0.8 + 0.4 * n), vec3(0.03, 0.03, 0.034), road);
          farEmissive = vec3(1.0, 0.5, 0.18) * road * 0.045 * uStreetGlow * (0.4 + 1.0 * n * n);
        }`,
      )
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += farEmissive;");
  };
  mat.customProgramCacheKey = () => "city-far-ground-v1";
  return mat;
}
