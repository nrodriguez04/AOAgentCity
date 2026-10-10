import { z } from "zod";
import { DRAFT_KINDS } from "./enums";
import { MetricValue } from "./events";
import type { AgentRow } from "./rows";

// CrewAI crews work alongside the Claude agents. These types are shared by the
// crew definitions (packages/agents) and the crew runner (packages/runtime).

/**
 * What a crew's input builder can do: call tools through the gateway as the crew
 * (permission-checked and logged like any agent's tool call).
 */
export interface CrewIO {
  agent: AgentRow;
  now(): Date;
  /** Calls a tool and returns its result. Throws when the gateway returns an error. */
  call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T>;
}

/** Kickoff inputs for CrewAI AMP (string values only), or a reason to skip this run. */
export type CrewInputs = { inputs: Record<string, string> } | { skip: string };

/** One task of a crew, in execution order, and the crew member who does it. */
export interface CrewTask {
  /** The task key in the crew's tasks.yaml. */
  id: string;
  /** Who does it, e.g. "Writer". */
  member: string;
  /** What the city shows while it runs, e.g. "Writing the devlog". */
  label: string;
}

/** What the crew runner needs from a crew definition. */
export interface CrewSpec {
  /** CrewAI project directory in this repo, e.g. "crews/devlog" (the AMP working directory). */
  project: string;
  tasks: CrewTask[];
  buildInputs(io: CrewIO): Promise<CrewInputs>;
}

/**
 * Where a crew is deployed. Stored in Vault as agent:<agent_id>:crewai, a JSON
 * object with the crew's AMP URL and bearer token.
 */
export interface CrewConnection {
  url: string;
  token: string;
}

export const CrewDraft = z.object({
  kind: z.enum(DRAFT_KINDS),
  channel: z.string().min(1).max(40).nullish(),
  title: z.string().min(1).max(200),
  body_md: z.string().min(1).max(40_000),
});

export const CrewTaskProposal = z.object({
  title: z.string().min(3).max(140),
  notes: z.string().max(4_000).nullish(),
  priority: z.number().int().min(1).max(5).nullish(),
  /** Days from now; the crew does not pick calendar dates itself. */
  due_in_days: z.number().int().min(0).max(60).nullish(),
});

/** Token usage the crew reports for itself (AMP's status API does not include it). */
export const CrewUsage = z.object({
  prompt_tokens: z.number().int().min(0).default(0),
  completion_tokens: z.number().int().min(0).default(0),
  cached_prompt_tokens: z.number().int().min(0).default(0),
  cache_creation_tokens: z.number().int().min(0).default(0),
  successful_requests: z.number().int().min(0).default(0),
  /** Model ids the crew's agents used, e.g. ["claude-sonnet-5-5"]. */
  models: z.array(z.string()).default([]),
});
export type CrewUsage = z.infer<typeof CrewUsage>;

/**
 * The JSON every crew returns as its final output (crews/<project>/src/<package>/result.py
 * mirrors it). Agent City validates it before applying anything.
 */
export const CrewResult = z.object({
  /** One line for the activity feed. */
  summary: z.string().min(1).max(300),
  drafts: z.array(CrewDraft).max(12).default([]),
  tasks: z.array(CrewTaskProposal).max(5).default([]),
  metrics: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), MetricValue).nullish(),
  metrics_summary: z.string().min(3).max(200).nullish(),
  usage: CrewUsage.nullish(),
});
export type CrewResult = z.infer<typeof CrewResult>;

/** Finds and validates a crew's JSON result in the output text AMP returns. */
export function parseCrewOutput(text: string): { ok: true; result: CrewResult } | { ok: false; error: string } {
  const candidates = [text.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  let error = "the output contains no JSON object";
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const parsed = CrewResult.safeParse(value);
    if (parsed.success) return { ok: true, result: parsed.data };
    error = z.prettifyError(parsed.error).slice(0, 500);
  }
  return { ok: false, error };
}
