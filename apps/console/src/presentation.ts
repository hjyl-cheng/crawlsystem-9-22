import type { BusinessCategory, ChannelClock, ClockName, Domain, ErrorCode, ManagementState, PlanStatus, Plan, Role } from '@crawlsystem/contracts';

export const planLabels: Record<PlanStatus, string> = {
  QUEUED: '等待执行', RUNNING: '执行中', WAITING: '等待依赖', COMPLETED: '本轮已完成', CANCELLED: '已取消', FAILED: '执行失败',
};
export const domainLabels: Record<Domain, string> = { ABOUT: '频道基础信息', VIDEO: '视频与评论', AGENT: 'Agent 分析' };
/** Short labels for error-code chips; full sentences live in api.ts. */
export const errorCodeLabels: Record<ErrorCode, string> = {
  INVALID_REQUEST: '请求不合规', UNAUTHENTICATED: '身份失效', FORBIDDEN: '无权限', NOT_FOUND: '对象不存在', CONFLICT: '状态冲突',
  STALE_EXECUTION: '执行代次过期', PLAN_TERMINAL: '计划已结束', INPUT_MISMATCH: '输入版本不符', TARGET_MISMATCH: '超出目标范围',
  DOMAIN_INCOMPLETE: '领域未完整', DOMAIN_NOT_REQUIRED: '非必需领域', DEPENDENCY_NOT_IMPLEMENTED: '能力未接入',
  BUDGET_EXHAUSTED: '预算耗尽', UNAVAILABLE: '依赖不可用', INTERNAL_ERROR: '内部错误',
};
export const roleLabels: Record<Role, string> = { reader: '只读用户', operator: '操作员', worker: '执行身份', node: '节点代理身份' };
export const isTerminal = (plan: Plan) => ['COMPLETED', 'CANCELLED', 'FAILED'].includes(plan.status);
export const time = (value?: string | number | null): string => value == null ? '尚未提供' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(new Date(value));
export const number = (value?: number | null): string => value == null ? '未知' : new Intl.NumberFormat('zh-CN').format(value);
export const shortId = (value: string) => value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
export const planPath = (id: string) => `/plans/${encodeURIComponent(id)}`;
export const channelPath = (id: string) => `/channels/${encodeURIComponent(id)}`;
// M3 update clocks: what each clock covers and why it is due when it is.
export const clockLabels: Record<ClockName, string> = { ABOUT: '频道资料', VIDEO: '视频与评论', AGENT: 'Agent 画像' };
/** Plain words for the legacy policy's reason codes (packages/feature-clock); internal bookkeeping codes have none. */
const reasonText: Record<string, string> = {
  manual_override: '人工指定的间隔', clock_bootstrap_baseline: '这部分还没采集过，先按默认周期',
  // 频道资料
  about_baseline: '第一次采集资料', about_cold_start_cadence_fallback: '发布节奏还看不出来，先按 7 天',
  growth_percentile_critical: '订阅或播放增长排在前 10%，每天更新',
  about_priority_very_high: '综合热度很高', about_priority_high: '综合热度较高', about_priority_elevated: '综合热度偏高', about_priority_active: '比较活跃',
  about_priority_medium: '热度中等', about_priority_low: '热度偏低', about_priority_very_low: '热度低', about_priority_minimal: '热度很低',
  about_priority_dormant: '基本不活跃', about_priority_deeply_dormant: '长期不活跃',
  video_count_increased: '视频数在增加，3 天内再看', about_long_interval_stability_cap: '稳定的时间还不够长，间隔暂不拉长',
  about_slowdown_one_tier: '每次最多放慢一档', subscriber_growth_reference_fallback: '订阅增长暂无排名可比，按中等算', view_growth_reference_fallback: '播放增长暂无排名可比，按中等算',
  about_cold_start_recalculation: '拿到更多数据后重新算过，提前了', video_activity_recalculation: '看到视频发布情况后重新算过，提前了', agent_cold_start_recalculation: '拿到更多数据后重新算过，提前了',
  // 视频
  discovery_baseline: '第一次采集视频', publish_interval_fallback: '发布间隔还不知道，按默认间隔', regular_publish_prediction: '发布很规律，赶在预计的下一条之前检查',
  regular_publish_window_elapsed: '预计的发布时间已过', high_collection_priority: '采集优先级高', active_irregular_channel: '活跃但发布不规律',
  cold_irregular_channel: '不太活跃且发布不规律', empty_run_backoff: '连续几次没有新视频，逐步放慢', automatic_video_min_interval: '视频最快每 3 天查一次',
  recent_sampling_skipped: '近期视频的播放数据还没复查，7 天内再看', recent_sampling_failed_retry_cap: '近期视频复查没成功，7 天内再看',
  recent_sampling_baseline: '第一次复查近期视频', recent_pool_empty: '近 30 天没有新视频',
  recent_sampling_priority_very_high: '近期视频变化很快', recent_sampling_priority_high: '近期视频变化较快', recent_sampling_priority_medium: '近期视频变化一般',
  recent_sampling_priority_low: '近期视频变化较慢', recent_sampling_priority_very_low: '近期视频几乎不变',
  about_video_count_hint: '资料显示视频数增加，提前检查视频', partial_retry_cap: '上次只采到一部分，尽快补齐',
  // Agent 画像
  agent_semantic_baseline: '第一次生成画像，180 天后复查', agent_cross_version_baseline: 'Agent 升级了，重新起算',
  agent_semantic_comparison_unavailable: '画像变化无法比较，按 180 天', agent_semantic_continuous_interval: '按画像变化大小：变化越小，间隔越长（60～365 天）',
  agent_forward_load_spread: '为错开高峰顺延了几天',
};
/** "按发布节奏，N 天后再看" and similar codes carrying a day count. */
function reasonLabel(code: string): string | undefined {
  const days = /^about_(cold_start_cadence|active_cadence_cap)_(\d+)d$/.exec(code);
  if (days) return days[1] === 'cold_start_cadence' ? `第一次采集，按发布节奏 ${days[2]} 天后再看` : `按发布节奏，最长 ${days[2]} 天`;
  return reasonText[code];
}
/** Why a clock is due when it is, in plain words (unknown and bookkeeping codes are left out). */
export const clockReasonText = (reasons: readonly string[]): string => [...new Set(reasons.map(reasonLabel).filter((text): text is string => !!text))].join('；') || '按更新规则计算';
export const managementLabels: Record<ManagementState | 'none', string> = { managed: '持续更新中', paused: '已暂停', removed: '已移出纳管', none: '未纳管' };
/** A clock's state as in the old dashboard: 待到期 / 待重试 / 今日到期 / 逾期, or 已暂停 for a paused channel. */
export function clockState(c: Pick<ChannelClock, 'next_due_at' | 'retry_at'>, state: ManagementState | null, now = Date.now()): { label: string; tone: 'muted' | 'warn' | 'bad' } {
  if (state === 'paused') return { label: '已暂停', tone: 'muted' };
  const due = Date.parse(c.next_due_at), endOfToday = new Date(now); endOfToday.setHours(24, 0, 0, 0);
  if (due <= now) return { label: '逾期', tone: 'bad' };
  if (due < endOfToday.getTime()) return { label: '今日到期', tone: 'warn' };
  return c.retry_at ? { label: '待重试', tone: 'warn' } : { label: '待到期', tone: 'muted' };
}
/** "3 天后" / "5 小时后" / "已到期", relative to now. */
export const dueIn = (value: string, now = Date.now()): string => {
  const hours = (Date.parse(value) - now) / 3_600_000;
  return hours <= 0 ? '已到期' : hours < 48 ? `${Math.ceil(hours)} 小时后` : `${Math.round(hours / 24)} 天后`;
};
export const receiptPath = (id: string) => `/receipts/${encodeURIComponent(id)}`;

/** Chinese labels of the 19 fixed business categories (24.8 §5.3); the English value is the stored one. */
export const categoryLabels: Record<BusinessCategory, string> = {
  Automotive: '汽车', 'Beauty Creators': '美妆博主', 'Casual Vlogs': '日常生活记录', Dance: '舞蹈', Education: '教育', Fashion: '时尚', Food: '美食', Gaming: '游戏',
  'General Humanities & Society': '综合人文与社会', 'Health & Wellness': '健康与养生', Home: '家居', Music: '音乐', Parenting: '育儿', 'Pets & Animals': '宠物与动物',
  'Self Improvement': '自我提升', 'Software & Internet': '软件与互联网', 'Sports & Outdoors': '体育与户外', Tech: '科技', Travel: '旅行',
};
