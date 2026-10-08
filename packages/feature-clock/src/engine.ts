import { addDays, formatInstant, parseInstant, utcDay, type Day, type Instant } from './time.ts';
import { sha256Mod, unique } from './py.ts';
import { ACTIVE_POLICY, type ClockPolicy } from './policy.ts';
import { deriveRecentChangeProbability, deriveSharedFeatures, NO_SIGNALS, ReferenceCatalog, type CollectionPrioritySignals } from './shared-features.ts';
import {
  applyAboutEvent, applyAboutStabilityEvidence, applyAgentEvent, applyVideoEvent, INITIAL_STATE,
  type AboutFacts, type AgentFacts, type ChannelFeatureState, type Outcome, type VideoFacts,
} from './state.ts';
import { decideAboutDue, decideAgentDue, decideVideoDue, limitAboutSlowdown, recentPublishActive, type ClockDecision } from './decide.ts';

/**
 * Port of the clock orchestration in feature_engine/applier.py (_apply_business_state,
 * _bootstrap_clocks, _update_clocks, _recalculate_first_cross_domain_clocks), without storage:
 * a snapshot and one observation in, the next snapshot and its clock decisions out.
 * A failed observation changes nothing but the per-kind count, exactly as in the legacy engine.
 */

export const CLOCK_KINDS = ['about', 'video', 'agent'] as const;
export type ClockKind = typeof CLOCK_KINDS[number];

/** One channel's three clocks (feature_clock.channel_clock_state). */
export interface ChannelClockState {
  about_due_day: Day; about_tier: number; about_last_complete_at: Instant | null;
  video_due_day: Day; video_tier: number; video_last_complete_at: Instant | null; video_last_outcome: Outcome | null;
  agent_due_day: Day; agent_tier: number; agent_last_complete_at: Instant | null;
  /** Stable position within a day's dispatch, 0..1023. */
  dispatch_slot: number;
}

export interface ClockSnapshot {
  state: ChannelFeatureState;
  clock: ChannelClockState | null;
  /** Observations applied per kind, failures included (the legacy per-kind checkpoint sequence). */
  applied: Record<ClockKind, number>;
}

export const EMPTY_SNAPSHOT: ClockSnapshot = Object.freeze({ state: INITIAL_STATE, clock: null, applied: Object.freeze({ about: 0, video: 0, agent: 0 }) });

export type Observation =
  | { kind: 'about'; observed_at: Instant; outcome: Outcome; facts: AboutFacts | null }
  | { kind: 'video'; observed_at: Instant; outcome: Outcome; facts: VideoFacts | null }
  | { kind: 'agent'; observed_at: Instant; outcome: Outcome; facts: AgentFacts | null };

export interface DecisionRecord {
  kind: ClockKind;
  mode: 'bootstrap' | 'post_run';
  tier: number;
  due_day: Day;
  reason_codes: string[];
}

export interface ClockContext {
  /** The newest reference distributions on or before the observation's UTC day. */
  references: ReferenceCatalog;
  signals?: CollectionPrioritySignals;
  policy?: ClockPolicy;
}

export function dispatchSlot(channelId: string, slots = 1024): number {
  return sha256Mod(`${channelId}:dispatch`, slots);
}

const sharedInputs = (state: ChannelFeatureState) => ({
    subscriber_count: state.last_subscriber_count,
    subscriber_velocity_ewma: state.subscriber_velocity_ewma,
    view_velocity_ewma: state.view_velocity_ewma,
    recent30_video_count: state.recent30_video_count,
    last_publish_at: state.last_publish_at,
    about_identity_observed: state.last_about_observed_at !== null,
    about_observed: state.last_about_observed_at !== null,
    discovery_observed: state.last_discovery_observed_at !== null,
    recent_sampling_observed: state.last_recent_sampling_at !== null,
    agent_observed: state.last_agent_observed_at !== null,
});

/** Cross-channel features (percentiles, activity, priority) as of `at`. */
function withShared(state: ChannelFeatureState, references: ReferenceCatalog, signals: CollectionPrioritySignals, at: Instant): ChannelFeatureState {
  const shared = deriveSharedFeatures(sharedInputs(state), references, signals, at);
  return {
    ...state,
    subscriber_size_percentile: shared.subscriber_size_percentile,
    subscriber_growth_percentile: shared.subscriber_growth_percentile,
    view_growth_percentile: shared.view_growth_percentile,
    growth_momentum: shared.growth_momentum,
    user_query_demand: shared.user_query_demand,
    data_incompleteness: shared.data_incompleteness,
    manual_priority: shared.manual_priority,
    collection_priority: shared.collection_priority,
    channel_activity: shared.channel_activity,
    recent_change_probability: deriveRecentChangeProbability(state.recent_view_change_ewma, state.recent_engagement_change_ewma, state.recent_upload_change_ewma, shared.channel_activity),
    reference_distribution_version: shared.reference_distribution_version,
  };
}

/** Refresh the cross-channel features after a state change. */
function enrich(state: ChannelFeatureState, references: ReferenceCatalog, signals: CollectionPrioritySignals, observedAt: Instant): ChannelFeatureState {
  const reasons = [...state.fallback_reason_codes];
  if (references.version === null) reasons.push('reference_distribution_unavailable');
  return { ...withShared(state, references, signals, observedAt), fallback_reason_codes: unique(reasons) };
}

const SHARED_FIELDS = [
  'subscriber_size_percentile', 'subscriber_growth_percentile', 'view_growth_percentile', 'growth_momentum', 'user_query_demand',
  'data_incompleteness', 'manual_priority', 'collection_priority', 'channel_activity', 'recent_change_probability', 'reference_distribution_version',
] as const satisfies readonly (keyof ChannelFeatureState)[];

/**
 * The legacy daily refresh (reference_data.refresh_shared_feature_states): re-rank every channel
 * against the new day's distributions, as of that day's start. Clocks are not touched; the next
 * observation decides with the refreshed features. Null when nothing changed.
 */
export function refreshSharedFeatures(state: ChannelFeatureState, references: ReferenceCatalog, signals: CollectionPrioritySignals, asOf: Instant): ChannelFeatureState | null {
  const next = withShared(state, references, signals, asOf);
  return SHARED_FIELDS.some(field => next[field] !== state[field]) ? { ...next, state_version: state.state_version + 1 } : null;
}

const record = (kind: ClockKind, mode: DecisionRecord['mode'], decided: ClockDecision): DecisionRecord =>
  ({ kind, mode, tier: decided.tier_days, due_day: decided.due_day, reason_codes: decided.reason_codes });
const HINT_REASONS = ['about_video_count_hint', 'recent_publish_active'];

export function applyObservation(channelId: string, snapshot: ClockSnapshot, observation: Observation, context: ClockContext): { snapshot: ClockSnapshot; decisions: DecisionRecord[] } {
  const applied = { ...snapshot.applied, [observation.kind]: snapshot.applied[observation.kind] + 1 };
  if (observation.outcome === 'failed') return { snapshot: { ...snapshot, applied }, decisions: [] };
  const policy = context.policy ?? ACTIVE_POLICY, signals = context.signals ?? NO_SIGNALS;
  const previous = snapshot.state, observedAt = observation.observed_at, outcome = observation.outcome;
  const refresh = (state: ChannelFeatureState) => enrich(state, context.references, signals, observedAt);

  let state: ChannelFeatureState, decided: ClockDecision, baseline = false;
  if (observation.kind === 'about') {
    const transition = applyAboutEvent(previous, observedAt, outcome, observation.facts, policy.about_config.velocity_ewma_alpha);
    state = transition.state;
    if (transition.business_state_changed) {
      state = applyAboutStabilityEvidence(previous, refresh(state), observedAt, outcome, transition.baseline);
    }
    baseline = transition.baseline;
    decided = decideAboutDue(state, observedAt, outcome, baseline, policy);
  } else if (observation.kind === 'video') {
    if (observation.facts === null) throw new Error('a Video observation needs facts unless it failed');
    const transition = applyVideoEvent(previous, observedAt, observation.facts, policy.discovery_config.interval_ewma_alpha, policy.recent_sampling_config.change_ewma_alpha);
    state = transition.business_state_changed ? refresh(transition.state) : transition.state;
    decided = decideVideoDue(state, observedAt, transition, policy);
  } else {
    const transition = applyAgentEvent(previous, observedAt, outcome, observation.facts);
    state = transition.business_state_changed ? refresh(transition.state) : transition.state;
    decided = decideAgentDue(state, observedAt, transition.baseline, channelId, policy);
  }

  const clock = snapshot.clock;
  if (clock === null) {
    const [next, decisions] = bootstrap(channelId, observation, state, decided, policy);
    return { snapshot: { state, clock: next, applied }, decisions };
  }
  if (observation.kind === 'about' && !baseline) decided = limitAboutSlowdown(decided, clock.about_tier);
  const recalculated = recalculateFirstCrossDomain(channelId, observation, state, clock, snapshot.applied, policy);
  const [next, decisions] = update(observation, state, decided, clock, recalculated, policy);
  return { snapshot: { state, clock: next, applied }, decisions };
}

/** The first successful observation creates all three clocks: its own from the decision, the others at their baselines. */
function bootstrap(channelId: string, observation: Observation, state: ChannelFeatureState, decided: ClockDecision, policy: ClockPolicy): [ChannelClockState, DecisionRecord[]] {
  const observedDay = utcDay(observation.observed_at);
  const tiers: Record<ClockKind, number> = { about: policy.about_config.baseline_interval_days, video: 7, agent: policy.agent_config.baseline_interval_days };
  const due: Record<ClockKind, Day> = { about: addDays(observedDay, tiers.about), video: addDays(observedDay, tiers.video), agent: addDays(observedDay, tiers.agent) };
  tiers[observation.kind] = decided.tier_days;
  due[observation.kind] = decided.due_day;
  const decisions = [record(observation.kind, 'bootstrap', decided)];
  if (observation.kind === 'about' && (state.video_count_delta ?? 0) > 0 && recentPublishActive(state, observation.observed_at)) {
    const hintDays = policy.discovery_config.automatic_min_interval_days, hinted = addDays(observedDay, hintDays);
    if (hinted < due.video) {
      due.video = hinted; tiers.video = hintDays;
      decisions.push({ kind: 'video', mode: 'bootstrap', tier: hintDays, due_day: hinted, reason_codes: HINT_REASONS });
    }
  }
  const completeAt = (kind: ClockKind) => observation.kind === kind && observation.outcome === 'complete' ? observation.observed_at : null;
  return [{
    about_due_day: due.about, about_tier: tiers.about, about_last_complete_at: completeAt('about'),
    video_due_day: due.video, video_tier: tiers.video, video_last_complete_at: completeAt('video'),
    video_last_outcome: observation.kind === 'video' ? observation.outcome : null,
    agent_due_day: due.agent, agent_tier: tiers.agent, agent_last_complete_at: completeAt('agent'),
    dispatch_slot: dispatchSlot(channelId),
  }, decisions];
}

/**
 * About and Agent clocks set from a single cold observation are re-decided once later
 * observations know more about the channel, and pulled earlier (never later) when that says so.
 */
function recalculateFirstCrossDomain(channelId: string, observation: Observation, state: ChannelFeatureState, clock: ChannelClockState, applied: Record<ClockKind, number>, policy: ClockPolicy): Partial<Record<'about' | 'agent', ClockDecision>> {
  const output: Partial<Record<'about' | 'agent', ClockDecision>> = {};
  for (const [kind, observedAt] of [['about', state.last_about_observed_at], ['agent', state.last_agent_observed_at]] as const) {
    if (kind === observation.kind || observedAt === null || applied[kind] !== 1) continue;
    const lastComplete = clock[`${kind}_last_complete_at`];
    const outcome = lastComplete !== null && lastComplete === observedAt ? 'complete' : 'partial';
    const recalculated = kind === 'about' ? decideAboutDue(state, observedAt, outcome, true, policy) : decideAgentDue(state, observedAt, true, channelId, policy);
    if (recalculated.due_day >= clock[`${kind}_due_day`]) continue;
    const specific = kind === 'about' && observation.kind === 'video' ? 'video_activity_recalculation' : `${kind}_cold_start_recalculation`;
    output[kind] = { ...recalculated, reason_codes: unique([...recalculated.reason_codes, specific, 'cross_domain_cold_start_recalculation']) };
  }
  return output;
}

function update(observation: Observation, state: ChannelFeatureState, decided: ClockDecision, clock: ChannelClockState, recalculated: Partial<Record<'about' | 'agent', ClockDecision>>, policy: ClockPolicy): [ChannelClockState, DecisionRecord[]] {
  const next = { ...clock }, kind = observation.kind;
  const decisions = [record(kind, 'post_run', decided)];
  next[`${kind}_due_day`] = decided.due_day;
  next[`${kind}_tier`] = decided.tier_days;
  if (kind === 'about' && (state.video_count_delta ?? 0) > 0 && recentPublishActive(state, observation.observed_at)) {
    const hintDays = policy.discovery_config.automatic_min_interval_days, hinted = addDays(utcDay(observation.observed_at), hintDays);
    if (hinted < next.video_due_day) {
      next.video_due_day = hinted; next.video_tier = hintDays;
      decisions.push({ kind: 'video', mode: 'post_run', tier: hintDays, due_day: hinted, reason_codes: HINT_REASONS });
    }
  }
  for (const other of ['about', 'agent'] as const) {
    const decision = recalculated[other];
    if (decision === undefined) continue;
    next[`${other}_due_day`] = decision.due_day;
    next[`${other}_tier`] = decision.tier_days;
    decisions.push(record(other, 'post_run', decision));
  }
  if (observation.outcome === 'complete') next[`${kind}_last_complete_at`] = observation.observed_at;
  if (kind === 'video') next.video_last_outcome = observation.outcome;
  return [next, decisions];
}

/** The earliest of the three clocks (channel_next_run_day). */
export function nextRunDay(clock: ChannelClockState): Day {
  return [clock.about_due_day, clock.video_due_day, clock.agent_due_day].sort()[0]!;
}

const CLOCK_INSTANTS = ['about_last_complete_at', 'video_last_complete_at', 'agent_last_complete_at'] as const;

/** JSON form of a clock row: instants as ISO text. */
export function serializeClock(clock: ChannelClockState): Record<string, unknown> {
  const output: Record<string, unknown> = { ...clock };
  for (const field of CLOCK_INSTANTS) output[field] = clock[field] === null ? null : formatInstant(clock[field]);
  return output;
}

export function deserializeClock(json: Record<string, unknown>): ChannelClockState {
  const clock = { ...json } as Record<string, unknown>;
  for (const field of CLOCK_INSTANTS) clock[field] = typeof json[field] === 'string' ? parseInstant(json[field] as string) : null;
  return clock as unknown as ChannelClockState;
}
