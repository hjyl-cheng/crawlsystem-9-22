import source from './clock_policy_v16_rule_7.json' with { type: 'json' };

/**
 * The legacy active clock policy, v16-rule-7, copied verbatim from crawlSystem
 * services/feature-engine (commit e92d9227). The port carries the code paths this policy enables:
 * cadence and dynamic baselines are on, so the older cold-start floor and random bootstrap tiers
 * are not reproduced, and loading a policy with them off is refused.
 */
export interface ClockPolicy {
  policy_version: string;
  allowed_days: number[];
  about_config: {
    velocity_ewma_alpha: number; baseline_interval_days: number; neutral_growth_percentile: number;
    video_delta_full_scale: number; cold_start_max_publish_age_days: number;
    cold_start_tier_one_max_publish_interval_days: number; cold_start_min_reliable_intervals: number;
    cold_start_min_feature_confidence: number; dynamic_baseline_enabled: boolean; cadence_baseline_enabled: boolean;
  };
  discovery_config: { fallback_interval_days: number; interval_ewma_alpha: number; regularity_threshold: number; silence_decay: number; automatic_min_interval_days: number };
  recent_sampling_config: { fallback_interval_days: number; change_ewma_alpha: number };
  agent_config: { baseline_interval_days: number; dynamic_baseline_enabled: boolean };
  partial_retry_config: { about_days: number; discovery_days: number; recent_sampling_days: number; agent_days: number };
}

export function loadPolicy(policy: ClockPolicy): ClockPolicy {
  const { about_config: about, agent_config: agent } = policy;
  if (!about.cadence_baseline_enabled || !about.dynamic_baseline_enabled || !agent.dynamic_baseline_enabled) {
    throw new Error(`policy ${policy.policy_version} needs cadence and dynamic baselines, the only paths this port carries`);
  }
  return policy;
}

export const ACTIVE_POLICY: ClockPolicy = loadPolicy(source.policy);

/** Video tiers are the policy's allowed days that are also Video tiers. */
export const VIDEO_TIER_DAYS = [1, 3, 7, 14, 30, 60, 90] as const;
export function discoveryDays(policy: ClockPolicy): number[] {
  const days = policy.allowed_days.filter(day => (VIDEO_TIER_DAYS as readonly number[]).includes(day));
  return days.length > 0 ? days : [...VIDEO_TIER_DAYS];
}
