import { daysBetween, type Day, type Instant } from './time.ts';
import { isClose } from './py.ts';

/** Port of feature_engine/shared_features.py: cohort percentiles, activity and collection priority. */

export const REFERENCE_METHOD_VERSION = 'v16-empirical-1';
export const DEFAULT_MINIMUM_COHORT_SIZE = 20;
export const QUANTILE_PROBABILITIES: readonly number[] = Array.from({ length: 101 }, (_, index) => index / 100.0);
/** Features ranked daily across channels, and the state field each one reads. */
export const REFERENCE_FEATURES = {
  subscriber_count: 'last_subscriber_count',
  subscriber_velocity_ewma: 'subscriber_velocity_ewma',
  view_velocity_ewma: 'view_velocity_ewma',
} as const;
export type ReferenceFeature = keyof typeof REFERENCE_FEATURES;

export function subscriberScaleCohort(subscriberCount: number | null): string {
  if (subscriberCount === null) return 'subs:unknown';
  if (subscriberCount < 0) throw new Error('subscriber_count cannot be negative');
  if (subscriberCount < 1_000) return 'subs:0-1k';
  if (subscriberCount < 10_000) return 'subs:1k-10k';
  if (subscriberCount < 100_000) return 'subs:10k-100k';
  if (subscriberCount < 1_000_000) return 'subs:100k-1m';
  if (subscriberCount < 10_000_000) return 'subs:1m-10m';
  if (subscriberCount < 100_000_000) return 'subs:10m-100m';
  return 'subs:100m+';
}

export interface QuantileDistribution {
  as_of_day: Day;
  cohort_key: string;
  feature_name: string;
  sample_count: number;
  probabilities: number[];
  values: number[];
  method_version?: string;
}

function bisectLeft(values: readonly number[], target: number): number {
  let low = 0, high = values.length;
  while (low < high) { const middle = (low + high) >> 1; if (values[middle]! < target) low = middle + 1; else high = middle; }
  return low;
}
function bisectRight(values: readonly number[], target: number): number {
  let low = 0, high = values.length;
  while (low < high) { const middle = (low + high) >> 1; if (target < values[middle]!) high = middle; else low = middle + 1; }
  return low;
}

/** Where `value` falls in a distribution, interpolating between quantiles; ties take the middle. */
export function distributionPercentile(distribution: QuantileDistribution, value: number): number {
  const { probabilities: p, values } = distribution;
  if (!Number.isFinite(value)) throw new Error('percentile input must be finite');
  const left = bisectLeft(values, value), right = bisectRight(values, value);
  if (left !== right) return (p[left]! + p[right - 1]!) / 2.0;
  if (left === 0) return p[0]!;
  if (left === values.length) return p[p.length - 1]!;
  const lower = values[left - 1]!, upper = values[left]!;
  if (isClose(lower, upper)) return (p[left - 1]! + p[left]!) / 2.0;
  const fraction = (value - lower) / (upper - lower);
  return p[left - 1]! + fraction * (p[left]! - p[left - 1]!);
}

/** One day's reference distributions. A small cohort falls back to the all-channel distribution. */
export class ReferenceCatalog {
  readonly #byKey = new Map<string, QuantileDistribution>();
  constructor(readonly distributions: readonly QuantileDistribution[] = [], readonly minimumCohortSize = DEFAULT_MINIMUM_COHORT_SIZE) {
    for (const item of distributions) {
      const key = `${item.feature_name}\u0000${item.cohort_key}`;
      if (this.#byKey.has(key)) throw new Error('reference catalog contains duplicate feature/cohort rows');
      if (item.probabilities.length === 0 || item.probabilities.length !== item.values.length) throw new Error('reference probabilities and values must have equal non-zero lengths');
      this.#byKey.set(key, item);
    }
    if (new Set(distributions.map(item => `${item.as_of_day}:${item.method_version ?? REFERENCE_METHOD_VERSION}`)).size > 1) {
      throw new Error('reference catalog must contain one day and method version');
    }
  }

  get version(): string | null {
    const item = this.distributions[0];
    return item ? `${item.as_of_day}:${item.method_version ?? REFERENCE_METHOD_VERSION}` : null;
  }

  percentile(featureName: string, cohortKey: string, value: number | null): number | null {
    if (value === null) return null;
    let selected = this.#byKey.get(`${featureName}\u0000${cohortKey}`);
    if (selected === undefined || selected.sample_count < this.minimumCohortSize) selected = this.#byKey.get(`${featureName}\u0000all`);
    if (selected === undefined || selected.sample_count === 0) return null;
    return Math.min(1.0, Math.max(0.0, distributionPercentile(selected, value)));
  }
}

/** Operator and user demand, each in [0, 1]. */
export interface CollectionPrioritySignals { user_query_demand: number; manual_priority: number }
export const NO_SIGNALS: CollectionPrioritySignals = { user_query_demand: 0.0, manual_priority: 0.0 };

export interface SharedFeatureInputs {
  subscriber_count: number | null;
  subscriber_velocity_ewma: number | null;
  view_velocity_ewma: number | null;
  recent30_video_count: number | null;
  last_publish_at: Instant | null;
  about_identity_observed: boolean;
  about_observed: boolean;
  discovery_observed: boolean;
  recent_sampling_observed: boolean;
  agent_observed: boolean;
}

export interface SharedFeatureResult {
  subscriber_size_percentile: number | null;
  subscriber_growth_percentile: number | null;
  view_growth_percentile: number | null;
  growth_momentum: number | null;
  user_query_demand: number;
  data_incompleteness: number;
  manual_priority: number;
  channel_activity: number;
  collection_priority: number;
  reference_distribution_version: string | null;
}

export function publishFrequencyScore(recentCount: number | null): number {
  const count = recentCount ?? 0;
  if (count <= 0) return 0.0;
  if (count === 1) return 0.15;
  if (count <= 4) return 0.35;
  if (count <= 9) return 0.60;
  if (count <= 19) return 0.80;
  return 1.0;
}

export function publishRecencyScore(lastPublishAt: Instant | null, observedAt: Instant): number {
  if (lastPublishAt === null) return 0.05;
  const age = Math.max(0.0, daysBetween(lastPublishAt, observedAt));
  if (age <= 1) return 1.0;
  if (age <= 3) return 0.85;
  if (age <= 7) return 0.65;
  if (age <= 14) return 0.40;
  if (age <= 30) return 0.20;
  return 0.05;
}

export function deriveRecentChangeProbability(view: number | null, engagement: number | null, upload: number | null, activity: number | null): number | null {
  if (view === null && engagement === null && upload === null) return null;
  const probability = (0.45 * (view ?? 0.0)) + (0.25 * (engagement ?? 0.0)) + (0.20 * (upload ?? 0.0)) + (0.10 * (activity ?? 0.0));
  return Math.min(1.0, Math.max(0.0, probability));
}

export function deriveSharedFeatures(inputs: SharedFeatureInputs, references: ReferenceCatalog, signals: CollectionPrioritySignals, observedAt: Instant): SharedFeatureResult {
  const cohort = subscriberScaleCohort(inputs.subscriber_count);
  const size = references.percentile('subscriber_count', 'all', inputs.subscriber_count);
  const subscriberGrowth = references.percentile('subscriber_velocity_ewma', cohort, inputs.subscriber_velocity_ewma);
  const viewGrowth = references.percentile('view_velocity_ewma', cohort, inputs.view_velocity_ewma);
  const momentum = subscriberGrowth !== null && viewGrowth !== null ? (subscriberGrowth + viewGrowth) / 2.0 : null;
  const activity = (0.40 * publishFrequencyScore(inputs.recent30_video_count))
    + (0.25 * publishRecencyScore(inputs.last_publish_at, observedAt))
    + (0.35 * (momentum ?? 0.5));
  const observed = [inputs.about_identity_observed, inputs.about_observed, inputs.discovery_observed, inputs.recent_sampling_observed, inputs.agent_observed];
  const incompleteness = 1.0 - (observed.filter(Boolean).length / observed.length);
  const priority = (0.30 * (size ?? 0.5)) + (0.25 * activity) + (0.20 * signals.user_query_demand)
    + (0.15 * incompleteness) + (0.10 * signals.manual_priority);
  return {
    subscriber_size_percentile: size,
    subscriber_growth_percentile: subscriberGrowth,
    view_growth_percentile: viewGrowth,
    growth_momentum: momentum,
    user_query_demand: signals.user_query_demand,
    data_incompleteness: incompleteness,
    manual_priority: signals.manual_priority,
    channel_activity: Math.min(1.0, Math.max(0.0, activity)),
    collection_priority: Math.min(1.0, Math.max(0.0, priority)),
    reference_distribution_version: references.version,
  };
}

/**
 * percentile_cont at the 101 reference probabilities, as the legacy daily reference job computed
 * them in SQL: linear interpolation between the closest ranks of the sorted values.
 */
export function quantiles(values: readonly number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  return QUANTILE_PROBABILITIES.map(p => {
    const rank = p * (sorted.length - 1), lower = Math.floor(rank), upper = Math.ceil(rank);
    return sorted[lower]! + (rank - lower) * (sorted[upper]! - sorted[lower]!);
  });
}
