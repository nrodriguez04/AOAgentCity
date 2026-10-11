// Number grounding: every amount an agent states must come from something it
// read in the run (its context or a tool result). This is the eval for the
// runtime rule "only report numbers you got from tool results in this run",
// and for HQ's "never state a number you did not read".
//
// Checked: money ($19.00, $4.2K), percentages (3.1%) and other numbers of 100
// or more. Small integers are left alone by default: counting the items in a
// list ("2 approvals waiting") is reading, not inventing. Writing that is built
// from a fixed input (a devlog from a list of commits) can check them too with
// a lower minCount. Dates, times, years, ids (APV-2026-0004, HQ-01, Q4),
// numbering (devlog 2, #3, list markers) and links are not quantities and are
// skipped.

export interface StatedNumber {
  /** As written, e.g. "$4,210" or "3.1%". */
  text: string;
  value: number;
  kind: "money" | "percent" | "count";
}

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

/** Text with everything that looks numeric but is not a quantity blanked out. */
function withoutNonQuantities(text: string): string {
  return (
    text
      .replace(/https?:\/\/\S+/g, " ")
      // ISO timestamps and dates, clock times
      .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, " ")
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?/gi, " ")
      .replace(/\b\d{1,2}\s*[ap]\.?m\.?(?![a-z])/gi, " ")
      // "Oct 11", "October 11th, 2026", "11 October"
      .replace(new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "gi"), " ")
      .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\b`, "gi"), " ")
      // ids and codes: letters joined to digits (APV-2026-0004, HQ-01, Q4, pi_3Q, 82nd), but not 48.2K or $1.5M
      .replace(/\b[A-Za-z]+[-_]?\d[\w-]*|\b\d+[-_]?(?![kKmM]\b)[A-Za-z][\w-]*/g, " ")
      // years
      .replace(/\b(?:19|20)\d{2}\b/g, " ")
      // numbering: "devlog 2", "part 3", "#4", list markers
      .replace(/\b(?:devlog|episode|part|week|day|chapter|season|volume|vol\.|no\.|number)\s*#?\d+\b/gi, " ")
      .replace(/#\d+\b/g, " ")
      .replace(/^\s*\d+[.)]\s/gm, " ")
  );
}

function parseAmount(digits: string, suffix: string | undefined): number {
  const base = Number(digits.replace(/,/g, ""));
  const scale = suffix?.toLowerCase() === "k" ? 1_000 : suffix?.toLowerCase() === "m" ? 1_000_000 : 1;
  return base * scale;
}

export interface NumberOptions {
  /** Plain numbers below this are not checked (default 100). Money and percentages always are. */
  minCount?: number;
}

/** The quantities stated in a piece of text (markdown is fine). */
export function statedNumbers(text: string, options: NumberOptions = {}): StatedNumber[] {
  const minCount = options.minCount ?? 100;
  const found: StatedNumber[] = [];
  let rest = withoutNonQuantities(text);

  rest = rest.replace(/(?:US)?\$\s?(\d[\d,]*(?:\.\d+)?)\s?([kKmM](?![a-z]))?/g, (match, digits: string, suffix?: string) => {
    found.push({ text: match.trim(), value: parseAmount(digits, suffix), kind: "money" });
    return " ";
  });
  rest = rest.replace(/(\d[\d,]*(?:\.\d+)?)\s?%/g, (match, digits: string) => {
    found.push({ text: match.trim(), value: parseAmount(digits, undefined), kind: "percent" });
    return " ";
  });
  for (const match of rest.matchAll(/(?<![\w.])(\d[\d,]*(?:\.\d+)?)\s?([kKmM](?![a-z]))?(?![\w])/g)) {
    const value = parseAmount(match[1]!, match[2]);
    if (value >= minCount) found.push({ text: match[0].trim(), value, kind: "count" });
  }
  return found;
}

/** Every number that appears anywhere in the evidence, in the forms it could be restated in. */
export function evidenceValues(evidence: string): number[] {
  const values = new Set<number>();
  for (const match of evidence.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const raw = Number(match[0].replace(/,/g, ""));
    if (!Number.isFinite(raw)) continue;
    const v = Math.abs(raw);
    // As written, and as cents <-> dollars (Stripe amounts are in cents).
    for (const candidate of [v, v / 100, v * 100]) values.add(candidate);
  }
  return [...values];
}

/** Does a stated number match something in the evidence, allowing for how it was rounded when written? */
function matches(stated: StatedNumber, evidence: number[]): boolean {
  const decimals = (stated.text.match(/\.(\d+)/)?.[1]?.length ?? 0);
  const abbreviated = /[kKmM]$/.test(stated.text);
  // Written as "$4,210" may be 4210.37 rounded; "3.1%" may be 3.14; "$4.2K" may be 4,213.
  const tolerance = abbreviated ? Math.max(stated.value * 0.0125, 0.5) : 0.5 * 10 ** -decimals + 1e-9;
  return evidence.some((e) => Math.abs(e - stated.value) <= tolerance);
}

/** The stated numbers that appear nowhere in the evidence. */
export function ungroundedNumbers(text: string, evidence: string, options: NumberOptions = {}): StatedNumber[] {
  const values = evidenceValues(evidence);
  return statedNumbers(text, options).filter((n) => !matches(n, values));
}
