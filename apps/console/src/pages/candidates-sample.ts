/** DESIGN PREVIEW ONLY. The candidate-channel backend does not exist yet; these
 * invented channels and figures are shown only behind the explicit
 * "预览示例数据" switch, under a warning banner. Delete once the API exists. */
export type CandidateStatus = 'pending' | 'approved' | 'rejected';
export interface CandidatesView {
  kpis: { value: number; delta: string; rate: string; series: number[] }[];
  imports: { file: string; rows: number; ok: number; failed: number; at: string; by: string }[];
  total: number;
  rows: { name: string; handle: string; color: string; source: string; method: string; keyword: string | null; subscribers: string; videos: number; latest: string; status: CandidateStatus; tag: string; found: string }[];
}

export const candidatesSample: CandidatesView = {
  kpis: [
    { value: 12438, delta: '+1,204', rate: '+10.7%', series: [5, 6, 5, 7, 8, 7, 9, 10] },
    { value: 3217, delta: '+642', rate: '+25.8%', series: [4, 5, 5, 6, 7, 8, 8, 10] },
    { value: 8126, delta: '+518', rate: '+6.8%', series: [6, 7, 6, 8, 7, 9, 9, 10] },
    { value: 892, delta: '+44', rate: '+5.2%', series: [5, 4, 6, 5, 7, 6, 8, 9] },
  ],
  imports: [
    { file: 'youtube_channels_0922.csv', rows: 1248, ok: 1201, failed: 47, at: '09-22 14:21', by: 'preview' },
    { file: 'tech_keywords.txt', rows: 892, ok: 876, failed: 16, at: '09-21 18:32', by: 'preview' },
    { file: 'import_from_query.csv', rows: 2431, ok: 2388, failed: 43, at: '09-20 11:06', by: 'admin' },
  ],
  total: 12438,
  rows: [
    { name: '星野科技评测', handle: '@hoshino-tech', color: '#3f7fe0', source: 'Query 发现', method: '关键词搜索', keyword: 'tech review', subscribers: '128 万', videos: 1146, latest: '3 天前', status: 'pending', tag: '科技', found: '09-22 14:18' },
    { name: 'Daily Chef Lab', handle: '@dailycheflab', color: '#1fa88a', source: 'Query 发现', method: '相关频道', keyword: 'cooking', subscribers: '84 万', videos: 612, latest: '7 天前', status: 'approved', tag: '美食', found: '09-22 13:55' },
    { name: 'Moto Trails BR', handle: '@mototrailsbr', color: '#e0782f', source: '批量导入', method: '手动导入', keyword: null, subscribers: '35.6 万', videos: 408, latest: '2 天前', status: 'pending', tag: '汽车', found: '09-22 11:21' },
    { name: 'Numberline Studio', handle: '@numberline', color: '#475569', source: 'Query 发现', method: '相关频道', keyword: 'math', subscribers: '64 万', videos: 198, latest: '10 天前', status: 'approved', tag: '教育', found: '09-22 10:37' },
    { name: 'Deep Talk Pod', handle: '@deeptalkpod', color: '#7c3aed', source: 'Query 发现', method: '关键词搜索', keyword: 'ai podcast', subscribers: '42 万', videos: 1321, latest: '1 天前', status: 'pending', tag: 'AI', found: '09-22 09:15' },
    { name: 'Web Forge', handle: '@webforge', color: '#e24e3a', source: '批量导入', method: 'URL 列表', keyword: 'web dev', subscribers: '21 万', videos: 512, latest: '5 天前', status: 'rejected', tag: '开发', found: '09-21 18:42' },
    { name: 'Orbit Notes', handle: '@orbitnotes', color: '#0e7490', source: 'Query 发现', method: '相关频道', keyword: 'space', subscribers: '224 万', videos: 268, latest: '4 天前', status: 'pending', tag: '科普', found: '09-21 16:03' },
    { name: 'Circuit Hours', handle: '@circuithours', color: '#15803d', source: '关键词导入', method: '关键词扩展', keyword: 'computer science', subscribers: '17 万', videos: 1024, latest: '6 天前', status: 'approved', tag: '计算机', found: '09-21 14:27' },
    { name: 'Little Green Thumb', handle: '@littlegreenthumb', color: '#39a852', source: 'Query 发现', method: '关键词搜索', keyword: 'gardening', subscribers: '4.9 万', videos: 176, latest: '8 天前', status: 'pending', tag: '园艺', found: '09-21 11:02' },
    { name: 'Kanal Ekonomi', handle: '@kanalekonomi', color: '#d8a31f', source: 'Query 发现', method: '相关频道', keyword: 'economy', subscribers: '241 万', videos: 1893, latest: '1 天前', status: 'approved', tag: '财经', found: '09-21 09:40' },
  ],
};
