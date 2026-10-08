// Update clocks for managed channels (M3, docs/m3/README.md; 24.8 §7: three clocks). Each
// managed channel has one clock per domain - About, Video, Agent - saying when that part is next
// due and why. The days come from the legacy clock algorithm, ported unchanged into
// packages/feature-clock (policy v16-rule-7); an operator may pin a clock to a fixed interval.
import type { Domain } from './index.ts';

export const CLOCK_POLICY_VERSION = 'v16-rule-7';
export const CLOCK_NAMES = ['ABOUT', 'VIDEO', 'AGENT'] as const satisfies readonly Domain[];
export type ClockName = typeof CLOCK_NAMES[number];
/**
 * Why a clock is due when it is: the legacy policy's reason codes (about_priority_low,
 * regular_publish_prediction, agent_forward_load_spread, ...) or one of these set outside it.
 */
export const MANUAL_OVERRIDE_REASON = 'manual_override';
/** A domain not observed yet starts at the policy's baseline interval. */
export const BOOTSTRAP_BASELINE_REASON = 'clock_bootstrap_baseline';
/** Intervals an operator may pin a clock to (overriding the policy for that channel and domain). */
export const OVERRIDE_DAYS = [1, 2, 3, 5, 7, 14, 30, 60, 90, 180, 365] as const;
