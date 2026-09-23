/** DESIGN PREVIEW ONLY. Invented channels at production volume, shown only
 * behind the explicit "预览示例数据" switch under a warning banner. The default
 * view uses the real channel and completeness APIs. */
import type { PlanStatus } from '@crawlsystem/contracts';

export interface ChannelSampleRow {
  id: string; title: string; handle: string; color: string; country: string; category: string; subscribers: string; videos: number;
  lastUpdate: string; nextUpdate: string; freshness: 'ok' | 'overdue' | 'paused'; plan: PlanStatus; agent: string;
}
export const channelsSample = {
  kpis: { total: 426318, complete: 392104, partial: 21480, missing: 12734, overdue: 21043, paused: 8732 },
  tabs: { all: 426318, ok: 392104, overdue: 21043, paused: 8732 },
  rows: [
    { id: 'UCsample0001', title: '星野科技评测', handle: '@hoshino-tech', color: '#3f7fe0', country: '日本', category: '科技数码', subscribers: '128 万', videos: 1146, lastUpdate: '09-20', nextUpdate: '09-27', freshness: 'ok', plan: 'COMPLETED', agent: '已完成' },
    { id: 'UCsample0002', title: 'Daily Chef Lab', handle: '@dailycheflab', color: '#1fa88a', country: '美国', category: '美食', subscribers: '84 万', videos: 612, lastUpdate: '09-21', nextUpdate: '09-28', freshness: 'ok', plan: 'RUNNING', agent: '运行中' },
    { id: 'UCsample0003', title: 'Kanal Ekonomi', handle: '@kanalekonomi', color: '#d8a31f', country: '土耳其', category: '财经', subscribers: '241 万', videos: 1893, lastUpdate: '09-18', nextUpdate: '09-25', freshness: 'overdue', plan: 'WAITING', agent: '等待配额' },
    { id: 'UCsample0004', title: 'Orbit Notes', handle: '@orbitnotes', color: '#0e7490', country: '美国', category: '科普', subscribers: '224 万', videos: 268, lastUpdate: '09-20', nextUpdate: '09-27', freshness: 'ok', plan: 'COMPLETED', agent: '已完成' },
    { id: 'UCsample0005', title: 'Web Forge', handle: '@webforge', color: '#e24e3a', country: '德国', category: '开发', subscribers: '21 万', videos: 512, lastUpdate: '09-17', nextUpdate: '09-24', freshness: 'ok', plan: 'FAILED', agent: '失败' },
    { id: 'UCsample0006', title: 'Moto Trails BR', handle: '@mototrailsbr', color: '#e0782f', country: '巴西', category: '汽车', subscribers: '35.6 万', videos: 408, lastUpdate: '09-19', nextUpdate: '09-26', freshness: 'ok', plan: 'COMPLETED', agent: '已完成' },
    { id: 'UCsample0007', title: 'Studio Pastel', handle: '@studiopastel', color: '#b35ad9', country: '法国', category: '设计', subscribers: '9.1 万', videos: 233, lastUpdate: '09-15', nextUpdate: '09-22', freshness: 'overdue', plan: 'WAITING', agent: '等待输入' },
    { id: 'UCsample0008', title: 'Circuit Hours', handle: '@circuithours', color: '#15803d', country: '美国', category: '计算机', subscribers: '17 万', videos: 1024, lastUpdate: '09-16', nextUpdate: '—', freshness: 'paused', plan: 'CANCELLED', agent: '已暂停' },
    { id: 'UCsample0009', title: 'Pixel Arcade KR', handle: '@pixelarcadekr', color: '#e24e7a', country: '韩国', category: '游戏', subscribers: '71.3 万', videos: 954, lastUpdate: '09-21', nextUpdate: '09-28', freshness: 'ok', plan: 'COMPLETED', agent: '已完成' },
    { id: 'UCsample0010', title: 'Little Green Thumb', handle: '@littlegreenthumb', color: '#39a852', country: '英国', category: '园艺', subscribers: '4.9 万', videos: 176, lastUpdate: '09-14', nextUpdate: '09-21', freshness: 'overdue', plan: 'COMPLETED', agent: '已完成' },
  ] as ChannelSampleRow[],
  detail: {
    joined: '2016-04-12', views: '3.13 亿', verified: true, lastRun: '09-20 14:23', okStreak: 56, failStreak: 0, group: '日本 · 科技数码',
    policies: [{ domain: '频道资料', every: '每 30 天', next: '10-05' }, { domain: '视频与评论', every: '每 7 天', next: '09-27' }, { domain: 'Agent 画像', every: '每 14 天', next: '10-04' }],
  },
};
