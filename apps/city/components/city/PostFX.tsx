"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, N8AO, SMAA, TiltShift2, ToneMapping, Vignette, type TiltShiftEffect } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { useRef } from "react";
import * as THREE from "three";
import type { ViewInsets } from "@/lib/visual-types";

// Post stack (spec §10.4): ambient occlusion, bloom on the emissive city,
// a two-pass tilt-shift for the miniature feel, ACES tone mapping, vignette
// and SMAA. Low graphics drops AO and tilt-shift.

export function PostFX({ lowGraphics, insets }: { lowGraphics: boolean; insets?: ViewInsets }) {
  const size = useThree((s) => s.size);
  // Keep the tilt-shift focus band on the centre of the unobstructed area.
  const top = insets?.top ?? 0;
  const bottom = insets?.bottom ?? 0;
  const clearH = Math.max(80, size.height - top - bottom);
  const focusY = size.height > 0 ? 1 - (top + clearH * 0.54) / size.height : 0.46;
  // Strong miniature blur over the whole city, gentler in close-ups so displays stay readable.
  const tilt1 = useRef<TiltShiftEffect>(null);
  const tilt2 = useRef<TiltShiftEffect>(null);
  useFrame(({ camera, controls }) => {
    const target = (controls as unknown as { target?: THREE.Vector3 } | null)?.target;
    const d = target ? camera.position.distanceTo(target) : 200;
    const blur = 0.04 + 0.09 * THREE.MathUtils.smoothstep(d, 60, 190);
    if (tilt1.current) tilt1.current.blur = blur;
    if (tilt2.current) tilt2.current.blur = blur;
  });
  if (lowGraphics) {
    return (
      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur intensity={0.7} luminanceThreshold={0.82} luminanceSmoothing={0.25} radius={0.62} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        <Vignette darkness={0.5} offset={0.32} />
        <SMAA />
      </EffectComposer>
    );
  }
  return (
    <EffectComposer multisampling={0}>
      <N8AO aoRadius={2.4} distanceFalloff={1.4} intensity={2.2} quality="low" halfRes />
      <Bloom mipmapBlur intensity={0.62} luminanceThreshold={0.85} luminanceSmoothing={0.25} radius={0.62} />
      <TiltShift2 ref={tilt1} blur={0.13} taper={0.36} start={[0, focusY]} end={[1, focusY]} direction={[1, 0.35]} samples={7} />
      <TiltShift2 ref={tilt2} blur={0.13} taper={0.36} start={[0, focusY]} end={[1, focusY]} direction={[0.35, -1]} samples={7} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Vignette darkness={0.5} offset={0.32} />
      <SMAA />
    </EffectComposer>
  );
}
