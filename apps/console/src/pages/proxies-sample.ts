/** DESIGN PREVIEW ONLY. Proxy resources are not connected in M1 (fixture runs use
 * no proxy); these figures are invented and shown only behind the explicit
 * "预览示例数据" switch under a warning banner. Addresses come from the RFC 5737
 * documentation ranges and providers are unnamed, so nothing points at a real
 * host or vendor. Credentials are never shown in the console. */
export type IpState = 'healthy' | 'degraded' | 'cooldown' | 'failed' | 'disabled';
export interface ProxiesView {
  kpis: { total: number; totalDelta: string; providers: number; groups: number; healthy: number; healthyRate: string; cooldown: number; failed: number; requests: string; requestsDelta: string };
  ips: { ip: string; port: number; region: string; provider: string; group: string; state: IpState; success: string; latency: string; requests: number; checked: string; node: string }[];
  states: { state: IpState; count: number }[];
  providers: { name: string; count: number }[];
  groups: { name: string; count: number; color: string }[];
  providerStats: { name: string; ips: number; availability: string; requests: string }[];
  trend: { day: string; value: number }[];
}

export const proxiesSample: ProxiesView = {
  kpis: { total: 12480, totalDelta: '+5.2%', providers: 8, groups: 24, healthy: 10432, healthyRate: '83.6%', cooldown: 796, failed: 452, requests: '286.5 万', requestsDelta: '+12%' },
  ips: [
    { ip: '192.0.2.34', port: 8080, region: '美国', provider: '服务商 A', group: '美国住宅', state: 'healthy', success: '99.2%', latency: '320 ms', requests: 12832, checked: '1 分钟前', node: 'A1-HK' },
    { ip: '198.51.100.18', port: 1080, region: '新加坡', provider: '服务商 B', group: '亚洲数据中心', state: 'healthy', success: '98.6%', latency: '280 ms', requests: 8421, checked: '2 分钟前', node: 'A3-SG' },
    { ip: '203.0.113.23', port: 3128, region: '德国', provider: '服务商 C', group: '欧洲住宅', state: 'degraded', success: '91.8%', latency: '650 ms', requests: 15230, checked: '3 分钟前', node: 'A2-HK' },
    { ip: '192.0.2.112', port: 8080, region: '英国', provider: '服务商 D', group: '欧洲 ISP', state: 'cooldown', success: '72.3%', latency: '—', requests: 321, checked: '5 分钟前', node: 'S1-CN' },
    { ip: '198.51.100.11', port: 8080, region: '加拿大', provider: '服务商 E', group: '北美住宅', state: 'healthy', success: '99.1%', latency: '310 ms', requests: 10542, checked: '1 分钟前', node: 'S3-US' },
    { ip: '203.0.113.56', port: 8888, region: '日本', provider: '服务商 F', group: '亚洲数据中心', state: 'healthy', success: '98.9%', latency: '290 ms', requests: 7654, checked: '2 分钟前', node: 'A3-SG' },
    { ip: '192.0.2.75', port: 1080, region: '法国', provider: '服务商 A', group: '欧洲住宅', state: 'failed', success: '12.3%', latency: '—', requests: 0, checked: '8 分钟前', node: 'A2-HK' },
    { ip: '198.51.100.99', port: 8080, region: '美国', provider: '服务商 G', group: '美国住宅', state: 'healthy', success: '99.5%', latency: '260 ms', requests: 21432, checked: '1 分钟前', node: 'A1-HK' },
    { ip: '203.0.113.90', port: 3128, region: '美国', provider: '服务商 H', group: '美国数据中心', state: 'disabled', success: '—', latency: '—', requests: 0, checked: '—', node: '—' },
    { ip: '192.0.2.21', port: 8080, region: '新加坡', provider: '服务商 B', group: '亚洲 ISP', state: 'healthy', success: '97.6%', latency: '380 ms', requests: 5213, checked: '3 分钟前', node: 'A3-SG' },
  ],
  states: [{ state: 'healthy', count: 10432 }, { state: 'degraded', count: 800 }, { state: 'cooldown', count: 796 }, { state: 'failed', count: 452 }, { state: 'disabled', count: 0 }],
  providers: [{ name: '服务商 A', count: 3240 }, { name: '服务商 B', count: 2180 }, { name: '服务商 C', count: 1560 }, { name: '服务商 D', count: 1420 }, { name: '服务商 E', count: 980 }, { name: '其他 3 家', count: 3100 }],
  groups: [{ name: '美国住宅', count: 2860, color: '#11c38c' }, { name: '欧洲住宅', count: 2120, color: '#277cf7' }, { name: '亚洲数据中心', count: 1980, color: '#c05cf0' }, { name: '美国数据中心', count: 1560, color: '#ffad21' }, { name: '欧洲 ISP', count: 1240, color: '#21b9ea' }, { name: '其他 19 组', count: 2720, color: '#94a3b8' }],
  providerStats: [{ name: '服务商 A', ips: 3240, availability: '95.2%', requests: '68.5 万' }, { name: '服务商 B', ips: 2180, availability: '92.1%', requests: '52.3 万' }, { name: '服务商 C', ips: 1560, availability: '88.6%', requests: '36.2 万' }, { name: '服务商 D', ips: 1420, availability: '90.5%', requests: '28.1 万' }, { name: '服务商 E', ips: 980, availability: '94.3%', requests: '21.6 万' }],
  trend: ['09-24', '09-25', '09-26', '09-27', '09-28', '09-29', '09-30'].map((day, i) => ({ day, value: [83.1, 84.0, 82.6, 83.9, 84.4, 83.2, 83.6][i]! })),
};
