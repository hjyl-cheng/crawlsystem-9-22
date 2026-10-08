/**
 * Legacy Recent Sampling (crawlSystem services/qybullmq incrementalVideoPlanner.js and
 * incrementalVideo.js nextVideoChangeProbability, video-plan-1): which recent known videos an
 * update re-reads, and how a re-read moves a video's learned chance of change. Comments are not
 * re-read for known videos (M3-D3), so the legacy "next" quota is always zero.
 */

export const RECENT_SAMPLING = {
  recentWindowDays: 30,
  staleAfterDays: 7,
  defaultCollectionPriority: 0.5,
  defaultChangeProbability: 0.5,
  minimumRefreshScore: 0.55,
  changeEwmaAlpha: 0.4,
  /** Legacy dispatcher capacity: player_cap 20 at factor 1. */
  playerCap: 20,
} as const;

const DAY = 86_400_000;

export interface SamplingRow {
  video_id: string;
  /** Epoch milliseconds, or null when unknown. */
  published_at: number | null;
  /** When the counts were last read (the legacy player_last_observed_at). */
  stats_observed_at: number | null;
  change_probability: number | null;
}

export interface SamplingPlan {
  /** Known videos published inside the recent window. */
  recent_count: number;
  stale_ratio: number;
  candidate_count: number;
  video_ids: string[];
}

const unit = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

function score(row: SamplingRow, now: number) {
  const staleness = row.stats_observed_at === null ? 1 : Math.min(1, Math.max(0, (now - row.stats_observed_at) / (RECENT_SAMPLING.staleAfterDays * DAY)));
  const freshness = row.published_at === null ? 0 : Math.max(0, 1 - ((now - row.published_at) / (30 * DAY)));
  const learned = unit(row.change_probability);
  const change = learned ?? (0.60 * RECENT_SAMPLING.defaultChangeProbability) + (0.40 * freshness);
  const playerScore = (0.60 * staleness) + (0.40 * change);
  return { row, playerScore, stale: staleness >= 1, candidate: row.stats_observed_at === null || playerScore >= RECENT_SAMPLING.minimumRefreshScore };
}

/** `rows` are the channel's known videos published inside the recent window (planRecentVideoSampling). */
export function planRecentSampling(rows: readonly SamplingRow[], now: number): SamplingPlan {
  const pool = rows.map(row => score(row, now));
  const candidates = pool.filter(item => item.candidate);
  const staleRatio = pool.length === 0 ? 0 : pool.filter(item => item.stale).length / pool.length;
  const demand = candidates.reduce((total, item) => total + item.playerScore, 0);
  const coverage = 0.50 + (0.50 * RECENT_SAMPLING.defaultCollectionPriority);
  const suggested = candidates.length === 0 ? 0 : Math.min(candidates.length, Math.ceil(demand * coverage));
  const quota = Math.min(candidates.length, suggested, RECENT_SAMPLING.playerCap);
  const chosen = [...candidates].sort((a, b) => b.playerScore - a.playerScore || a.row.video_id.localeCompare(b.row.video_id)).slice(0, quota);
  return { recent_count: pool.length, stale_ratio: Number(staleRatio.toFixed(6)), candidate_count: candidates.length, video_ids: chosen.map(item => item.row.video_id) };
}

export interface CountSnapshot { view_count: number | null; like_count: number | null; comment_count: number | null }

/** The learned chance a video's counts change: views weigh 0.70, likes and comments 0.15 each (EWMA, alpha 0.4). */
export function nextChangeProbability(previous: CountSnapshot, current: CountSnapshot, previousProbability: number | null): number | null {
  const signals: { weight: number; changed: boolean }[] = [];
  if (previous.view_count !== null && current.view_count !== null) signals.push({ weight: 0.70, changed: previous.view_count !== current.view_count });
  if (previous.like_count !== null && current.like_count !== null) signals.push({ weight: 0.15, changed: previous.like_count !== current.like_count });
  if (previous.comment_count !== null && current.comment_count !== null) signals.push({ weight: 0.15, changed: previous.comment_count !== current.comment_count });
  const prior = unit(previousProbability);
  if (signals.length === 0) return prior;
  const weight = signals.reduce((total, signal) => total + signal.weight, 0);
  const observed = signals.reduce((total, signal) => total + (signal.changed ? signal.weight : 0), 0) / weight;
  const alpha = RECENT_SAMPLING.changeEwmaAlpha;
  return prior === null ? observed : (alpha * observed) + ((1 - alpha) * prior);
}
