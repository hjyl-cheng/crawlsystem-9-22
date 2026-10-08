import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  BOOTSTRAP_BASELINE_REASON, CLOCK_POLICY_VERSION, MANUAL_OVERRIDE_REASON, isVideoUnavailable,
  type AgentResult, type ChannelFacts, type ClockName, type VideoItem,
} from '@crawlsystem/contracts';
import { contentHash } from '@crawlsystem/contracts/hash';
import {
  ACTIVE_POLICY, addDays, applyObservation, casefold, CLOCK_KINDS, dayStart, deserializeClock, deserializeState, EMPTY_SNAPSHOT, instantFromDate,
  NO_SIGNALS, parseInstant, QUANTILE_PROBABILITIES, REFERENCE_FEATURES, REFERENCE_METHOD_VERSION, ReferenceCatalog, refreshSharedFeatures,
  serializeClock, serializeState, utcDay,
  type ClockKind, type ClockSnapshot, type Day, type DecisionRecord, type Instant, type MetricStatus, type Observation,
} from '@crawlsystem/feature-clock';

/**
 * Update clocks from the legacy algorithm (packages/feature-clock): what the new system collected is
 * read as the legacy observations, applied to the channel's stored feature state, and the resulting
 * clocks are written to m1.channel_clocks with an operator's pinned interval applied on top.
 */

if (ACTIVE_POLICY.policy_version !== CLOCK_POLICY_VERSION) throw new Error('contracts and feature-clock disagree on the clock policy');

const NAME: Record<ClockKind, ClockName> = { about: 'ABOUT', video: 'VIDEO', agent: 'AGENT' };
const sha256 = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

// ---- what was collected, as legacy observations -------------------------------------------

/** Metric statuses the legacy events know: anything not resolved is unavailable or unresolved. */
const METRIC: Record<ChannelFacts['subscriber_count']['status'], MetricStatus> = {
  exact: 'exact', estimated: 'estimated', unresolved: 'unresolved', empty: 'unavailable', unavailable: 'unavailable', disabled: 'unavailable',
};

/** About facts; complete only when all three counts are resolved (the legacy rule). */
export function aboutObservation(about: ChannelFacts): Observation {
  const metric = (value: ChannelFacts['subscriber_count']) => {
    const status = METRIC[value.status];
    return [status === 'exact' || status === 'estimated' ? value.value : null, status] as const;
  };
  const [subscribers, subscriberStatus] = metric(about.subscriber_count), [views, viewStatus] = metric(about.total_view_count), [videos, videoStatus] = metric(about.total_video_count);
  const resolved = [subscriberStatus, viewStatus, videoStatus].every(status => status === 'exact' || status === 'estimated');
  return { kind: 'about', observed_at: parseInstant(about.observed_at), outcome: resolved ? 'complete' : 'partial', facts: {
    subscriber_count: subscribers, subscriber_count_status: subscriberStatus, total_view_count: views, total_view_count_status: viewStatus,
    total_video_count: videos, total_video_count_status: videoStatus,
  } };
}

/**
 * A Video run as legacy Discovery: the videos it saw for the first time. Recent Sampling (re-reading
 * known videos' counts) arrives with M3 step 3; until then it is skipped, which the legacy policy
 * answers by bringing the Video clock back within 7 days.
 */
export function videoObservation(observedAt: Instant, firstSeen: readonly VideoItem[]): Observation {
  return { kind: 'video', observed_at: observedAt, outcome: 'partial', facts: {
    discovery_outcome: 'complete',
    discovery: {
      first_seen: firstSeen.map(video => ({ published_at: isVideoUnavailable(video) || video.published_at === null ? null : parseInstant(video.published_at) })),
      first_seen_count: firstSeen.length,
      detail_success_count: firstSeen.filter(video => !isVideoUnavailable(video)).length,
      stop_reason: 'frozen_manifest',
    },
    recent_sampling_outcome: 'skipped',
    recent_sampling: null,
  } };
}

/**
 * An Agent profile as the legacy extended Agent payload: topics are the categories and tags,
 * evidence the cited evidence and sources (fingerprinted), the version the model and taxonomy.
 */
export function agentObservation(agent: AgentResult): Observation {
  const facts = agent.facts, categories = facts.channel_categories.value, tags = facts.channel_tags.value.tags;
  const evidence = Object.values(facts).flatMap(fact => [...fact.evidence, ...fact.source_urls]);
  const topics = [...new Set([`l1:${casefold(categories.level_1)}`, ...categories.level_2.map(item => `l2:${casefold(item)}`), ...tags.map(tag => `tag:${casefold(tag)}`)])];
  return { kind: 'agent', observed_at: parseInstant(agent.observed_at), outcome: 'complete', facts: {
    output_hash: contentHash(facts),
    category_level_1: categories.level_1,
    category_level_2: categories.level_2,
    tag_count: tags.length,
    evidence_count: evidence.length,
    active_subscriber_ratio: facts.active_subscriber_ratio.value,
    topic_tokens: topics.slice(0, 128),
    evidence_fingerprints: [...new Set(evidence.map(sha256))].slice(0, 256),
    agent_version_hash: sha256(`${agent.model_version}\u0000${agent.taxonomy_version}`),
  } };
}

// ---- stored state ------------------------------------------------------------------------

/** A channel's engine snapshot and the reason codes of the latest decision per kind. */
export interface StoredClocks { snapshot: ClockSnapshot; reasons: Partial<Record<ClockKind, string[]>> }

export async function loadClocks(client: PoolClient, workspaceId: string, channelId: string): Promise<StoredClocks | null> {
  const row = (await client.query('SELECT state,clock,applied,reasons FROM m1.channel_feature_state WHERE workspace_id=$1 AND channel_id=$2 FOR UPDATE', [workspaceId, channelId])).rows[0];
  if (!row) return null;
  return { snapshot: { state: deserializeState(row.state), clock: row.clock ? deserializeClock(row.clock) : null, applied: { ...EMPTY_SNAPSHOT.applied, ...row.applied } }, reasons: row.reasons };
}

async function saveClocks(client: PoolClient, workspaceId: string, channelId: string, stored: StoredClocks): Promise<void> {
  const { state, clock, applied } = stored.snapshot;
  await client.query(`INSERT INTO m1.channel_feature_state(workspace_id,channel_id,policy_version,state,clock,applied,reasons) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(workspace_id,channel_id) DO UPDATE SET policy_version=EXCLUDED.policy_version,state=EXCLUDED.state,clock=EXCLUDED.clock,applied=EXCLUDED.applied,reasons=EXCLUDED.reasons,updated_at=clock_timestamp()`,
  [workspaceId, channelId, CLOCK_POLICY_VERSION, serializeState(state), clock ? serializeClock(clock) : null, applied, stored.reasons]);
}

/** The newest reference distributions on or before `day` (the legacy load_reference_catalog). */
export async function referenceCatalog(client: PoolClient | Pool, workspaceId: string, day: Day): Promise<ReferenceCatalog> {
  const rows = (await client.query(`SELECT as_of_day::text AS as_of_day,feature_name,cohort_key,sample_count,quantiles FROM m1.feature_reference_distributions
    WHERE workspace_id=$1 AND method_version=$2 AND as_of_day=(SELECT max(as_of_day) FROM m1.feature_reference_distributions WHERE workspace_id=$1 AND method_version=$2 AND as_of_day<=$3::date)
    ORDER BY feature_name,cohort_key`, [workspaceId, REFERENCE_METHOD_VERSION, day])).rows;
  return new ReferenceCatalog(rows.map(row => ({ as_of_day: row.as_of_day, feature_name: row.feature_name, cohort_key: row.cohort_key, sample_count: row.sample_count,
    probabilities: row.quantiles.probabilities, values: row.quantiles.values, method_version: REFERENCE_METHOD_VERSION })));
}

// ---- applying observations ---------------------------------------------------------------

/** Apply observations in order; the reason codes of each kind's latest decision are kept. */
export async function applyObservations(client: PoolClient, workspaceId: string, channelId: string, stored: StoredClocks | null, observations: readonly Observation[]): Promise<StoredClocks> {
  let snapshot = stored?.snapshot ?? EMPTY_SNAPSHOT;
  const reasons = { ...stored?.reasons }, catalogs = new Map<Day, ReferenceCatalog>();
  for (const observation of observations) {
    const day = utcDay(observation.observed_at);
    if (!catalogs.has(day)) catalogs.set(day, await referenceCatalog(client, workspaceId, day));
    const bootstrapping = snapshot.clock === null;
    const result = applyObservation(channelId, snapshot, observation, { references: catalogs.get(day)!, signals: NO_SIGNALS });
    snapshot = result.snapshot;
    if (bootstrapping && snapshot.clock !== null) for (const kind of CLOCK_KINDS) reasons[kind] = [BOOTSTRAP_BASELINE_REASON];
    for (const decision of result.decisions as DecisionRecord[]) reasons[decision.kind] = decision.reason_codes;
  }
  const next = { snapshot, reasons };
  await saveClocks(client, workspaceId, channelId, next);
  return next;
}

/** When each kind was last applied and attempted in this change, and by which plan. */
export interface ClockActivity { planId: string | null; succeeded: Partial<Record<ClockKind, Date>>; attempted: Partial<Record<ClockKind, Date>> }

/**
 * Write the effective clocks: the engine's day, interval and reasons, or for a pinned clock the
 * pinned interval counted from its last success (or today). Due days start at 00:00 UTC.
 */
export async function writeClocks(client: PoolClient, workspaceId: string, channelId: string, stored: StoredClocks, activity: ClockActivity, now: Date): Promise<void> {
  const clock = stored.snapshot.clock;
  if (clock === null) return;
  const existing = new Map((await client.query('SELECT clock,override_days,last_success_at FROM m1.channel_clocks WHERE workspace_id=$1 AND channel_id=$2 FOR UPDATE', [workspaceId, channelId]))
    .rows.map(row => [row.clock as ClockName, row as { override_days: number | null; last_success_at: Date | null }]));
  for (const kind of CLOCK_KINDS) {
    const name = NAME[kind], pinned = existing.get(name)?.override_days ?? null;
    const lastSuccess = activity.succeeded[kind] ?? existing.get(name)?.last_success_at ?? null;
    let dueDay = clock[`${kind}_due_day`], interval = clock[`${kind}_tier`], reasons = stored.reasons[kind] ?? [BOOTSTRAP_BASELINE_REASON];
    if (pinned !== null) [dueDay, interval, reasons] = [addDays(utcDay(instantFromDate(lastSuccess ?? now)), pinned), pinned, [MANUAL_OVERRIDE_REASON]];
    await client.query(`INSERT INTO m1.channel_clocks(workspace_id,channel_id,clock,due_at,retry_at,interval_days,reason,reasons,policy_version,last_success_at,last_attempt_at,last_plan_id)
      VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(workspace_id,channel_id,clock) DO UPDATE SET due_at=EXCLUDED.due_at,retry_at=NULL,interval_days=EXCLUDED.interval_days,reason=EXCLUDED.reason,reasons=EXCLUDED.reasons,
        policy_version=EXCLUDED.policy_version,last_success_at=coalesce(EXCLUDED.last_success_at,m1.channel_clocks.last_success_at),
        last_attempt_at=coalesce(EXCLUDED.last_attempt_at,m1.channel_clocks.last_attempt_at),last_plan_id=coalesce(EXCLUDED.last_plan_id,m1.channel_clocks.last_plan_id),updated_at=clock_timestamp()`,
    [workspaceId, channelId, name, dayStart(dueDay), interval, reasons.at(-1)!.slice(0, 60), reasons, CLOCK_POLICY_VERSION,
      activity.succeeded[kind] ?? null, activity.attempted[kind] ?? activity.succeeded[kind] ?? null, activity.attempted[kind] || activity.succeeded[kind] ? activity.planId : null]);
  }
}

// ---- the daily reference refresh ---------------------------------------------------------

const COHORT_SQL = `CASE WHEN v_subs IS NULL THEN 'subs:unknown' WHEN v_subs < 1000 THEN 'subs:0-1k' WHEN v_subs < 10000 THEN 'subs:1k-10k'
  WHEN v_subs < 100000 THEN 'subs:10k-100k' WHEN v_subs < 1000000 THEN 'subs:100k-1m' WHEN v_subs < 10000000 THEN 'subs:1m-10m'
  WHEN v_subs < 100000000 THEN 'subs:10m-100m' ELSE 'subs:100m+' END`;

/**
 * Once per UTC day (the legacy FeatureReferenceRefresher): rank every channel's subscriber count
 * and growth into percentile distributions (growth also per subscriber-size cohort), then refresh
 * every channel's cross-channel features against them. Returns null when the day is already done.
 */
export async function refreshReferences(pool: Pool, workspaceId: string, now = new Date()): Promise<{ as_of_day: Day; distributions: number; channels: number } | null> {
  const day = utcDay(instantFromDate(now));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('m1.feature_reference_distributions:' || $1))", [workspaceId]);
    const done = await client.query('SELECT 1 FROM m1.feature_reference_distributions WHERE workspace_id=$1 AND method_version=$2 AND as_of_day=$3::date LIMIT 1', [workspaceId, REFERENCE_METHOD_VERSION, day]);
    if (done.rowCount) { await client.query('ROLLBACK'); return null; }
    let distributions = 0;
    for (const [feature, field] of Object.entries(REFERENCE_FEATURES)) {
      const cohorts = feature === 'subscriber_count' ? `'all'` : `unnest(ARRAY['all', ${COHORT_SQL}])`;
      const rows = (await client.query(`SELECT cohort_key, count(value)::int AS sample_count,
          percentile_cont($3::float8[]) WITHIN GROUP (ORDER BY value) AS values
        FROM (SELECT (state->>$2)::float8 AS value, (state->>'last_subscriber_count')::float8 AS v_subs FROM m1.channel_feature_state WHERE workspace_id=$1) samples,
          LATERAL (SELECT ${cohorts} AS cohort_key) cohort
        WHERE value IS NOT NULL GROUP BY cohort_key`, [workspaceId, field, QUANTILE_PROBABILITIES])).rows;
      for (const row of rows) {
        await client.query(`INSERT INTO m1.feature_reference_distributions(workspace_id,method_version,as_of_day,feature_name,cohort_key,sample_count,quantiles) VALUES($1,$2,$3::date,$4,$5,$6,$7)`,
          [workspaceId, REFERENCE_METHOD_VERSION, day, feature, row.cohort_key, row.sample_count, { probabilities: QUANTILE_PROBABILITIES, values: row.values }]);
        distributions += 1;
      }
    }
    const catalog = await referenceCatalog(client, workspaceId, day), asOf = instantFromDate(dayStart(day));
    let channels = 0;
    for (const row of (await client.query('SELECT channel_id,state FROM m1.channel_feature_state WHERE workspace_id=$1 ORDER BY channel_id FOR UPDATE', [workspaceId])).rows) {
      const refreshed = refreshSharedFeatures(deserializeState(row.state), catalog, NO_SIGNALS, asOf);
      if (refreshed === null) continue;
      await client.query('UPDATE m1.channel_feature_state SET state=$3,updated_at=clock_timestamp() WHERE workspace_id=$1 AND channel_id=$2', [workspaceId, row.channel_id, serializeState(refreshed)]);
      channels += 1;
    }
    await client.query('COMMIT');
    return { as_of_day: day, distributions, channels };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
