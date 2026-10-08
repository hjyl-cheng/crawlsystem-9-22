// Update clocks for managed channels (M3, docs/m3/README.md; 24.8 §7: three clocks). Each
// managed channel has one clock per domain - About, Video, Agent - saying when that part is next
// due and why. The Video clock follows new-video discovery; refreshing the recent videos' counts
// rides along with a Video run once its own 14-day period has passed. v1 uses the fixed tiers
// confirmed on 2026-10-08; dynamic rules come later behind a new policy version.
import type { Domain } from './index.ts';

export const CLOCK_POLICY_VERSION = 'm3-v1-fixed';
export const CLOCK_NAMES = ['ABOUT', 'VIDEO', 'AGENT'] as const satisfies readonly Domain[];
export type ClockName = typeof CLOCK_NAMES[number];
export const CLOCK_REASONS = ['first_collection', 'manual_manage', 'baseline', 'active_publishing', 'new_video_active', 'discovery_empty_backoff', 'retry_after_failure', 'manual_override'] as const;
export type ClockReason = typeof CLOCK_REASONS[number];

const FIRST_DAYS: Record<ClockName, number> = { ABOUT: 7, VIDEO: 7, AGENT: 60 };
const BASELINE_DAYS: Record<ClockName, number> = { ABOUT: 7, VIDEO: 7, AGENT: 180 };
const RETRY_DAYS: Record<ClockName, number> = { ABOUT: 3, VIDEO: 3, AGENT: 14 };
const ACTIVE_DAYS = 3;           // About and new-video discovery of a channel that is publishing now
export const ACTIVE_WINDOW_DAYS = 14; // "publishing now": latest known upload within this window
const MAX_EMPTY_BACKOFF = 3;     // empty discoveries stretch the Video interval up to 3x
/** Recent-video refresh: included in a Video run once this many days have passed since the last one. */
export const REFRESH_INTERVAL_DAYS = 14;

/** What is known about the channel when a clock is decided. */
export interface ClockFacts {
  /** Newest publish time among stored videos, if any. */
  latestPublishedAt: string | null;
  /** New videos this run discovered; null when the run did not report it. */
  newVideosFound: number | null;
  /** Consecutive discoveries before this one that found nothing. */
  emptyDiscoveryRuns: number;
}
export interface ClockDecision { interval_days: number; reason: ClockReason }
/** Intervals an operator may pin a clock to (overriding the policy for that channel and domain). */
export const OVERRIDE_DAYS = [1, 2, 3, 5, 7, 14, 30, 60, 90, 180, 365] as const;

/**
 * first: the channel just entered management. success: this domain was applied; the normal
 * period restarts. failure: it was required but not applied; only a retry is scheduled and the
 * normal period does not advance (24.8 §5.2).
 */
export function decideClock(clock: ClockName, outcome: 'first' | 'success' | 'failure', facts: ClockFacts, now: Date, overrideDays: number | null = null): ClockDecision {
  // An operator's pinned interval replaces the policy; a retry never waits longer than that interval.
  if (outcome === 'failure') return { interval_days: Math.min(RETRY_DAYS[clock], overrideDays ?? Infinity), reason: 'retry_after_failure' };
  if (overrideDays !== null) return { interval_days: overrideDays, reason: 'manual_override' };
  if (outcome === 'first') return { interval_days: FIRST_DAYS[clock], reason: 'first_collection' };
  const active = facts.latestPublishedAt !== null && now.getTime() - Date.parse(facts.latestPublishedAt) <= ACTIVE_WINDOW_DAYS * 86_400_000;
  if (clock === 'ABOUT') return active && (facts.newVideosFound ?? 0) > 0 ? { interval_days: ACTIVE_DAYS, reason: 'new_video_active' } : { interval_days: BASELINE_DAYS.ABOUT, reason: 'baseline' };
  if (clock === 'VIDEO') {
    if (active) return { interval_days: ACTIVE_DAYS, reason: 'active_publishing' };
    const empty = facts.newVideosFound === 0 ? facts.emptyDiscoveryRuns + 1 : 0;
    if (empty === 0) return { interval_days: BASELINE_DAYS.VIDEO, reason: 'baseline' };
    return { interval_days: Math.round(BASELINE_DAYS.VIDEO * Math.min(MAX_EMPTY_BACKOFF, 1 + 0.25 * empty)), reason: 'discovery_empty_backoff' };
  }
  return { interval_days: BASELINE_DAYS[clock], reason: 'baseline' };
}
/** Whether a Video run starting at `now` should also refresh the recent videos' counts. */
export function refreshDue(refreshDueAt: string | null, now: Date): boolean {
  return refreshDueAt === null || Date.parse(refreshDueAt) <= now.getTime();
}
