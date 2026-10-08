import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_POLICY, addDays, agentForwardOffset, agentForwardSpreadMaxDays, applyAboutEvent, applyAgentEvent, applyVideoEvent,
  decideAboutDue, decideAgentDue, decideVideoDue, discoveryRisk, INITIAL_STATE, limitAboutSlowdown, parseInstant, samplingRisk,
  MICROS_PER_DAY, type AboutFacts, type AgentFacts, type ChannelFeatureState, type ClockPolicy,
} from '../src/index.ts';

/** Legacy unit tests (crawlSystem services/feature-engine/tests) ported for the paths policy v16-rule-7 uses. */

const OBSERVED = parseInstant('2026-07-20T00:00:00Z');
const daysBefore = (days: number) => OBSERVED - days * MICROS_PER_DAY;
const state = (fields: Partial<ChannelFeatureState> = {}): ChannelFeatureState => ({ ...INITIAL_STATE, ...fields });
const withPolicy = (change: (policy: ClockPolicy) => void): ClockPolicy => { const policy = structuredClone(ACTIVE_POLICY); change(policy); return policy; };
const about = (fields: Partial<ChannelFeatureState>, baseline = false) => decideAboutDue(state(fields), OBSERVED, 'complete', baseline, ACTIVE_POLICY);
const exact = (subscribers: number, views: number, videos: number): AboutFacts => ({
  subscriber_count: subscribers, subscriber_count_status: 'exact', total_view_count: views, total_view_count_status: 'exact', total_video_count: videos, total_video_count_status: 'exact',
});

test('About velocities are per day and smoothed; the video delta is the count difference', () => {
  const first = applyAboutEvent(INITIAL_STATE, parseInstant('2026-07-20T00:00:00Z'), 'complete', exact(1000, 10000, 20), 0.3).state;
  const second = applyAboutEvent(first, parseInstant('2026-07-22T00:00:00Z'), 'complete', exact(1200, 11000, 22), 0.3).state;
  assert.equal(second.subscriber_velocity_ewma, 100.0);
  assert.equal(second.view_velocity_ewma, 500.0);
  assert.equal(second.video_count_delta, 2);
});

test('due days are UTC calendar days, whatever the local time of the run', () => {
  assert.equal(decideAboutDue(INITIAL_STATE, parseInstant('2026-07-21T00:30:00+08:00'), 'complete', true, ACTIVE_POLICY).due_day, '2026-07-27');
  assert.equal(decideAboutDue(INITIAL_STATE, parseInstant('2026-07-20T23:50:00Z'), 'complete', true, ACTIVE_POLICY).due_day, '2026-07-27');
});

test('a first About run follows the publishing cadence: 1, 2, 3, 5 days, else 7', () => {
  for (const [interval, tier] of [[1.0, 1], [2.289383, 2], [3.0, 3], [5.0, 5], [8.0, 7]] as const) {
    const decided = about({
      last_subscriber_count: 19_000, recent30_video_count: 13, recent_publish_interval_days: [interval, interval, interval],
      publish_interval_ewma: interval, publish_interval_median: interval, last_publish_at: daysBefore(1), about_metric_confidence: 1.0,
    }, true);
    assert.equal(decided.tier_days, tier, `publishing every ${interval} days`);
  }
});

test('long About intervals need both stable time and stable runs', () => {
  for (const [days, runs, tier] of [[20, 20, 7], [21, 2, 7], [21, 3, 14], [60, 6, 30], [120, 9, 60], [180, 12, 90], [365, 15, 180]] as const) {
    const decided = about({ subscriber_growth_percentile: 0.0, view_growth_percentile: 0.0, about_stable_since: daysBefore(days), about_stable_runs: runs });
    assert.equal(decided.tier_days, tier, `${days} days, ${runs} runs`);
  }
});

test('About slows down one tier at a time but speeds up at once', () => {
  const slow = about({ subscriber_growth_percentile: 0.0, view_growth_percentile: 0.0, about_stable_since: daysBefore(400), about_stable_runs: 20 });
  assert.equal(slow.tier_days, 180);
  const limited = limitAboutSlowdown(slow, 2);
  assert.equal(limited.tier_days, 3);
  assert.equal(limited.due_day, addDays('2026-07-20', 3));
  assert.ok(limited.reason_codes.includes('about_slowdown_one_tier'));
  const fast = about({ subscriber_growth_percentile: 0.90, view_growth_percentile: 0.90 });
  assert.equal(limitAboutSlowdown(fast, 30).tier_days, 1);
});

test('critical growth means a daily About; a partial run retries within 3 days', () => {
  assert.equal(about({ subscriber_growth_percentile: 0.91, view_growth_percentile: 0.50 }).tier_days, 1);
  const partial = decideAboutDue(state({ subscriber_growth_percentile: 0.10, view_growth_percentile: 0.10, about_stable_since: parseInstant('2026-01-01T00:00:00Z') }), OBSERVED, 'partial', false, ACTIVE_POLICY);
  assert.equal(partial.tier_days, 3);
  assert.ok(partial.reason_codes.includes('partial_retry_cap'));
});

test('every Discovery tier, the 90-day ceiling and the partial cap', () => {
  for (const [raw, outcome, expected] of [[1, 'complete', 1], [2, 'complete', 3], [4, 'complete', 7], [8, 'complete', 14], [15, 'complete', 30], [31, 'complete', 60], [61, 'complete', 90], [365, 'complete', 90], [365, 'partial', 3]] as const) {
    const policy = withPolicy(p => { p.discovery_config.fallback_interval_days = raw; });
    assert.equal(discoveryRisk(INITIAL_STATE, OBSERVED, outcome, false, policy).interval_days, expected, `${raw} raw days, ${outcome}`);
  }
});

test('a regular channel past its window backs off on silence and empty runs; finding a video clears the backoff', () => {
  const silent = discoveryRisk(state({ publish_interval_ewma: 7.0, publish_interval_median: 7.0, publish_regularity: 0.9, last_publish_at: daysBefore(100), new_video_empty_runs: 4, channel_activity: 0.1 }), OBSERVED, 'complete', false, ACTIVE_POLICY);
  assert.equal(silent.interval_days, 90);
  assert.ok(silent.reason_codes.includes('regular_publish_window_elapsed') && silent.reason_codes.includes('empty_run_backoff'));
  const active = discoveryRisk(state({ publish_interval_ewma: 2.0, publish_interval_median: 1.0, publish_regularity: 0.2, last_publish_at: OBSERVED - MICROS_PER_DAY / 2, channel_activity: 0.8 }), OBSERVED, 'complete', false, ACTIVE_POLICY);
  assert.ok(!active.reason_codes.includes('empty_run_backoff'));
});

test('every Recent Sampling tier and the partial cap', () => {
  const cases: [string, Partial<ChannelFeatureState>, boolean, 'complete' | 'partial', number][] = [
    ['baseline', {}, true, 'complete', 14],
    ['very high', { recent30_video_count: 20, channel_activity: 1.0, recent_change_probability: 1.0, recent_stale_ratio: 1.0, collection_priority: 1.0 }, false, 'complete', 3],
    ['high', { recent30_video_count: 10, channel_activity: 0.8, recent_change_probability: 0.8, recent_stale_ratio: 0.2, collection_priority: 0.0 }, false, 'complete', 7],
    ['medium', { recent30_video_count: 5, channel_activity: 0.4, recent_change_probability: 0.4, recent_stale_ratio: 0.4, collection_priority: 0.0 }, false, 'complete', 14],
    ['low', { recent30_video_count: 1, channel_activity: 0.2, recent_change_probability: 0.2, recent_stale_ratio: 0.35, collection_priority: 0.0 }, false, 'complete', 30],
    ['very low', { recent30_video_count: 1, collection_priority: 0.0 }, false, 'complete', 60],
    ['empty pool', { recent30_video_count: 0 }, false, 'complete', 60],
    ['partial', { recent30_video_count: 1 }, false, 'partial', 7],
  ];
  for (const [name, fields, baseline, outcome, expected] of cases) assert.equal(samplingRisk(state(fields), outcome, baseline, ACTIVE_POLICY).interval_days, expected, name);
});

test('the Video clock takes the shorter risk but never less than 3 days; failed sampling caps it at 7', () => {
  const hourly = decideVideoDue(state({
    recent_publish_interval_days: [0.042, 0.043, 0.041], publish_interval_ewma: 0.042, publish_interval_median: 0.042, publish_regularity: 0.99,
    last_publish_at: OBSERVED - MICROS_PER_DAY / 24, recent30_video_count: 30, channel_activity: 0.825, recent_stale_ratio: 1.0,
  }), OBSERVED, { discovery_outcome: 'partial', recent_sampling_outcome: 'complete', discovery_baseline: true, recent_sampling_baseline: true }, ACTIVE_POLICY);
  assert.equal(hourly.tier_days, 3);
  assert.ok(hourly.reason_codes.includes('automatic_video_min_interval'));
  const slowDiscovery = withPolicy(p => { p.discovery_config.fallback_interval_days = 90; });
  const busy = decideVideoDue(state({ recent30_video_count: 20, channel_activity: 1.0, recent_change_probability: 1.0, recent_stale_ratio: 1.0, collection_priority: 1.0 }),
    OBSERVED, { discovery_outcome: 'complete', recent_sampling_outcome: 'complete', discovery_baseline: false, recent_sampling_baseline: false }, slowDiscovery);
  assert.deepEqual([busy.tier_days, busy.due_day], [3, '2026-07-23']);
  assert.ok(busy.reason_codes.includes('video_interval_constrained_by_recent_sampling'));
  const failed = decideVideoDue(INITIAL_STATE, OBSERVED, { discovery_outcome: 'complete', recent_sampling_outcome: 'failed', discovery_baseline: false, recent_sampling_baseline: false }, slowDiscovery);
  assert.equal(failed.tier_days, 7);
  assert.ok(failed.reason_codes.includes('recent_sampling_failed_retry_cap'));
});

test('Discovery learns publish intervals and checks just before the next predicted upload', () => {
  const transition = applyVideoEvent(INITIAL_STATE, parseInstant('2026-07-20T12:00:00Z'), {
    discovery_outcome: 'complete',
    discovery: { first_seen: [{ published_at: parseInstant('2026-07-20T10:00:00Z') }, { published_at: parseInstant('2026-07-17T10:00:00Z') }], first_seen_count: 2, detail_success_count: 2, stop_reason: 'anchor_matched' },
    recent_sampling_outcome: 'complete',
    recent_sampling: { recent_count: 8, stale_ratio: 0.5, selected_count: 4, success_count: 4, comparable_view_count: 4, view_changed_count: 2, engagement_changed_count: 1 },
  }, 0.35, 0.4);
  assert.deepEqual(transition.state.recent_publish_interval_days, [3.0]);
  assert.equal(transition.state.publish_regularity, 1.0);
  assert.equal(decideVideoDue(transition.state, parseInstant('2026-07-20T12:00:00Z'), transition, ACTIVE_POLICY).tier_days, 3);
});

test('the Agent interval is continuous in semantic change: 60 days at full change, 365 unchanged', () => {
  const cases: [string, Partial<ChannelFeatureState>, boolean, number][] = [
    ['baseline', {}, true, 180],
    ['new Agent version', { agent_version_changed: true, topic_drift: 1.0, evidence_replacement: 1.0 }, false, 180],
    ['topic drift 0.75', { topic_drift: 0.75 }, false, 85],
    ['evidence replaced 0.40', { evidence_replacement: 0.40 }, false, 182],
    ['content shift 0.15', { recent_content_shift: 0.15 }, false, 288],
    ['stable', { topic_drift: 0.14, evidence_replacement: 0.05, recent_content_shift: 0.10 }, false, 292],
    ['nothing comparable', {}, false, 180],
    ['unchanged', { topic_drift: 0.0, agent_stable_runs: 6 }, false, 365],
    ['topic drift 0.80', { topic_drift: 0.80 }, false, 77],
  ];
  for (const [name, fields, baseline, expected] of cases) assert.equal(decideAgentDue(state(fields), OBSERVED, baseline, null, ACTIVE_POLICY).tier_days, expected, name);
  const nearby = new Set([0.48, 0.49, 0.50, 0.51, 0.52].map(drift => decideAgentDue(state({ topic_drift: drift }), OBSERVED, false, null, ACTIVE_POLICY).tier_days));
  assert.ok(nearby.size >= 4 && ![60, 90, 180, 365].some(days => nearby.has(days)));
});

test('Agent runs are spread forward by a stable per-channel offset', () => {
  for (const [tier, drift] of [[85, 0.75], [182, 0.40], [288, 0.15], [365, 0.0]] as const) {
    const decided = decideAgentDue(state({ topic_drift: drift }), OBSERVED, false, 'UC-agent-spread', ACTIVE_POLICY);
    const offset = agentForwardOffset('UC-agent-spread', ACTIVE_POLICY.policy_version, tier);
    assert.equal(decided.tier_days, tier);
    assert.ok(offset >= 0 && offset <= agentForwardSpreadMaxDays(tier));
    assert.equal(decided.due_day, addDays('2026-07-20', tier + offset));
    assert.ok(decided.reason_codes.includes('agent_forward_load_spread'));
  }
  const restarted = decideAgentDue(state({ agent_version_changed: true }), OBSERVED, false, 'UC-agent-urgent', ACTIVE_POLICY);
  assert.equal(restarted.due_day, addDays('2026-07-20', 180 + agentForwardOffset('UC-agent-urgent', ACTIVE_POLICY.policy_version, 180)));
  assert.ok(restarted.reason_codes.includes('agent_cross_version_baseline'));
  const offsets = new Set(Array.from({ length: 100 }, (_, index) => agentForwardOffset(`UC-agent-${index}`, 'v16-rule-7', 148)));
  assert.ok(offsets.size > 10 && [...offsets].every(offset => offset >= 0 && offset <= agentForwardSpreadMaxDays(148)));
});

test('replacing every piece of evidence counts as full change even when the count is equal', () => {
  const facts = (output: string, evidence: string[]): AgentFacts => ({
    output_hash: `sha256:${output.repeat(64)}`, category_level_1: 'Technology', category_level_2: ['l1:technology', 'tag:ai'], tag_count: 10,
    evidence_count: evidence.length, active_subscriber_ratio: 35, topic_tokens: ['l1:technology', 'tag:ai'],
    evidence_fingerprints: evidence.map(value => `sha256:${value.repeat(64)}`), agent_version_hash: `sha256:${'c'.repeat(64)}`,
  });
  const first = applyAgentEvent(INITIAL_STATE, parseInstant('2026-07-20T12:00:00Z'), 'complete', facts('a', ['a', 'b'])).state;
  const second = applyAgentEvent(first, parseInstant('2026-08-20T12:00:00Z'), 'complete', facts('b', ['d', 'e'])).state;
  assert.equal(second.evidence_replacement, 1.0);
  assert.equal(second.recent_content_shift, 0.0);
  assert.ok((second.agent_change_score ?? 0) >= 0.30);
});
