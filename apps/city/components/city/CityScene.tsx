"use client";

import { PerformanceMonitor } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { generateBridges } from "@/lib/scene/bridges";
import { generateCity, type HeroLot } from "@/lib/scene/cityGen";
import { installDuskFog } from "@/lib/scene/fog";
import { FramingPlanner } from "@/lib/scene/framing";
import { HERO_SPECS } from "@/lib/scene/heroSpecs";
import { NO_REFLECTION_LAYER, OVERVIEW } from "@/lib/scene/layout";
import { loadManifest, type HeroManifest } from "@/lib/scene/manifest";
import { createCityUniforms } from "@/lib/scene/materials";
import { generatePark } from "@/lib/scene/parkGen";
import { generateStreets } from "@/lib/scene/streetGen";
import type { BuildingVisuals, CitySceneProps } from "@/lib/visual-types";
import { AdaptiveFog, DuskEnvironment, FOG_COLOR, Lights, SkyDome } from "./Atmosphere";
import { Bridges } from "./Bridges";
import { CameraRig, type CameraApi, type FlyTarget, type FramingPlan, type ViewPose } from "./CameraRig";
import { CityGrid } from "./CityGrid";
import { WaterGlints } from "./Glints";
import { CityContext, useCity, type CityContextValue } from "./cityContext";
import { Island, Pond, Water } from "./Ground";
import { HeroTowers } from "./heroes/HeroTowers";
import { LabelLayer, LabelProjector, type LabelAnchor, type LabelRegistry } from "./Labels";
import { Trees } from "./Park";
import { TimesSquareCrowd } from "./People";
import { PostFX } from "./PostFX";
import { RenderStats } from "./RenderStats";
import { SteamVents, StreetLights } from "./Streets";
import { Traffic } from "./Traffic";

// Agent City: a miniature Manhattan at dusk. Renders exactly what the props
// say (spec §10.5); it never reads app state or Supabase itself.

installDuskFog();

/** Optional development aids (used by /preview); not part of the app contract. */
export interface CitySceneDebug {
  /** Cap the frame rate (renders on demand). Handy for software-rendered screenshots. */
  maxFps?: number;
  /** Start (and reset) the camera at this pose instead of the default overview. */
  view?: ViewPose;
  /** Publish per-pass draw calls and triangles on window.__cityStats. */
  stats?: boolean;
}

/** Per-frame ambience: lights respond to traffic, the kill switch dims the city. */
function CityFrame() {
  const { uniforms, ambience } = useCity();
  useFrame((state, dt) => {
    const a = ambience.current;
    const traffic = THREE.MathUtils.clamp(a.trafficDensity, 0, 1);
    const k = Math.min(dt, 0.25);
    uniforms.uTime.value = state.clock.elapsedTime;
    uniforms.uLitScale.value = THREE.MathUtils.damp(uniforms.uLitScale.value, (0.8 + 0.4 * traffic) * (a.paused ? 0.62 : 1), 1.5, k);
    uniforms.uLightGain.value = THREE.MathUtils.damp(uniforms.uLightGain.value, a.paused ? 0.5 : 1, 1.5, k);
    uniforms.uStreetGlow.value = THREE.MathUtils.damp(uniforms.uStreetGlow.value, a.paused ? 0.6 : 1, 1.5, k);
  });
  return null;
}

/** Renders at most `fps` frames per second (frameloop="demand"). */
function FrameThrottle({ fps }: { fps: number }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const id = setInterval(() => invalidate(), 1000 / Math.max(0.1, fps));
    return () => clearInterval(id);
  }, [fps, invalidate]);
  return null;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

/** Where to aim the camera on each landmark (the interesting part: crowns, LED band, screens). */
const AIM: Partial<Record<BuildingVisuals["model"], number>> = {
  "deco-spire": 0.56,
  "glass-led": 0.66,
  "twist-tower": 0.55,
  "ring-cylinder": 0.6,
  "billboard-block": 0.42,
};

function specFor(b: BuildingVisuals, manifest: HeroManifest | null) {
  return manifest?.[b.model] ?? HERO_SPECS[b.model];
}

function heroLotsFor(buildings: BuildingVisuals[], manifest: HeroManifest): HeroLot[] {
  return buildings.map((b) => {
    const spec = specFor(b, manifest);
    return { id: b.divisionId, x: b.x, z: b.z, rotation: b.rotation, w: spec.lot[0], d: spec.lot[1], height: spec.frameHeight };
  });
}

export default function CityScene(props: CitySceneProps & { debug?: CitySceneDebug }) {
  const { ambience, buildings } = props;
  const low = ambience.lowGraphics;
  const reducedMotion = useReducedMotion();
  const uniforms = useMemo(() => createCityUniforms(), []);
  const ambienceRef = useRef(ambience);
  ambienceRef.current = ambience;
  const ctx = useMemo<CityContextValue>(() => ({ uniforms, ambience: ambienceRef }), [uniforms]);
  const cameraApi = useRef<CameraApi | null>(null);
  const labels = useMemo<LabelRegistry>(() => new Map(), []);

  const [manifest, setManifest] = useState<HeroManifest | null>(null);
  useEffect(() => {
    let alive = true;
    const timeout = setTimeout(() => alive && setManifest((m) => m ?? {}), 2500);
    loadManifest().then((m) => alive && setManifest(m));
    return () => {
      alive = false;
      clearTimeout(timeout);
    };
  }, []);

  // The filler city is regenerated only when hero lots actually move.
  const lots = useMemo(() => (manifest ? heroLotsFor(buildings, manifest) : null), [manifest, buildings]);
  const lotsKey = lots ? lots.map((l) => `${l.id}:${l.x}:${l.z}:${l.rotation}:${l.w}:${l.d}:${l.height}`).join("|") : "";
  const lotsRef = useRef(lots);
  lotsRef.current = lots;
  const city = useMemo(() => (lotsKey ? generateCity(lotsRef.current ?? []) : null), [lotsKey]);
  const streets = useMemo(() => generateStreets(), []);
  const bridges = useMemo(() => generateBridges(), []);
  const lanes = useMemo(() => [...streets.lanes, ...bridges.lanes], [streets, bridges]);
  const park = useMemo(() => generatePark(), []);
  const trees = useMemo(() => {
    const ls = lotsRef.current;
    if (!ls) return park.trees;
    return park.trees.filter((t) => !ls.some((l) => Math.abs(t.x - l.x) < l.w / 2 + 0.8 && Math.abs(t.z - l.z) < l.d / 2 + 0.8));
  }, [park, lotsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const targetFor = useCallback(
    (id: string): FlyTarget | null => {
      const b = buildings.find((x) => x.divisionId === id);
      if (!b) return null;
      const s = specFor(b, manifest);
      return { id, x: b.x, z: b.z, height: s.frameHeight, radius: Math.hypot(s.footprint[0], s.footprint[1]) / 2, aim: AIM[b.model] };
    },
    [buildings, manifest],
  );
  // Fly-to framing that avoids putting other buildings between the camera and the tower.
  const plan = useMemo<FramingPlan>(() => {
    const ls = lotsRef.current ?? [];
    const planner = new FramingPlanner(
      city,
      ls.map((l) => ({ id: l.id, x: l.x, z: l.z, height: l.height, radius: Math.hypot(l.w, l.d) / 2, w: l.w, d: l.d })),
    );
    return (t, fit) => planner.plan(t, fit);
  }, [city, lotsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const focusTarget = useMemo(() => (props.focusDivisionId ? targetFor(props.focusDivisionId) : null), [props.focusDivisionId, targetFor]);
  const focusKey = `${props.focusDivisionId ?? ""}:${props.focusToken ?? 0}`;

  const anchors = useMemo<LabelAnchor[]>(
    () =>
      buildings.map((b) => {
        const s = specFor(b, manifest);
        const p = new THREE.Vector3(...s.label).applyAxisAngle(new THREE.Vector3(0, 1, 0), b.rotation);
        p.add(new THREE.Vector3(b.x, 0, b.z));
        return { divisionId: b.divisionId, position: p };
      }),
    [buildings, manifest],
  );

  const { onSelectDivision } = props;
  const selectFromLabel = useCallback(
    (id: string) => {
      onSelectDivision(id);
      const t = targetFor(id);
      if (t) cameraApi.current?.flyTo(t);
    },
    [onSelectDivision, targetFor],
  );
  const labelFor = useCallback((id: string) => labels.get(id), [labels]);

  const maxFps = props.debug?.maxFps;
  // Adaptive resolution: start sharp, drop the pixel ratio if the frame rate sags.
  const [dprCap, setDprCap] = useState(2);
  const dpr: [number, number] = low ? [1, Math.min(1.25, dprCap)] : [1, dprCap];
  return (
    <div style={{ position: "absolute", inset: 0, background: "#070b14", overflow: "hidden" }}>
      <Canvas
        dpr={dpr}
        frameloop={maxFps ? "demand" : "always"}
        camera={{ position: OVERVIEW.position, fov: 35, near: 0.5, far: 2400 }}
        gl={{ antialias: false, powerPreference: "high-performance", stencil: false }}
        onCreated={({ gl, camera, raycaster }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.0;
          // Small props render in the main view but are skipped by the water reflection.
          camera.layers.enable(NO_REFLECTION_LAYER);
          raycaster.layers.enable(NO_REFLECTION_LAYER);
        }}
      >
        <CityContext.Provider value={ctx}>
          {maxFps ? <FrameThrottle fps={maxFps} /> : null}
          {!maxFps && (
            <PerformanceMonitor
              bounds={() => [45, 58]}
              flipflops={4}
              onDecline={() => setDprCap((d) => Math.max(1, d - 0.5))}
              onIncline={() => setDprCap((d) => Math.min(2, d + 0.25))}
            />
          )}
          <color attach="background" args={[FOG_COLOR]} />
          <CityFrame />
          <AdaptiveFog />
          <SkyDome />
          <Lights />
          <DuskEnvironment />
          <Island park={park} />
          <Water lowGraphics={low} />
          <Pond />
          {city && <CityGrid model={city} />}
          <StreetLights lamps={streets.lamps} pools={streets.pools} parkLamps={park.pathLamps} />
          <SteamVents vents={streets.vents} />
          <TimesSquareCrowd count={low ? 260 : 520} />
          <Trees trees={trees} />
          <Bridges model={bridges} />
          <WaterGlints lamps={streets.lamps} bridges={bridges} low={low} />
          <Traffic lanes={lanes} density={ambience.trafficDensity} lowGraphics={low} />
          {manifest && (
            <HeroTowers
              buildings={buildings}
              manifest={manifest}
              onSelectDivision={onSelectDivision}
              cameraApi={cameraApi}
              reducedMotion={reducedMotion}
              labelFor={labelFor}
            />
          )}
          <LabelProjector anchors={anchors} registry={labels} insets={props.viewInsets} />
          <CameraRig
            apiRef={cameraApi}
            focus={focusTarget}
            focusKey={focusKey}
            resetToken={props.cameraResetToken}
            insets={props.viewInsets}
            reducedMotion={reducedMotion}
            plan={plan}
            home={props.debug?.view}
          />
          <PostFX lowGraphics={low} insets={props.viewInsets} />
          {props.debug?.stats && <RenderStats />}
        </CityContext.Provider>
      </Canvas>
      <LabelLayer buildings={buildings} registry={labels} onSelect={selectFromLabel} />
    </div>
  );
}
