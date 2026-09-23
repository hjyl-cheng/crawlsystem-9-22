/** DESIGN PREVIEW ONLY. The Data API branch (collector-side calls to external
 * data APIs such as the YouTube Data API) is not connected in M1; these figures
 * are invented and shown only behind the explicit "预览示例数据" switch, under a
 * warning banner. Delete once the API exists. */
export interface DataApiView {
  kpis: { calls: number; callsDelta: string; successRate: string; failed: number; quotaUsed: number; quotaTotal: number; avgMs: number; p95Ms: number };
  trend: { day: string; ok: number; failed: number }[];
  statuses: { label: string; count: number; color: string }[];
  reasons: { code: number; reason: string; label: string; count: number }[];
  endpoints: { name: string; purpose: string; cost: number; calls: number; rate: string; avgMs: number; enabled: boolean }[];
  keys: { name: string; used: number; total: number; state: 'ok' | 'near' | 'exhausted' }[];
  failures: { at: string; endpoint: string; code: number; reason: string; plan: string }[];
}

const days = Array.from({ length: 30 }, (_, i) => `09-${String(i + 1).padStart(2, '0')}`);
const ok = [3120, 3380, 3010, 3560, 3720, 3240, 3490, 3910, 4020, 3680, 3850, 4210, 3960, 4120, 4380, 4050, 4270, 4610, 4330, 4480, 4720, 4390, 4560, 4810, 4630, 4950, 4700, 4880, 5040, 4920];
const failed = [62, 71, 58, 84, 95, 66, 73, 121, 104, 77, 81, 133, 96, 88, 142, 90, 94, 160, 101, 97, 118, 92, 99, 151, 107, 124, 98, 103, 119, 111];

export const dataApiSample: DataApiView = {
  kpis: { calls: 5031, callsDelta: '+2.3%', successRate: '97.8%', failed: 111, quotaUsed: 7420, quotaTotal: 10000, avgMs: 420, p95Ms: 980 },
  trend: days.map((day, i) => ({ day, ok: ok[i]!, failed: failed[i]! })),
  statuses: [{ label: '成功', count: 4920, color: '#11c38c' }, { label: '客户端错误（4xx）', count: 86, color: '#ffad21' }, { label: '服务端错误（5xx）', count: 25, color: '#e0524a' }],
  reasons: [
    { code: 403, reason: 'quotaExceeded', label: '配额用尽', count: 41 }, { code: 429, reason: 'rateLimitExceeded', label: '请求过快', count: 28 },
    { code: 404, reason: 'notFound', label: '视频或频道不存在', count: 17 }, { code: 503, reason: 'backendError', label: '上游服务错误', count: 15 }, { code: 400, reason: 'badRequest', label: '参数错误', count: 10 },
  ],
  endpoints: [
    { name: 'channels.list', purpose: '频道资料与统计补充', cost: 1, calls: 1284, rate: '99.2%', avgMs: 320, enabled: true },
    { name: 'playlistItems.list', purpose: '频道上传视频列表', cost: 1, calls: 1102, rate: '98.6%', avgMs: 280, enabled: true },
    { name: 'videos.list', purpose: '视频详情与播放统计', cost: 1, calls: 1856, rate: '97.9%', avgMs: 410, enabled: true },
    { name: 'commentThreads.list', purpose: '首屏评论补充', cost: 1, calls: 742, rate: '95.1%', avgMs: 520, enabled: true },
    { name: 'search.list', purpose: 'Query 发现兜底搜索', cost: 100, calls: 47, rate: '97.9%', avgMs: 610, enabled: true },
    { name: 'captions.list', purpose: '字幕列表（未使用）', cost: 50, calls: 0, rate: '—', avgMs: 0, enabled: false },
  ],
  keys: [
    { name: '项目 A · key-01', used: 7420, total: 10000, state: 'near' },
    { name: '项目 B · key-02', used: 10000, total: 10000, state: 'exhausted' },
    { name: '项目 C · key-03', used: 2180, total: 10000, state: 'ok' },
  ],
  failures: [
    { at: '09-30 14:23', endpoint: 'videos.list', code: 429, reason: 'rateLimitExceeded', plan: 'plan_00121' },
    { at: '09-30 14:21', endpoint: 'channels.list', code: 404, reason: 'channelNotFound', plan: 'plan_00118' },
    { at: '09-30 14:18', endpoint: 'commentThreads.list', code: 403, reason: 'commentsDisabled', plan: 'plan_00120' },
    { at: '09-30 14:17', endpoint: 'videos.list', code: 503, reason: 'backendError', plan: 'plan_00117' },
    { at: '09-30 14:15', endpoint: 'search.list', code: 403, reason: 'quotaExceeded', plan: 'plan_00116' },
  ],
};
