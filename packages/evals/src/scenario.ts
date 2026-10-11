import type { Grader } from "./graders";
import type { ScriptTurn } from "./scripted";
import type { World } from "./world";

/**
 * One situation an agent must handle well: a fixture world, the run to start
 * in it, and the graders that decide whether the run handled it.
 */
export interface Scenario {
  /** "<agent>.<situation>", e.g. "hq.busy-morning". */
  id: string;
  agentId: string;
  /** What it checks, in one line. */
  title: string;
  /** The run's goal; defaults to the agent's scheduled goal. */
  goal?: string;
  setup(world: World): Promise<void>;
  graders: Grader[];
  /** A run that passes every grader, replayed offline to prove the scenario and its graders work. */
  reference(world: World): ScriptTurn[];
  /** Runs that must fail, each naming the graders that must catch it. */
  counterexamples: Counterexample[];
}

export interface Counterexample {
  name: string;
  script(world: World): ScriptTurn[];
  /** Grader ids this run must fail. */
  fails: string[];
}
