"use client";

import { createContext, useContext } from "react";
import type { CityUniforms } from "@/lib/scene/materials";
import type { CityAmbience } from "@/lib/visual-types";

export interface CityContextValue {
  uniforms: CityUniforms;
  /** Live ambience, read inside useFrame without re-rendering. */
  ambience: { current: CityAmbience };
}

export const CityContext = createContext<CityContextValue | null>(null);

export function useCity(): CityContextValue {
  const ctx = useContext(CityContext);
  if (!ctx) throw new Error("useCity() outside <CityScene>");
  return ctx;
}
