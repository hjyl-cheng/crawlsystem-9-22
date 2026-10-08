import type { ReactNode } from 'react';
import { CircleCheck, Gauge, PhoneCall, RefreshCw, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import type { DataApiSummary } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Empty, ErrorBox } from '../ui.js';
import { planPath, time } from '../presentation.js';
import Donut from '../components/donut.js';
import LineChart from '../components/line-chart.js';
import './overview.css';
import './discover.css';
import './data-api.css';

const OK = '#277cf7', FAIL = '#e0524a';
const fmt = (n?: number) => n === undefined ? '—' : n.toLocaleString('zh-CN');
const endpointText: Record<string, { name: string; purpose: string }> = {
  channels: { name: 'channels.list', purpose: '频道资料与订阅、播放、视频数' },
  playlistItems: { name: 'playlistItems.list', purpose: '列出上传视频（首次采集与找新视频）' },
  videos: { name: 'videos.list', purpose: '视频详情与播放、点赞、评论数（含近期复查）' },
  unknown: { name: '未记录', purpose: '本次上线前的调用，未记录接口名' },
};
const reasonText: Record<DataApiSummary['failures_by_reason'][number]['reason'], string> = {
  quota: '配额用完或请求过快', forbidden: '无权限或密钥受限', not_found: '频道或视频不存在', invalid: '请求参数不合规', unavailable: '网络或上游服务异常',
};
const reasonColor = { quota: '#f4ad38', forbidden: '#8057d8', not_found: '#94a3b8', invalid: '#0e7490', unavailable: FAIL } as const;

function Card({ title, subtitle, extra, className = '', children }: { title: string; subtitle?: string; extra?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`panel discover-card ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{extra}</div>{children}</section>;
}
function Kpi({ label, tone, icon, value, foot }: { label: string; tone: string; icon: ReactNode; value?: ReactNode; foot: ReactNode }) {
  return <section className={`panel discover-kpi tone-${tone}`}><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value ?? '—'}</strong><span className="kpi-foot"><span>{foot}</span></span></div></section>;
}

/** YouTube Data API usage by the collectors: today's quota, the last 24 hours of calls, and why calls failed. */
export default function DataApi() {
  const { api } = useAuth();
  const summary = useResource('data-api-summary', signal => api.dataApiSummary(signal), true, 30_000);
  const d = summary.data;
  const calls24 = d?.hourly.reduce((n, h) => n + h.calls, 0), failures24 = d?.hourly.reduce((n, h) => n + h.failures, 0);
  const rate = calls24 ? `${(((calls24 - (failures24 ?? 0)) / calls24) * 100).toFixed(1)}%` : '—';
  const reasonMax = Math.max(1, ...(d?.failures_by_reason.map(r => r.count) ?? [1]));
  return <div className="dashboard discover data-api-page">
    <header className="dashboard-heading">
      <div><h1>数据 API</h1><p>采集链路调用 YouTube Data API 的情况：配额、调用量与失败原因</p>
        <span className={`data-freshness ${summary.error ? 'failing' : ''}`}><i/>{d ? `统计时间 ${time(d.observed_at)}` : '正在读取'}</span></div>
      <div className="dashboard-period"><button className="button small" onClick={summary.refresh}><RefreshCw size={13}/>刷新</button></div>
    </header>
    {summary.error && <ErrorBox error={summary.error}/>}

    <div className="discover-kpis">
      <Kpi label="今日配额使用" tone="amber" icon={<Gauge size={22}/>} value={d && `${((d.used_units / Math.max(1, d.limit)) * 100).toFixed(1)}%`}
        foot={d ? `${fmt(d.used_units)} / ${fmt(d.limit)} 单位 · ${time(d.reset_at)} 重置（太平洋时间 0 点）` : '—'}/>
      <Kpi label="为进行中的计划预留" tone="blue" icon={<Gauge size={22}/>} value={fmt(d?.reserved_units)} foot="计划结束后释放未用部分"/>
      <Kpi label="近 24 小时调用" tone="blue" icon={<PhoneCall size={22}/>} value={fmt(calls24)} foot="每次调用消耗 1 个配额单位"/>
      <Kpi label="近 24 小时成功率" tone="green" icon={<CircleCheck size={22}/>} value={rate} foot={d ? `失败 ${fmt(failures24)} 次` : '—'}/>
    </div>

    <div className="discover-row row-charts">
      <Card title="调用趋势" subtitle="近 24 小时，按小时" className="span-2" extra={<div className="chart-legend"><span><i style={{ background: OK }}/>调用</span><span><i style={{ background: FAIL }}/>失败</span></div>}>
        <LineChart points={d?.hourly.map(h => ({ x: new Date(h.hour).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }), values: { calls: h.calls, failures: h.failures } }))}
          series={[{ key: 'calls', label: '调用', color: OK, area: true }, { key: 'failures', label: '失败', color: FAIL }]} empty="近 24 小时没有调用" label="近 24 小时每小时 Data API 调用与失败次数"/>
      </Card>
      <Card title="失败原因" subtitle="近 24 小时">
        {d?.failures_by_reason.length ? <div className="source-body"><Donut parts={d.failures_by_reason.map(r => ({ label: reasonText[r.reason], count: r.count, color: reasonColor[r.reason] }))} caption="失败" label="失败原因分布"/>
          <div className="reason-bars">{d.failures_by_reason.map(r => <div key={r.reason}><span title={r.reason}>{reasonText[r.reason]}</span><div className="dim-bar"><i style={{ width: `${(r.count / reasonMax) * 100}%`, background: reasonColor[r.reason] }}/></div><b>{fmt(r.count)}</b></div>)}</div></div>
          : <Empty title="近 24 小时没有失败">失败的调用会按原因汇总在这里。</Empty>}
      </Card>
    </div>

    <div className="discover-row row-endpoints">
      <section className="panel endpoint-list">
        <div className="panel-heading"><div><h2>接口</h2><p>近 24 小时</p></div></div>
        {d?.endpoints.length ? <div className="table-scroll"><table><thead><tr><th>接口</th><th>用途</th><th className="num">调用</th><th className="num">失败</th><th className="num">成功率</th></tr></thead>
          <tbody>{d.endpoints.map(e => { const t = endpointText[e.endpoint] ?? { name: e.endpoint, purpose: '—' }; return <tr key={e.endpoint}><td className="mono query-term">{t.name}</td><td>{t.purpose}</td>
            <td className="num">{fmt(e.calls)}</td><td className={`num ${e.failures ? 'text-red' : ''}`}>{fmt(e.failures)}</td><td className="num">{e.calls ? `${(((e.calls - e.failures) / e.calls) * 100).toFixed(1)}%` : '—'}</td></tr>; })}</tbody></table></div>
          : <Empty title="近 24 小时没有调用">采集计划调用 Data API 后，这里按接口统计。</Empty>}
      </section>
      <div className="side-stack">
        <Card title="最近失败请求" extra={<TriangleAlert size={14} className="text-muted"/>}>
          {d?.recent_failures.length ? <div className="table-scroll"><table><thead><tr><th>时间</th><th>接口</th><th>原因</th><th>计划</th></tr></thead>
            <tbody>{d.recent_failures.map(f => <tr key={`${f.at}-${f.plan_id}`}><td>{time(f.at)}</td><td className="mono">{endpointText[f.endpoint ?? 'unknown']?.name ?? f.endpoint}</td><td>{reasonText[f.reason]}</td>
              <td><Link to={planPath(f.plan_id)}>查看</Link></td></tr>)}</tbody></table></div>
            : <Empty title="没有失败请求">失败的请求会列在这里，并可跳转到对应计划。</Empty>}
        </Card>
      </div>
    </div>
    <footer className="dashboard-foot"><span>只统计采集链路自己的 Data API 调用；配额按太平洋时间自然日计。</span><span>统计每 30 秒刷新</span></footer>
  </div>;
}
