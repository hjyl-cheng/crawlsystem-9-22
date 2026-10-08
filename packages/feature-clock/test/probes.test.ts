import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  ACTIVE_POLICY, agentForwardOffset, agentForwardSpreadMaxDays, decideAboutDue, decideAgentDue, decideVideoDue,
  deserializeState, limitAboutSlowdown, parseInstant, recentPublishActive, type ClockDecision,
} from '../src/index.ts';

/**
 * Boundary parity: parity/probes.py called the legacy decision functions on feature states packed
 * around every threshold they test (publish ages near 7 and 30 days, cadence near each About
 * tier, priority cuts, stability gates, regularity 0.65, empty runs, semantic-curve rounding).
 */

type Recorded = { tier: number; due_day: string; reason_codes: string[] };
interface Probe {
  channel_id: string;
  observed_at: string;
  state: Record<string, unknown>;
  about: { outcome: 'complete' | 'partial'; baseline: boolean; decision: Recorded; previous_tier: number; limited: Recorded };
  video: { discovery_outcome: 'complete' | 'partial'; recent_sampling_outcome: 'complete' | 'partial' | 'failed' | 'skipped'; discovery_baseline: boolean; recent_sampling_baseline: boolean; decision: Recorded };
  agent: { baseline: boolean; decision: Recorded };
  recent_publish_active: boolean;
}

const fixture: { source: { commit: string; policy_version: string }; spread: { interval: number; max: number; offset: number }[]; probes: Probe[] } =
  JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/decision-probes.json.gz', import.meta.url))).toString('utf8'));
const recorded = (decision: ClockDecision): Recorded => ({ tier: decision.tier_days, due_day: decision.due_day, reason_codes: decision.reason_codes });

test('probes come from the legacy engine at the recorded commit and policy', () => {
  assert.equal(fixture.source.commit, 'e92d9227a5a3847430e5d062bea13227564ee419');
  assert.equal(fixture.source.policy_version, ACTIVE_POLICY.policy_version);
  assert.ok(fixture.probes.length >= 5000);
});

test('the Agent forward spread matches for every interval from 1 to 399 days', () => {
  for (const { interval, max, offset } of fixture.spread) {
    assert.equal(agentForwardSpreadMaxDays(interval), max, `max spread for ${interval} days`);
    assert.equal(agentForwardOffset('UCspread', ACTIVE_POLICY.policy_version, interval), offset, `offset for ${interval} days`);
  }
});

test('every boundary probe decides the same About, Video and Agent clocks', () => {
  for (const [index, probe] of fixture.probes.entries()) {
    const state = deserializeState(probe.state), at = parseInstant(probe.observed_at), where = `probe ${index}`;
    assert.equal(recentPublishActive(state, at), probe.recent_publish_active, `${where}: recent publish`);
    const about = decideAboutDue(state, at, probe.about.outcome, probe.about.baseline, ACTIVE_POLICY);
    assert.deepEqual(recorded(about), probe.about.decision, `${where}: About`);
    assert.deepEqual(recorded(limitAboutSlowdown(about, probe.about.previous_tier)), probe.about.limited, `${where}: About slowdown from ${probe.about.previous_tier}`);
    assert.deepEqual(recorded(decideVideoDue(state, at, probe.video, ACTIVE_POLICY)), probe.video.decision, `${where}: Video`);
    assert.deepEqual(recorded(decideAgentDue(state, at, probe.agent.baseline, probe.channel_id, ACTIVE_POLICY)), probe.agent.decision, `${where}: Agent`);
  }
});
