import type { RiskTier } from "./enums";

// Risk tiers (spec §7.1).
//   read            execute immediately, log
//   internal_write  execute immediately, log
//   external_effect approval required
//   financial       approval required, amount shown, never auto-approved

const TIER_RANK: Record<RiskTier, number> = {
  read: 0,
  internal_write: 1,
  external_effect: 2,
  financial: 3,
};

export function tierRank(tier: RiskTier): number {
  return TIER_RANK[tier];
}

/** True when an agent granted `maxTier` may call a tool registered at `toolTier`. */
export function tierAllows(maxTier: RiskTier, toolTier: RiskTier): boolean {
  return tierRank(toolTier) <= tierRank(maxTier);
}

/** Side effects always go through the approval queue. There is no bypass flag. */
export function requiresApproval(tier: RiskTier): boolean {
  return tier === "external_effect" || tier === "financial";
}

export const TIER_LABELS: Record<RiskTier, string> = {
  read: "Read",
  internal_write: "Internal write",
  external_effect: "External effect",
  financial: "Financial",
};
