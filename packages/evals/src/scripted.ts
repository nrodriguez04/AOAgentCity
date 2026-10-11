import type { MessageParam, ModelClient, ModelMessage } from "@agent-city/runtime";
import { toApiName, toolFromApiName } from "@agent-city/tools";

// A scripted stand-in for the model. Offline evals replay a known-good run (and
// known-bad ones) through the real runtime, so the scenarios and graders are
// checked in CI without an API key.

/** One assistant turn: tool calls (by registry name) or the final message. */
export type ScriptStep = { calls: { tool: string; input: Record<string, unknown> }[] } | { text: string };

/** A turn can depend on what earlier tool calls returned, like a real model's would. */
export type ScriptTurn = ScriptStep | ((seen: ToolResults) => ScriptStep);

export function callTools(...calls: { tool: string; input: Record<string, unknown> }[]): ScriptStep {
  return { calls };
}

export function finalText(text: string): ScriptStep {
  return { text };
}

/** Results of the tool calls made so far in the run, by tool name. */
export class ToolResults {
  private readonly byTool = new Map<string, unknown[]>();

  constructor(messages: MessageParam[]) {
    const names = new Map<string, string>();
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as { type: string; id?: string; name?: string; tool_use_id?: string; content?: unknown }[]) {
        if (block.type === "tool_use" && block.id && block.name) names.set(block.id, toolFromApiName(block.name)?.name ?? block.name);
        if (block.type === "tool_result" && block.tool_use_id && typeof block.content === "string") {
          const tool = names.get(block.tool_use_id);
          if (!tool) continue;
          const parsed = JSON.parse(block.content) as { status?: string; result?: unknown };
          this.byTool.set(tool, [...(this.byTool.get(tool) ?? []), parsed.status === "ok" ? parsed.result : parsed]);
        }
      }
    }
  }

  /** The latest result of `tool`; throws if the script never called it. */
  latest<T>(tool: string): T {
    const results = this.byTool.get(tool);
    if (!results?.length) throw new Error(`script read ${tool} before calling it`);
    return results.at(-1) as T;
  }
}

export function scriptedModel(turns: ScriptTurn[]): ModelClient {
  let turn = 0;
  return {
    async create(params) {
      const next = turns[turn++];
      // A script that runs out ends the run instead of looping.
      const step = next === undefined ? { text: "Done." } : typeof next === "function" ? next(new ToolResults(params.messages)) : next;
      const content =
        "calls" in step
          ? step.calls.map((c, i) => ({ type: "tool_use", id: `toolu_eval_${turn}_${i}`, name: toApiName(c.tool), input: c.input }))
          : [{ type: "text", text: step.text, citations: null }];
      return {
        id: `msg_eval_${turn}`,
        type: "message",
        role: "assistant",
        model: params.model,
        content,
        stop_reason: "calls" in step ? "tool_use" : "end_turn",
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: 1_000,
          output_tokens: 200,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: null,
          iterations: null,
        },
      } as unknown as ModelMessage;
    },
  };
}
