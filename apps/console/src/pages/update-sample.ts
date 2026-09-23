/** DESIGN PREVIEW ONLY. The update-collection backend (Clock scheduling and
 * refresh plans) does not exist yet; these invented channels and figures are
 * shown only behind the explicit "预览示例数据" switch, under a warning banner.
 * Delete once the API exists. */
export type UpdateStatus = 'due' | 'running' | 'overdue' | 'quota' | 'agent' | 'done' | 'recovering';
export interface UpdateView {
  kpis: { value: string; compare: string; delta: string; up: boolean; good: boolean; foot?: string }[];
  flow: { queue: number; running: number; agent: number; api: number; applied: string; current: number };
  tasks: { channel: string; region: string; content: string; lastOk: string; next: string; status: UpdateStatus; waiting: string | null; result: string | null; worker: string }[];
  waiting: { label: string; count: number; color: string }[];
  nodes: { node: string; running: number; idle: number; failed: number; total: number }[];
  incidents: { at: string; group: string; channels: number; state: 'pending' | 'partial' | 'resolved' }[];
  completed: { channel: string; content: string; at: string; result: string }[];
}

export const updateSample: UpdateView = {
  kpis: [
    { value: '256', compare: '较昨日', delta: '+12.8%', up: true, good: true },
    { value: '198', compare: '较昨日', delta: '+6.4%', up: true, good: true, foot: '更新成功率 97.1%' },
    { value: '32', compare: '较昨日', delta: '-20.0%', up: false, good: true },
    { value: '18', compare: '较昨日', delta: '+50.0%', up: true, good: false },
  ],
  flow: { queue: 32, running: 14, agent: 6, api: 4, applied: '2 / 2', current: 198 },
  tasks: [
    { channel: '星野科技评测', region: '日本 / 科技', content: '新视频 + 统计', lastOk: '09-21', next: '09-22', status: 'due', waiting: null, result: null, worker: 'update-a1-03' },
    { channel: 'Daily Chef Lab', region: '美国 / 美食', content: '新视频 + 评论', lastOk: '09-21', next: '09-22', status: 'running', waiting: null, result: '抓取中 68%', worker: 'update-a2-01' },
    { channel: 'Kanal Ekonomi', region: '土耳其 / 财经', content: '新视频 + 统计', lastOk: '09-20', next: '09-21', status: 'overdue', waiting: '等待 Worker', result: '上次超时', worker: 'update-s3-02' },
    { channel: 'Orbit Notes', region: '美国 / 科普', content: '频道资料', lastOk: '09-21', next: '09-22', status: 'quota', waiting: '等待配额', result: null, worker: '—' },
    { channel: 'Pixel Arcade KR', region: '韩国 / 游戏', content: '新视频 + 评论', lastOk: '09-21', next: '09-23', status: 'agent', waiting: '等待 Agent', result: null, worker: 'agent-s2-01' },
    { channel: 'Moto Trails BR', region: '巴西 / 汽车', content: '新视频 + 统计', lastOk: '09-21', next: '09-22', status: 'done', waiting: null, result: '成功 12 个视频', worker: 'update-a3-04' },
    { channel: 'Studio Pastel', region: '法国 / 设计', content: '新视频 + 统计', lastOk: '09-20', next: '09-22', status: 'recovering', waiting: '人工恢复', result: '重试中', worker: 'update-a1-02' },
    { channel: 'Deep Talk Pod', region: '美国 / 播客', content: '新视频 + 统计', lastOk: '09-21', next: '09-23', status: 'due', waiting: null, result: null, worker: 'update-a2-03' },
  ],
  waiting: [
    { label: '等待 Worker', count: 12, color: '#277cf7' }, { label: '等待配额', count: 8, color: '#ff8a4c' },
    { label: '等待 Agent', count: 6, color: '#ffad21' }, { label: '等待 API', count: 4, color: '#8b5cf6' }, { label: '人工暂停', count: 2, color: '#94a3b8' },
  ],
  nodes: [
    { node: 'A1-HK', running: 4, idle: 1, failed: 1, total: 6 }, { node: 'A2-HK', running: 3, idle: 2, failed: 0, total: 5 },
    { node: 'A3-SG', running: 2, idle: 3, failed: 1, total: 6 }, { node: 'S3-US', running: 1, idle: 2, failed: 0, total: 3 },
  ],
  incidents: [
    { at: '09-22 19:24', group: '请求超时（连接失败）', channels: 8, state: 'pending' },
    { at: '09-22 16:11', group: '解析失败（页面结构变化）', channels: 5, state: 'partial' },
    { at: '09-22 14:03', group: 'Agent 执行失败', channels: 3, state: 'pending' },
    { at: '09-22 10:21', group: '视频去重异常', channels: 2, state: 'resolved' },
  ],
  completed: [
    { channel: 'Moto Trails BR', content: '新视频 + 统计', at: '09-22 21:18', result: '成功 12 个视频' },
    { channel: 'Numberline Studio', content: '频道资料', at: '09-22 21:05', result: '资料已更新' },
    { channel: 'Circuit Hours', content: '新视频 + 评论', at: '09-22 20:47', result: '成功 8 个视频' },
    { channel: 'Web Forge', content: '视频统计', at: '09-22 20:31', result: '成功 96 个视频' },
    { channel: 'Little Green Thumb', content: '新视频 + 统计', at: '09-22 20:15', result: '成功 3 个视频' },
  ],
};
