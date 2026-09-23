import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, Bot, Box, CalendarClock, CircleCheck, Clock3, CodeXml, FileText, Info, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { Empty } from '../ui.js';
import Donut from '../components/donut.js';
import type { UpdateStatus, UpdateView } from './update-sample.js';
import './overview.css';
import './discover.css';
import './update.css';

const NOT_CONNECTED = '更新采集尚未接入';
const kpis: { label: string; tone: string; icon: ReactNode }[] = [
  { label: '今日应执行', tone: 'blue', icon: <CalendarClock size={22}/> },
  { label: '今日已完成', tone: 'green', icon: <CircleCheck size={22}/> },
  { label: '今日待执行', tone: 'blue', icon: <Clock3 size={22}/> },
  { label: '逾期待处理', tone: 'red', icon: <TriangleAlert size={22}/> },
];
const statusMeta: Record<UpdateStatus, { label: string; tone: string }> = {
  due: { label: '今日待执行', tone: 'blue' }, running: { label: '执行中', tone: 'blue' }, overdue: { label: '逾期待处理', tone: 'red' },
  quota: { label: '等待配额', tone: 'amber' }, agent: { label: '等待 Agent', tone: 'amber' }, done: { label: '已完成', tone: 'green' }, recovering: { label: '恢复中', tone: 'cyan' },
};
const incidentMeta = { pending: { label: '待恢复', tone: 'red' }, partial: { label: '部分恢复', tone: 'amber' }, resolved: { label: '已处理', tone: 'green' } } as const;

function Card({ title, subtitle, extra, className = '', children }: { title: string; subtitle?: ReactNode; extra?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`panel discover-card ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{extra}</div>{children}</section>;
}
const Unavailable = ({ children = '查看全部' }: { children?: string }) => <span className="dashboard-unavailable" title={NOT_CONNECTED}>{children}<ArrowRight size={12}/></span>;
const Step = ({ icon, title, note, value }: { icon: ReactNode; title: string; note: string; value?: ReactNode }) =>
  <div className="flow-step"><span className="flow-icon">{icon}</span><div><b>{title}</b><small>{note}</small>{value !== undefined && <em>{value}</em>}</div></div>;

export default function Update() {
  const [sampleOn, setSampleOn] = useState(false);
  const [data, setData] = useState<UpdateView>();
  // The sample module loads only when asked for, so it never ships with the default view.
  useEffect(() => {
    if (!sampleOn) { setData(undefined); return; }
    let live = true;
    void import('./update-sample.js').then(module => { if (live) setData(module.updateSample); });
    return () => { live = false; };
  }, [sampleOn]);
  const waitingTotal = data?.waiting.reduce((sum, w) => sum + w.count, 0) ?? 0;
  const pct = (n: number) => waitingTotal ? `${(n / waitingTotal * 100).toFixed(1)}%` : '—';
  return <div className="dashboard discover update-page">
    <header className="dashboard-heading">
      <div><h1>更新采集</h1><p>已纳管频道的持续更新与调度执行，聚焦待执行、逾期、异常与恢复</p><span className="data-freshness failing"><i/>{data ? '示例数据' : NOT_CONNECTED}</span></div>
      <div className="dashboard-period"><label className="sample-switch" htmlFor="update-sample"><input id="update-sample" type="checkbox" checked={sampleOn} onChange={event => setSampleOn(event.target.checked)}/>预览示例数据</label>
        <div title="时间范围统计尚未接入"><button disabled>近24小时</button><button disabled>近7天</button><button disabled>近30天</button></div></div>
    </header>
    {data && <div className="sample-banner" role="note"><TriangleAlert size={14}/>以下为设计示例数据（频道均为虚构），用于预览页面效果，不是真实统计。更新采集后端接入后显示真实数据。</div>}

    <div className="discover-kpis">{kpis.map((kpi, i) => { const k = data?.kpis[i]; return <section key={kpi.label} className={`panel discover-kpi tone-${kpi.tone}`}>
      <span className="kpi-icon">{kpi.icon}</span>
      <div><small>{kpi.label}</small><strong>{k ? k.value : '—'}</strong>{k ? <span className="kpi-foot"><span>{k.compare} <em className={k.good ? 'good' : 'bad'}>{k.up ? '↑' : '↓'} {k.delta}</em></span>{k.foot && <span>{k.foot}</span>}</span> : <span className="kpi-foot"><span>{NOT_CONNECTED}</span></span>}</div>
    </section>; })}</div>

    <div className="discover-row row-schedule">
      <Card title="更新调度概览" subtitle="按频道更新策略定时生成待执行队列，完成更新采集后写入数据库并刷新频道当前状态" className="schedule-card">
        <div className="schedule-flow">
          <Step icon={<CalendarClock size={18}/>} title="调度策略" note="按频道配置计算下次执行日"/>
          <ArrowRight className="flow-arrow" size={16}/>
          <Step icon={<FileText size={18}/>} title="待执行队列" note="按计划时间生成任务" value={data ? `${data.flow.queue} 个待执行` : undefined}/>
          <ArrowRight className="flow-arrow" size={16}/>
          <Step icon={<RefreshCw size={18}/>} title="更新采集" note="抓取新视频、统计与评论" value={data ? `${data.flow.running} 个执行中` : undefined}/>
          <ArrowRight className="flow-arrow" size={16}/>
          <div className="flow-branch"><Step icon={<Bot size={16}/>} title="Agent 任务" note="条件触发" value={data ? `${data.flow.agent} 个` : undefined}/><Step icon={<CodeXml size={16}/>} title="Data API" note="按需补充" value={data ? `${data.flow.api} 个` : undefined}/></div>
          <ArrowRight className="flow-arrow" size={16}/>
          <Step icon={<Box size={18}/>} title="Ingest / APPLIED" note="清洗入库" value={data ? `${data.flow.applied} 步骤完成` : undefined}/>
          <ArrowRight className="flow-arrow" size={16}/>
          <Step icon={<FileText size={18}/>} title="Channel Current" note="刷新频道当前视图" value={data ? `今日更新 ${data.flow.current}` : undefined}/>
        </div>
      </Card>
      <Card title="调度说明" className="notes-card">
        <ul className="schedule-notes"><li><Info size={13}/>按频道更新策略自动计算下次执行日</li><li><Info size={13}/>可按逾期、待执行、执行中筛选任务</li><li><Info size={13}/>异常任务可从下方恢复入口处理</li></ul>
        <p className="schedule-hint">更新策略在频道配置中维护；本页只展示调度执行与结果。</p>
      </Card>
    </div>

    <div className="discover-row row-tasks">
      <Card title="更新任务列表" className="task-list" extra={<div className="list-tools">
        {['全部状态', '全部国家', '全部分类', '全部更新内容'].map(label => <select key={label} aria-label={label} disabled><option>{label}</option></select>)}
        <label className="list-search" htmlFor="update-search"><Search size={13}/><input id="update-search" placeholder="搜索频道名称 / 任务编号…" disabled/></label>
      </div>}>
        {data ? <div className="table-scroll"><table><thead><tr><th>频道</th><th>国家 / 分类</th><th>本次更新内容</th><th>上次成功</th><th>下次执行</th><th>当前状态</th><th>等待原因</th><th>最近结果</th><th>执行 Worker</th><th>操作</th></tr></thead>
          <tbody>{data.tasks.map(t => { const meta = statusMeta[t.status]; return <tr key={t.channel}><td className="query-term">{t.channel}</td><td>{t.region}</td><td>{t.content}</td><td>{t.lastOk}</td><td>{t.next}</td><td><span className={`status-chip ${meta.tone}`}><i/>{meta.label}</span></td><td className={t.waiting ? 'text-amber' : 'text-muted'}>{t.waiting ?? '—'}</td><td className={t.result?.startsWith('成功') ? 'text-green' : ''}>{t.result ?? '—'}</td><td className="mono">{t.worker}</td><td className="row-actions"><span title={NOT_CONNECTED}>查看</span>{t.status === 'overdue' && <span title={NOT_CONNECTED}>恢复</span>}{t.status === 'due' && <span title={NOT_CONNECTED}>跳过</span>}</td></tr>; })}</tbody></table></div>
          : <Empty title="尚无更新任务">频道更新调度（Clock）与更新采集尚未接入后端。</Empty>}
      </Card>
      <div className="side-stack">
        <Card title="等待原因分布" extra={<Unavailable>查看详情</Unavailable>}>
          {data ? <div className="source-body"><Donut parts={data.waiting} caption="待执行任务" label="待执行任务的等待原因"/><div className="legend">{data.waiting.map(w => <div key={w.label}><i style={{ background: w.color }}/><span>{w.label}</span><b>{pct(w.count)}</b><small>{w.count}</small></div>)}</div></div> : <Empty title="暂无等待任务">{NOT_CONNECTED}</Empty>}
        </Card>
        <Card title="更新节点状态" extra={<Unavailable/>}>
          {data ? <div className="table-scroll"><table><thead><tr><th>节点</th><th className="num">运行中</th><th className="num">空闲</th><th className="num">异常</th><th className="num">总数</th></tr></thead><tbody>{data.nodes.map(n => <tr key={n.node}><td>{n.node}</td><td className="num text-green">{n.running}</td><td className="num">{n.idle}</td><td className={`num ${n.failed ? 'text-red' : ''}`}>{n.failed}</td><td className="num">{n.total}</td></tr>)}</tbody></table></div> : <Empty title="暂无更新节点">{NOT_CONNECTED}</Empty>}
        </Card>
      </div>
    </div>

    <div className="discover-row row-results">
      <Card title="异常更新与恢复入口" className="span-2" extra={<Unavailable/>}>
        {data ? <div className="table-scroll"><table><thead><tr><th>时间</th><th>错误组</th><th className="num">影响频道</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.incidents.map(e => { const m = incidentMeta[e.state]; return <tr key={e.at}><td>{e.at}</td><td>{e.group}</td><td className="num">{e.channels}</td><td><span className={`status-chip ${m.tone}`}><i/>{m.label}</span></td><td className="row-actions"><span title={NOT_CONNECTED}>查看</span>{e.state !== 'resolved' && <span title={NOT_CONNECTED}>{e.state === 'partial' ? '重试' : '批量恢复'}</span>}</td></tr>; })}</tbody></table></div> : <Empty title="暂无异常更新">{NOT_CONNECTED}</Empty>}
      </Card>
      <Card title="最近完成更新的频道" className="span-2" extra={<Unavailable/>}>
        {data ? <div className="table-scroll"><table><thead><tr><th>频道</th><th>更新内容</th><th>完成时间</th><th>结果</th></tr></thead><tbody>{data.completed.map(c => <tr key={c.channel}><td className="query-term">{c.channel}</td><td>{c.content}</td><td>{c.at}</td><td><span className="status-chip green">{c.result}</span></td></tr>)}</tbody></table></div> : <Empty title="暂无完成记录">{NOT_CONNECTED}</Empty>}
      </Card>
    </div>
    <footer className="dashboard-foot"><span>更新采集与调度为后续阶段模块；接入前各统计显示“—”。“预览示例数据”仅用于查看页面设计。</span><span>口径：今日 = 浏览器时区自然日</span></footer>
  </div>;
}
