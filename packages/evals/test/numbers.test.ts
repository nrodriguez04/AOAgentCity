import { describe, expect, it } from "vitest";
import { statedNumbers, ungroundedNumbers } from "../src/numbers";

describe("statedNumbers", () => {
  it("finds money, percentages and large counts", () => {
    const found = statedNumbers("MRR $4,210 (+3.1% WoW), 182 active, followers 48.2K, spend $0.52 and US$1,900.50");
    expect(found.map((n) => [n.kind, n.value])).toEqual([
      ["money", 4210],
      ["money", 0.52],
      ["money", 1900.5],
      ["percent", 3.1],
      ["count", 182],
      ["count", 48_200],
    ]);
  });

  it("skips dates, times, years, ids, links and small counts", () => {
    const text = [
      "# Daily brief: Sunday, October 11",
      "- 2 approvals waiting since 2026-10-10T14:05:00Z (APV-2026-0004, PUR-2026-0004), HQ-01 ran at 6:55 AM and 7pm.",
      "- Due Oct 14, 2026; see https://fedops.example/approvals/APV-2026-0004 and pi_3QdemoA1.",
      "1. Clear the 3 approvals in Q4.",
    ].join("\n");
    expect(statedNumbers(text)).toEqual([]);
  });
});

describe("ungroundedNumbers", () => {
  const evidence = JSON.stringify({ total_usd: 2.37, by_division: [{ division_id: "creatoros", cost_usd: 1.12 }], amount_cents: 1900, mrr: 4210.37, delta: 3.14, followers: 48_213 });

  it("accepts numbers restated from the evidence, including cents as dollars and rounding", () => {
    expect(ungroundedNumbers("Spend $2.37, CreatorOS $1.12, refund $19.00, MRR $4,210 (+3.1%), 48.2K followers", evidence)).toEqual([]);
  });

  it("flags numbers the evidence does not contain", () => {
    const flagged = ungroundedNumbers("MRR $5,100 (+12% WoW), refund $25.00, spend $2.37, 640 signups", evidence);
    expect(flagged.map((n) => n.text)).toEqual(["$5,100", "$25.00", "12%", "640"]);
  });

  it("does not let a rounded figure pass for a different one", () => {
    // $2.40 is not $2.37, even though both round to $2.
    expect(ungroundedNumbers("Spend $2.40", evidence).map((n) => n.text)).toEqual(["$2.40"]);
    expect(ungroundedNumbers("Spend $2", evidence)).toEqual([]);
  });
});
