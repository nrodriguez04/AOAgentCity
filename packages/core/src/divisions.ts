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
// (lib/scene/layout.ts); slots sit inside blocks of that grid, clear of the
// avenues, streets and Broadway (which runs down x = -5.5 south of z = 38).
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
    slot: { x: 2, z: 66.5, buildingModel: "deco-spire" },
  },
  {
    id: "parlaylab",
    name: "ParlayLab",
    kind: "business",
    status: "planning",
    summary: "Pre-launch sports forecasting product. Its billing agents are parked until it launches.",
    contextMd: [
      "# ParlayLab",
      "Information-only sports analytics: an NFL parlay pricer and multi-sport predictions (repo nrodriguez04/parlaylab).",
      "Pre-launch: not deployed; accounts and a Stripe Pro plan are coded but billing is not configured.",
      "- BILLING-01, SUPPORT-01, GROWTH-01 and the review crew are parked until billing is live.",
      "- First agents after launch: Data Quality (feed staleness, incidents), then Insights (explain predictions, no stake advice).",
      "- Predictions come from the statistical engine only; agents never invent odds or numbers.",
    ].join("\n"),
    slot: { x: 22, z: -31.5, buildingModel: "glass-led" },
  },
  {
    id: "halo",
    name: "Hålo", // display name; "halo" stays the id in code
    kind: "business",
    status: "planned",
    summary: "Real estate wholesaling CRM, built but not deployed. Tested underwriting math comes before any agent.",
    contextMd: [
      "# Hålo",
      "Internal wholesaling CRM (repo nrodriguez04/halo_production): leads, human-approved SMS and email, ATTOM enrichment, PII encryption. Not deployed.",
      "- Before any agent: tested ARV, repair and MAO calculators (today GPT writes prices onto deals), consent capture, and scoped service access.",
      "- No outreach until a lawyer has reviewed wholesaling and TCPA rules.",
    ].join("\n"),
    slot: { x: 44, z: 10.5, buildingModel: "ring-cylinder" },
  },
  {
    id: "fedops",
    name: "FedOps",
    kind: "business",
    status: "planning",
    summary: "Government contracting operating system, built but not deployed. Phase 1 deploys it and connects it to Agent City.",
    contextMd: [
      "# FedOps",
      "Internal operating system for a government prime contractor (repo nrodriguez04/fedops). Built, not deployed: SAM.gov discovery, eligibility and fit scoring, solicitation analysis with verbatim citations, compliance rules, pricing with a capital gate, bid decisions as approvals with a two-person rule, accounting.",
      "- Blockers: deployment (Neon, Railway, Vercel, R2), the real company profile, a second approver for RED actions, an LLM key.",
      "- FedOps stays the authority for its own approvals; Agent City will mirror its queue and approvals.",
    ].join("\n"),
    slot: { x: -22, z: 66.5, buildingModel: "neoclassical" },
  },
  {
    id: "galleyswap",
    name: "GalleySwap",
    kind: "business",
    status: "planned",
    summary: "Trip marketplace for flight attendants, built but never deployed.",
    contextMd: [
      "# GalleySwap",
      "Marketplace where American Airlines flight attendants post trips with a cash bounty (repo nrodriguez04/galleyswap): API, admin, iOS and Android apps, Stripe Connect, Descope. Generated in one import; never built or deployed.",
      "- First agent after a staging deploy: a read-only Dispute Assistant, then Trust & Safety flags.",
      "- Never automate airline systems; money moves only through its payment rules.",
    ].join("\n"),
    slot: { x: -44, z: 31.5, buildingModel: "warehouse-loft" },
  },
  {
    id: "averageoutput",
    name: "AverageOutput",
    kind: "business",
    // "planning" (not "planned"): the devlog crew works here, so the tower is built and lit.
    status: "planning",
    summary: "Studio brand; OTHERLIFE is its flagship game. The devlog crew turns each week's work into a devlog.",
    contextMd: [
      "# AverageOutput",
      "Average Output Studios builds OTHERLIFE (codename AOWorld), a persistent multiplayer life simulation in Unreal Engine.",
      "Open decision: whether OTHERLIFE becomes its own division.",
      "",
      "## Devlog voice",
      "- Honest, specific and a little nerdy: show the systems, and say what is still placeholder.",
      "- Never promise release dates, platforms, prices or features that are not decided.",
      "- Describe what changed for the world and the player, not how impressive it is.",
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
    summary: "Social and content. The content crew plans and drafts the week's posts.",
    contextMd: [
      "# CreatorOS",
      "Nico's social and content operation. The content crew plans and drafts the week's posts every Monday; nothing is posted without Nico.",
      "",
      "## Strategy (starter draft: replace it with yours, the content crew follows this section)",
      "- Audience: founders and builders curious about running companies with AI agents, and players following OTHERLIFE.",
      "- Platforms: X and Bluesky for short posts, LinkedIn for one longer post a week, Reddit or Discord for OTHERLIFE devlogs.",
      "- Voice: first person, plain and specific. Real numbers and screenshots over adjectives. No hype words.",
      "- Pillars: building in public across the divisions; lessons from running AI agents; OTHERLIFE development.",
      "- Cadence: three to five posts a week.",
      "- Never: customer data, revenue figures Nico has not cleared for public, or betting advice.",
    ].join("\n"),
    slot: { x: -27.5, z: -45.5, buildingModel: "billboard-block" },
  },
];

export const DIVISION_ORDER: readonly string[] = DIVISIONS.map((d) => d.id);

export function divisionDefinition(id: string): DivisionDefinition | undefined {
  return DIVISIONS.find((d) => d.id === id);
}
