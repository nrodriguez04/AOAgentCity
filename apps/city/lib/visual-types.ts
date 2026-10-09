import type { BuildingModel, DivisionStatus } from "@agent-city/core";

// Contract between the data side (store -> deriveVisualState) and the 3D scene.
// The scene never reads Supabase or the store directly: it renders exactly what
// it is given here (spec §10.5).

export type CrownMode =
  /** Nothing special. */
  | "off"
  /** Steady crown lights (division live, agents idle). */
  | "steady"
  /** Soft pulse: at least one agent is working. */
  | "pulse"
  /** Red, slow pulse until the error is acknowledged in the UI. */
  | "error";

export interface DisplayLine {
  label: string;
  value: string;
  tone?: "neutral" | "up" | "down";
}

export interface BuildingVisuals {
  divisionId: string;
  name: string;
  model: BuildingModel;
  /** Lot centre in city units (+x east, +z south) and rotation around +y. */
  x: number;
  z: number;
  rotation: number;
  status: DivisionStatus;
  /** planned / concept divisions render as wireframe or scaffolding. */
  underConstruction: boolean;
  /** Division or whole city paused: darker windows, no pulses. */
  dimmed: boolean;
  /**
   * Window lighting. The tower's floors are split, bottom to top, into `bands`
   * equal groups, one per agent. Bands [0, activeBands) belong to working agents:
   * their windows light up floor by floor (an upward sweep) to nearly fully lit.
   * All other floors sit at `ambientLit` (about 0.2 of windows lit, steady glow).
   */
  floors: { bands: number; activeBands: number };
  ambientLit: number;
  crown: CrownMode;
  /** Rooftop beacon flashing amber while approvals are pending; count is the badge. */
  beacon: { active: boolean; count: number };
  /** Epoch ms of the latest run.succeeded inside the flash window: a white flash runs up the building edges. */
  flashAt: number | null;
  /** HQ only: epoch ms until which the searchlight sweeps after a brief is published. */
  searchlightUntil: number | null;
  /** Latest metrics for the ParlayLab LED band and the CreatorOS billboards. */
  display: DisplayLine[];
  selected: boolean;
}

export interface CityAmbience {
  /** 0..1 avenue traffic density, from run volume over the last hour. */
  trafficDensity: number;
  /** Kill switch on: the whole city dims. */
  paused: boolean;
  /** Disables AO, tilt-shift and water reflections; reduces traffic. */
  lowGraphics: boolean;
}

/** CSS pixels of the canvas covered by UI (glass panel, division bar, top bar). */
export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CitySceneProps {
  buildings: BuildingVisuals[];
  ambience: CityAmbience;
  /** When set (or changed), the camera flies to this division's tower. */
  focusDivisionId: string | null;
  /**
   * Increments on every focus request, so selecting the same division again
   * flies back to it even though focusDivisionId did not change.
   */
  focusToken?: number;
  /** Increment to fly the camera back to the overview. */
  cameraResetToken: number;
  /**
   * The overview and fly-to targets should be framed in the unobstructed part
   * of the canvas (the canvas itself stays full-screen behind the glass UI).
   */
  viewInsets?: ViewInsets;
  onSelectDivision(divisionId: string): void;
}
