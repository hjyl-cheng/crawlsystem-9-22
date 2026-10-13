import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { isVideoUnavailable, type FrozenInput, type VideoFacts, type VideoItem } from '@crawlsystem/contracts';

/**
 * Legacy channel lifecycle (oldsystem channelDormancy.js, videoActivityLifecycle.js, publicationTimeEvidence.js):
 * an update whose uploads scan is complete and finds no content published in the last 90 days puts the channel to
 * sleep until a deterministic 30-90 day recheck; a normal empty uploads list does so at once. While it sleeps only a
 * Video probe runs, on the recheck day; a probe that finds recent content wakes it.
 */
export const DORMANT_REASON = 'no_published_content_within_90_days';
export const DORMANT_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

/** Legacy dormantRecheckDelayDays: 30 + sha256("dormant-video-probe-v1\0{id}\0{cycle}") first uint32 mod 61. */
export function dormantRecheckDelayDays(channelId: string, cycle: number): number {
  const id = channelId.trim();
  if (!id) throw new TypeError('channelId is required');
  if (!Number.isSafeInteger(cycle) || cycle <= 0) throw new TypeError('cycle must be positive');
  return 30 + createHash('sha256').update(`dormant-video-probe-v1\u0000${id}\u0000${cycle}`).digest().readUInt32BE(0) % 61;
}
export const addUtcDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);

export type WindowRelation = 'inside' | 'outside' | 'after_as_of' | 'cutoff_overlap' | 'unresolved';
/** Legacy classifyPublicationWindow: only exact evidence decides; a date-only day on the cutoff is uncertain. */
export function publicationWindow(v: Pick<VideoFacts, 'published_at' | 'published_at_status' | 'published_at_precision'>, asOf: Date, days = DORMANT_WINDOW_DAYS): WindowRelation {
  if (v.published_at_status !== 'exact' || !v.published_at) return 'unresolved';
  const published = Date.parse(v.published_at), now = asOf.getTime(), cutoff = now - days * DAY_MS;
  if (!Number.isFinite(published)) return 'unresolved';
  if (v.published_at_precision === 'second') return published > now ? 'after_as_of' : published <= cutoff ? 'outside' : 'inside';
  const [p, n, c] = [published, now, cutoff].map(t => Math.floor(t / DAY_MS));
  return p! > n! ? 'after_as_of' : p! < c! ? 'outside' : p === c ? 'cutoff_overlap' : 'inside';
}
/** Legacy stored activity evidence (videoActivityLifecycle.js:289-318): an unfinished live stream is uncertain. */
export function activityEvidence(videos: readonly VideoItem[], asOf: Date): { recent: number; uncertain: number } {
  let recent = 0, uncertain = 0;
  for (const v of videos) {
    if (isVideoUnavailable(v)) continue;
    if (v.content_type === 'live' && !v.live_ended_at && v.duration_seconds.value === null) { uncertain++; continue; }
    const relation = publicationWindow(v, asOf);
    if (relation === 'inside') recent++;
    else if (relation !== 'outside') uncertain++;
  }
  return { recent, uncertain };
}
/** Legacy evaluateVideoActivity. */
export function evaluateActivity({ recent, uncertain, complete }: { recent: number; uncertain: number; complete: boolean }): 'active' | 'dormant' | 'inconclusive' {
  return recent > 0 ? 'active' : !complete || uncertain > 0 ? 'inconclusive' : 'dormant';
}

export interface Lifecycle { lifecycle_status: 'active' | 'dormant'; dormant_reason: string | null; dormant_since: Date | null; dormant_recheck_day: string | null; dormant_cycle: number }
export async function loadLifecycle(client: PoolClient, workspaceId: string, channelId: string): Promise<Lifecycle | null> {
  const row = (await client.query('SELECT * FROM control.channel_lifecycle WHERE workspace_id=$1 AND channel_id=$2', [workspaceId, channelId])).rows[0];
  return row ? { ...row, dormant_recheck_day: row.dormant_recheck_day ? new Date(row.dormant_recheck_day).toISOString().slice(0, 10) : null } as Lifecycle : null;
}

/**
 * After a completed plan applied VIDEO: decide the channel's lifecycle (inside the plan's settling transaction).
 * Like legacy, a first collection decides only an empty uploads list; updates decide from the stored videos when
 * their uploads scan was complete (reached an anchor or the end of the list).
 */
export async function settleLifecycle(client: PoolClient, plan: QueryResultRow, at: Date): Promise<Lifecycle | null> {
  const frozen = plan.frozen_input as FrozenInput;
  if (frozen.source_mode !== 'youtube') return null;
  const workspace = plan.workspace_id as string, channel = plan.channel_id as string;
  const prior = (await client.query('SELECT * FROM control.channel_lifecycle WHERE workspace_id=$1 AND channel_id=$2 FOR UPDATE', [workspace, channel])).rows[0];
  const manifest = (await client.query('SELECT manifest FROM control.plan_video_targets WHERE plan_id=$1', [plan.plan_id])).rows[0]?.manifest;
  const listed = (manifest?.video_ids ?? []).length;
  // Legacy U-110: a normal empty uploads list (the region recheck already ran in the collector) sleeps at once.
  const empty = manifest && !listed && (manifest.kind === 'targets' ? manifest.exhausted === true : manifest.stop_reason === 'list_end' && !manifest.scanned_count);
  let decision: 'active' | 'dormant' | 'inconclusive', reason = DORMANT_REASON, recent = 0;
  if (empty) { decision = 'dormant'; reason = 'uploads_empty'; }
  else if (frozen.plan_kind !== 'UPDATE') return prior ? await loadLifecycle(client, workspace, channel) : null;
  else {
    const videos = (await client.query('SELECT data FROM control.videos WHERE workspace_id=$1 AND channel_id=$2', [workspace, channel])).rows.map(r => r.data as VideoItem);
    const evidence = activityEvidence(videos, at);
    recent = evidence.recent;
    decision = evaluateActivity({ ...evidence, complete: ['anchor_matched', 'list_end'].includes(manifest?.stop_reason) });
  }
  const sleeping = prior?.lifecycle_status === 'dormant';
  if (decision === 'dormant') {
    const cycle = (prior?.dormant_cycle ?? 0) + 1, delay = dormantRecheckDelayDays(channel, cycle);
    await client.query(`INSERT INTO control.channel_lifecycle(workspace_id,channel_id,lifecycle_status,dormant_reason,dormant_since,dormant_recheck_day,dormant_cycle,
        dormant_last_probe_at,recent_published_content_count,decision,decided_plan_id,decided_at)
      VALUES($1,$2,'dormant',$3,$4,$5,$6,$7,0,'dormant',$8,$7)
      ON CONFLICT(workspace_id,channel_id) DO UPDATE SET lifecycle_status='dormant',dormant_reason=EXCLUDED.dormant_reason,dormant_since=EXCLUDED.dormant_since,
        dormant_recheck_day=EXCLUDED.dormant_recheck_day,dormant_cycle=EXCLUDED.dormant_cycle,dormant_last_probe_at=EXCLUDED.dormant_last_probe_at,
        recent_published_content_count=0,decision='dormant',decided_plan_id=EXCLUDED.decided_plan_id,decided_at=EXCLUDED.decided_at,updated_at=clock_timestamp()`,
      [workspace, channel, reason, sleeping ? prior.dormant_since : at, addUtcDays(at.toISOString().slice(0, 10), delay), cycle, at, plan.plan_id]);
  } else if (decision === 'active') {
    await client.query(`INSERT INTO control.channel_lifecycle(workspace_id,channel_id,lifecycle_status,dormant_cycle,recent_published_content_count,decision,decided_plan_id,decided_at)
      VALUES($1,$2,'active',0,$3,'active',$4,$5)
      ON CONFLICT(workspace_id,channel_id) DO UPDATE SET lifecycle_status='active',dormant_reason=NULL,dormant_since=NULL,dormant_recheck_day=NULL,dormant_cycle=0,
        dormant_last_probe_at=NULL,recent_published_content_count=EXCLUDED.recent_published_content_count,decision='active',decided_plan_id=EXCLUDED.decided_plan_id,
        decided_at=EXCLUDED.decided_at,updated_at=clock_timestamp()`, [workspace, channel, recent, plan.plan_id, at]);
  } else if (sleeping) {
    // Legacy U-111: an inconclusive probe of a sleeping channel only records the probe.
    await client.query(`UPDATE control.channel_lifecycle SET dormant_last_probe_at=$3,decision='inconclusive',decided_plan_id=$4,decided_at=$3,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND channel_id=$2`, [workspace, channel, at, plan.plan_id]);
  } else {
    await client.query(`INSERT INTO control.channel_lifecycle(workspace_id,channel_id,lifecycle_status,dormant_cycle,recent_published_content_count,decision,decided_plan_id,decided_at)
      VALUES($1,$2,'active',0,0,'inconclusive',$3,$4)
      ON CONFLICT(workspace_id,channel_id) DO UPDATE SET decision='inconclusive',decided_plan_id=EXCLUDED.decided_plan_id,decided_at=EXCLUDED.decided_at,updated_at=clock_timestamp()`,
      [workspace, channel, plan.plan_id, at]);
  }
  return loadLifecycle(client, workspace, channel);
}
