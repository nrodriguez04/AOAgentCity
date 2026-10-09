// Schedules and budgets run on Nico's clock (CRON_TZ=America/Chicago, spec §8).
export const CITY_TIMEZONE = "America/Chicago";

function wallClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Offset of `timeZone` from UTC at instant `at`, in milliseconds (negative west of UTC). */
export function zoneOffsetMs(at: Date, timeZone = CITY_TIMEZONE): number {
  const w = wallClock(at, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant local midnight began for the day containing `at` in `timeZone`. */
export function startOfDayInZone(at: Date, timeZone = CITY_TIMEZONE): Date {
  const w = wallClock(at, timeZone);
  const midnightAsUtc = Date.UTC(w.year, w.month - 1, w.day);
  let guess = new Date(midnightAsUtc - zoneOffsetMs(at, timeZone));
  // The offset at midnight can differ from the offset at `at` on DST change days.
  const offsetAtGuess = zoneOffsetMs(guess, timeZone);
  guess = new Date(midnightAsUtc - offsetAtGuess);
  return guess;
}

export function formatInZone(at: Date, timeZone = CITY_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
}
