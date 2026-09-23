import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, Box, CircleAlert, CircleCheck, CirclePlay, Clock3, FileText, Funnel, Info, OctagonX, Plus, Search, Snowflake, TriangleAlert, Zap } from 'lucide-react';
import { Empty } from '../ui.js';
import Donut from '../components/donut.js';
import type { DiscoverView } from './discover-sample.js';
import './overview.css';
import './discover.css';

type Status = DiscoverView['statuses'][number]['key'];
const statusMeta: Record<Status, { label: string; tone: string; icon: ReactNode }> = {
  pending: { label: '待执行', tone: 'blue', icon: <Clock3 size={16}/> },
  running: { label: '运行中', tone: 'green', icon: <CirclePlay size={16}/> },
  cooldown: { label: '冷静期', tone: 'cyan', icon: <Snowflake size={16}/> },
  lowyield: { label: '低效观察', tone: 'amber', icon: <TriangleAlert size={16}/> },
  disabled: { label: '停用', tone: 'red', icon: <OctagonX size={16}/> },
};
const kpiIcons = [<Search size={22}/>, <FileText size={22}/>, <Box size={22}/>, <Zap size={22}/>];
const funnelIcons = [<CirclePlay size={20}/>, <FileText size={20}/>, <Funnel size={20}/>, <Box size={20}/>, <CircleCheck size={20}/>];
const kpiLabels = ['今日执行 Query', '今日发现频道', '去重后新频道', '转入全量采集'];
const funnelLabels = ['今日执行', '发现频道', '去重后', '进入候选', '转入全量'];
const fmt = (n: number) => n.toLocaleString('zh-CN');
const pct = (part: number, total: number) => total ? `${(part / total * 100).toFixed(1)}%` : '—';
const NOT_CONNECTED = 'Discover 尚未接入';

function Card({ title, subtitle, extra, className = '', children }: { title: string; subtitle?: string; extra?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`panel discover-card ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{extra}</div>{children}</section>;
}
const Unavailable = ({ children = '查看详情' }: { children?: string }) => <span className="dashboard-unavailable" title={NOT_CONNECTED}>{children}<ArrowRight size={12}/></span>;

export default function Discover() {
  const [sampleOn, setSampleOn] = useState(false);
  const [data, setData] = useState<DiscoverView>();
  const [dimension, setDimension] = useState<'country' | 'category'>('country');
  // The sample module loads only when asked for, so it never ships with the default view.
  useEffect(() => {
    if (!sampleOn) { setData(undefined); return; }
    let live = true;
    void import('./discover-sample.js').then(module => { if (live) setData(module.discoverSample); });
    return () => { live = false; };
  }, [sampleOn]);
  const sourceTotal = data?.sources.reduce((sum, s) => sum + s.count, 0) ?? 0;
  const bars = data ? (dimension === 'country' ? data.countries : data.categories) : [];
  const barTotal = bars.reduce((sum, b) => sum + b.count, 0), barMax = Math.max(1, ...bars.map(b => b.count));
  const statusTotal = data?.statuses.reduce((sum, s) => sum + s.count, 0) ?? 0;
  return <div className="dashboard discover">
    <header className="dashboard-heading">
      <div><h1>Query 发现</h1><p>管理自发现查询词、执行策略、来源归因与发现效果</p><span className="data-freshness failing"><i/>{data ? '示例数据' : NOT_CONNECTED}</span></div>
      <div className="dashboard-period">
        <label className="sample-switch" htmlFor="discover-sample"><input id="discover-sample" type="checkbox" checked={sampleOn} onChange={event => setSampleOn(event.target.checked)}/>预览示例数据</label>
        <div title="时间范围统计尚未接入"><button disabled>近24小时</button><button disabled>近7天</button><button disabled>近30天</button></div>
      </div>
    </header>
    {data && <div className="sample-banner" role="note"><TriangleAlert size={14}/>以下为设计示例数据，用于预览页面效果，不是真实统计。Discover 后端接入后显示真实数据。</div>}

    <div className="discover-kpis">{kpiLabels.map((label, i) => { const k = data?.kpis[i]; return <section key={label} className="panel discover-kpi">
      <span className="kpi-icon">{kpiIcons[i]}</span>
      <div><small>{label}</small><strong>{k ? fmt(k.value) : '—'}</strong>{k ? <><em>↑ {k.delta}</em><span className="kpi-foot"><span>{k.compare}</span><span>{k.total}</span></span></> : <span className="kpi-foot"><span>{NOT_CONNECTED}</span></span>}</div>
    </section>; })}</div>

    <div className="discover-row row-flow">
      <Card title="Query 执行与发现漏斗" subtitle="今日口径：从执行 Query 到转入全量采集；Query 池存量不计入转化率" className="funnel-card">
        <div className="funnel">{funnelLabels.map((label, i) => { const step = data?.funnel[i]; return <div key={label} className="funnel-step">
          <span className="funnel-icon">{funnelIcons[i]}</span><small>{label}</small><strong>{step ? fmt(step.value) : '—'}</strong><span className="funnel-note">{step?.note ?? '尚未接入'}</span>
          {step ? <span className={`funnel-badge ${step.tone}`}>{step.badge}</span> : <span className="funnel-badge slate">—</span>}
        </div>; })}</div>
      </Card>
      <Card title="来源构成" extra={<Unavailable/>}>
        <div className="source-body"><Donut parts={data?.sources} caption="新增频道" label={data ? '新增频道的来源构成' : '来源构成尚未接入'}/><div className="legend">{(data?.sources ?? ['手工关键词', '标签派生', '视频标题', '频道简介', '相关搜索', 'Agent 建议'].map(label => ({ label, count: 0, color: '#c9d4e3' }))).map(s => <div key={s.label}><i style={{ background: s.color }}/><span>{s.label}</span><b>{data ? pct(s.count, sourceTotal) : '—'}</b><small>{data ? s.count : ''}</small></div>)}</div></div>
      </Card>
      <Card title="国家与业务分类" extra={<div className="segmented" role="tablist"><button role="tab" aria-selected={dimension === 'country'} className={dimension === 'country' ? 'on' : ''} onClick={() => setDimension('country')}>国家</button><button role="tab" aria-selected={dimension === 'category'} className={dimension === 'category' ? 'on' : ''} onClick={() => setDimension('category')}>业务分类</button></div>}>
        {bars.length ? <div className="dim-bars">{bars.map(b => <div key={b.name}><span>{b.code && <i className="cc">{b.code}</i>}{b.name}</span><div className="dim-bar"><i style={{ width: `${b.count / barMax * 100}%` }}/></div><b>{pct(b.count, barTotal)}</b><small>{b.count}</small></div>)}</div> : <Empty title="尚无分布数据">{NOT_CONNECTED}</Empty>}
      </Card>
    </div>

    <div className="discover-row row-state">
      <Card title="Query 状态分布" subtitle="当前 Query 池存量">
        <div className="status-grid">{(Object.keys(statusMeta) as Status[]).map(key => { const s = data?.statuses.find(x => x.key === key); const meta = statusMeta[key]; return <div key={key} className={`status-cell ${meta.tone}`}>
          {meta.icon}<small>{meta.label}</small><strong>{s ? fmt(s.count) : '—'}</strong><span>{s ? pct(s.count, statusTotal) : ''}</span>
        </div>; })}</div>
      </Card>
      <Card title="执行策略与时间窗" subtitle="按搜索结果的上传时间范围分配执行频率" extra={<Unavailable>配置管理</Unavailable>}>
        {data ? <div className="table-scroll"><table><thead><tr><th>时间窗</th><th>策略说明</th><th>下次执行</th></tr></thead><tbody>{data.policies.map(p => <tr key={p.window}><td>{p.window}</td><td>{p.rule}</td><td>{p.next}</td></tr>)}</tbody></table></div> : <Empty title="尚未配置执行策略">{NOT_CONNECTED}</Empty>}
      </Card>
      <Card title="关键提醒" extra={<Unavailable>查看全部</Unavailable>}>
        {data ? <div className="alerts">{data.alerts.map(a => <div key={a.title} className={`alert-row ${a.tone}`}>{a.tone === 'red' ? <CircleAlert size={17}/> : a.tone === 'amber' ? <TriangleAlert size={17}/> : <Info size={17}/>}<div><b><em>{a.count}</em> {a.title}</b><small>{a.detail}</small></div><time>{a.when}</time></div>)}</div> : <Empty title="暂无提醒">{NOT_CONNECTED}</Empty>}
      </Card>
    </div>

    <div className="discover-row row-list">
      <Card title="Query 列表" subtitle={data ? `示例 ${data.queries.length} 条` : '支持按国家、分类、状态筛选'} className="query-list" extra={<div className="list-tools">
        <select aria-label="国家" disabled><option>全部国家</option></select><select aria-label="业务分类" disabled><option>全部分类</option></select><select aria-label="状态" disabled><option>全部状态</option></select>
        <label className="list-search" htmlFor="query-search"><Search size={13}/><input id="query-search" placeholder="搜索 Query 词…" disabled/></label>
        <button className="button small primary" disabled title={NOT_CONNECTED}><Plus size={13}/>新增 Query</button>
      </div>}>
        {data ? <div className="table-scroll"><table><thead><tr><th>Query 词</th><th>国家</th><th>业务分类</th><th>来源</th><th>时间窗</th><th>状态</th><th>上次执行</th><th>下次执行</th><th className="num">发现频道</th><th className="num">去重后</th><th className="num">转全量</th><th>操作</th></tr></thead>
          <tbody>{data.queries.map(q => { const meta = statusMeta[q.status]; return <tr key={q.term}><td className="query-term">{q.term}</td><td>{q.country}</td><td>{q.category}</td><td>{q.source}</td><td>{q.window}</td><td><span className={`status-chip ${meta.tone}`}><i/>{meta.label}</span></td><td>{q.last}</td><td>{q.next}</td><td className="num">{q.found}</td><td className="num">{q.unique}</td><td className="num">{q.full}</td><td className="row-actions"><span title={NOT_CONNECTED}>查看</span><span title={NOT_CONNECTED}>执行</span><span title={NOT_CONNECTED}>调整策略</span></td></tr>; })}</tbody></table></div>
          : <Empty title="尚无 Query">Discover 模块的 Query 管理与执行尚未接入后端。</Empty>}
      </Card>
      <Card title="近期发现效果 Top 10" extra={<Unavailable>查看全部</Unavailable>}>
        {data ? <div className="table-scroll"><table><thead><tr><th>#</th><th>Query 词</th><th className="num">新增</th><th className="num">去重后</th></tr></thead><tbody>{data.top.map((t, i) => <tr key={t.term}><td><span className={`rank ${i < 3 ? 'hot' : ''}`}>{i + 1}</span></td><td className="query-term">{t.term}</td><td className="num">{t.found}</td><td className="num">{t.unique}</td></tr>)}</tbody></table></div> : <Empty title="暂无排行">{NOT_CONNECTED}</Empty>}
      </Card>
    </div>
    <footer className="dashboard-foot"><span>Discover 为后续阶段模块；接入前各统计显示“—”。“预览示例数据”仅用于查看页面设计。</span><span>口径：今日 = 浏览器时区自然日</span></footer>
  </div>;
}
