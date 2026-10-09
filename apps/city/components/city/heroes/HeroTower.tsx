"use client";

import { useGLTF } from "@react-three/drei";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Component, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import type { HeroSpec } from "@/lib/scene/heroSpecs";
import { NO_REFLECTION_LAYER } from "@/lib/scene/layout";
import { hashSeed } from "@/lib/scene/random";
import type { BuildingVisuals } from "@/lib/visual-types";
import { useCity } from "../cityContext";
import type { FlyTarget } from "../CameraRig";
import { LedTicker, ScreenPainter, screenKindFor } from "./displays";
import { FloorAnimator } from "./floorAnimator";
import { buildFromGltf, buildPlaceholder, type BodyParts } from "./heroBody";
import { CROWN_COLORS, createHeroUniforms, createLineMaterial, type HeroUniforms } from "./heroMaterials";
import { Beacon, Construction, Searchlights, SelectionRing } from "./overlays";

// One division landmark: the GLB (or a placeholder tower while it loads or if
// it is missing), plus every state effect from BuildingVisuals.

type PartsSetter = (next: BodyParts | null, prev?: BodyParts) => void;

interface BodyCtx {
  model: BuildingVisuals["model"];
  spec: HeroSpec;
  city: ReturnType<typeof useCity>["uniforms"];
  hero: HeroUniforms;
}

class HeroErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    // A broken or missing model only costs this tower its detail.
    console.info("[agent-city] hero model unavailable, showing placeholder:", error instanceof Error ? error.message : error);
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function useBody(parts: BodyParts, onParts: PartsSetter) {
  useLayoutEffect(() => {
    onParts(parts);
    return () => {
      onParts(null, parts);
      parts.dispose();
    };
  }, [parts, onParts]);
}

function GltfBody({ url, ctx, onParts }: { url: string; ctx: BodyCtx; onParts: PartsSetter }) {
  const gltf = useGLTF(url, false, true);
  const parts = useMemo(() => buildFromGltf(gltf.scene, ctx), [gltf, ctx]);
  useBody(parts, onParts);
  return <primitive object={parts.root} />;
}

function PlaceholderBody({ ctx, onParts }: { ctx: BodyCtx; onParts: PartsSetter }) {
  const parts = useMemo(() => buildPlaceholder(ctx), [ctx]);
  useBody(parts, onParts);
  return <primitive object={parts.root} />;
}

const RED = new THREE.Color(1, 0.09, 0.05);
const AIMS: Partial<Record<BuildingVisuals["model"], number>> = {
  "deco-spire": 0.56,
  "glass-led": 0.66,
  "twist-tower": 0.55,
  "ring-cylinder": 0.6,
  "billboard-block": 0.42,
};
const aimFor = (m: BuildingVisuals["model"]) => AIMS[m];
const noRaycast = () => null;

export function HeroTower({
  visuals,
  spec,
  url,
  onSelect,
  onFly,
  reducedMotion,
  labelFor,
}: {
  visuals: BuildingVisuals;
  spec: HeroSpec;
  url: string | null;
  onSelect(divisionId: string): void;
  onFly(target: FlyTarget): void;
  reducedMotion: boolean;
  /** The DOM label of this tower, to mirror 3D hover onto it. */
  labelFor(divisionId: string): HTMLElement | undefined;
}) {
  const { uniforms } = useCity();
  const hero = useMemo(() => createHeroUniforms(Math.max(1, Math.round(spec.floors)), spec.roofHeight), [spec.floors, spec.roofHeight]);
  const ctx = useMemo<BodyCtx>(() => ({ model: visuals.model, spec, city: uniforms, hero }), [visuals.model, spec, uniforms, hero]);
  const animator = useMemo(() => new FloorAnimator(hero.uFloorTex.value, hero.uFloorCount.value), [hero]);
  const [parts, setParts] = useState<BodyParts | null>(null);
  const onParts = useCallback<PartsSetter>((next, prev) => setParts((cur) => next ?? (cur === prev ? null : cur)), []);
  const vref = useRef(visuals);
  vref.current = visuals;

  useEffect(() => () => hero.uFloorTex.value.dispose(), [hero]);

  // Construction progress: deterministic per division.
  const builtTo = useMemo(() => {
    const r = (hashSeed(visuals.divisionId.length, visuals.divisionId.charCodeAt(0), visuals.divisionId.charCodeAt(1) || 0) % 1000) / 1000;
    return Math.max(1.2, spec.roofHeight * (0.34 + 0.22 * r));
  }, [visuals.divisionId, spec.roofHeight]);

  useEffect(() => {
    if (!parts) return;
    parts.setConstruction(visuals.underConstruction);
    hero.uBuiltTo.value = visuals.underConstruction ? builtTo : 1e4;
  }, [parts, visuals.underConstruction, builtTo, hero]);

  // LED band (ParlayLab) and billboards (CreatorOS).
  const ledAspect = spec.ledBand ? spec.ledBand.length / Math.max(0.1, spec.ledBand.height) : 12;
  const led = useMemo(() => (parts && parts.ledMeshes.length ? new LedTicker(visuals.name, ledAspect) : null), [parts, visuals.name, ledAspect]);
  const painters = useMemo(
    () => (parts ? parts.screens.map((s) => ({ part: s, painter: new ScreenPainter(screenKindFor(s.index, s.aspect), s.index + 1, s.aspect, visuals.name) })) : []),
    [parts, visuals.name],
  );
  useEffect(() => {
    const mats: THREE.Material[] = [];
    if (parts && led) {
      led.texture.flipY = !parts.fromGltf;
      led.texture.needsUpdate = true;
      const m = new THREE.MeshBasicMaterial({ map: led.texture });
      m.color.setScalar(2.6);
      mats.push(m);
      for (const mesh of parts.ledMeshes) mesh.material = m;
    }
    for (const { part, painter } of painters) {
      painter.texture.flipY = !parts?.fromGltf;
      painter.texture.needsUpdate = true;
      const m = new THREE.MeshBasicMaterial({ map: painter.texture, side: THREE.DoubleSide });
      m.color.setScalar(part.index === 0 ? 2.1 : 1.8);
      mats.push(m);
      part.mesh.material = m;
    }
    return () => {
      mats.forEach((m) => m.dispose());
      led?.dispose();
      painters.forEach((p) => p.painter.dispose());
    };
  }, [parts, led, painters]);

  // Edge lines for the success flash and the construction blueprint.
  const flashMat = useMemo(() => createLineMaterial(hero, uniforms, "flash"), [hero, uniforms]);
  const blueprintMat = useMemo(() => createLineMaterial(hero, uniforms, "blueprint"), [hero, uniforms]);
  useEffect(
    () => () => {
      flashMat.dispose();
      blueprintMat.dispose();
    },
    [flashMat, blueprintMat],
  );
  const flashLines = useRef<THREE.LineSegments>(null);

  const crownColor = CROWN_COLORS[visuals.model] ?? new THREE.Color(1, 0.85, 0.6);
  const crownLevel = useRef(0.5);
  const tmpColor = useMemo(() => new THREE.Color(), []);

  useFrame((state, dt) => {
    const v = vref.current;
    const t = state.clock.elapsedTime;
    animator.setTargets(v.underConstruction ? 0 : v.floors.bands, v.floors.activeBands);
    animator.update(dt);
    hero.uAmbientLit.value = THREE.MathUtils.damp(hero.uAmbientLit.value, v.underConstruction ? 0 : v.ambientLit * (v.dimmed ? 0.55 : 1), 3, dt);
    hero.uDim.value = THREE.MathUtils.damp(hero.uDim.value, v.dimmed ? 1 : 0, 3, dt);
    const fp = v.flashAt != null ? (Date.now() - v.flashAt) / 1500 : -1;
    hero.uFlash.value = fp >= 0 && fp <= 1 ? fp : -1;
    if (flashLines.current) flashLines.current.visible = hero.uFlash.value >= 0;

    if (parts) {
      let k: number;
      let color = crownColor;
      const wave = 0.5 + 0.5 * Math.sin(t * 2.4);
      switch (v.crown) {
        case "off":
          k = 0.1;
          break;
        case "steady":
          k = 2.0;
          break;
        case "pulse":
          k = v.dimmed ? 1.2 : 1.3 + 1.6 * wave;
          break;
        case "error":
          color = RED;
          k = v.dimmed ? 2.0 : 0.9 + 2.6 * (0.5 + 0.5 * Math.sin(t * 1.5));
          break;
      }
      if (v.dimmed && v.crown !== "error") k *= 0.45;
      // A selected tower's crown burns a little brighter.
      if (v.selected && v.crown !== "off") k *= 1.3;
      crownLevel.current = THREE.MathUtils.damp(crownLevel.current, k, 9, dt);
      parts.crownMat.emissive.lerp(color, 1 - Math.exp(-dt * 5));
      parts.crownMat.emissiveIntensity = crownLevel.current;
      parts.ringMat.emissive.lerp(v.crown === "error" ? RED : CROWN_COLORS["ring-cylinder"]!, 1 - Math.exp(-dt * 5));
      parts.ringMat.emissiveIntensity = 0.4 + crownLevel.current * 1.1;
      tmpColor.setRGB(1.0, 0.86, 0.66);
      parts.accentMat.emissive.copy(tmpColor);
      parts.accentMat.emissiveIntensity = (v.dimmed ? 0.5 : 1.1) + (v.crown === "off" ? 0 : crownLevel.current * 0.2);
    }
    if (led) {
      led.draw(v.display);
      led.scroll(dt * (reducedMotion ? 0.35 : 1));
    }
    for (const p of painters) p.painter.update(t, v.display, reducedMotion ? 2 : 6);
  });

  const select = useCallback(() => {
    const v = vref.current;
    onSelect(v.divisionId);
    onFly({ id: v.divisionId, x: v.x, z: v.z, height: spec.frameHeight, radius: Math.hypot(spec.footprint[0], spec.footprint[1]) / 2, aim: aimFor(v.model) });
  }, [onSelect, onFly, spec.frameHeight, spec.footprint]);

  const onClick = useCallback(
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      select();
    },
    [select],
  );
  const onOver = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      labelFor(vref.current.divisionId)?.setAttribute("data-hover", "1");
      document.body.style.cursor = "pointer";
    },
    [labelFor],
  );
  const onOut = useCallback(() => {
    labelFor(vref.current.divisionId)?.setAttribute("data-hover", "0");
    document.body.style.cursor = "";
  }, [labelFor]);
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  const fpDiag = Math.hypot(spec.footprint[0], spec.footprint[1]);
  const searchlightActive = visuals.searchlightUntil != null && visuals.searchlightUntil > Date.now();
  const [, force] = useState(0);
  // Re-render when the searchlight window ends so it fades out.
  useEffect(() => {
    if (!visuals.searchlightUntil) return;
    const ms = visuals.searchlightUntil - Date.now();
    if (ms <= 0) return;
    const id = setTimeout(() => force((n) => n + 1), Math.min(ms + 50, 2 ** 31 - 1));
    return () => clearTimeout(id);
  }, [visuals.searchlightUntil]);

  return (
    <group position={[visuals.x, 0, visuals.z]} rotation-y={visuals.rotation} name={`hero-${visuals.divisionId}`}>
      <group onClick={onClick} onPointerOver={onOver} onPointerOut={onOut}>
        <HeroErrorBoundary fallback={<PlaceholderBody ctx={ctx} onParts={onParts} />}>
          <Suspense fallback={<PlaceholderBody ctx={ctx} onParts={onParts} />}>
            {url ? <GltfBody url={url} ctx={ctx} onParts={onParts} /> : <PlaceholderBody ctx={ctx} onParts={onParts} />}
          </Suspense>
        </HeroErrorBoundary>
      </group>
      {parts?.edges && (
        <>
          <lineSegments ref={flashLines} geometry={parts.edges} material={flashMat} visible={false} renderOrder={7} raycast={noRaycast} layers={NO_REFLECTION_LAYER} />
          {visuals.underConstruction && (
            <lineSegments geometry={parts.edges} material={blueprintMat} renderOrder={7} raycast={noRaycast} layers={NO_REFLECTION_LAYER} />
          )}
        </>
      )}
      {parts && visuals.underConstruction && <Construction bounds={parts.bounds} builtTo={builtTo} hero={hero} uniforms={uniforms} />}
      <Beacon position={spec.beacon} active={visuals.beacon.active} uniforms={uniforms} />
      {spec.searchlight && (visuals.searchlightUntil != null || visuals.model === "deco-spire") && (
        <Searchlights position={spec.searchlight} active={searchlightActive} uniforms={uniforms} reducedMotion={reducedMotion} />
      )}
      <SelectionRing radius={fpDiag / 2 + 0.9} selected={visuals.selected} reducedMotion={reducedMotion} />
    </group>
  );
}
