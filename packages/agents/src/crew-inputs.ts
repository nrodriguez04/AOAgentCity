import { CITY_TIMEZONE } from "@agent-city/core";

// Small helpers for building crew inputs. CrewAI AMP takes string inputs only,
// and every character is a prompt token, so inputs are compact text with caps.

/** "Week of Monday, Oct 5, 2026" in the city's timezone. */
export function weekLabel(now: Date): string {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: CITY_TIMEZONE, weekday: "short" }).format(now);
  const back = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday);
  const monday = new Date(now.getTime() - Math.max(0, back) * 86_400_000);
  const date = new Intl.DateTimeFormat("en-US", { timeZone: CITY_TIMEZONE, month: "short", day: "numeric", year: "numeric" }).format(monday);
  return `Week of Monday, ${date}`;
}

/** Trim to `max` characters on a line boundary, saying how much was left out. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  const kept = text.slice(0, cut > max * 0.5 ? cut : max);
  return `${kept}\n[... ${text.length - kept.length} more characters left out]`;
}

/** One line per item, or a placeholder when there is nothing. */
export function bullets(items: string[], empty = "(none)"): string {
  return items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : empty;
}

export const day = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "unknown date");

// Result shapes of the read tools the crews call (see packages/tools).

export interface DivisionResult {
  id: string;
  name: string;
  status: string;
  summary: string | null;
  metrics: Record<string, { value: number; unit?: string; label?: string; delta?: number; as_of?: string }>;
  context_md: string | null;
}

export interface EventsResult {
  events: { ts: string; division_id: string; agent_id: string | null; type: string; level: string; summary: string }[];
}

export interface DraftsResult {
  drafts: { id: string; created_at: string; division_id: string; kind: string; channel: string | null; title: string; status: string; excerpt: string }[];
}

export interface TasksResult {
  tasks: { id: string; title: string; notes: string | null; owner: string; status: string; priority: number; due_at: string | null }[];
}

export interface CommitsResult {
  repo: string;
  since: string;
  truncated: boolean;
  commits: { sha: string; date: string | null; author: string | null; merge: boolean; message: string; url: string }[];
}
