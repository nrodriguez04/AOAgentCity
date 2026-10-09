import { demoDecide, demoSetPaused } from "./demo";
import { useCity } from "./store";
import { supabase } from "./supabase";

// The city's only writes (spec §2, §5.3): approval decisions and the pause switch.
// RLS allows exactly these columns for the owner.

export type ActionResult = { ok: true } | { ok: false; error: string };

const isDemo = () => useCity.getState().connection === "demo";

export async function decideApproval(approvalId: string, decision: "approved" | "rejected", note: string | null): Promise<ActionResult> {
  if (isDemo()) return demoDecide(approvalId, decision, note);
  const { data, error } = await supabase()
    .from("approvals")
    .update({ status: decision, decided_note: note?.trim() || null })
    .eq("id", approvalId)
    .eq("status", "pending")
    .select("*");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "This approval was already decided or has expired." };
  useCity.getState().upsertApproval({ ...data[0], amount_cents: data[0].amount_cents == null ? null : Number(data[0].amount_cents) });
  return { ok: true };
}

export async function setCityPaused(paused: boolean): Promise<ActionResult> {
  if (isDemo()) {
    demoSetPaused(paused);
    return { ok: true };
  }
  const { data, error } = await supabase().from("settings").update({ agents_paused: paused }).eq("id", true).select("agents_paused, trigger_api_url, updated_at");
  if (error) return { ok: false, error: error.message };
  if (data?.[0]) useCity.getState().setSettings(data[0]);
  return { ok: true };
}
