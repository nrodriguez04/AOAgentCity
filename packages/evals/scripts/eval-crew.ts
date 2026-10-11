// Grade a crew's real output against the inputs it was given.
//
//   cd crews/devlog && uv run run_crew inputs.example.json > /tmp/devlog-out.json
//   pnpm eval:crew averageoutput.devlog-crew crews/devlog/inputs.example.json /tmp/devlog-out.json
//
// Paths are relative to the repository root. Exits 1 if any grader fails.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CREW_EXPECTATIONS, gradeCrewOutput } from "../src";

const [crewId, inputsPath, outputPath] = process.argv.slice(2);
if (!crewId || !inputsPath || !outputPath) {
  console.error(`usage: pnpm eval:crew <crew agent id> <inputs.json> <output file>\ncrews: ${Object.keys(CREW_EXPECTATIONS).join(", ")}`);
  process.exit(2);
}

// pnpm runs package scripts from the package directory; resolve against where the command was typed.
const root = process.env.INIT_CWD ?? process.cwd();
const inputs = JSON.parse(readFileSync(resolve(root, inputsPath), "utf8")) as Record<string, unknown>;
const output = readFileSync(resolve(root, outputPath), "utf8");
const grades = gradeCrewOutput(crewId, Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, String(v)])), output);

for (const g of grades) console.log(`${g.pass ? "pass" : "FAIL"}  ${g.grader}${g.pass ? "" : `: ${g.detail}`}`);
process.exit(grades.every((g) => g.pass) ? 0 : 1);
