import type { CrewSpec } from "@agent-city/core";
import { devlogCrewSpec } from "../averageoutput/devlog-crew/spec";
import { contentCrewSpec } from "../creatoros/content-crew/spec";
import { reviewCrewSpec } from "../parlaylab/review-crew/spec";

// The crew specs the worker runs, by agent id. Unlike the full definitions in
// ./index.ts, nothing here reads files, so the Trigger.dev bundle can load it.

const SPECS = [devlogCrewSpec, contentCrewSpec, reviewCrewSpec];

export const CREW_SPECS: ReadonlyMap<string, CrewSpec> = new Map(SPECS.map((s) => [s.id, s]));

export function crewSpec(agentId: string): CrewSpec | undefined {
  return CREW_SPECS.get(agentId);
}
