/** DESIGN PREVIEW ONLY. Publication to downstream business systems is not
 * enabled in M1 (every plan reports publication_status NOT_ENABLED); these
 * invented channels, consumers and receipts are shown only behind the explicit
 * "预览示例数据" switch, under a warning banner. Delete once delivery exists.
 * States follow the architecture: SENT is not DELIVERED until the consumer's
 * receipt is recorded. */
export type DeliveryStatus = 'not_ready' | 'ready' | 'sent' | 'delivered' | 'failed';
export interface DeliveryRow {
  id: string; channel: string; handle: string; color: string; revision: number; collectedAt: string;
  target: string; topic: string; status: DeliveryStatus; lastAt: string | null; receipt: string; receiptDetail: string;
}
export interface DeliveryView {
  kpis: { ready: number; readyDelta: string; deliveredToday: number; deliveredMonth: number; sent: number; oldestSent: string; failed: number; failRate: string };
  tabs: Record<'all' | DeliveryStatus, number>;
  rows: DeliveryRow[];
  week: { sent: number; accepted: number; failed: number; rate: string };
  log: { step: string; at: string; done: boolean; note?: string }[];
}

export const deliverySample: DeliveryView = {
  kpis: { ready: 28, readyDelta: '-12', deliveredToday: 56, deliveredMonth: 1284, sent: 12, oldestSent: '8 分钟', failed: 6, failRate: '8.7%' },
  tabs: { all: 128, not_ready: 18, ready: 28, sent: 12, delivered: 64, failed: 6 },
  rows: [
    { id: 'PUB-0923-001', channel: '星野科技评测', handle: '@hoshino-tech', color: '#3f7fe0', revision: 42, collectedAt: '09-23 10:02', target: '业务系统 A', topic: 'channel.profile.v1', status: 'delivered', lastAt: '09-23 10:24', receipt: '已接受', receiptDetail: '业务回执 10:24' },
    { id: 'PUB-0923-002', channel: 'Daily Chef Lab', handle: '@dailycheflab', color: '#1fa88a', revision: 17, collectedAt: '09-23 10:51', target: '业务系统 A', topic: 'channel.profile.v1', status: 'sent', lastAt: '09-23 11:05', receipt: '待确认', receiptDetail: '已发送 8 分钟' },
    { id: 'PUB-0923-003', channel: 'Moto Trails BR', handle: '@mototrailsbr', color: '#e0782f', revision: 9, collectedAt: '09-23 09:40', target: '业务系统 B', topic: 'channel.profile.v1', status: 'ready', lastAt: null, receipt: '—', receiptDetail: '等待发布窗口' },
    { id: 'PUB-0923-004', channel: 'Pixel Arcade KR', handle: '@pixelarcadekr', color: '#e24e7a', revision: 31, collectedAt: '09-22 16:32', target: '业务系统 A', topic: 'channel.profile.v1', status: 'delivered', lastAt: '09-22 16:40', receipt: '已接受', receiptDetail: '业务回执 16:40' },
    { id: 'PUB-0923-005', channel: 'Little Green Thumb', handle: '@littlegreenthumb', color: '#39a852', revision: 3, collectedAt: '09-22 14:08', target: '业务系统 B', topic: 'channel.profile.v1', status: 'not_ready', lastAt: null, receipt: '—', receiptDetail: 'Agent 画像未完成' },
    { id: 'PUB-0923-006', channel: 'Studio Pastel', handle: '@studiopastel', color: '#b35ad9', revision: 12, collectedAt: '09-23 09:01', target: '业务系统 A', topic: 'channel.profile.v1', status: 'failed', lastAt: '09-23 09:12', receipt: '业务拒绝', receiptDetail: '字段 channel_categories 版本不匹配' },
    { id: 'PUB-0923-007', channel: 'Kanal Ekonomi', handle: '@kanalekonomi', color: '#d8a31f', revision: 55, collectedAt: '09-21 19:20', target: '业务系统 A', topic: 'channel.profile.v1', status: 'delivered', lastAt: '09-21 19:36', receipt: '已接受', receiptDetail: '业务回执 19:36' },
    { id: 'PUB-0923-008', channel: 'Deep Talk Pod', handle: '@deeptalkpod', color: '#7c3aed', revision: 6, collectedAt: '09-23 08:40', target: '业务系统 B', topic: 'channel.profile.v1', status: 'sent', lastAt: '09-23 08:50', receipt: '待确认', receiptDetail: '已发送 2 小时，超过确认时限' },
  ],
  week: { sent: 12, accepted: 10, failed: 0, rate: '100%' },
  log: [
    { step: '发布资格满足', at: '09-23 10:02', done: true, note: '资料、视频、评论、Agent 画像均已入库（版本 r42）' },
    { step: '写入 Outbox', at: '09-23 10:02', done: true },
    { step: '发送至 Kafka', at: '09-23 10:03', done: true, note: 'channel.profile.v1' },
    { step: '业务系统接收', at: '09-23 10:23', done: true, note: '业务系统 A · Inbox 已记录' },
    { step: '业务回执：已交付', at: '09-23 10:24', done: true },
  ],
};
