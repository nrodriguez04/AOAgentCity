import type { DivisionKind, DivisionStatus } from "./enums";

// Each division is a landmark-style tower (spec §10.3). These are original
// designs inspired by New York architectural styles, not replicas.
export const BUILDING_MODELS = [
  "deco-spire", // HQ: tallest Art Deco spire with crown lights
  "glass-led", // ParlayLab: glass curtain wall with a scrolling LED band
  "ring-cylinder", // Halo: cylindrical tower with a glowing ring crown
  "neoclassical", // FedOps: columned temple front
  "warehouse-loft", // GalleySwap: converted brick warehouse near the river
  "twist-tower", // AverageOutput / OTHERLIFE: twisting modern tower
  "bank-dome", // Finances: stone bank with a dome
  "glass-pavilion", // Health: low glass pavilion in the park
  "billboard-block", // CreatorOS: billboard-covered Times Square block
] as const;
export type BuildingModel = (typeof BUILDING_MODELS)[number];

export interface DivisionDefinition {
  id: string;
  name: string;
  kind: DivisionKind;
  status: DivisionStatus;
  summary: string;
  /** Living context doc agents read at the start of every run. */
  contextMd: string;
  slot: { x: number; z: number; buildingModel: BuildingModel; rotation?: number };
}

// City coordinates: +x is east, +z is south. The grid lives in apps/city
// (lib/city-layout.ts); slots sit on block centres of that grid.
export const DIVISIONS: DivisionDefinition[] = [
  {
    id: "hq",
    name: "HQ",
    kind: "hq",
    status: "planning",
    summary: "Orchestrator: daily brief, priorities and routing across every division.",
    contextMd: [
      "# HQ",
      "HQ reasons across every division and decides what matters today.",
      "- Owner: Nico. Agents serve Nico; they never act on his behalf outside the approval queue.",
      "- Live business today: ParlayLab. Everything else is planned or concept.",
    ].join("\n"),
    slot: { x: 0, z: 66.5, buildingModel: "deco-spire" },
  },
  {
    id: "parlaylab",
    name: "ParlayLab",
    kind: "business",
    status: "live",
    summary: "Live business. Stripe subscription tiers configured.",
    contextMd: [
      "# ParlayLab",
      "Subscription product billed through Stripe (tiers are configured as Stripe prices).",
      "- Revenue health: MRR, active subscriptions by tier, failed payments, churn.",
      "- Support inbox: customer questions, billing issues, bug reports.",
      "- Any email to a customer, refund, or price change goes through the approval queue.",
    ].join("\n"),
    slot: { x: 22, z: -31.5, buildingModel: "glass-led" },
  },
  {
    id: "halo",
    name: "Halo",
    kind: "business",
    status: "planned",
    summary: "Planned business. Placeholder building only.",
    contextMd: "# Halo\nPlanned. No agents yet.",
    slot: { x: 44, z: 10.5, buildingModel: "ring-cylinder" },
  },
  {
    id: "fedops",
    name: "FedOps",
    kind: "business",
    status: "planned",
    summary: "Planned business. Placeholder building only.",
    contextMd: "# FedOps\nPlanned. No agents yet.",
    slot: { x: -22, z: 66.5, buildingModel: "neoclassical" },
  },
  {
    id: "galleyswap",
    name: "GalleySwap",
    kind: "business",
    status: "planned",
    summary: "Not yet in the city POC. Placeholder building only.",
    contextMd: "# GalleySwap\nPlanned. No agents yet.",
    slot: { x: -44, z: 31.5, buildingModel: "warehouse-loft" },
  },
  {
    id: "averageoutput",
    name: "AverageOutput",
    kind: "business",
    status: "planned",
    summary: "Studio brand; OTHERLIFE is its flagship game. One division or two is still an open decision.",
    contextMd: [
      "# AverageOutput",
      "Average Output Studios builds OTHERLIFE (codename AOWorld), a persistent multiplayer life simulation in Unreal Engine.",
      "Open decision: whether OTHERLIFE becomes its own division.",
    ].join("\n"),
    slot: { x: 0, z: -17.5, buildingModel: "twist-tower" },
  },
  {
    id: "finances",
    name: "Finances",
    kind: "personal",
    status: "planned",
    summary: "Personal finances. Read-only when built.",
    contextMd: "# Finances\nPlanned. Read-only aggregation only; no money-movement tools exist.",
    slot: { x: 22, z: 73.5, buildingModel: "bank-dome" },
  },
  {
    id: "health",
    name: "Health",
    kind: "personal",
    status: "planned",
    summary: "Personal health. Private and read-only when built.",
    contextMd: "# Health\nPlanned. Private, read-only sources; summaries only.",
    slot: { x: 0, z: -76, buildingModel: "glass-pavilion" },
  },
  {
    id: "creatoros",
    name: "CreatorOS",
    kind: "creator",
    status: "live",
    summary: "Social and content POC. Agents arrive in phase 2.",
    contextMd: "# CreatorOS\nLive POC. Content calendar, drafts and metrics agents arrive in phase 2; posting will require approval.",
    slot: { x: -22, z: -45.5, buildingModel: "billboard-block" },
  },
];

export const DIVISION_ORDER: readonly string[] = DIVISIONS.map((d) => d.id);

export function divisionDefinition(id: string): DivisionDefinition | undefined {
  return DIVISIONS.find((d) => d.id === id);
}
