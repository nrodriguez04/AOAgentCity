import { CITY_TIMEZONE } from "@agent-city/core";

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" });

/** "3 min. ago", "in 2 hr." */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  // Small skews between the writer's clock and this one read as "just now" either way.
  if (abs < 45_000) return "just now";
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  return rtf.format(Math.round(diff / 86_400_000), "day");
}

export function clockTime(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: CITY_TIMEZONE, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(at);
}

export function dateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CITY_TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
