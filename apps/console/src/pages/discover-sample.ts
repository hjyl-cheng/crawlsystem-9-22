/** DESIGN PREVIEW ONLY. The Discover backend does not exist yet; these figures
 * are invented to show the page layout and are rendered only behind the explicit
 * "预览示例数据" switch, under a warning banner. Delete once the API exists. */
export interface DiscoverView {
  kpis: { label: string; value: number; delta: string; compare: string; total: string }[];
  funnel: { label: string; value: number; note: string; badge: string; tone: 'green' | 'blue' | 'amber' | 'slate' }[];
  sources: { label: string; count: number; color: string }[];
  countries: { name: string; count: number; code?: string }[];
  categories: { name: string; count: number; code?: string }[];
  statuses: { key: 'pending' | 'running' | 'cooldown' | 'lowyield' | 'disabled'; count: number }[];
  policies: { window: string; rule: string; next: string }[];
  alerts: { tone: 'red' | 'amber' | 'blue'; count: number; title: string; detail: string; when: string }[];
  queries: { term: string; country: string; category: string; source: string; window: string; status: 'pending' | 'running' | 'cooldown' | 'lowyield' | 'disabled'; last: string; next: string; found: number; unique: number; full: number }[];
  top: { term: string; found: number; unique: number }[];
}

export const discoverSample: DiscoverView = {
  kpis: [
    { label: '今日执行 Query', value: 1284, delta: '+12.5%', compare: '较昨日 +143', total: '累计 12,840' },
    { label: '今日发现频道', value: 342, delta: '+28.1%', compare: '较昨日 +75', total: '累计 3,421' },
    { label: '去重后新频道', value: 210, delta: '+16.7%', compare: '去重率 38.6%', total: '累计 1,892' },
    { label: '转入全量采集', value: 48, delta: '+60.0%', compare: '较昨日 +18', total: '累计 412' },
  ],
  // One basis throughout: today's flow. The standing Query pool is shown separately, never as a funnel step.
  funnel: [
    { label: '今日执行', value: 1284, note: '完成 1,187 次', badge: '完成率 92.4%', tone: 'green' },
    { label: '发现频道', value: 342, note: '搜索结果中的频道', badge: '较昨日 +28.1%', tone: 'green' },
    { label: '去重后', value: 210, note: '排除已纳管与重复', badge: '去重率 38.6%', tone: 'slate' },
    { label: '进入候选', value: 196, note: '通过基础准入', badge: '待评估 196', tone: 'blue' },
    { label: '转入全量', value: 48, note: '候选审核通过', badge: '转化率 24.5%', tone: 'green' },
  ],
  sources: [
    { label: '手工关键词', count: 96, color: '#277cf7' }, { label: '标签派生', count: 77, color: '#11c38c' },
    { label: '视频标题', count: 64, color: '#ffad21' }, { label: '频道简介', count: 42, color: '#ff8a4c' },
    { label: '相关搜索', count: 39, color: '#c05cf0' }, { label: 'Agent 建议', count: 24, color: '#8fb4ff' },
  ],
  countries: [{ name: '美国', code: 'US', count: 97 }, { name: '日本', code: 'JP', count: 62 }, { name: '巴西', code: 'BR', count: 43 }, { name: '英国', code: 'GB', count: 35 }, { name: '其他', count: 105 }],
  categories: [{ name: '科技数码', count: 88 }, { name: '教育', count: 71 }, { name: '旅行', count: 52 }, { name: '美食', count: 47 }, { name: '其他', count: 84 }],
  statuses: [{ key: 'pending', count: 426 }, { key: 'running', count: 583 }, { key: 'cooldown', count: 178 }, { key: 'lowyield', count: 64 }, { key: 'disabled', count: 32 }],
  policies: [
    { window: '上传时间：近一年', rule: '高频执行，发现新热点', next: '09-22 22:00' },
    { window: '上传时间：近一月', rule: '中频执行，平衡成本', next: '09-22 23:30' },
    { window: '上传时间：近一周', rule: '低频执行，长尾挖掘', next: '09-23 02:00' },
  ],
  alerts: [
    { tone: 'red', count: 12, title: '个 Query 连续两次无新增频道', detail: '建议检查关键词或调整国家 / 分类', when: '2 小时前' },
    { tone: 'amber', count: 3, title: '个 Query 缺少国家或分类', detail: '请补充，影响去重与路由', when: '5 小时前' },
    { tone: 'blue', count: 1, title: '个 Query 命中异常增长', detail: '“ai tools” 24 小时新增 120 个频道', when: '6 小时前' },
  ],
  queries: [
    { term: 'ai tools', country: '美国', category: '科技数码', source: '手工关键词', window: '近一周', status: 'running', last: '09-22 20:15', next: '09-22 22:00', found: 120, unique: 72, full: 18 },
    { term: 'python tutorial', country: '美国', category: '教育', source: '标签派生', window: '近一月', status: 'running', last: '09-22 19:30', next: '09-22 23:30', found: 86, unique: 51, full: 12 },
    { term: 'travel japan', country: '日本', category: '旅行', source: '视频标题', window: '近一周', status: 'cooldown', last: '09-22 18:12', next: '09-23 02:00', found: 64, unique: 38, full: 9 },
    { term: 'cooking recipes', country: '美国', category: '美食', source: '频道简介', window: '近一月', status: 'pending', last: '09-21 16:40', next: '09-22 23:30', found: 42, unique: 28, full: 6 },
    { term: 'football highlights', country: '英国', category: '体育', source: '相关搜索', window: '近一周', status: 'running', last: '09-22 20:05', next: '09-22 22:00', found: 38, unique: 25, full: 8 },
    { term: 'beauty tips', country: '美国', category: '美妆', source: 'Agent 建议', window: '近一月', status: 'lowyield', last: '09-21 14:20', next: '09-22 23:30', found: 38, unique: 18, full: 4 },
    { term: 'home workout', country: '巴西', category: '健身', source: '标签派生', window: '近一年', status: 'disabled', last: '09-18 09:10', next: '—', found: 11, unique: 3, full: 0 },
  ],
  top: [
    { term: 'ai tools', found: 120, unique: 72 }, { term: 'python tutorial', found: 86, unique: 51 }, { term: 'travel japan', found: 64, unique: 38 },
    { term: 'cooking recipes', found: 42, unique: 28 }, { term: 'football highlights', found: 38, unique: 25 }, { term: 'beauty tips', found: 36, unique: 18 },
    { term: 'make money online', found: 28, unique: 16 }, { term: 'iphone review', found: 24, unique: 14 }, { term: 'world news', found: 22, unique: 12 }, { term: 'fitness workout', found: 20, unique: 11 },
  ],
};
