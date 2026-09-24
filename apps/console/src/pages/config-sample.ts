/** DESIGN PREVIEW ONLY. There is no configuration centre in M1: runtime parameters
 * live in deployment manifests and environment variables. These items are invented
 * and shown only behind the explicit "预览示例数据" switch under a warning banner.
 * Operators are placeholder accounts, and no value here is the one actually deployed. */
export type ConfigState = 'active' | 'pending' | 'draft' | 'disabled';
export type Risk = 'low' | 'medium' | 'high';
export interface ConfigItem { name: string; key: string; group: string; value: string; defaultValue: string; state: ConfigState; risk: Risk; updated: string; operator: string; scope: string; description: string }
export interface ConfigView {
  kpis: { total: number; active: number; pending: number; draft: number; high: number; changes7d: number };
  items: ConfigItem[];
  changes: { time: string; name: string; before: string; after: string; operator: string; result: 'published' | 'pending' | 'draft' }[];
  checks: { required: [number, number]; highRisk: number; references: [number, number]; pending: number };
  groups: { group: string; count: number }[];
}

export const configSample: ConfigView = {
  kpis: { total: 128, active: 102, pending: 3, draft: 5, high: 16, changes7d: 28 },
  items: [
    { name: '更新采集默认并发', key: 'update.default_concurrency', group: '更新采集', value: '24', defaultValue: '16', state: 'active', risk: 'medium', updated: '09/22 20:14', operator: 'admin', scope: '所有更新采集计划', description: '单个 Worker 同时执行的更新采集计划数上限，超出后排队等待。' },
    { name: 'Agent 批量上限', key: 'agent.batch.max_channels', group: 'Agent 任务', value: '30', defaultValue: '20', state: 'active', risk: 'medium', updated: '09/22 18:32', operator: 'operator-a', scope: '所有 Agent 画像分析任务', description: '一次 Agent 批处理最多包含的频道数，用于控制内存与模型调用压力。' },
    { name: 'Data API 重试次数', key: 'data_api.retry.max_attempts', group: '数据 API', value: '3', defaultValue: '3', state: 'active', risk: 'low', updated: '09/22 17:20', operator: 'operator-b', scope: '所有外部 API 调用', description: '单次外部 API 调用失败后的最大尝试次数，超出后计划进入等待或失败。' },
    { name: 'Query 默认周期', key: 'query.default.window', group: 'Query 发现', value: 'this_week', defaultValue: 'last_7_days', state: 'pending', risk: 'medium', updated: '09/22 16:05', operator: 'operator-c', scope: '新建 Query', description: '新建 Query 未指定时间范围时使用的搜索发布时间窗口。' },
    { name: '交付最大重试', key: 'delivery.retry.max_attempts', group: '发布交付', value: '5', defaultValue: '5', state: 'active', risk: 'medium', updated: '09/22 15:11', operator: 'operator-d', scope: '所有下游交付目标', description: '下游接收端未确认时的最大重投次数，超出后进入人工处理。' },
    { name: 'IP 冷却时长', key: 'proxy.ip.cooldown_minutes', group: 'IP 资源', value: '20', defaultValue: '10', state: 'active', risk: 'high', updated: '09/22 12:03', operator: 'operator-e', scope: '所有代理 IP', description: '代理 IP 被限流后暂停分配的分钟数，到期自动恢复。' },
    { name: 'Worker 心跳超时', key: 'worker.heartbeat.timeout_seconds', group: 'Worker', value: '60', defaultValue: '30', state: 'draft', risk: 'high', updated: '09/22 10:21', operator: 'operator-f', scope: '所有 Worker', description: '超过该时长未收到心跳即视为失联，不再分配新任务。' },
    { name: '原始响应保留天数', key: 'data.raw_response.retention_days', group: '系统', value: '30', defaultValue: '14', state: 'active', risk: 'high', updated: '09/22 09:18', operator: 'operator-g', scope: '采集原始响应', description: '用于诊断的原始响应保存期限；仍被恢复或重放需要的数据不会被清理。' },
  ],
  changes: [
    { time: '09/22 18:32', name: 'Agent 批量上限', before: '20', after: '30', operator: 'operator-a', result: 'published' },
    { time: '09/22 16:05', name: 'Query 默认周期', before: 'last_7_days', after: 'this_week', operator: 'operator-c', result: 'pending' },
    { time: '09/22 12:03', name: 'IP 冷却时长', before: '10', after: '20', operator: 'operator-e', result: 'published' },
    { time: '09/21 20:14', name: '更新采集默认并发', before: '16', after: '24', operator: 'admin', result: 'published' },
    { time: '09/21 15:11', name: 'Worker 心跳超时', before: '30', after: '60', operator: 'operator-f', result: 'draft' },
  ],
  checks: { required: [128, 128], highRisk: 16, references: [128, 128], pending: 3 },
  groups: [
    { group: '更新采集', count: 16 }, { group: 'Query 发现', count: 10 }, { group: 'Agent 任务', count: 18 }, { group: '数据 API', count: 14 },
    { group: 'IP 资源', count: 20 }, { group: 'Worker', count: 12 }, { group: '发布交付', count: 12 }, { group: '系统', count: 26 },
  ],
};
