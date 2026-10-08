// Update clocks for managed channels (M3, docs/m3/README.md). Each managed channel has four
// clocks; a clock says when its part of the channel is next due and why. v1 uses the fixed
// tiers confirmed on 2026-10-08; dynamic rules (growth percentiles, publishing cadence) come
// later behind a new policy version, once enough history exists.
import type { Domain } from './index.ts';

export const CLOCK_POLICY_VERSION = 'm3-v1-fixed';
export const CLOCK_NAMES = ['ABOUT', 'DISCOVERY', 'REFRESH', 'AGENT'] as const;
export type ClockName = typeof CLOCK_NAMES[number];
export const CLOCK_REASONS = ['first_collection', 'manual_manage', 'baseline', 'active_publishing', 'new_video_active', 'discovery_empty_backoff', 'retry_after_failure'] as const;
export type ClockReason = typeof CLOCK_REASONS[number];

/** Which clocks a plan domain advances: VIDEO covers new-video discovery and the recent-video refresh. */
export function clocksOf(domain: Domain): ClockName[] {
  return domain === 'VIDEO' ? ['DISCOVERY', 'REFRESH'] : [domain];
}

const FIRST_DAYS: Record<ClockName, number> = { ABOUT: 7, DISCOVERY: 7, REFRESH: 14, AGENT: 60 };
const BASELINE_DAYS: Record<ClockName, number> = { ABOUT: 7, DISCOVERY: 7, REFRESH: 14, AGENT: 180 };
const RETRY_DAYS: Record<ClockName, number> = { ABOUT: 3, DISCOVERY: 3, REFRESH: 7, AGENT: 14 };
const ACTIVE_DAYS = 3;           // About and discovery of a channel that is publishing now
export const ACTIVE_WINDOW_DAYS = 14; // "publishing now": latest known upload within this window
const MAX_EMPTY_BACKOFF = 3;     // empty discoveries stretch the interval up to 3x

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

/**
 * first: the channel just entered management. success: this part was applied; the normal
 * period restarts. failure: it was required but not applied; only a retry is scheduled and the
 * normal period does not advance (24.8 §5.2).
 */
export function decideClock(clock: ClockName, outcome: 'first' | 'success' | 'failure', facts: ClockFacts, now: Date): ClockDecision {
  if (outcome === 'first') return { interval_days: FIRST_DAYS[clock], reason: 'first_collection' };
  if (outcome === 'failure') return { interval_days: RETRY_DAYS[clock], reason: 'retry_after_failure' };
  const active = facts.latestPublishedAt !== null && now.getTime() - Date.parse(facts.latestPublishedAt) <= ACTIVE_WINDOW_DAYS * 86_400_000;
  if (clock === 'ABOUT') return active && (facts.newVideosFound ?? 0) > 0 ? { interval_days: ACTIVE_DAYS, reason: 'new_video_active' } : { interval_days: BASELINE_DAYS.ABOUT, reason: 'baseline' };
  if (clock === 'DISCOVERY') {
    if (active) return { interval_days: ACTIVE_DAYS, reason: 'active_publishing' };
    const empty = facts.newVideosFound === 0 ? facts.emptyDiscoveryRuns + 1 : 0;
    if (empty === 0) return { interval_days: BASELINE_DAYS.DISCOVERY, reason: 'baseline' };
    return { interval_days: Math.round(BASELINE_DAYS.DISCOVERY * Math.min(MAX_EMPTY_BACKOFF, 1 + 0.25 * empty)), reason: 'discovery_empty_backoff' };
  }
  return { interval_days: BASELINE_DAYS[clock], reason: 'baseline' };
}
