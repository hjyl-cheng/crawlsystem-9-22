import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, CircleCheck, Clock3, Gauge, KeyRound, PhoneCall, Settings, TriangleAlert } from 'lucide-react';
import { Empty } from '../ui.js';
import Donut from '../components/donut.js';
import LineChart from '../components/line-chart.js';
import type { DataApiView } from './data-api-sample.js';
import './overview.css';
import './discover.css';
import './data-api.css';

const NOT_CONNECTED = 'Data API 尚未接入';
const OK = '#277cf7', FAIL = '#e0524a';
const fmt = (n: number) => n.toLocaleString('zh-CN');

function Card({ title, subtitle, extra, className = '', children }: { title: string; subtitle?: string; extra?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`panel discover-card ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{extra}</div>{children}</section>;
}
const Unavailable = ({ children = '查看全部' }: { children?: string }) => <span className="dashboard-unavailable" title={NOT_CONNECTED}>{children}<ArrowRight size={12}/></span>;
function Kpi({ label, tone, icon, value, foot }: { label: string; tone: string; icon: ReactNode; value?: ReactNode; foot: ReactNode }) {
  return <section className={`panel discover-kpi tone-${tone}`}><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value ?? '—'}</strong><span className="kpi-foot"><span>{foot}</span></span></div></section>;
}

export default function DataApi() {
  const [sampleOn, setSampleOn] = useState(false);
  const [data, setData] = useState<DataApiView>();
  // The sample module loads only when asked for, so it never ships with the default view.
  useEffect(() => {
    if (!sampleOn) { setData(undefined); return; }
    let live = true;
    void import('./data-api-sample.js').then(module => { if (live) setData(module.dataApiSample); });
    return () => { live = false; };
  }, [sampleOn]);
  const k = data?.kpis;
  const statusTotal = data?.statuses.reduce((s, x) => s + x.count, 0) ?? 0;
  const reasonMax = Math.max(1, ...(data?.reasons.map(r => r.count) ?? [1])), reasonTotal = data?.reasons.reduce((s, r) => s + r.count, 0) ?? 0;
  return <div className="dashboard discover data-api-page">
    <header className="dashboard-heading">
      <div><h1>数据 API</h1><p>采集链路的补充分支：直接抓取拿不到的数据，调用 YouTube Data API 等外部接口补充</p><span className="data-freshness failing"><i/>{data ? '示例数据' : NOT_CONNECTED}</span></div>
      <div className="dashboard-period"><label className="sample-switch" htmlFor="data-api-sample"><input id="data-api-sample" type="checkbox" checked={sampleOn} onChange={event => setSampleOn(event.target.checked)}/>预览示例数据</label>
        <button className="button small" disabled title={NOT_CONNECTED}><Settings size={13}/>配额设置</button></div>
    </header>
    {data && <div className="sample-banner" role="note"><TriangleAlert size={14}/>以下为设计示例数据，用于预览页面效果，不是真实调用统计。Data API 分支接入后显示真实数据。</div>}

    <div className="discover-kpis">
      <Kpi label="今日调用" tone="blue" icon={<PhoneCall size={22}/>} value={k && fmt(k.calls)} foot={k ? `较昨日 ${k.callsDelta}` : NOT_CONNECTED}/>
      <Kpi label="成功率" tone="green" icon={<CircleCheck size={22}/>} value={k?.successRate} foot={k ? `失败 ${fmt(k.failed)} 次` : NOT_CONNECTED}/>
      <Kpi label="今日配额使用" tone="amber" icon={<Gauge size={22}/>} value={k && `${(k.quotaUsed / k.quotaTotal * 100).toFixed(1)}%`} foot={k ? `${fmt(k.quotaUsed)} / ${fmt(k.quotaTotal)} 单位 · 太平洋时间 0 点重置` : NOT_CONNECTED}/>
      <Kpi label="平均响应" tone="blue" icon={<Clock3 size={22}/>} value={k && `${k.avgMs} ms`} foot={k ? `P95 ${k.p95Ms} ms` : NOT_CONNECTED}/>
    </div>

    <div className="discover-row row-charts">
      <Card title="调用趋势" subtitle="近 30 天每日调用量" className="span-2" extra={<div className="chart-legend"><span><i style={{ background: OK }}/>成功</span><span><i style={{ background: FAIL }}/>失败</span></div>}><LineChart points={data?.trend.map(t => ({ x: t.day, values: { ok: t.ok, failed: t.failed } }))} series={[{ key: 'ok', label: '成功', color: OK, area: true }, { key: 'failed', label: '失败', color: FAIL }]} empty="调用趋势尚未接入" label="近 30 天每日调用量：成功与失败"/></Card>
      <Card title="请求状态分布" subtitle="今日">
        {data ? <div className="source-body"><Donut parts={data.statuses} caption="今日调用" label="今日调用的状态分布"/><div className="legend">{data.statuses.map(s => <div key={s.label}><i style={{ background: s.color }}/><span title={s.label}>{s.label}</span><b>{(s.count / statusTotal * 100).toFixed(1)}%</b><small>{fmt(s.count)}</small></div>)}</div></div> : <Empty title="暂无调用">{NOT_CONNECTED}</Empty>}
      </Card>
      <Card title="失败原因 Top 5" subtitle="今日，按上游返回的错误原因" extra={<Unavailable/>}>
        {data ? <div className="reason-bars">{data.reasons.map(r => <div key={r.reason}><span className="code">{r.code}</span><span title={r.reason}>{r.label}</span><div className="dim-bar"><i style={{ width: `${r.count / reasonMax * 100}%` }}/></div><b>{r.count}</b><small>{(r.count / reasonTotal * 100).toFixed(1)}%</small></div>)}</div> : <Empty title="暂无失败">{NOT_CONNECTED}</Empty>}
      </Card>
    </div>

    <div className="discover-row row-endpoints">
      <section className="panel endpoint-list">
        <div className="status-tabs" role="tablist"><button role="tab" aria-selected="true" className="on">接口列表</button>{['调用日志', '失败日志'].map(t => <button key={t} role="tab" aria-selected="false" disabled title={NOT_CONNECTED}>{t}</button>)}</div>
        {data ? <div className="table-scroll"><table><thead><tr><th>接口</th><th>用途</th><th className="num">每次消耗配额</th><th className="num">今日调用</th><th className="num">成功率</th><th className="num">平均响应</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>{data.endpoints.map(e => <tr key={e.name}><td className="mono query-term">{e.name}</td><td>{e.purpose}</td><td className={`num ${e.cost >= 50 ? 'text-amber' : ''}`}>{e.cost} 单位</td><td className="num">{fmt(e.calls)}</td><td className="num">{e.rate}</td><td className="num">{e.avgMs ? `${e.avgMs} ms` : '—'}</td><td><span className={`status-chip ${e.enabled ? 'green' : 'slate'}`}><i/>{e.enabled ? '已启用' : '未使用'}</span></td><td className="row-actions"><span title={NOT_CONNECTED}>查看</span><span title={NOT_CONNECTED}>{e.enabled ? '停用' : '启用'}</span></td></tr>)}</tbody></table></div>
          : <Empty title="尚无接口调用">采集链路的 Data API 分支尚未接入。接入后展示所调用的外部接口、配额消耗与成功率。</Empty>}
      </section>
      <div className="side-stack">
        <Card title="配额与密钥" subtitle="每个项目每日配额" className="natural" extra={<Unavailable>管理</Unavailable>}>
          {data ? <div className="quota-list">{data.keys.map(q => <div key={q.name}><div className="quota-head"><span><KeyRound size={12}/>{q.name}</span><b className={q.state === 'exhausted' ? 'text-red' : q.state === 'near' ? 'text-amber' : ''}>{q.state === 'exhausted' ? '已用尽' : `${(q.used / q.total * 100).toFixed(0)}%`}</b></div><div className="dim-bar"><i className={q.state} style={{ width: `${q.used / q.total * 100}%` }}/></div><small>{fmt(q.used)} / {fmt(q.total)} 单位</small></div>)}</div> : <Empty title="尚未配置密钥">{NOT_CONNECTED}</Empty>}
        </Card>
        <Card title="最近失败请求" extra={<Unavailable/>}>
          {data ? <div className="table-scroll"><table><thead><tr><th>时间</th><th>接口</th><th>状态码</th><th>原因</th></tr></thead><tbody>{data.failures.map(f => <tr key={f.at + f.endpoint}><td>{f.at}</td><td className="mono">{f.endpoint}</td><td><span className={`status-chip ${f.code >= 500 ? 'red' : 'amber'}`}>{f.code}</span></td><td className="mono" title={`计划 ${f.plan}`}>{f.reason}</td></tr>)}</tbody></table></div> : <Empty title="暂无失败请求">{NOT_CONNECTED}</Empty>}
        </Card>
      </div>
    </div>
    <footer className="dashboard-foot"><span>Data API 是采集链路的条件 / 兜底分支，与 Agent 任务并列；对外提供数据不在本页范围。</span><span>“预览示例数据”仅用于查看页面设计</span></footer>
  </div>;
}
