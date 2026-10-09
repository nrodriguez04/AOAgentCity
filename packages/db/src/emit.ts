import { AgentEvent, MetricsPayload, type AgentEventInput, type AgentState, type EventRow } from "@agent-city/core";
import type { Repo } from "./repo";

/**
 * The only way events are written (spec §5.2). Validates against the event
 * contract, inserts the row, and checks the agent in (state + last_checkin_at) in
 * the same statement. Agents never write to `events` themselves: tools and the
 * runtime call this on their behalf.
 */
export async function emit(
  repo: Repo,
  input: AgentEventInput,
  options: { agentState?: AgentState | null } = {},
): Promise<EventRow> {
  const event = AgentEvent.parse(input);

  if (event.type === "metric.updated") {
    const metrics = MetricsPayload.parse(event.payload).metrics;
    await repo.mergeDivisionMetrics(event.division_id, metrics);
  }

  const state = options.agentState !== undefined ? options.agentState : defaultAgentState(event.type);
  return repo.insertEventAndCheckin(event, event.agent_id ? state : null);
}

function defaultAgentState(type: AgentEvent["type"]): AgentState | null {
  switch (type) {
    case "run.started":
    case "run.progress":
      return "working";
    case "run.succeeded":
      return "idle";
    case "run.failed":
      return "error";
    default:
      // Check in without changing state.
      return null;
  }
}
