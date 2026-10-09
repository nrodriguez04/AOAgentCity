"use client";

import { useGLTF } from "@react-three/drei";
import { useEffect } from "react";
import { HERO_SPECS } from "@/lib/scene/heroSpecs";
import type { HeroManifest } from "@/lib/scene/manifest";
import type { BuildingVisuals } from "@/lib/visual-types";
import type { CameraApi, FlyTarget } from "../CameraRig";
import { HeroTower } from "./HeroTower";

export function heroUrl(model: string): string {
  return `/models/${model}.glb`;
}

/** All division landmarks. A model loads only when the manifest lists it. */
export function HeroTowers({
  buildings,
  manifest,
  onSelectDivision,
  cameraApi,
  reducedMotion,
  labelFor,
}: {
  buildings: BuildingVisuals[];
  manifest: HeroManifest;
  onSelectDivision(divisionId: string): void;
  cameraApi: { current: CameraApi | null };
  reducedMotion: boolean;
  labelFor(divisionId: string): HTMLElement | undefined;
}) {
  useEffect(() => {
    for (const key of Object.keys(manifest)) useGLTF.preload(heroUrl(key), false, true);
  }, [manifest]);

  const fly = (t: FlyTarget) => cameraApi.current?.flyTo(t);
  return (
    <group name="heroes">
      {buildings.map((b) => {
        const spec = manifest[b.model] ?? HERO_SPECS[b.model];
        return (
          <HeroTower
            key={b.divisionId}
            visuals={b}
            spec={spec}
            url={manifest[b.model] ? heroUrl(b.model) : null}
            onSelect={onSelectDivision}
            onFly={fly}
            reducedMotion={reducedMotion}
            labelFor={labelFor}
          />
        );
      })}
    </group>
  );
}
