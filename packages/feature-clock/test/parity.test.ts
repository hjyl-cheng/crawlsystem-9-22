import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  applyObservation, EMPTY_SNAPSHOT, formatInstant, INITIAL_STATE, parseInstant, ReferenceCatalog, serializeState,
  type AgentFacts, type ChannelClockState, type ClockSnapshot, type Observation, type VideoFacts,
} from '../src/index.ts';

/**
 * Parity with the legacy Python engine: parity/generate.py drove the legacy code through random
 * channel histories (crawlSystem e92d9227, policy v16-rule-7) and recorded every step (features as
 * changes from the previous step, so the fixture stays small). Every clock
 * day, tier, reason and feature must match exactly, except publish regularity (exp(−2.5·CV)),
 * which may differ in the last bit: V8 and the C library round exp differently.
 */

interface Golden {
  source: { commit: string; policy_version: string };
  initial_state: Record<string, unknown>;
  scenarios: {
    channel_id: string;
    catalog: { as_of_day: string; cohort_key: string; feature_name: string; sample_count: number; probabilities: number[]; values: number[] }[];
    signals: { user_query_demand: number; manual_priority: number };
    steps: { event: LegacyEvent; decisions: unknown[]; state_changes: Record<string, unknown>; clock: Record<string, unknown> | null }[];
  }[];
}
interface LegacyEvent { observation_kind: 'about' | 'video' | 'agent'; observed_at: string; outcome: 'complete' | 'partial' | 'failed'; payload: Record<string, any> }

const golden: Golden = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/parity-golden.json.gz', import.meta.url))).toString('utf8'));

/** The legacy event payload as the engine reads it (feature_engine/events.py, values already valid). */
function observation(event: LegacyEvent): Observation {
  const observed_at = parseInstant(event.observed_at), outcome = event.outcome, payload = event.payload;
  if (event.observation_kind === 'about') {
    return { kind: 'about', observed_at, outcome, facts: outcome === 'failed' ? null : {
      subscriber_count: payload.subscriber_count, subscriber_count_status: payload.subscriber_count_status,
      total_view_count: payload.total_view_count, total_view_count_status: payload.total_view_count_status,
      total_video_count: payload.total_video_count, total_video_count_status: payload.total_video_count_status,
    } };
  }
  if (event.observation_kind === 'video') {
    if (outcome === 'failed') return { kind: 'video', observed_at, outcome, facts: null };
    const discovery = payload.discovery.payload, sampling = payload.recent_sampling;
    const facts: VideoFacts = {
      discovery_outcome: payload.discovery.outcome,
      discovery: {
        first_seen: discovery.first_seen.map((item: { published_at: string | null }) => ({ published_at: item.published_at === null ? null : parseInstant(item.published_at) })),
        first_seen_count: discovery.first_seen_count, detail_success_count: discovery.detail_success_count, stop_reason: discovery.stop_reason,
      },
      recent_sampling_outcome: sampling.outcome,
      recent_sampling: sampling.outcome === 'skipped' ? null : sampling.payload,
    };
    return { kind: 'video', observed_at, outcome, facts };
  }
  const facts: AgentFacts | null = outcome === 'failed' ? null : {
    output_hash: payload.output_hash, category_level_1: payload.category_level_1, category_level_2: payload.category_level_2,
    tag_count: payload.tag_count, evidence_count: payload.evidence_count, active_subscriber_ratio: payload.active_subscriber_ratio,
    topic_tokens: payload.topic_tokens ?? null, evidence_fingerprints: payload.evidence_fingerprints ?? null, agent_version_hash: payload.agent_version_hash ?? null,
  };
  return { kind: 'agent', observed_at, outcome, facts };
}

function clockJson(clock: ChannelClockState | null): Record<string, unknown> | null {
  if (clock === null) return null;
  const at = (value: number | null) => value === null ? null : formatInstant(value);
  return { ...clock, about_last_complete_at: at(clock.about_last_complete_at), video_last_complete_at: at(clock.video_last_complete_at), agent_last_complete_at: at(clock.agent_last_complete_at) };
}

/** Fields computed through exp, which may differ from the C library in the last bit. */
const LAST_BIT_FIELDS = new Set(['publish_regularity']);
const lastBit = (actual: unknown, expected: unknown) => typeof actual === 'number' && typeof expected === 'number'
  && Math.abs(actual - expected) <= 1e-15 * Math.abs(expected);

test('golden vectors come from the legacy engine at the recorded commit and policy', () => {
  assert.equal(golden.source.commit, 'e92d9227a5a3847430e5d062bea13227564ee419');
  assert.equal(golden.source.policy_version, 'v16-rule-7');
  assert.ok(golden.scenarios.length >= 200);
});

test('a new channel starts from the legacy initial features', () => {
  assert.deepEqual(serializeState(INITIAL_STATE), golden.initial_state);
});

test('every legacy step gives the same clock decisions, clocks and features', () => {
  let steps = 0, inexact = 0;
  for (const scenario of golden.scenarios) {
    const references = new ReferenceCatalog(scenario.catalog);
    let snapshot: ClockSnapshot = EMPTY_SNAPSHOT, expectedState = serializeState(INITIAL_STATE);
    scenario.steps.forEach((step, index) => {
      const where = `${scenario.channel_id} step ${index} (${step.event.observation_kind} ${step.event.outcome})`;
      const result = applyObservation(scenario.channel_id, snapshot, observation(step.event), { references, signals: scenario.signals });
      snapshot = result.snapshot;
      assert.deepEqual(result.decisions, step.decisions, `${where}: decisions`);
      assert.deepEqual(clockJson(snapshot.clock), step.clock, `${where}: clock`);
      const actual = serializeState(snapshot.state);
      expectedState = { ...expectedState, ...step.state_changes };
      for (const [field, expected] of Object.entries(expectedState)) {
        if (LAST_BIT_FIELDS.has(field) && actual[field] !== expected && lastBit(actual[field], expected)) { inexact += 1; continue; }
        assert.deepEqual(actual[field], expected, `${where}: ${field}`);
      }
      assert.deepEqual(Object.keys(actual).sort(), Object.keys(expectedState).sort(), `${where}: state fields`);
      steps += 1;
    });
  }
  assert.ok(steps >= 2000, `${steps} steps`);
  // Last-bit differences are rare; a jump would mean a semantic drift hiding under the tolerance.
  assert.ok(inexact <= steps / 10, `${inexact} last-bit regularity differences over ${steps} steps`);
});
