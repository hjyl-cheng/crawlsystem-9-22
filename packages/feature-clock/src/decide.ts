import { addDays, daysBetween, utcDay, type Day, type Instant } from './time.ts';
import { daysToMicros, or, roundHalfEven, sha256Mod, unique } from './py.ts';
import { discoveryDays, type ClockPolicy } from './policy.ts';
import { publishFrequencyScore } from './shared-features.ts';
import type { ChannelFeatureState } from './state.ts';

/** Port of feature_engine/policy.py (the paths policy v16-rule-7 enables): how many days until each clock is due. */

export interface ClockDecision {
  due_day: Day;
  tier_days: number;
  reason_codes: string[];
}

export const ABOUT_TIER_DAYS = [1, 2, 3, 5, 7, 14, 30, 60, 90, 180] as const;
const ABOUT_COLD_START_CADENCE_TIERS: readonly (readonly [number, number])[] = [[1.5, 1], [2.5, 2], [3.5, 3], [5.5, 5]];
/** [minimum stable days, minimum stable runs, longest allowed About interval] */
const ABOUT_LONG_STABILITY_GATES: readonly (readonly [number, number, number])[] = [[21, 3, 14], [60, 6, 30], [120, 9, 60], [180, 12, 90], [365, 15, 180]];
const AGENT_FORWARD_SPREAD_DAYS: readonly (readonly [number, number])[] = [[14, 0], [30, 2], [60, 6], [90, 14], [180, 20], [365, 29]];
export const AGENT_FORWARD_SPREAD_VERSION = 'agent-forward-spread-1';
const AGENT_SEMANTIC_MIN_INTERVAL_DAYS = 60;
const AGENT_SEMANTIC_MAX_INTERVAL_DAYS = 365;
const AGENT_SEMANTIC_CURVE_EXPONENT = 1.8;

function decision(observedAt: Instant, interval: number, reasons: readonly string[]): ClockDecision {
  return { due_day: addDays(utcDay(observedAt), interval), tier_days: interval, reason_codes: unique(reasons) };
}

function stableDays(state: ChannelFeatureState, observedAt: Instant): number {
  return state.about_stable_since === null ? 0.0 : Math.max(0.0, daysBetween(state.about_stable_since, observedAt));
}

/** The channel published within 30 days (or its recent pool is non-empty). */
export function recentPublishActive(state: ChannelFeatureState, observedAt: Instant): boolean {
  if ((state.recent30_video_count ?? 0) > 0) return true;
  if (state.last_publish_at === null || observedAt <= state.last_publish_at) return false;
  return (observedAt - state.last_publish_at) / 1e6 <= 30 * 86400;
}

export function expectedPublishInterval(state: ChannelFeatureState): number | null {
  if (state.publish_interval_ewma !== null && state.publish_interval_median !== null) {
    return (0.60 * state.publish_interval_ewma) + (0.40 * state.publish_interval_median);
  }
  return or(state.publish_interval_ewma, state.publish_interval_median);
}

// ---- About -------------------------------------------------------------------------------

/** A channel publishing at a reliable cadence gets an About tier near that cadence. */
function aboutCadenceTier(state: ChannelFeatureState, observedAt: Instant, policy: ClockPolicy): number | null {
  const config = policy.about_config;
  const expected = expectedPublishInterval(state);
  let cadence: number | null = null;
  if (expected !== null && expected > 0 && state.recent_publish_interval_days.length >= config.cold_start_min_reliable_intervals) cadence = expected;
  else if ((state.recent30_video_count ?? 0) > 0) cadence = 30.0 / (or(state.recent30_video_count, 1));
  const publishAge = state.last_publish_at === null ? null : Math.max(0.0, daysBetween(state.last_publish_at, observedAt));
  const confidence = state.about_metric_confidence ?? state.feature_confidence;
  const qualified = config.cadence_baseline_enabled && cadence !== null
    && publishAge !== null && publishAge <= config.cold_start_max_publish_age_days
    && confidence >= config.cold_start_min_feature_confidence;
  if (!qualified) return null;
  const tiers: (readonly [number, number])[] = [[config.cold_start_tier_one_max_publish_interval_days, 1], ...ABOUT_COLD_START_CADENCE_TIERS.slice(1)];
  return tiers.find(([maximum]) => cadence! <= maximum)?.[1] ?? 7;
}

function aboutPriorityTier(priority: number): [number, string] {
  const tiers: [number, number, string][] = [
    [0.75, 1, 'about_priority_very_high'], [0.65, 2, 'about_priority_high'], [0.55, 3, 'about_priority_elevated'],
    [0.45, 5, 'about_priority_active'], [0.35, 7, 'about_priority_medium'], [0.25, 14, 'about_priority_low'],
    [0.15, 30, 'about_priority_very_low'], [0.10, 60, 'about_priority_minimal'], [0.05, 90, 'about_priority_dormant'],
  ];
  const found = tiers.find(([threshold]) => priority >= threshold);
  return found ? [found[1], found[2]] : [180, 'about_priority_deeply_dormant'];
}

function aboutStabilityCap(state: ChannelFeatureState, stable: number): number {
  let cap = 7;
  for (const [days, runs, tier] of ABOUT_LONG_STABILITY_GATES) if (stable >= days && state.about_stable_runs >= runs) cap = tier;
  return cap;
}

export function decideAboutDue(state: ChannelFeatureState, observedAt: Instant, outcome: 'complete' | 'partial', baseline: boolean, policy: ClockPolicy): ClockDecision {
  const config = policy.about_config;
  const reasons: string[] = [];
  let subscriber = state.subscriber_growth_percentile, view = state.view_growth_percentile;
  if (subscriber === null) { subscriber = config.neutral_growth_percentile; reasons.push('subscriber_growth_reference_fallback'); }
  if (view === null) { view = config.neutral_growth_percentile; reasons.push('view_growth_reference_fallback'); }
  const videoChange = Math.min(1.0, Math.max(0.0, state.video_count_delta ?? 0) / config.video_delta_full_scale);
  const priority = (0.40 * subscriber) + (0.35 * view) + (0.20 * videoChange) + (0.05 * state.collection_priority);
  const cadenceTier = aboutCadenceTier(state, observedAt, policy);
  let interval: number;
  if (baseline) {
    interval = cadenceTier ?? config.baseline_interval_days;
    reasons.push('about_baseline', cadenceTier !== null ? `about_cold_start_cadence_${interval}d` : 'about_cold_start_cadence_fallback');
  } else if (subscriber >= 0.90 || view >= 0.90) {
    interval = 1;
    reasons.push('growth_percentile_critical');
  } else {
    const [tier, reason] = aboutPriorityTier(priority);
    interval = tier;
    reasons.push(reason);
  }
  if (!baseline && cadenceTier !== null && interval > cadenceTier) {
    interval = cadenceTier;
    reasons.push(`about_active_cadence_cap_${cadenceTier}d`);
  }
  if ((state.video_count_delta ?? 0) > 0 && recentPublishActive(state, observedAt)) {
    interval = Math.min(interval, 3);
    reasons.push('video_count_increased');
  }
  const cap = aboutStabilityCap(state, stableDays(state, observedAt));
  if (interval > cap) { interval = cap; reasons.push('about_long_interval_stability_cap'); }
  if (outcome === 'partial') { interval = Math.min(interval, policy.partial_retry_config.about_days); reasons.push('partial_retry_cap'); }
  return decision(observedAt, interval, reasons);
}

/** About may speed up at once but slows down at most one tier per run. */
export function limitAboutSlowdown(decided: ClockDecision, previousTierDays: number): ClockDecision {
  if (decided.tier_days <= previousTierDays) return decided;
  const index = (ABOUT_TIER_DAYS as readonly number[]).indexOf(previousTierDays);
  if (index < 0) return decided;
  const nextTier = ABOUT_TIER_DAYS[Math.min(index + 1, ABOUT_TIER_DAYS.length - 1)]!;
  if (decided.tier_days <= nextTier) return decided;
  return {
    due_day: addDays(addDays(decided.due_day, -decided.tier_days), nextTier),
    tier_days: nextTier,
    reason_codes: unique([...decided.reason_codes, 'about_slowdown_one_tier']),
  };
}

// ---- Video -------------------------------------------------------------------------------

export interface RiskCandidate { interval_days: number; reason_codes: string[] }

function mapTier(rawDays: number, allowed: readonly number[]): number {
  const raw = Math.max(1.0, rawDays);
  return allowed.find(tier => raw <= tier) ?? allowed[allowed.length - 1]!;
}

/** When the next upload is likely: a regular channel is checked just before its predicted upload, others by a decaying rate. */
export function discoveryRisk(state: ChannelFeatureState, observedAt: Instant, outcome: 'complete' | 'partial', baseline: boolean, policy: ClockPolicy): RiskCandidate {
  const config = policy.discovery_config;
  const reasons: string[] = [];
  const expected = expectedPublishInterval(state);
  const regular = (state.publish_regularity ?? 0.0) >= config.regularity_threshold && state.last_publish_at !== null;
  let raw: number;
  if (expected === null || expected <= 0) {
    raw = config.fallback_interval_days;
    reasons.push('publish_interval_fallback');
  } else if (regular && state.last_publish_at! + daysToMicros(expected) - daysToMicros(Math.min(7, Math.max(1, Math.ceil(expected * 0.20)))) > observedAt) {
    const lead = Math.min(7, Math.max(1, Math.ceil(expected * 0.20)));
    const rawDue = state.last_publish_at! + daysToMicros(expected) - daysToMicros(lead);
    raw = Math.max(1.0, daysBetween(observedAt, rawDue));
    reasons.push('regular_publish_prediction');
  } else {
    if (regular) reasons.push('regular_publish_window_elapsed');
    const age = state.last_publish_at !== null ? Math.max(0.0, daysBetween(state.last_publish_at, observedAt)) : expected;
    const silenceExcess = Math.max(0.0, (age / expected) - 1.0);
    const rate = (1.0 / expected) * Math.exp(-config.silence_decay * silenceExcess);
    let target: number;
    if (state.collection_priority >= 0.85) { target = 0.20; reasons.push('high_collection_priority'); }
    else if ((state.channel_activity ?? 0.0) >= 0.40) { target = 0.35; reasons.push('active_irregular_channel'); }
    else { target = 0.60; reasons.push('cold_irregular_channel'); }
    raw = -Math.log(1.0 - target) / Math.max(rate, 1e-9);
    if (state.new_video_empty_runs > 0) {
      raw *= 1.0 + Math.min(2.0, 0.25 * state.new_video_empty_runs);
      reasons.push('empty_run_backoff');
    }
  }
  let interval = mapTier(raw, discoveryDays(policy));
  if (baseline) reasons.push('discovery_baseline');
  if (outcome === 'partial') { interval = Math.min(interval, policy.partial_retry_config.discovery_days); reasons.push('partial_retry_cap'); }
  return { interval_days: interval, reason_codes: unique(reasons) };
}

/** How soon recent videos' numbers are worth re-reading. */
export function samplingRisk(state: ChannelFeatureState, outcome: 'complete' | 'partial', baseline: boolean, policy: ClockPolicy): RiskCandidate {
  const priority = (0.25 * (state.channel_activity ?? 0.0)) + (0.20 * publishFrequencyScore(state.recent30_video_count))
    + (0.25 * (state.recent_change_probability ?? 0.0)) + (0.20 * (state.recent_stale_ratio ?? 0.0)) + (0.10 * state.collection_priority);
  const reasons: string[] = [];
  let interval: number;
  if (baseline) { interval = policy.recent_sampling_config.fallback_interval_days; reasons.push('recent_sampling_baseline'); }
  else if (state.recent30_video_count === 0) { interval = 60; reasons.push('recent_pool_empty'); }
  else if (priority >= 0.80) { interval = 3; reasons.push('recent_sampling_priority_very_high'); }
  else if (priority >= 0.60) { interval = 7; reasons.push('recent_sampling_priority_high'); }
  else if (priority >= 0.40) { interval = 14; reasons.push('recent_sampling_priority_medium'); }
  else if (priority >= 0.20) { interval = 30; reasons.push('recent_sampling_priority_low'); }
  else { interval = 60; reasons.push('recent_sampling_priority_very_low'); }
  if (outcome === 'partial') { interval = Math.min(interval, policy.partial_retry_config.recent_sampling_days); reasons.push('partial_retry_cap'); }
  return { interval_days: interval, reason_codes: reasons };
}

/** Video takes the sooner of Discovery and Recent Sampling, never sooner than the automatic minimum. */
export function decideVideoDue(state: ChannelFeatureState, observedAt: Instant, transition: {
  discovery_outcome: 'complete' | 'partial'; recent_sampling_outcome: 'complete' | 'partial' | 'failed' | 'skipped';
  discovery_baseline: boolean; recent_sampling_baseline: boolean;
}, policy: ClockPolicy): ClockDecision {
  const discovery = discoveryRisk(state, observedAt, transition.discovery_outcome, transition.discovery_baseline, policy);
  const retry = policy.partial_retry_config.recent_sampling_days;
  const sampling: RiskCandidate = transition.recent_sampling_outcome === 'skipped' ? { interval_days: retry, reason_codes: ['recent_sampling_skipped'] }
    : transition.recent_sampling_outcome === 'failed' ? { interval_days: retry, reason_codes: ['recent_sampling_failed_retry_cap'] }
    : samplingRisk(state, transition.recent_sampling_outcome, transition.recent_sampling_baseline, policy);
  const byDiscovery = discovery.interval_days <= sampling.interval_days;
  const unconstrained = (byDiscovery ? discovery : sampling).interval_days;
  const interval = Math.max(unconstrained, policy.discovery_config.automatic_min_interval_days);
  const reasons = [...discovery.reason_codes, ...sampling.reason_codes, `video_interval_constrained_by_${byDiscovery ? 'discovery' : 'recent_sampling'}`];
  if (interval > unconstrained) reasons.push('automatic_video_min_interval');
  return decision(observedAt, interval, reasons);
}

// ---- Agent -------------------------------------------------------------------------------

export function agentForwardSpreadMaxDays(intervalDays: number): number {
  const first = AGENT_FORWARD_SPREAD_DAYS[0]!, last = AGENT_FORWARD_SPREAD_DAYS[AGENT_FORWARD_SPREAD_DAYS.length - 1]!;
  if (intervalDays <= first[0]) return first[1];
  if (intervalDays >= last[0]) return last[1];
  for (let index = 1; index < AGENT_FORWARD_SPREAD_DAYS.length; index += 1) {
    const [lowerDays, lowerSpread] = AGENT_FORWARD_SPREAD_DAYS[index - 1]!, [upperDays, upperSpread] = AGENT_FORWARD_SPREAD_DAYS[index]!;
    if (intervalDays <= upperDays) {
      const position = (intervalDays - lowerDays) / (upperDays - lowerDays);
      return roundHalfEven(lowerSpread + position * (upperSpread - lowerSpread));
    }
  }
  throw new Error('Agent spread anchors do not cover the interval');
}

/** A stable per-channel offset that spreads long Agent intervals over the following days. */
export function agentForwardOffset(channelId: string, policyVersion: string, tierDays: number): number {
  const normalized = channelId.trim();
  if (!normalized) throw new Error('channel_id cannot be empty');
  const maximum = agentForwardSpreadMaxDays(tierDays);
  return maximum === 0 ? 0 : sha256Mod(`${policyVersion}:${normalized}:${tierDays}:${AGENT_FORWARD_SPREAD_VERSION}`, maximum + 1);
}

function semanticChange(state: ChannelFeatureState): number | null {
  const comparable = [state.topic_drift, state.evidence_replacement, state.recent_content_shift].filter((value): value is number => value !== null);
  return comparable.length === 0 ? null : Math.min(1.0, Math.max(0.0, Math.max(...comparable)));
}

/** The less a channel's profile changed, the longer until the next one: 60 days at full change up to 365 when unchanged. */
function semanticIntervalDays(change: number): number {
  const stableFraction = (1.0 - change) ** AGENT_SEMANTIC_CURVE_EXPONENT;
  return roundHalfEven(AGENT_SEMANTIC_MIN_INTERVAL_DAYS + (AGENT_SEMANTIC_MAX_INTERVAL_DAYS - AGENT_SEMANTIC_MIN_INTERVAL_DAYS) * stableFraction);
}

/** Without a channel id the decision is not spread (as the legacy function). */
export function decideAgentDue(state: ChannelFeatureState, observedAt: Instant, baseline: boolean, channelId: string | null, policy: ClockPolicy): ClockDecision {
  const config = policy.agent_config;
  const change = semanticChange(state);
  let interval: number, reason: string;
  if (baseline) [interval, reason] = [config.baseline_interval_days, 'agent_semantic_baseline'];
  else if (state.agent_version_changed) [interval, reason] = [config.baseline_interval_days, 'agent_cross_version_baseline'];
  else if (change === null) [interval, reason] = [config.baseline_interval_days, 'agent_semantic_comparison_unavailable'];
  else [interval, reason] = [semanticIntervalDays(change), 'agent_semantic_continuous_interval'];
  const decided = decision(observedAt, interval, [reason]);
  if (channelId === null || agentForwardSpreadMaxDays(interval) === 0) return decided;
  const offset = agentForwardOffset(channelId, policy.policy_version, interval);
  return { ...decided, due_day: addDays(decided.due_day, offset), reason_codes: unique([...decided.reason_codes, 'agent_forward_load_spread']) };
}
