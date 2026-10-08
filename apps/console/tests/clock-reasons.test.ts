import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { clockReasonText } from '../src/presentation.js';

/** Codes that only record how a decision was combined; the tooltip leaves them out. */
const BOOKKEEPING = new Set(['video_interval_constrained_by_discovery', 'video_interval_constrained_by_recent_sampling', 'recent_publish_active', 'cross_domain_cold_start_recalculation']);

function legacyReasonCodes(): Set<string> {
  const codes = new Set<string>();
  const read = (name: string) => JSON.parse(gunzipSync(readFileSync(new URL(`../../../packages/feature-clock/test/fixtures/${name}`, import.meta.url))).toString('utf8'));
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) key === 'reason_codes' ? (item as string[]).forEach(code => codes.add(code)) : collect(item);
  };
  collect(read('parity-golden.json.gz').scenarios.map((s: { steps: { decisions: unknown }[] }) => s.steps.map(step => step.decisions)));
  collect(read('decision-probes.json.gz').probes);
  return codes;
}

test('every reason code the legacy clock policy produced has plain words', () => {
  const codes = legacyReasonCodes();
  assert.ok(codes.size > 40, `${codes.size} codes`);
  const missing = [...codes].filter(code => !BOOKKEEPING.has(code) && clockReasonText([code]) === '按更新规则计算');
  assert.deepEqual(missing, []);
});

test('the tooltip joins the reasons in order, once each, without bookkeeping codes', () => {
  assert.equal(clockReasonText(['about_priority_low', 'video_count_increased', 'about_priority_low']), '热度偏低；视频数在增加，3 天内再看');
  assert.equal(clockReasonText(['about_baseline', 'about_cold_start_cadence_2d']), '第一次采集资料；第一次采集，按发布节奏 2 天后再看');
  assert.equal(clockReasonText(['video_interval_constrained_by_discovery']), '按更新规则计算');
  assert.equal(clockReasonText(['manual_override']), '人工指定的间隔');
});
