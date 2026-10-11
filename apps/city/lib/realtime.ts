import type { AgentRow, ApprovalRow, BriefRow, DivisionRow, DraftRow, EventRow, SettingsRow, TaskRow, DocumentRow } from "@agent-city/core";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { DRAFT_LIMIT, EVENT_LIMIT, useCity, type Hydration } from "./store";
import { supabase } from "./supabase";

// Realtime wiring (spec §10.7): hydrate from the tables, then apply deltas.
// The city is a pure reader; the only writes are in ./actions.ts.

type Row = Record<string, unknown>;

// Postgres numerics/bigints can arrive as strings; normalise before they reach the store.
const toAgent = (r: Row): AgentRow => ({ ...(r as unknown as AgentRow), daily_budget_usd: Number(r.daily_budget_usd ?? 0) });
const toEvent = (r: Row): EventRow => ({ ...(r as unknown as EventRow), id: Number(r.id), payload: (r.payload as Record<string, unknown>) ?? {} });
const toApproval = (r: Row): ApprovalRow => ({
  ...(r as unknown as ApprovalRow),
  amount_cents: r.amount_cents == null ? null : Number(r.amount_cents),
});
const toDivision = (r: Row): DivisionRow => ({ ...(r as unknown as DivisionRow), metrics: (r.metrics as DivisionRow["metrics"]) ?? {} });

/** Every documents column except the search vector, which the city never needs. */
const DOCUMENT_COLUMNS = "id, division_id, slug, title, body_md, tags, archived, version, created_at, updated_at, updated_by";

async function must<T>(query: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data as T;
}

/** Current agents, divisions, approvals (pending + recent), last 200 events, open tasks, recent drafts, knowledge documents, latest brief, settings. */
export async function fetchSnapshot(): Promise<Hydration> {
  const db = supabase();
  const [divisions, agents, pending, recentApprovals, events, tasks, drafts, documents, briefs, settings] = await Promise.all([
    must(db.from("divisions").select("*")),
    must(db.from("agents").select("*")),
    must(db.from("approvals").select("*").in("status", ["pending", "approved", "executing"]).order("created_at", { ascending: false })),
    must(db.from("approvals").select("*").order("created_at", { ascending: false }).limit(30)),
    must(db.from("events").select("*").order("id", { ascending: false }).limit(EVENT_LIMIT)),
    must(db.from("tasks").select("*").in("status", ["open", "in_progress", "blocked"]).order("priority")),
    must(db.from("drafts").select("*").order("created_at", { ascending: false }).limit(DRAFT_LIMIT)),
    must(db.from("documents").select(DOCUMENT_COLUMNS).eq("archived", false).order("updated_at", { ascending: false }).limit(200)),
    must(db.from("briefs").select("*").order("created_at", { ascending: false }).limit(1)),
    must(db.from("settings").select("agents_paused, trigger_api_url, updated_at").limit(1)),
  ]);
  const approvals = new Map<string, ApprovalRow>();
  for (const row of [...(recentApprovals as Row[]), ...(pending as Row[])]) approvals.set(String(row.id), toApproval(row));
  return {
    divisions: (divisions as Row[]).map(toDivision),
    agents: (agents as Row[]).map(toAgent),
    approvals: [...approvals.values()],
    events: (events as Row[]).map(toEvent),
    tasks: tasks as TaskRow[],
    drafts: drafts as DraftRow[],
    documents: documents as unknown as DocumentRow[],
    brief: ((briefs as BriefRow[])[0] as BriefRow | undefined) ?? null,
    settings: ((settings as SettingsRow[])[0] as SettingsRow | undefined) ?? null,
  };
}

/**
 * Subscribe to changes and keep the store current. Re-hydrates on every
 * (re)subscribe so nothing missed during a disconnect is lost.
 */
export function connectRealtime(): () => void {
  const db = supabase();
  const store = useCity.getState();
  store.setConnection("connecting");
  let disposed = false;

  const rehydrate = async () => {
    try {
      const snapshot = await fetchSnapshot();
      if (!disposed) useCity.getState().hydrate(snapshot);
    } catch (error) {
      console.error("hydrate failed", error);
      if (!disposed) useCity.getState().setConnection("offline");
    }
  };

  const channel: RealtimeChannel = db
    .channel("city")
    .on("postgres_changes", { event: "*", schema: "public", table: "agents" }, (p) => {
      if (p.eventType !== "DELETE") useCity.getState().upsertAgent(toAgent(p.new));
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "events" }, (p) => useCity.getState().pushEvent(toEvent(p.new)))
    .on("postgres_changes", { event: "*", schema: "public", table: "approvals" }, (p) => {
      if (p.eventType === "DELETE") useCity.getState().removeApproval(String((p.old as Row).id));
      else useCity.getState().upsertApproval(toApproval(p.new));
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "divisions" }, (p) => {
      if (p.eventType !== "DELETE") useCity.getState().upsertDivision(toDivision(p.new));
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, (p) => {
      if (p.eventType !== "DELETE") useCity.getState().upsertTask(p.new as TaskRow);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "drafts" }, (p) => {
      if (p.eventType !== "DELETE") useCity.getState().upsertDraft(p.new as DraftRow);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "documents" }, (p) => {
      if (p.eventType !== "DELETE") useCity.getState().upsertDocument(p.new as DocumentRow);
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "briefs" }, (p) => useCity.getState().setBrief(p.new as BriefRow))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "settings" }, (p) => useCity.getState().setSettings(p.new as SettingsRow))
    .subscribe((status) => {
      if (disposed) return;
      if (status === "SUBSCRIBED") {
        useCity.getState().setConnection("live");
        void rehydrate();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        useCity.getState().setConnection("reconnecting");
      } else if (status === "CLOSED") {
        useCity.getState().setConnection("offline");
      }
    });

  return () => {
    disposed = true;
    void db.removeChannel(channel);
  };
}
