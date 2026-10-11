import type { DocumentEdit, DocumentInput, DocumentRow, DraftReview } from "@agent-city/core";
import { demoCreateDocument, demoDecide, demoEditDocument, demoReviewDraft, demoSetPaused } from "./demo";
import { useCity } from "./store";
import { supabase } from "./supabase";

// The city's only writes (spec §2, §5.3): approval decisions, draft reviews, knowledge
// documents and the pause switch. RLS allows exactly these columns for the owner.

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

/** Approve, edit, discard or mark a draft published. Nothing is posted anywhere from here. */
export async function reviewDraft(draftId: string, review: DraftReview): Promise<ActionResult> {
  if (isDemo()) return demoReviewDraft(draftId, review);
  const { data, error } = await supabase().from("drafts").update(review).eq("id", draftId).select("*");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "This draft could not be updated. Are you signed in as the owner?" };
  useCity.getState().upsertDraft(data[0]);
  return { ok: true };
}

const DOCUMENT_COLUMNS = "id, division_id, slug, title, body_md, tags, archived, version, created_at, updated_at, updated_by";

/** Write a new knowledge document. Agents in that division can search it from their next run. */
export async function createDocument(input: DocumentInput): Promise<ActionResult> {
  if (isDemo()) return demoCreateDocument(input);
  const { data, error } = await supabase().from("documents").insert(input).select(DOCUMENT_COLUMNS);
  if (error) return { ok: false, error: error.code === "23505" ? `A document called "${input.slug}" already exists here.` : error.message };
  if (data?.[0]) useCity.getState().upsertDocument(data[0] as unknown as DocumentRow);
  return { ok: true };
}

/** Edit or archive a document. The database keeps the previous version. */
export async function editDocument(documentId: string, edit: DocumentEdit): Promise<ActionResult> {
  if (isDemo()) return demoEditDocument(documentId, edit);
  const { data, error } = await supabase().from("documents").update(edit).eq("id", documentId).select(DOCUMENT_COLUMNS);
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) return { ok: false, error: "This document could not be updated. Are you signed in as the owner?" };
  useCity.getState().upsertDocument(data[0] as unknown as DocumentRow);
  return { ok: true };
}
