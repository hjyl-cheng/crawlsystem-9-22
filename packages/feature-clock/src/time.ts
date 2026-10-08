/**
 * Instants are UTC epoch microseconds (Python datetimes carry microseconds; JS Dates stop at
 * milliseconds). Clock days are UTC calendar days, 'YYYY-MM-DD', which also compare as strings.
 */
export type Instant = number;
export type Day = string;

export const MICROS_PER_DAY = 86_400_000_000;

const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(Z|[+-]\d{2}:?\d{2})$/i;

/** Parse an ISO-8601 timestamp with an explicit offset. Digits past microseconds are dropped. */
export function parseInstant(text: string): Instant {
  const match = ISO.exec(text.trim());
  if (!match) throw new Error(`timestamp must be ISO-8601 with a timezone: ${text}`);
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match;
  const millis = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  let offsetMinutes = 0;
  if (zone!.toUpperCase() !== 'Z') {
    const digits = zone!.replace(':', '');
    offsetMinutes = (digits.startsWith('-') ? -1 : 1) * (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5)));
  }
  return (millis - offsetMinutes * 60_000) * 1000 + Number(fraction.slice(0, 6).padEnd(6, '0'));
}

export function instantFromDate(value: Date): Instant {
  return value.getTime() * 1000;
}

export function instantToDate(value: Instant): Date {
  return new Date(Math.floor(value / 1000));
}

/** ISO text as Python's isoformat() writes UTC: fraction only when there are microseconds. */
export function formatInstant(value: Instant): string {
  const micros = ((value % 1_000_000) + 1_000_000) % 1_000_000;
  const base = new Date((value - micros) / 1000).toISOString().slice(0, 19);
  return micros === 0 ? `${base}Z` : `${base}.${String(micros).padStart(6, '0')}Z`;
}

/** (later − earlier).total_seconds() / 86400.0 */
export function daysBetween(earlier: Instant, later: Instant): number {
  return (later - earlier) / 1e6 / 86400.0;
}

export function utcDay(value: Instant): Day {
  return new Date(Math.floor(value / 1000)).toISOString().slice(0, 10);
}

export function addDays(day: Day, days: number): Day {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The instant a clock day starts (the legacy due_at). */
export function dayStart(day: Day): Date {
  return new Date(`${day}T00:00:00Z`);
}
