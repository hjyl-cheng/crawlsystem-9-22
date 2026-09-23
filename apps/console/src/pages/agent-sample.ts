/** DESIGN PREVIEW ONLY. Agent execution is not connected in M1; these invented
 * channels and results are shown only behind the explicit "预览示例数据" switch,
 * under a warning banner. The single Agent type is the channel profile analysis
 * with its ten fields (see docs/业务数据范围_旧系统字段参考). Delete once the API exists. */
export type AgentStatus = 'running' | 'waiting' | 'done' | 'failed' | 'paused';
export interface AgentTask {
  id: string; channel: string; handle: string; color: string; subscribers: string; region: string; category: string;
  trigger: string; fields: number; last: string; next: string; status: AgentStatus; priority: '高' | '中' | '低'; result: string; detail: string;
}
export interface AgentView {
  kpis: { total: number; running: number; doneToday: number; successRate: string; waiting: number; failed: number };
  tabs: Record<'all' | AgentStatus, number>;
  tasks: AgentTask[];
  profile: { label: string; value: string; confidence: '高' | '中' | '低' }[];
  run: { at: string; duration: string; model: string; taxonomy: string; inputVideos: number; inputComments: number };
}

export const agentSample: AgentView = {
  kpis: { total: 256, running: 12, doneToday: 186, successRate: '91.2%', waiting: 28, failed: 18 },
  tabs: { all: 256, running: 12, waiting: 28, done: 186, failed: 18, paused: 12 },
  tasks: [
    { id: 'AG-0921-001', channel: '星野科技评测', handle: '@hoshino-tech', color: '#3f7fe0', subscribers: '128 万', region: '日本', category: '科技数码', trigger: '全量采集后', fields: 10, last: '09-20 08:30', next: '09-27', status: 'done', priority: '高', result: '完成 10 / 10 项', detail: '耗时 3 分 28 秒' },
    { id: 'AG-0921-002', channel: 'Daily Chef Lab', handle: '@dailycheflab', color: '#1fa88a', subscribers: '84 万', region: '美国', category: '美食', trigger: '更新采集后', fields: 6, last: '09-21 10:12', next: '09-28', status: 'running', priority: '中', result: '处理中', detail: '已完成 6 / 10 项' },
    { id: 'AG-0921-003', channel: 'Orbit Notes', handle: '@orbitnotes', color: '#0e7490', subscribers: '224 万', region: '美国', category: '科普', trigger: '全量采集后', fields: 0, last: '09-19 16:40', next: '09-26', status: 'waiting', priority: '中', result: '等待模型配额', detail: '队列第 3 位' },
    { id: 'AG-0921-004', channel: 'Web Forge', handle: '@webforge', color: '#e24e3a', subscribers: '21 万', region: '德国', category: '开发', trigger: '更新采集后', fields: 7, last: '09-18 09:05', next: '09-25', status: 'failed', priority: '中', result: '执行失败', detail: '输出校验未通过：受众分布合计 ≠ 100' },
    { id: 'AG-0921-005', channel: 'Numberline Studio', handle: '@numberline', color: '#475569', subscribers: '64 万', region: '英国', category: '教育', trigger: '手动补跑', fields: 10, last: '09-20 14:02', next: '09-27', status: 'done', priority: '低', result: '完成 10 / 10 项', detail: '耗时 2 分 51 秒' },
    { id: 'AG-0921-006', channel: 'Circuit Hours', handle: '@circuithours', color: '#15803d', subscribers: '17 万', region: '美国', category: '计算机', trigger: '更新采集后', fields: 4, last: '09-17 11:20', next: '—', status: 'paused', priority: '低', result: '已暂停', detail: '操作员手动暂停' },
    { id: 'AG-0921-007', channel: 'Kanal Ekonomi', handle: '@kanalekonomi', color: '#d8a31f', subscribers: '241 万', region: '土耳其', category: '财经', trigger: '失败重试', fields: 10, last: '09-21 07:48', next: '09-28', status: 'done', priority: '高', result: '完成 10 / 10 项', detail: '耗时 4 分 06 秒' },
    { id: 'AG-0921-008', channel: 'Deep Talk Pod', handle: '@deeptalkpod', color: '#7c3aed', subscribers: '42 万', region: '美国', category: '播客', trigger: '全量采集后', fields: 0, last: '09-16 18:30', next: '09-23', status: 'waiting', priority: '中', result: '等待输入', detail: '评论首屏尚未入库' },
  ],
  profile: [
    { label: '创作者国家', value: '日本', confidence: '高' },
    { label: '创作者性别', value: '男性', confidence: '中' },
    { label: '创作者年龄', value: '约 32 岁', confidence: '低' },
    { label: '创作者语言', value: '日语', confidence: '高' },
    { label: '受众地区', value: '日本 58% · 美国 12% · 台湾地区 9%', confidence: '中' },
    { label: '受众语言', value: '日语 71% · 英语 15% · 中文 9%', confidence: '中' },
    { label: '受众年龄 / 性别', value: '25-34 岁男性最多（31%）', confidence: '低' },
    { label: '活跃订阅者比例', value: '约 38%', confidence: '低' },
    { label: '频道标签', value: '开箱、对比评测、iPhone、相机 等 10 项', confidence: '中' },
    { label: '频道分类', value: '科技数码 › 手机、摄影器材', confidence: '高' },
  ],
  run: { at: '09-20 08:30', duration: '3 分 28 秒', model: 'profile-2026.09', taxonomy: 'taxonomy-v3', inputVideos: 50, inputComments: 48 },
};
