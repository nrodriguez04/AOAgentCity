// Company apps that connect to Agent City (Phase 0, the company connector). Each
// app id is also its division id. An app pushes signed events into the event
// store (supabase/functions/app-events, docs/CONNECTOR.md) and its agents' tools
// call the app's agent API with a scoped token. The app stays the authority for
// its own approvals; Agent City mirrors them read-only and links back.

export const APP_IDS = ["fedops", "halo", "parlaylab", "galleyswap"] as const;
export type AppId = (typeof APP_IDS)[number];

export function isAppId(value: string): value is AppId {
  return (APP_IDS as readonly string[]).includes(value);
}

/** <app>.<subject>.<verb>, optionally one more segment: fedops.opportunity.qualified, halo.lead.stage.changed. */
export type AppEventType = `${AppId}.${string}`;

const APP_EVENT_TYPE = new RegExp(`^(${APP_IDS.join("|")})(\\.[a-z][a-z0-9_]*){2,3}$`);

/** The same rule the database enforces on events.type (migration app_connector). */
export function isAppEventType(type: string): type is AppEventType {
  return APP_EVENT_TYPE.test(type);
}

/** How a mirrored approval maps onto Agent City's tiers. FedOps: YELLOW is external_effect, RED is binding. */
export type AppApprovalRisk = "external_effect" | "financial" | "binding";

export type AppApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

/** An approval that lives in a company app, mirrored from its events. Decided in the app, never here. */
export interface AppApprovalRow {
  app: AppId;
  /** The app's own id for the approval, e.g. FedOps' APV-2026-0001. */
  external_id: string;
  division_id: string;
  title: string;
  risk: AppApprovalRisk;
  /** Where to decide it, in the app. https only. */
  url: string | null;
  status: AppApprovalStatus;
  requested_at: string;
  expires_at: string | null;
  decided_at: string | null;
  updated_at: string;
  /** When the owner was emailed about it. */
  notified_at: string | null;
}

/** Pending and not past its app-side expiry. */
export function isOpenAppApproval(a: Pick<AppApprovalRow, "status" | "expires_at">, now: number = Date.now()): boolean {
  return a.status === "pending" && (a.expires_at === null || Date.parse(a.expires_at) > now);
}

export const APP_RISK_LABELS: Record<AppApprovalRisk, string> = {
  external_effect: "Leaves the building",
  financial: "Moves money",
  binding: "Binds the company",
};
