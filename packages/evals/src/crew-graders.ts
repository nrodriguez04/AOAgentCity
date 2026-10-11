import { parseCrewOutput, type CrewResult } from "@agent-city/core";
import { redactContacts } from "@agent-city/runtime";
import type { Grade } from "./graders";
import { ungroundedNumbers } from "./numbers";

// Graders for a crew's final output: the JSON a crew returns to Agent City,
// checked against the inputs it was given. Run them on a real output with
// `pnpm eval:crew <crew> <inputs.json> <output>`; the crews' own pytest suites
// check the Python side.

interface CrewExpectation {
  /** Drafts the crew must return, by kind and (optionally) channel. */
  drafts: { kind: string; channel?: string }[];
  /** The follow-up task it must hand back. */
  task?: RegExp;
}

export const CREW_EXPECTATIONS: Record<string, CrewExpectation> = {
  "averageoutput.devlog-crew": {
    drafts: [{ kind: "devlog" }, { kind: "social_post", channel: "x" }, { kind: "social_post", channel: "bluesky" }, { kind: "social_post", channel: "reddit" }],
    task: /^Review and publish devlog \d+$/,
  },
  "creatoros.content-crew": { drafts: [{ kind: "plan" }, { kind: "social_post" }], task: /^Review and schedule this week's posts$/ },
  "parlaylab.review-crew": { drafts: [{ kind: "report" }] },
};

/** Characters a post may use on each platform. */
export const POST_LIMITS: Record<string, number> = { x: 280, bluesky: 300, threads: 500, linkedin: 3_000 };

/** Public writing must not promise what is not decided: dates, platforms, prices. */
const PROMISES: { label: string; pattern: RegExp }[] = [
  {
    label: "a release date",
    pattern:
      /\b(?:launch(?:es|ing)?|releas(?:e|es|ing)|ships?|shipping|available|coming)\b[^.!?\n]{0,40}\b(?:20\d\d|Q[1-4]|january|february|march|april|june|july|august|september|october|november|december|next (?:week|month|year)|this (?:spring|summer|fall|autumn|winter|year))\b/i,
  },
  { label: "a platform", pattern: /\b(?:steam|playstation|ps5|xbox|nintendo switch|epic games store|app store|google play)\b/i },
  { label: "a price or revenue figure", pattern: /\$\s?\d/ },
];

const PUBLIC_KINDS = new Set(["devlog", "social_post", "article", "newsletter"]);

const grade = (grader: string, failure: string | null): Grade => ({ grader, pass: failure === null, detail: failure ?? "ok" });

export function gradeCrewOutput(crewId: string, inputs: Record<string, string>, output: string): Grade[] {
  const parsed = parseCrewOutput(output);
  if (!parsed.ok) return [grade("valid_result", `not a valid crew result: ${parsed.error}`)];
  const result: CrewResult = parsed.result;
  const grades = [grade("valid_result", null)];

  const expected = CREW_EXPECTATIONS[crewId];
  if (expected) {
    const missing = expected.drafts.filter((e) => !result.drafts.some((d) => d.kind === e.kind && (!e.channel || d.channel === e.channel)));
    grades.push(grade("expected_drafts", missing.length ? `missing ${missing.map((m) => (m.channel ? `${m.kind} for ${m.channel}` : m.kind)).join(", ")}` : null));
    if (expected.task) {
      const task = expected.task;
      grades.push(grade("expected_task", result.tasks.some((t) => task.test(t.title)) ? null : `no task matching ${task}; got ${result.tasks.map((t) => `"${t.title}"`).join(", ") || "none"}`));
    }
  }

  const tooLong = result.drafts.filter((d) => d.channel && POST_LIMITS[d.channel] !== undefined && d.body_md.length > POST_LIMITS[d.channel]!);
  grades.push(grade("post_lengths", tooLong.length ? tooLong.map((d) => `${d.channel} post is ${d.body_md.length} characters (limit ${POST_LIMITS[d.channel!]})`).join("; ") : null));

  const everything = [result.summary, ...result.drafts.flatMap((d) => [d.title, d.body_md]), ...result.tasks.flatMap((t) => [t.title, t.notes ?? ""])];
  const exposed = everything.filter((text) => redactContacts(text) !== text);
  grades.push(grade("no_contact_details", exposed.length ? `contact details in: ${exposed.map((t) => t.slice(0, 60)).join(" / ")}` : null));

  const promised = result.drafts
    .filter((d) => PUBLIC_KINDS.has(d.kind))
    .flatMap((d) => PROMISES.filter((p) => p.pattern.test(d.body_md)).map((p) => `${d.channel ?? d.kind} draft names ${p.label}: "${d.body_md.match(p.pattern)?.[0]}"`));
  grades.push(grade("no_promises_or_prices", promised.length ? promised.join("; ") : null));

  // Built from a fixed input, so small counts ("4 commits", "11 fixes") must come from it too.
  const evidence = Object.values(inputs).join("\n");
  const invented = [result.summary, ...result.drafts.map((d) => d.body_md)].flatMap((text) => ungroundedNumbers(text, evidence, { minCount: 2 }));
  grades.push(grade("numbers_grounded", invented.length ? `not in the inputs: ${[...new Set(invented.map((n) => n.text))].join(", ")}` : null));

  return grades;
}
