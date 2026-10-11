import type { BriefRow, RunRow, TaskRow } from "@agent-city/core";
import type { TestDatabase } from "@agent-city/db/testing";
import type { RunOutcome } from "@agent-city/runtime";

/** One tool call as the gateway logged it. */
export interface ToolCallTrace {
  tool: string;
  /** ok, error, denied, invalid or pending_approval. */
  status: string;
  args: Record<string, unknown>;
  result: unknown;
}

/** Everything a run did and saw, collected from the database after it ends. Graders read only this. */
export interface RunTrace {
  agentId: string;
  outcome: RunOutcome;
  run: RunRow | null;
  toolCalls: ToolCallTrace[];
  briefs: BriefRow[];
  /** Open tasks before the run, to catch duplicates. */
  tasksBefore: TaskRow[];
  tasksCreated: TaskRow[];
  dispatches: { agentId: string; goal: string }[];
  approvalsCreated: number;
  /** The run's final message (its summary). */
  finalText: string;
  /** What the model read: its opening context and every tool result. Numbers it states must come from here. */
  evidence: string;
}

type Block = { type?: string; text?: string; content?: unknown };
type Message = { role: string; content: string | Block[] };

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: Block) => (typeof b === "string" ? b : (b.text ?? blockText(b.content)))).join("\n");
  return "";
}

/** The opening context and tool results (what the model read), and the last assistant text (what it concluded). */
export function readTranscript(transcript: unknown): { evidence: string; finalText: string } {
  const messages = ((transcript as { messages?: Message[] } | null)?.messages ?? []) as Message[];
  const evidence: string[] = [];
  let finalText = "";
  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") evidence.push(message.content);
      else for (const block of message.content) if (block.type === "tool_result") evidence.push(blockText(block.content));
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      const text = message.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
      if (text) finalText = text;
    }
  }
  return { evidence: evidence.join("\n"), finalText };
}

export async function collectTrace(
  t: TestDatabase,
  input: { agentId: string; outcome: RunOutcome; tasksBefore: TaskRow[]; dispatches: { agentId: string; goal: string }[] },
): Promise<RunTrace> {
  const runId = "runId" in input.outcome ? input.outcome.runId : null;
  const run = runId ? await t.repo.getRun(runId) : null;
  const toolCalls = runId
    ? (
        await t.sql.query<{ tool_name: string; status: string; args: Record<string, unknown>; result: unknown }>(
          `select tool_name, status, args, result from tool_calls where run_id = $1::uuid order by id`,
          [runId],
        )
      ).map((r) => ({ tool: r.tool_name, status: r.status, args: r.args ?? {}, result: r.result }))
    : [];
  const briefs = runId ? await t.sql.query<BriefRow>(`select * from briefs where run_id = $1::uuid order by created_at`, [runId]) : [];
  const before = new Set(input.tasksBefore.map((task) => task.id));
  const tasksCreated = (await t.repo.listTasks({ limit: 200 })).filter((task) => !before.has(task.id));
  const [{ n } = { n: 0 }] = runId
    ? await t.sql.query<{ n: number }>(`select count(*)::int as n from approvals where run_id = $1::uuid`, [runId])
    : [];
  const { evidence, finalText } = readTranscript(run?.transcript);
  return { agentId: input.agentId, outcome: input.outcome, run, toolCalls, briefs, tasksBefore: input.tasksBefore, tasksCreated, dispatches: input.dispatches, approvalsCreated: Number(n), finalText, evidence };
}
