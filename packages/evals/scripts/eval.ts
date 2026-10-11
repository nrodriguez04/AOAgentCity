// Agent evals.
//
//   pnpm eval                       offline: replay every scenario's reference run and
//                                   counterexamples through the real runtime (no API key, free)
//   pnpm eval --live                run Claude on every scenario (needs ANTHROPIC_API_KEY; costs money)
//     --scenario <id-prefix>        only matching scenarios (repeatable), e.g. --scenario hq.busy
//     --trials <n>                  runs per scenario (default 1)
//     --budget <usd>                stop starting runs once this much is spent (default 5)
//     --min-pass-rate <0..1>        share of trials each grader must pass (default 1)
//     --json <file>                 write the full report, including each brief, as JSON
//
// Live runs use the same model as production for each agent (MODEL_REASONING etc.
// override it), against a throwaway in-memory database: nothing real is touched,
// and dispatches are recorded rather than run.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { MODELS } from "@agent-city/core";
import { anthropicModelClient } from "@agent-city/runtime";
import { checkScenario, HQ_SCENARIOS, runTrial, summarize, type Scenario, type TrialResult } from "../src";

const { values } = parseArgs({
  options: {
    live: { type: "boolean", default: false },
    scenario: { type: "string", multiple: true },
    trials: { type: "string", default: "1" },
    budget: { type: "string", default: "5" },
    "min-pass-rate": { type: "string", default: "1" },
    json: { type: "string" },
  },
});

const ALL: Scenario[] = [...HQ_SCENARIOS];
const scenarios = values.scenario?.length ? ALL.filter((s) => values.scenario!.some((p) => s.id.startsWith(p))) : ALL;
if (scenarios.length === 0) {
  console.error(`No scenario matches ${values.scenario?.join(", ")}. Scenarios: ${ALL.map((s) => s.id).join(", ")}`);
  process.exit(2);
}

const pad = (text: string, width: number) => (text.length >= width ? text : text + " ".repeat(width - text.length));
const usd = (n: number) => `$${n.toFixed(4)}`;

async function offline(): Promise<boolean> {
  let ok = true;
  for (const scenario of scenarios) {
    const { reference, counterexamples } = await checkScenario(scenario);
    const refFailures = reference.grades.filter((g) => !g.pass);
    console.log(`\n${scenario.id}: ${scenario.title}`);
    console.log(`  reference run: ${refFailures.length ? `FAIL (${refFailures.map((g) => `${g.grader}: ${g.detail}`).join("; ")})` : "passes all graders"}`);
    ok &&= refFailures.length === 0;
    for (const c of counterexamples) {
      const caught = c.expected.every((id) => c.failed.includes(id)) && c.failed.length === c.expected.length;
      ok &&= caught;
      console.log(`  ${caught ? "caught" : "MISSED"}: ${c.name} (expected ${c.expected.join(", ")}; failed ${c.failed.join(", ") || "nothing"})`);
    }
  }
  console.log(ok ? "\nAll scenarios and graders check out." : "\nSome scenarios or graders are broken.");
  return ok;
}

async function live(): Promise<boolean> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY to run live evals. `pnpm eval` without --live needs no key.");
    process.exit(2);
  }
  const trials = Math.max(1, Number(values.trials));
  const budget = Number(values.budget);
  const minPassRate = Number(values["min-pass-rate"]);
  const model = anthropicModelClient();
  console.log(`Live evals: ${scenarios.length} scenario(s) x ${trials} trial(s), stopping new runs after ${usd(budget)}. HQ model: ${MODELS.reasoning}.`);

  let spent = 0;
  let ok = true;
  const report = [];
  for (const scenario of scenarios) {
    const results: TrialResult[] = [];
    for (let trial = 1; trial <= trials; trial++) {
      if (spent >= budget) {
        console.log(`  budget reached (${usd(spent)}); skipping the remaining runs`);
        break;
      }
      const result = await runTrial(scenario, model, trial);
      spent += result.costUsd;
      results.push(result);
      const failed = result.grades.filter((g) => !g.pass);
      console.log(`  ${scenario.id} #${trial}: ${result.status}, ${result.steps} steps, ${usd(result.costUsd)}, ${failed.length ? `failed ${failed.map((g) => g.grader).join(", ")}` : "all graders pass"}`);
    }
    const summary = summarize(scenario, results, minPassRate);
    ok &&= summary.passed;
    console.log(`\n${scenario.id}: ${summary.passed ? "PASS" : "FAIL"} - ${scenario.title}`);
    for (const g of scenario.graders) {
      const firstFailure = results.flatMap((r) => r.grades).find((x) => x.grader === g.id && !x.pass);
      console.log(`  ${pad(`${summary.passes.get(g.id)}/${results.length}`, 6)}${pad(g.id, 32)}${firstFailure ? firstFailure.detail.slice(0, 140) : g.description}`);
    }
    report.push({
      id: scenario.id,
      title: scenario.title,
      passed: summary.passed,
      trials: results.map((r) => ({
        trial: r.trial,
        status: r.status,
        cost_usd: r.costUsd,
        steps: r.steps,
        duration_ms: r.durationMs,
        grades: r.grades,
        brief: r.trace.briefs.at(-1)?.body_md ?? null,
        dispatches: r.trace.dispatches,
        tasks_created: r.trace.tasksCreated.map((t) => t.title),
        tool_calls: r.trace.toolCalls.map((c) => `${c.tool}:${c.status}`),
        final_text: r.trace.finalText,
      })),
    });
  }
  console.log(`\nSpent ${usd(spent)}. ${ok ? "Every scenario passed." : "Some scenarios failed."}`);
  // pnpm runs package scripts from the package directory; resolve against where the command was typed.
  if (values.json) writeFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), values.json), JSON.stringify({ model: MODELS.reasoning, spent_usd: spent, min_pass_rate: minPassRate, scenarios: report }, null, 2));
  return ok;
}

const passed = values.live ? await live() : await offline();
process.exit(passed ? 0 : 1);
