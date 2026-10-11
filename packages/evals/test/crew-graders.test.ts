import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gradeCrewOutput } from "../src";

// The devlog crew's real example inputs (four AOWorld commits), and outputs a
// good editor would and would not let through.
const inputs = JSON.parse(readFileSync(new URL("../../../crews/devlog/inputs.example.json", import.meta.url), "utf8")) as Record<string, string>;

const good = {
  summary: "Devlog 1 drafted: residents can be hired, Aurora's geography manifest, naval canon",
  drafts: [
    {
      kind: "devlog",
      channel: "blog",
      title: "OTHERLIFE devlog 1: a city that hires the people who live in it",
      body_md:
        "# OTHERLIFE devlog 1\n\nFour commits this week, 4 in all. A city can now hire the people who live in it, and those jobs persist across sessions.\n\nWe also wrote Aurora's geography down as a manifest the world builder reads, and the canon for submarines and naval work. That part is canon, not gameplay yet.\n\n## What's next\nMore of the map you can drive through. No dates: we will show it when it works.",
    },
    { kind: "social_post", channel: "x", title: "X: devlog 1", body_md: "OTHERLIFE devlog 1: cities in Aurora can now hire the people who live in them, and the jobs persist across sessions. Link in replies." },
    { kind: "social_post", channel: "bluesky", title: "Bluesky: devlog 1", body_md: "Devlog 1 is up: residents can be hired by businesses in their own city, and Aurora's geography now lives in one manifest." },
    { kind: "social_post", channel: "reddit", title: "Reddit: devlog 1", body_md: "We are building OTHERLIFE, a persistent life sim. This week: jobs for residents, a geography manifest, and naval canon (not playable yet)." },
  ],
  tasks: [{ title: "Review and publish devlog 1", priority: 2, due_in_days: 2, notes: "Check the naval canon wording." }],
};

const output = (patch: (r: typeof good) => unknown) => JSON.stringify(patch(structuredClone(good)));
const failures = (out: string, crew = "averageoutput.devlog-crew") =>
  gradeCrewOutput(crew, inputs, out)
    .filter((g) => !g.pass)
    .map((g) => g.grader);

describe("gradeCrewOutput", () => {
  it("passes a devlog result that sticks to the commits", () => {
    expect(gradeCrewOutput("averageoutput.devlog-crew", inputs, JSON.stringify(good)).filter((g) => !g.pass)).toEqual([]);
    // Wrapped in prose or a code fence, as models sometimes return it.
    expect(failures(`Here is the result:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``)).toEqual([]);
  });

  it("catches each kind of mistake on its own", () => {
    expect(failures("The crew could not finish.")).toEqual(["valid_result"]);
    expect(failures(output((r) => ({ ...r, drafts: r.drafts.filter((d) => d.channel !== "reddit") })))).toEqual(["expected_drafts"]);
    expect(failures(output((r) => ({ ...r, tasks: [] })))).toEqual(["expected_task"]);
    expect(failures(output((r) => (r.drafts[1]!.body_md = `${r.drafts[1]!.body_md} ${"Aurora keeps growing. ".repeat(10)}`, r)))).toEqual(["post_lengths"]);
    expect(failures(output((r) => (r.drafts[3]!.body_md += " Questions? Email nico.r@example.com.", r)))).toEqual(["no_contact_details"]);
    expect(failures(output((r) => (r.drafts[0]!.body_md += "\n\nOTHERLIFE launches on Steam in 2027.", r)))).toEqual(["no_promises_or_prices"]);
    // A made-up price is both a promise and a number the inputs never gave.
    expect(failures(output((r) => (r.drafts[2]!.body_md += " Early access is $19.99.", r)))).toEqual(["no_promises_or_prices", "numbers_grounded"]);
    expect(failures(output((r) => ({ ...r, summary: "Devlog 1 drafted: hiring, geography and 11 fixes" })))).toEqual(["numbers_grounded"]);
  });
});
