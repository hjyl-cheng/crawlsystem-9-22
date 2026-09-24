import type { Domain, ErrorCode, PlanStatus, Plan, Role } from '@crawlsystem/contracts';

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
export const receiptPath = (id: string) => `/receipts/${encodeURIComponent(id)}`;
