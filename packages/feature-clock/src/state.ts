import { createHash } from 'node:crypto';
import { daysBetween, formatInstant, parseInstant, type Instant } from './time.ts';
import { casefold, compareCodePoints, isClose, median, pstdev, sum, unique } from './py.ts';
import { deriveRecentChangeProbability, publishFrequencyScore, publishRecencyScore } from './shared-features.ts';

/** Port of feature_engine/state.py: a channel's features and how each observation updates them. */

export interface ChannelFeatureState {
  last_subscriber_count: number | null;
  last_subscriber_observed_at: Instant | null;
  last_total_view_count: number | null;
  last_total_view_observed_at: Instant | null;
  last_total_video_count: number | null;
  last_total_video_observed_at: Instant | null;
  last_about_observed_at: Instant | null;
  about_metric_confidence: number | null;
  subscriber_velocity_ewma: number | null;
  view_velocity_ewma: number | null;
  video_count_delta: number | null;
  subscriber_size_percentile: number | null;
  subscriber_growth_percentile: number | null;
  view_growth_percentile: number | null;
  growth_momentum: number | null;
  about_stable_since: Instant | null;
  about_stable_runs: number;

  recent_publish_interval_days: number[];
  publish_interval_ewma: number | null;
  publish_interval_median: number | null;
  publish_interval_mad: number | null;
  publish_regularity: number | null;
  last_publish_at: Instant | null;
  recent30_video_count: number | null;
  new_video_empty_runs: number;
  last_discovery_observed_at: Instant | null;
  last_complete_discovery_at: Instant | null;

  recent_stale_ratio: number | null;
  recent_view_change_ewma: number | null;
  recent_engagement_change_ewma: number | null;
  recent_upload_change_ewma: number | null;
  recent_change_probability: number | null;
  recent_sampling_stable_runs: number;
  last_recent_sampling_at: Instant | null;
  last_recent_sample_count: number | null;

  current_topic_vector: number[];
  current_topic_tokens: string[];
  current_agent_output_hash: string | null;
  current_agent_evidence_fingerprints: string[];
  current_agent_version_hash: string | null;
  last_agent_evidence_count: number | null;
  topic_drift: number | null;
  evidence_replacement: number | null;
  recent_content_shift: number | null;
  agent_version_changed: boolean;
  agent_output_changed: boolean;
  agent_change_score: number | null;
  agent_topic_vector_source: string | null;
  agent_confidence: number | null;
  agent_stable_runs: number;
  last_agent_observed_at: Instant | null;

  user_query_demand: number;
  data_incompleteness: number;
  manual_priority: number;
  collection_priority: number;
  channel_activity: number | null;
  feature_confidence: number;
  fallback_reason_codes: string[];
  reference_distribution_version: string | null;
  state_version: number;
}

export const INITIAL_STATE: Readonly<ChannelFeatureState> = Object.freeze({
  last_subscriber_count: null, last_subscriber_observed_at: null, last_total_view_count: null, last_total_view_observed_at: null,
  last_total_video_count: null, last_total_video_observed_at: null, last_about_observed_at: null, about_metric_confidence: null,
  subscriber_velocity_ewma: null, view_velocity_ewma: null, video_count_delta: null, subscriber_size_percentile: null,
  subscriber_growth_percentile: null, view_growth_percentile: null, growth_momentum: null, about_stable_since: null, about_stable_runs: 0,
  recent_publish_interval_days: [], publish_interval_ewma: null, publish_interval_median: null, publish_interval_mad: null,
  publish_regularity: null, last_publish_at: null, recent30_video_count: null, new_video_empty_runs: 0,
  last_discovery_observed_at: null, last_complete_discovery_at: null,
  recent_stale_ratio: null, recent_view_change_ewma: null, recent_engagement_change_ewma: null, recent_upload_change_ewma: null,
  recent_change_probability: null, recent_sampling_stable_runs: 0, last_recent_sampling_at: null, last_recent_sample_count: null,
  current_topic_vector: [], current_topic_tokens: [], current_agent_output_hash: null, current_agent_evidence_fingerprints: [],
  current_agent_version_hash: null, last_agent_evidence_count: null, topic_drift: null, evidence_replacement: null,
  recent_content_shift: null, agent_version_changed: false, agent_output_changed: false, agent_change_score: null,
  agent_topic_vector_source: null, agent_confidence: null, agent_stable_runs: 0, last_agent_observed_at: null,
  user_query_demand: 0.0, data_incompleteness: 1.0, manual_priority: 0.0, collection_priority: 0.346875, channel_activity: null,
  feature_confidence: 0.0, fallback_reason_codes: [], reference_distribution_version: null, state_version: 0,
});

/** Fields holding instants; everything else is a number, string, boolean or array as typed. */
export const INSTANT_FIELDS = [
  'last_subscriber_observed_at', 'last_total_view_observed_at', 'last_total_video_observed_at', 'last_about_observed_at',
  'about_stable_since', 'last_publish_at', 'last_discovery_observed_at', 'last_complete_discovery_at', 'last_recent_sampling_at',
  'last_agent_observed_at',
] as const satisfies readonly (keyof ChannelFeatureState)[];

// ---- observations ------------------------------------------------------------------------

export type Outcome = 'complete' | 'partial' | 'failed';
export const METRIC_STATUSES = ['exact', 'estimated', 'unavailable', 'unresolved'] as const;
export type MetricStatus = typeof METRIC_STATUSES[number];
const resolved = (status: MetricStatus) => status === 'exact' || status === 'estimated';

/** About facts; a value is present exactly when its status is exact or estimated. */
export interface AboutFacts {
  subscriber_count: number | null; subscriber_count_status: MetricStatus;
  total_view_count: number | null; total_view_count_status: MetricStatus;
  total_video_count: number | null; total_video_count_status: MetricStatus;
}

/** Discovery facts: the newly seen videos and how many of their details were read. */
export interface DiscoveryFacts {
  first_seen: { published_at: Instant | null }[];
  first_seen_count: number;
  detail_success_count: number;
  stop_reason: string;
}

/** Recent Sampling facts: the re-read of the channel's recent videos. */
export interface RecentSamplingFacts {
  recent_count: number; stale_ratio: number; selected_count: number; success_count: number;
  comparable_view_count: number; view_changed_count: number; engagement_changed_count: number;
}

export interface VideoFacts {
  discovery_outcome: 'complete' | 'partial';
  discovery: DiscoveryFacts;
  recent_sampling_outcome: 'complete' | 'partial' | 'failed' | 'skipped';
  /** null when skipped. */
  recent_sampling: RecentSamplingFacts | null;
}

export interface AgentFacts {
  output_hash: string;
  category_level_1: string | null;
  category_level_2: string[];
  tag_count: number;
  evidence_count: number;
  active_subscriber_ratio: number | null;
  topic_tokens: string[] | null;
  evidence_fingerprints: string[] | null;
  agent_version_hash: string | null;
}

// ---- About -------------------------------------------------------------------------------

export interface AboutTransition { state: ChannelFeatureState; baseline: boolean; business_state_changed: boolean }

const ewma = (previous: number | null, current: number, alpha: number) => previous === null ? current : (alpha * current) + ((1.0 - alpha) * previous);

/** [value, observedAt, velocity, applied, changed] */
type MetricUpdate = [number | null, Instant | null, number | null, boolean, boolean];
function metricUpdate(previousValue: number | null, previousAt: Instant | null, value: number | null, status: MetricStatus, observedAt: Instant): MetricUpdate {
  if (!resolved(status) || value === null) return [previousValue, previousAt, null, false, false];
  if (previousAt !== null && observedAt <= previousAt) return [previousValue, previousAt, null, false, false];
  if (previousValue === null || previousAt === null) return [value, observedAt, null, true, false];
  const elapsed = daysBetween(previousAt, observedAt);
  if (elapsed <= 0) return [previousValue, previousAt, null, false, false];
  return [value, observedAt, (value - previousValue) / elapsed, true, value !== previousValue];
}

function withActivity(state: ChannelFeatureState, observedAt: Instant): ChannelFeatureState {
  const activity = (0.40 * publishFrequencyScore(state.recent30_video_count))
    + (0.25 * publishRecencyScore(state.last_publish_at, observedAt))
    + (0.35 * (state.growth_momentum ?? 0.5));
  return { ...state, channel_activity: Math.min(1.0, Math.max(0.0, activity)) };
}

export function applyAboutEvent(state: ChannelFeatureState, observedAt: Instant, outcome: Outcome, facts: AboutFacts | null, velocityAlpha: number): AboutTransition {
  const baseline = state.last_about_observed_at === null;
  if (outcome === 'failed' || facts === null) return { state, baseline, business_state_changed: false };
  const subscriber = metricUpdate(state.last_subscriber_count, state.last_subscriber_observed_at, facts.subscriber_count, facts.subscriber_count_status, observedAt);
  const views = metricUpdate(state.last_total_view_count, state.last_total_view_observed_at, facts.total_view_count, facts.total_view_count_status, observedAt);
  const videos = metricUpdate(state.last_total_video_count, state.last_total_video_observed_at, facts.total_video_count, facts.total_video_count_status, observedAt);
  const metrics = [subscriber, views, videos];
  const compared = metrics.filter(metric => metric[2] !== null);
  if (!metrics.some(metric => metric[3])) return { state, baseline, business_state_changed: false };

  let stableRuns = state.about_stable_runs, stableSince = state.about_stable_since;
  if (compared.length > 0) {
    if (compared.some(metric => metric[4])) { stableRuns = 0; stableSince = observedAt; }
    else { stableRuns += 1; stableSince = stableSince ?? observedAt; }
  } else if (baseline) stableSince = observedAt;

  const reasons: string[] = [];
  if (baseline) reasons.push('about_baseline');
  if (outcome === 'partial') reasons.push('about_partial');
  if (state.subscriber_growth_percentile === null || state.view_growth_percentile === null) reasons.push('growth_reference_unavailable');
  const statuses = [facts.subscriber_count_status, facts.total_view_count_status, facts.total_video_count_status];
  const exact = statuses.filter(status => status === 'exact').length, estimated = statuses.filter(status => status === 'estimated').length;
  const confidence = Math.min(1.0, (exact + (0.75 * estimated)) / 3.0);
  const momentum = state.subscriber_growth_percentile !== null && state.view_growth_percentile !== null
    ? (state.subscriber_growth_percentile + state.view_growth_percentile) / 2.0 : null;
  const next: ChannelFeatureState = {
    ...state,
    last_subscriber_count: subscriber[0], last_subscriber_observed_at: subscriber[1],
    last_total_view_count: views[0], last_total_view_observed_at: views[1],
    last_total_video_count: videos[0], last_total_video_observed_at: videos[1],
    last_about_observed_at: state.last_about_observed_at === null || observedAt > state.last_about_observed_at ? observedAt : state.last_about_observed_at,
    about_metric_confidence: confidence,
    subscriber_velocity_ewma: subscriber[2] !== null ? ewma(state.subscriber_velocity_ewma, subscriber[2], velocityAlpha) : state.subscriber_velocity_ewma,
    view_velocity_ewma: views[2] !== null ? ewma(state.view_velocity_ewma, views[2], velocityAlpha) : state.view_velocity_ewma,
    video_count_delta: videos[2] !== null && state.last_total_video_count !== null ? videos[0]! - state.last_total_video_count : null,
    growth_momentum: momentum,
    about_stable_since: stableSince,
    about_stable_runs: stableRuns,
    feature_confidence: confidence,
    fallback_reason_codes: reasons,
    state_version: state.state_version + 1,
  };
  return { state: withActivity(next, observedAt), baseline, business_state_changed: true };
}

/** With cadence baselines, About is "stable" only while growth stays in the bottom 35% and no video arrives. */
export function applyAboutStabilityEvidence(previous: ChannelFeatureState, current: ChannelFeatureState, observedAt: Instant, outcome: Outcome, baseline: boolean, lowGrowthPercentile = 0.35): ChannelFeatureState {
  if (baseline) return { ...current, about_stable_since: observedAt, about_stable_runs: 0 };
  const keep = { ...current, about_stable_since: previous.about_stable_since, about_stable_runs: previous.about_stable_runs };
  if (outcome !== 'complete') return keep;
  const growth = [current.subscriber_growth_percentile, current.view_growth_percentile];
  if (growth.some(value => value === null)) return keep;
  const lowChange = Math.max(...(growth as number[])) < lowGrowthPercentile && (current.video_count_delta ?? 0) <= 0;
  if (!lowChange) return { ...current, about_stable_since: observedAt, about_stable_runs: 0 };
  return { ...current, about_stable_since: previous.about_stable_since ?? observedAt, about_stable_runs: previous.about_stable_runs + 1 };
}

// ---- Video -------------------------------------------------------------------------------

export interface VideoTransition {
  state: ChannelFeatureState;
  discovery_baseline: boolean;
  recent_sampling_baseline: boolean;
  business_state_changed: boolean;
  discovery_outcome: VideoFacts['discovery_outcome'];
  recent_sampling_outcome: VideoFacts['recent_sampling_outcome'];
}

function publishTimes(discovery: DiscoveryFacts, after: Instant | null = null): Instant[] {
  const times = new Set<Instant>();
  for (const item of discovery.first_seen) {
    if (item.published_at !== null && (after === null || item.published_at > after)) times.add(item.published_at);
  }
  return [...times].sort((a, b) => a - b);
}

/** Robust median, MAD and regularity (exp(−2.5·CV) over intervals within 3.5 robust deviations). */
export function intervalStatistics(intervals: readonly number[]): [number | null, number | null, number | null] {
  if (intervals.length === 0) return [null, null, null];
  const center = median(intervals);
  const mad = median(intervals.map(value => Math.abs(value - center)));
  let robust = mad === 0
    ? intervals.filter(value => isClose(value, center, { absTol: 1e-9 }))
    : intervals.filter(value => Math.abs(value - center) <= 3.5 * 1.4826 * mad);
  if (robust.length === 0) robust = [...intervals];
  const robustMedian = median(robust);
  const robustMean = sum(robust) / robust.length;
  const cv = robust.length > 1 && robustMean > 0 ? pstdev(robust) / robustMean : 0.0;
  return [robustMedian, mad, Math.min(1.0, Math.max(0.0, Math.exp(-2.5 * cv)))];
}

interface PhaseTransition { state: ChannelFeatureState; baseline: boolean; changed: boolean }

function applyDiscoveryPhase(state: ChannelFeatureState, observedAt: Instant, outcome: 'complete' | 'partial', discovery: DiscoveryFacts, intervalAlpha: number): PhaseTransition {
  const baseline = state.last_discovery_observed_at === null;
  if (state.last_discovery_observed_at !== null && observedAt <= state.last_discovery_observed_at) return { state, baseline, changed: false };
  const allPublished = publishTimes(discovery);
  const published = publishTimes(discovery, state.last_complete_discovery_at);
  const points = [...new Set(state.last_publish_at !== null ? [...published, state.last_publish_at] : published)].sort((a, b) => a - b);
  const newIntervals: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    if (points[index]! > points[index - 1]!) newIntervals.push(daysBetween(points[index - 1]!, points[index]!));
  }
  const history = [...state.recent_publish_interval_days, ...newIntervals].slice(-32);
  let intervalEwma = state.publish_interval_ewma;
  for (const value of newIntervals) intervalEwma = ewma(intervalEwma, value, intervalAlpha);
  const [robustMedian, mad, regularity] = intervalStatistics(history);
  const candidates = state.last_publish_at !== null ? [state.last_publish_at, ...published] : published;
  const latestPublish = candidates.length > 0 ? Math.max(...candidates) : null;
  let emptyRuns = state.new_video_empty_runs;
  if (outcome === 'complete') emptyRuns = published.length > 0 ? 0 : emptyRuns + 1;
  const coverage = discovery.first_seen_count > 0 ? discovery.detail_success_count / discovery.first_seen_count : 1.0;
  const confidence = (outcome === 'complete' ? 0.75 : 0.45) + (0.25 * coverage);
  const reasons: string[] = [];
  if (baseline) reasons.push('discovery_baseline');
  if (outcome === 'partial') reasons.push('discovery_partial');
  if (discovery.stop_reason === 'gap_abandoned_latest_30') reasons.push('discovery_gap_abandoned_latest_30');
  if (history.length === 0) reasons.push('publish_interval_unavailable');
  if (allPublished.length > published.length) reasons.push('backfill_first_seen_ignored');
  const next: ChannelFeatureState = {
    ...state,
    recent_publish_interval_days: history,
    publish_interval_ewma: intervalEwma,
    publish_interval_median: robustMedian,
    publish_interval_mad: mad,
    publish_regularity: regularity,
    last_publish_at: latestPublish,
    new_video_empty_runs: emptyRuns,
    last_discovery_observed_at: observedAt,
    last_complete_discovery_at: outcome === 'complete' ? observedAt : state.last_complete_discovery_at,
    feature_confidence: Math.min(1.0, confidence),
    fallback_reason_codes: reasons,
    state_version: state.state_version + 1,
  };
  return { state: withActivity(next, observedAt), baseline, changed: true };
}

function applyRecentSamplingPhase(state: ChannelFeatureState, observedAt: Instant, outcome: 'complete' | 'partial' | 'failed', sampling: RecentSamplingFacts, changeAlpha: number): PhaseTransition {
  const baseline = state.last_recent_sampling_at === null;
  if (outcome === 'failed' || (state.last_recent_sampling_at !== null && observedAt <= state.last_recent_sampling_at)) return { state, baseline, changed: false };
  const viewScore = sampling.comparable_view_count > 0 ? sampling.view_changed_count / sampling.comparable_view_count : null;
  const engagementScore = sampling.success_count > 0 ? sampling.engagement_changed_count / sampling.success_count : 0.0;
  let uploadScore = 0.0;
  if (state.recent30_video_count !== null) {
    uploadScore = Math.min(1.0, Math.abs(sampling.recent_count - state.recent30_video_count) / Math.max(state.recent30_video_count, 1));
  }
  const viewEwma = viewScore !== null ? ewma(state.recent_view_change_ewma, viewScore, changeAlpha) : state.recent_view_change_ewma;
  const engagementEwma = ewma(state.recent_engagement_change_ewma, engagementScore, changeAlpha);
  const uploadEwma = ewma(state.recent_upload_change_ewma, uploadScore, changeAlpha);
  const changed = (viewScore ?? 0.0) > 0 || engagementScore > 0 || uploadScore > 0;
  let stableRuns = state.recent_sampling_stable_runs;
  if (baseline || changed) stableRuns = 0;
  else if (viewScore !== null || state.recent30_video_count !== null) stableRuns += 1;
  const reasons: string[] = [];
  if (baseline) reasons.push('recent_sampling_baseline');
  if (outcome === 'partial') reasons.push('recent_sampling_partial');
  if (sampling.comparable_view_count === 0) reasons.push('comparable_views_unavailable');
  const next = withActivity({
    ...state,
    recent30_video_count: sampling.recent_count,
    recent_stale_ratio: sampling.stale_ratio,
    recent_view_change_ewma: viewEwma,
    recent_engagement_change_ewma: engagementEwma,
    recent_upload_change_ewma: uploadEwma,
    recent_sampling_stable_runs: stableRuns,
    last_recent_sampling_at: observedAt,
    last_recent_sample_count: sampling.success_count,
    feature_confidence: sampling.selected_count > 0 ? sampling.success_count / sampling.selected_count : 1.0,
    fallback_reason_codes: reasons,
    state_version: state.state_version + 1,
  }, observedAt);
  return { state: { ...next, recent_change_probability: deriveRecentChangeProbability(viewEwma, engagementEwma, uploadEwma, next.channel_activity) }, baseline, changed: true };
}

export function applyVideoEvent(state: ChannelFeatureState, observedAt: Instant, facts: VideoFacts, intervalAlpha: number, changeAlpha: number): VideoTransition {
  const discovery = applyDiscoveryPhase(state, observedAt, facts.discovery_outcome, facts.discovery, intervalAlpha);
  const sampling = facts.recent_sampling_outcome === 'skipped'
    ? { state: discovery.state, baseline: discovery.state.last_recent_sampling_at === null, changed: false }
    : applyRecentSamplingPhase(discovery.state, observedAt, facts.recent_sampling_outcome, required(facts.recent_sampling), changeAlpha);
  const reasons = [...discovery.state.fallback_reason_codes, ...sampling.state.fallback_reason_codes];
  if (facts.recent_sampling_outcome === 'failed') reasons.push('recent_sampling_failed');
  else if (facts.recent_sampling_outcome === 'skipped') reasons.push('recent_sampling_skipped');
  return {
    state: {
      ...sampling.state,
      feature_confidence: Math.min(discovery.state.feature_confidence, sampling.state.feature_confidence),
      fallback_reason_codes: unique(reasons),
      state_version: state.state_version + 1,
    },
    discovery_baseline: discovery.baseline,
    recent_sampling_baseline: sampling.baseline,
    business_state_changed: discovery.changed || sampling.changed,
    discovery_outcome: facts.discovery_outcome,
    recent_sampling_outcome: facts.recent_sampling_outcome,
  };
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error('Recent Sampling facts are required unless the phase was skipped');
  return value;
}

// ---- Agent -------------------------------------------------------------------------------

export interface AgentTransition { state: ChannelFeatureState; baseline: boolean; business_state_changed: boolean; output_changed: boolean; evidence_count: number }

function agentTopicTokens(facts: AgentFacts): [string[], string] {
  if (facts.topic_tokens !== null && facts.topic_tokens.length > 0) return [facts.topic_tokens, 'crawler_topic_tokens'];
  const tokens: string[] = [];
  if (facts.category_level_1) tokens.push(`l1:${casefold(facts.category_level_1)}`);
  tokens.push(...facts.category_level_2.map(item => `l2:${casefold(item)}`));
  return [[...new Set(tokens)].sort(compareCodePoints), 'category_vector_fallback'];
}

/** Topic tokens hashed into 64 buckets (first 8 bytes of SHA-256, big-endian), L2-normalised. */
export function topicVector(tokens: readonly string[], dimensions = 64): number[] {
  if (tokens.length === 0) return [];
  const values = new Array<number>(dimensions).fill(0.0);
  for (const token of tokens) {
    const index = Number(createHash('sha256').update(token, 'utf8').digest().readBigUInt64BE(0) % BigInt(dimensions));
    values[index]! += 1.0;
  }
  const norm = Math.sqrt(sum(values.map(value => value * value)));
  return values.map(value => value / norm);
}

function cosineDistance(previous: readonly number[], current: readonly number[]): number | null {
  if (previous.length === 0 || current.length === 0 || previous.length !== current.length) return null;
  return Math.min(1.0, Math.max(0.0, 1.0 - sum(previous.map((left, index) => left * current[index]!))));
}

function setChange(previous: readonly string[], current: readonly string[]): number | null {
  if (previous.length === 0) return null;
  const before = new Set(previous), added = new Set(current.filter(item => !before.has(item)));
  return Math.min(1.0, added.size / Math.max(before.size, 1));
}

function jaccardDistance(previous: readonly string[], current: readonly string[]): number | null {
  if (previous.length === 0 || current.length === 0) return null;
  const before = new Set(previous), after = new Set(current);
  const shared = [...after].filter(item => before.has(item)).length;
  return 1.0 - (shared / new Set([...before, ...after]).size);
}

export function applyAgentEvent(state: ChannelFeatureState, observedAt: Instant, outcome: Outcome, facts: AgentFacts | null): AgentTransition {
  const baseline = state.last_agent_observed_at === null;
  if (outcome === 'failed' || facts === null || (state.last_agent_observed_at !== null && observedAt <= state.last_agent_observed_at)) {
    return { state, baseline, business_state_changed: false, output_changed: false, evidence_count: 0 };
  }
  const [tokens, source] = agentTopicTokens(facts);
  let vectorSource = source;
  const vector = topicVector(tokens);
  const outputChanged = state.current_agent_output_hash !== null && state.current_agent_output_hash !== facts.output_hash;
  const topicDrift = cosineDistance(state.current_topic_vector, vector);
  let evidenceReplacement = setChange(state.current_agent_evidence_fingerprints, facts.evidence_fingerprints ?? []);
  if (evidenceReplacement === null && state.last_agent_evidence_count !== null) {
    // Legacy version-1 events did not carry evidence identities.
    evidenceReplacement = Math.min(1.0, Math.abs(facts.evidence_count - state.last_agent_evidence_count) / Math.max(state.last_agent_evidence_count, 1));
    vectorSource = `${vectorSource}+legacy_evidence_count_fallback`;
  }
  const contentShift = jaccardDistance(state.current_topic_tokens, tokens);
  const versionChanged = state.current_agent_version_hash !== null && facts.agent_version_hash !== null && state.current_agent_version_hash !== facts.agent_version_hash;
  const changeScore = (0.45 * (topicDrift ?? 0.0)) + (0.30 * (evidenceReplacement ?? 0.0)) + (0.15 * (contentShift ?? 0.0)) + (versionChanged ? 0.10 : 0.0);
  const confidence = (facts.category_level_1 ? 0.25 : 0.0) + (facts.category_level_2.length > 0 ? 0.25 : 0.0)
    + (0.20 * Math.min(1.0, facts.tag_count / 10.0)) + (0.20 * Math.min(1.0, facts.evidence_count / 20.0))
    + (facts.active_subscriber_ratio !== null ? 0.10 : 0.0);
  const reasons: string[] = [];
  if (baseline) reasons.push('agent_baseline');
  if (vector.length === 0) reasons.push('agent_topic_vector_unavailable');
  if (evidenceReplacement === null) reasons.push('agent_evidence_baseline');
  const stable = baseline || outputChanged || versionChanged || changeScore > 0.0 ? 0 : state.agent_stable_runs + 1;
  return {
    state: {
      ...state,
      current_topic_vector: vector,
      current_topic_tokens: tokens,
      current_agent_output_hash: facts.output_hash,
      current_agent_evidence_fingerprints: facts.evidence_fingerprints ?? [],
      current_agent_version_hash: facts.agent_version_hash,
      last_agent_evidence_count: facts.evidence_count,
      topic_drift: topicDrift,
      evidence_replacement: evidenceReplacement,
      recent_content_shift: contentShift,
      agent_version_changed: versionChanged,
      agent_output_changed: outputChanged,
      agent_change_score: Math.min(1.0, changeScore),
      agent_topic_vector_source: vectorSource,
      agent_confidence: Math.min(1.0, confidence),
      agent_stable_runs: stable,
      last_agent_observed_at: observedAt,
      feature_confidence: Math.min(1.0, confidence),
      fallback_reason_codes: reasons,
      state_version: state.state_version + 1,
    },
    baseline,
    business_state_changed: true,
    output_changed: outputChanged,
    evidence_count: facts.evidence_count,
  };
}

// ---- storage -----------------------------------------------------------------------------

/** JSON form of a state: instants as ISO text, everything else as is. */
export function serializeState(state: ChannelFeatureState): Record<string, unknown> {
  const output: Record<string, unknown> = { ...state };
  for (const field of INSTANT_FIELDS) output[field] = state[field] === null ? null : formatInstant(state[field]);
  return output;
}

/** Inverse of serializeState; missing fields take their initial values. */
export function deserializeState(json: Record<string, unknown>): ChannelFeatureState {
  const state: Record<string, unknown> = { ...INITIAL_STATE };
  for (const field of Object.keys(INITIAL_STATE)) if (field in json) state[field] = json[field];
  for (const field of INSTANT_FIELDS) state[field] = typeof state[field] === 'string' ? parseInstant(state[field] as string) : state[field] ?? null;
  return state as unknown as ChannelFeatureState;
}
