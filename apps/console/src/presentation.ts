import type { ChannelClock, ClockName, ClockReason, Domain, ErrorCode, ManagementState, PlanStatus, Plan, Role } from '@crawlsystem/contracts';

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
export const clockReasonLabels: Record<ClockReason, string> = {
  first_collection: '首次采集后的初始间隔', manual_manage: '手动纳管后的初始间隔', baseline: '常规间隔',
  active_publishing: '近 14 天有发布，缩短为 3 天', new_video_active: '有新视频且近期活跃，缩短为 3 天',
  discovery_empty_backoff: '连续未发现新视频，逐步放慢', retry_after_failure: '上次未完成，安排重试（不推进常规周期）',
  manual_override: '人工指定间隔',
};
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
