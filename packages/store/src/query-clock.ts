/**
 * Query clock (24.8 §5.2): a new binding runs once over THIS_YEAR; a successful run then sets a discrete
 * WEEK or MONTH cadence searching THIS_WEEK / THIS_MONTH. Low yield cools a binding down and then makes it
 * dormant; there is no continuous quality score. Months are calendar months in UTC (the day is clamped to
 * the month's end). A failure only schedules a retry and never starts a new normal period.
 */

export const LEGACY_QUERY_POLICY_VERSION = 'query-clock-1';
export const QUERY_POLICY_VERSION = 'query-clock-2-about';
/** New qualified channels in one run that make a binding weekly; fewer (but some) make it monthly. */
export const WEEKLY_MIN_QUALIFIED = 3;
/** Consecutive empty runs before COOLDOWN; one more empty run after the cool-down makes it DORMANT. */
export const COOLDOWN_AFTER_EMPTY_RUNS = 3;
export const COOLDOWN_MONTHS = 3;

export type QueryState = 'BOOTSTRAP' | 'ACTIVE' | 'COOLDOWN' | 'DORMANT' | 'DISABLED';
export type QueryCadence = 'WEEK' | 'MONTH';
export type QueryWindow = 'THIS_YEAR' | 'THIS_WEEK' | 'THIS_MONTH';
export interface ClockedBinding { state: QueryState; cadence: QueryCadence | null; cadence_override: QueryCadence | null; empty_runs: number }
export interface QueryClockChange { state: QueryState; cadence: QueryCadence | null; next_run_at: Date | null; empty_runs: number }

/** The search window a run of this binding freezes. */
export function runWindow(binding: ClockedBinding): QueryWindow {
  if (binding.state === 'BOOTSTRAP') return 'THIS_YEAR';
  return (binding.cadence_override ?? binding.cadence ?? 'MONTH') === 'WEEK' ? 'THIS_WEEK' : 'THIS_MONTH';
}

/** The same day `months` calendar months later (UTC), clamped to that month's last day. */
export function addCalendarMonths(at: Date, months: number): Date {
  const target = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + months, 1, at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds(), at.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(at.getUTCDate(), lastDay));
  return target;
}

const after = (cadence: QueryCadence, now: Date) => cadence === 'WEEK' ? new Date(now.getTime() + 7 * 86_400_000) : addCalendarMonths(now, 1);

/** A run completed and found `qualifiedNew` new channels at or above the subscriber threshold. */
export function settleQueryRun(binding: ClockedBinding, qualifiedNew: number, now: Date): QueryClockChange {
  if (qualifiedNew > 0) {
    const cadence: QueryCadence = qualifiedNew >= WEEKLY_MIN_QUALIFIED ? 'WEEK' : 'MONTH';
    return { state: 'ACTIVE', cadence, next_run_at: after(binding.cadence_override ?? cadence, now), empty_runs: 0 };
  }
  const empty = binding.empty_runs + 1;
  if (binding.state === 'COOLDOWN') return { state: 'DORMANT', cadence: 'MONTH', next_run_at: null, empty_runs: empty };
  if (empty >= COOLDOWN_AFTER_EMPTY_RUNS) return { state: 'COOLDOWN', cadence: 'MONTH', next_run_at: addCalendarMonths(now, COOLDOWN_MONTHS), empty_runs: empty };
  return { state: 'ACTIVE', cadence: 'MONTH', next_run_at: after(binding.cadence_override ?? 'MONTH', now), empty_runs: empty };
}

/** When a failed run is retried: 1 hour, doubling per consecutive failure, at most a day. */
export function retryAt(failures: number, now: Date): Date {
  return new Date(now.getTime() + Math.min(24, 2 ** Math.max(0, failures - 1)) * 3_600_000);
}
