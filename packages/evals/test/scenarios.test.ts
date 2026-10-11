import { describe, expect, it } from "vitest";
import { checkScenario, HQ_SCENARIOS } from "../src";

// Offline evals: each scenario runs through the real runtime, tools and seeded
// database with a scripted model. A known-good run must pass every grader, and
// each known-bad run must be caught by the graders it names, so a change that
// blinds a grader or breaks a scenario fails here, without an API key.

describe.each(HQ_SCENARIOS.map((s) => [s.id, s] as const))("%s", (_id, scenario) => {
  it("passes every grader with the reference run, and catches each counterexample", async () => {
    const { reference, counterexamples } = await checkScenario(scenario);

    const failed = reference.grades.filter((g) => !g.pass);
    expect(failed, `reference run failed: ${failed.map((g) => `${g.grader}: ${g.detail}`).join("; ")}`).toEqual([]);
    expect(reference.status).toBe("succeeded");

    expect(counterexamples.length).toBeGreaterThan(0);
    for (const c of counterexamples) {
      expect(c.failed, `"${c.name}" should fail ${c.expected.join(", ")}`).toEqual(expect.arrayContaining(c.expected));
      // A counterexample isolates one mistake: nothing else may fail, or a grader is too loose to trust.
      expect(c.failed, `"${c.name}" failed more than it should`).toEqual(c.expected);
    }
  });
});
