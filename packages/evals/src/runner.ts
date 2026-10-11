import { runAgent, type ModelClient } from "@agent-city/runtime";
import type { Grade } from "./graders";
import type { Scenario } from "./scenario";
import { scriptedModel, type ScriptTurn } from "./scripted";
import { collectTrace, type RunTrace } from "./trace";
import { World } from "./world";

// Runs a scenario through the real runtime: a fresh seeded database per trial,
// the agent's real instructions, tools and permissions, and either a scripted
// model (offline) or Claude (live). Dispatches are recorded, not executed.

export interface TrialResult {
  trial: number;
  grades: Grade[];
  status: string;
  costUsd: number;
  steps: number;
  durationMs: number;
  trace: RunTrace;
}

export async function runTrial(
  scenario: Scenario,
  model: ModelClient | { script: (world: World) => ScriptTurn[] },
  trial = 1,
): Promise<TrialResult> {
  const world = await World.create();
  const started = Date.now();
  try {
    await scenario.setup(world);
    const tasksBefore = await world.t.repo.listTasks({ statuses: ["open", "in_progress", "blocked"], limit: 200 });
    const dispatches: { agentId: string; goal: string }[] = [];
    const client = "script" in model ? scriptedModel(model.script(world)) : model;
    const outcome = await runAgent(
      {
        repo: world.t.repo,
        model: client,
        services: {
          async dispatchRun({ agentId, goal }) {
            dispatches.push({ agentId, goal });
            return { id: `eval-dispatch-${dispatches.length}` };
          },
        },
      },
      { agentId: scenario.agentId, goal: scenario.goal ?? null, trigger: "cron" },
    );
    const trace = await collectTrace(world.t, { agentId: scenario.agentId, outcome, tasksBefore, dispatches });
    return {
      trial,
      grades: scenario.graders.map((g) => g.grade(trace)),
      status: outcome.status,
      costUsd: "costUsd" in outcome ? outcome.costUsd : 0,
      steps: "steps" in outcome ? outcome.steps : 0,
      durationMs: Date.now() - started,
      trace,
    };
  } finally {
    await world.close();
  }
}

export interface ScenarioResult {
  scenario: Scenario;
  trials: TrialResult[];
  /** grader id -> trials passed. */
  passes: Map<string, number>;
  passed: boolean;
}

/** Every grader must pass in at least `minPassRate` of the trials (default: all of them). */
export function summarize(scenario: Scenario, trials: TrialResult[], minPassRate = 1): ScenarioResult {
  const passes = new Map(scenario.graders.map((g) => [g.id, 0]));
  for (const trial of trials) for (const grade of trial.grades) if (grade.pass) passes.set(grade.grader, (passes.get(grade.grader) ?? 0) + 1);
  const passed = trials.length > 0 && [...passes.values()].every((n) => n / trials.length >= minPassRate);
  return { scenario, trials, passes, passed };
}

/** Offline check of a scenario: its reference run passes every grader, each counterexample fails the graders it names. */
export async function checkScenario(scenario: Scenario): Promise<{
  reference: TrialResult;
  counterexamples: { name: string; expected: string[]; failed: string[]; trial: TrialResult }[];
}> {
  const reference = await runTrial(scenario, { script: scenario.reference });
  const counterexamples = [];
  for (const c of scenario.counterexamples) {
    const trial = await runTrial(scenario, { script: c.script });
    counterexamples.push({ name: c.name, expected: c.fails, failed: trial.grades.filter((g) => !g.pass).map((g) => g.grader), trial });
  }
  return { reference, counterexamples };
}
