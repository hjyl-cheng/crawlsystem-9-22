/** DESIGN PREVIEW ONLY. Invented figures that show the full-collection page at
 * production volume; rendered only behind the explicit "预览示例数据" switch,
 * under a warning banner. The default view uses the real plan APIs. */
import type { PlanStatus, PlansSummary } from '@crawlsystem/contracts';

/** Approved candidate channels feeding full collection (candidate backend not built yet). */
export const approvedCandidatesSample = 1412;
export interface PlansSampleRow { id: string; channel: string; domains: { domain: 'ABOUT' | 'VIDEO' | 'AGENT'; applied: boolean }[]; status: PlanStatus; waiting: string | null; created: string; updated: string }
export const plansSummarySample: PlansSummary = {
  observed_at: '2026-09-22T13:21:00.000Z', total: 1236,
  by_status: { QUEUED: 156, RUNNING: 89, WAITING: 28, COMPLETED: 621, CANCELLED: 280, FAILED: 62 },
  created_24h: 412, completed_24h: 328, avg_completion_seconds_24h: 10080,
  domains: [{ domain: 'ABOUT', required: 1236, applied: 1097 }, { domain: 'AGENT', required: 1236, applied: 758 }, { domain: 'VIDEO', required: 1236, applied: 946 }],
  waiting_reasons: [{ reason: '代理不足', plans: 14 }, { reason: 'Agent 等待', plans: 9 }, { reason: 'API 回流', plans: 7 }, { reason: 'Ingest 排队', plans: 5 }, { reason: '人工介入', plans: 4 }, { reason: '其他', plans: 2 }],
};
export const plansErrorsSample = [
  { at: '09-22 21:10', phase: 'Agent', message: 'Agent 请求超时', plan: 'plan_00120' },
  { at: '09-22 20:33', phase: 'API', message: 'API 回流数据为空', plan: 'plan_00121' },
  { at: '09-22 19:56', phase: 'Ingest', message: '数据校验失败', plan: 'plan_00118' },
  { at: '09-22 18:22', phase: '主采集', message: '代理连接失败', plan: 'plan_00120' },
  { at: '09-22 17:43', phase: 'Worker', message: '节点负载过高', plan: 'plan_00117' },
];
const d = (about: boolean, video: boolean, agent: boolean) => [{ domain: 'ABOUT' as const, applied: about }, { domain: 'VIDEO' as const, applied: video }, { domain: 'AGENT' as const, applied: agent }];
export const plansListSample: PlansSampleRow[] = [
  { id: 'plan_00123', channel: '星野科技评测', domains: d(true, true, false), status: 'RUNNING', waiting: null, created: '09-22 20:18', updated: '09-22 21:28' },
  { id: 'plan_00122', channel: 'Daily Chef Lab', domains: d(true, true, false), status: 'RUNNING', waiting: null, created: '09-22 19:56', updated: '09-22 21:18' },
  { id: 'plan_00121', channel: 'Moto Trails BR', domains: d(true, true, false), status: 'WAITING', waiting: 'API 回流', created: '09-22 18:43', updated: '09-22 21:12' },
  { id: 'plan_00120', channel: 'Numberline Studio', domains: d(true, false, false), status: 'WAITING', waiting: '代理不足', created: '09-22 17:22', updated: '09-22 21:10' },
  { id: 'plan_00119', channel: 'Deep Talk Pod', domains: d(true, true, true), status: 'COMPLETED', waiting: null, created: '09-22 16:05', updated: '09-22 20:40' },
  { id: 'plan_00118', channel: 'Web Forge', domains: d(true, true, false), status: 'FAILED', waiting: null, created: '09-22 15:18', updated: '09-22 19:56' },
  { id: 'plan_00117', channel: 'Orbit Notes', domains: d(true, false, false), status: 'RUNNING', waiting: null, created: '09-22 14:03', updated: '09-22 21:02' },
  { id: 'plan_00116', channel: 'Circuit Hours', domains: d(true, true, false), status: 'WAITING', waiting: 'Agent 等待', created: '09-22 12:41', updated: '09-22 20:55' },
];
