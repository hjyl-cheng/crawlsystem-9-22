/** DESIGN PREVIEW ONLY. Production-scale Workers and servers with resource
 * figures (Prometheus is not wired into the console yet); shown only behind the
 * explicit "预览示例数据" switch under a warning banner. Addresses come from the
 * RFC 5737 documentation ranges. The default view uses real Worker heartbeats. */
export type WorkerType = 'Discover' | 'Full' | 'Update' | 'Agent' | 'API';
export interface SampleWorker { id: string; type: WorkerType; state: 'running' | 'idle' | 'stale' | 'paused'; server: string; ip: string; task: string | null; uptime: string; cpu: number; mem: number; version: string; capacity: number }
export const workersSample = {
  kpis: { servers: 12, serversOnline: 10, workers: 48, accepting: 36, stale: 4, running: 256, cpu: 42, mem: 68 },
  tabs: { servers: 12, workers: 48, tasks: 256 },
  workers: [
    { id: 'full-worker-01', type: 'Full', state: 'running', server: 'A1-HK', ip: '10.0.1.12', task: '星野科技评测 · 全量', uptime: '2 小时 14 分', cpu: 32, mem: 48, version: 'v1.4.2', capacity: 4 },
    { id: 'update-worker-02', type: 'Update', state: 'idle', server: 'A1-HK', ip: '10.0.1.13', task: null, uptime: '5 小时 32 分', cpu: 8, mem: 26, version: 'v1.4.2', capacity: 6 },
    { id: 'full-worker-03', type: 'Full', state: 'stale', server: 'S3-US', ip: '10.0.2.10', task: null, uptime: '—', cpu: 0, mem: 0, version: 'v1.4.1', capacity: 4 },
    { id: 'agent-worker-04', type: 'Agent', state: 'running', server: 'S2-CN', ip: '10.0.3.21', task: 'Daily Chef Lab · 画像', uptime: '1 小时 08 分', cpu: 45, mem: 62, version: 'v1.4.2', capacity: 2 },
    { id: 'update-worker-05', type: 'Update', state: 'running', server: 'A2-HK', ip: '10.0.4.8', task: 'Kanal Ekonomi · 更新', uptime: '8 小时 21 分', cpu: 72, mem: 81, version: 'v1.4.2', capacity: 6 },
    { id: 'discover-worker-06', type: 'Discover', state: 'paused', server: 'S1-CN', ip: '10.0.5.16', task: null, uptime: '3 小时 02 分', cpu: 3, mem: 18, version: 'v1.4.2', capacity: 8 },
    { id: 'api-worker-07', type: 'API', state: 'running', server: 'A3-SG', ip: '10.0.6.7', task: 'videos.list · 批次 12', uptime: '3 小时 16 分', cpu: 25, mem: 37, version: 'v1.4.2', capacity: 10 },
    { id: 'full-worker-08', type: 'Full', state: 'running', server: 'A3-SG', ip: '10.0.6.9', task: 'Orbit Notes · 全量', uptime: '6 小时 11 分', cpu: 61, mem: 73, version: 'v1.4.2', capacity: 4 },
  ] as SampleWorker[],
  servers: [
    { name: 'A1-HK', region: '香港', ip: '192.0.2.10', online: true, cpu: 38, mem: 62, disk: 45, net: '520 Mbps', workers: 12 },
    { name: 'A2-HK', region: '香港', ip: '192.0.2.11', online: true, cpu: 47, mem: 71, disk: 68, net: '310 Mbps', workers: 8 },
    { name: 'A3-SG', region: '新加坡', ip: '198.51.100.20', online: true, cpu: 28, mem: 56, disk: 32, net: '210 Mbps', workers: 10 },
    { name: 'S1-CN', region: '华南', ip: '203.0.113.30', online: true, cpu: 71, mem: 83, disk: 52, net: '280 Mbps', workers: 10 },
    { name: 'S3-US', region: '美西', ip: '203.0.113.31', online: false, cpu: 0, mem: 0, disk: 0, net: '—', workers: 0 },
  ],
  tasks: Array.from({ length: 24 }, (_, h) => ({ x: `${String(h).padStart(2, '0')}:00`, ok: [182, 176, 170, 168, 172, 190, 214, 236, 262, 280, 296, 302, 298, 305, 312, 308, 296, 284, 270, 258, 240, 226, 210, 196][h]!, failed: [6, 5, 5, 4, 6, 8, 9, 11, 12, 14, 13, 16, 12, 11, 15, 13, 12, 10, 9, 9, 8, 7, 7, 6][h]! })),
  resources: Array.from({ length: 12 }, (_, i) => ({ x: `10:${String(i * 5).padStart(2, '0')}`, cpu: [40, 42, 41, 44, 43, 45, 42, 41, 43, 44, 42, 42][i]!, mem: [66, 67, 67, 68, 69, 68, 68, 69, 70, 69, 68, 68][i]!, disk: [51, 51, 52, 52, 52, 53, 53, 53, 53, 54, 54, 54][i]! })),
};
