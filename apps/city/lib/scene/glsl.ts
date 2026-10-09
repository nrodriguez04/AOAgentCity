// Shared GLSL snippets for the city's procedural materials.

export const GLSL_HASH = /* glsl */ `
float cityHash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float cityHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float cityHash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 cityHash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float cityNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = cityHash12(i); float b = cityHash12(i + vec2(1.0, 0.0));
  float c = cityHash12(i + vec2(0.0, 1.0)); float d = cityHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float cityFbm(vec2 p) {
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * cityNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
`;

/**
 * Box-filtered pulse train: 1 where fract(x) is inside [a, b], averaged over a
 * footprint of width w. Keeps procedural windows and road markings from
 * aliasing at a distance.
 */
export const GLSL_PULSE = /* glsl */ `
float cityPulseInt(float x, float a, float b) { return floor(x) * (b - a) + clamp(fract(x), a, b) - a; }
float cityPulse(float x, float a, float b, float w) {
  w = max(w, 1e-4);
  return clamp((cityPulseInt(x + 0.5 * w, a, b) - cityPulseInt(x - 0.5 * w, a, b)) / w, 0.0, 1.0);
}
// Anti-aliased band: 1 where |x| < halfWidth.
float cityBand(float x, float halfWidth, float aa) {
  return 1.0 - smoothstep(halfWidth - aa, halfWidth + aa, abs(x));
}
`;

/** Window light palette shared by fillers and hero towers. */
export const GLSL_WINDOW_COLORS = /* glsl */ `
vec3 cityWindowColor(float r, float warmBias) {
  // r in 0..1 picks a lamp type; warmBias shifts toward incandescent.
  float t = fract(r + warmBias * 0.35);
  if (t < 0.34) return vec3(1.0, 0.62, 0.30);   // 2700K incandescent
  if (t < 0.58) return vec3(1.0, 0.76, 0.48);   // warm white
  if (t < 0.76) return vec3(1.0, 0.88, 0.70);   // halogen
  if (t < 0.92) return vec3(0.80, 0.90, 1.0);   // fluorescent
  return vec3(0.62, 0.76, 1.0);                  // cold LED / TV glow
}
`;
