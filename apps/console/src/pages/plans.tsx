import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Box, CircleAlert, CircleCheck, CircleDot, CirclePlay, CircleX, Clock3, FileText, FolderOpen, Hourglass, Plus, TriangleAlert, Video, Bot } from 'lucide-react';
import { PlanStatusSchema, type PlanStatus, type PlansSummary } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Empty, Pagination, PlanBadge, ResourceView, usePagination } from '../ui.js';
import { channelPath, domainLabels, errorCodeLabels, planLabels, planPath, time } from '../presentation.js';
import Donut from '../components/donut.js';
import type { PlansSampleRow } from './plans-sample.js';
import './overview.css';
import './discover.css';
import './plans.css';

// Statistics change on the scale of plan runs; the list keeps the default 5s polling.
const SUMMARY_INTERVAL_MS = 15_000;
const fmt = (n: number) => n.toLocaleString('zh-CN');
const pct = (part: number, total: number) => total ? `${(part / total * 100).toFixed(1)}%` : '—';
const clock = (value: number | string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
const duration = (seconds: number | null) => seconds === null ? '—' : seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${(seconds / 60).toFixed(1)} 分钟` : `${(seconds / 3600).toFixed(1)} 小时`;
const shortStatus: Record<PlanStatus, string> = { QUEUED: '待执行', RUNNING: '执行中', WAITING: '等待依赖', COMPLETED: '已完成', FAILED: '已失败', CANCELLED: '已取消' };
const shortDomain = { ABOUT: '资料', VIDEO: '视频', AGENT: 'Agent' } as const;
const reasonColors = ['#277cf7', '#11c38c', '#ffad21', '#8b5cf6', '#21b9ea', '#94a3b8'];
const statusCells: { status: PlanStatus; tone: string; icon: ReactNode }[] = [
  { status: 'QUEUED', tone: 'blue', icon: <Clock3 size={16}/> }, { status: 'RUNNING', tone: 'green', icon: <CirclePlay size={16}/> },
  { status: 'WAITING', tone: 'amber', icon: <Hourglass size={16}/> }, { status: 'COMPLETED', tone: 'green', icon: <CircleCheck size={16}/> },
  { status: 'FAILED', tone: 'red', icon: <CircleX size={16}/> }, { status: 'CANCELLED', tone: 'cyan', icon: <CircleDot size={16}/> },
];

function Card({ title, subtitle, extra, className = '', children }: { title: string; subtitle?: string; extra?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`panel discover-card ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{extra}</div>{children}</section>;
}
const More = ({ to, children = '查看全部' }: { to: string; children?: string }) => <Link className="dashboard-more" to={to}>{children}<ArrowRight size={12}/></Link>;

function Summary({ s, loading }: { s?: PlansSummary; loading: boolean }) {
  const v = (n?: number) => s && n !== undefined ? fmt(n) : loading ? '…' : '—';
  const domain = (key: 'ABOUT' | 'VIDEO' | 'AGENT') => s?.domains.find(d => d.domain === key);
  const kpis: { label: string; tone: string; icon: ReactNode; value?: number; foot: ReactNode }[] = [
    { label: '待执行', tone: 'blue', icon: <FolderOpen size={22}/>, value: s?.by_status.QUEUED, foot: <span>近 24 小时新建 {v(s?.created_24h)}</span> },
    { label: '执行中', tone: 'blue', icon: <CirclePlay size={22}/>, value: s?.by_status.RUNNING, foot: <span>全部计划 {v(s?.total)}</span> },
    { label: '近 24 小时完成', tone: 'green', icon: <CircleCheck size={22}/>, value: s?.completed_24h, foot: <span>平均用时 {s ? duration(s.avg_completion_seconds_24h) : '—'}</span> },
    { label: '等待依赖 / 失败', tone: 'red', icon: <CircleAlert size={22}/>, value: s?.by_status.WAITING, foot: <span>执行失败 {v(s?.by_status.FAILED)}</span> },
  ];
  const funnel: { label: string; icon: ReactNode; value?: number; of?: number; note: string }[] = [
    { label: '新建计划', icon: <FileText size={18}/>, value: s?.total, of: s?.total, note: '全部计划' },
    { label: '资料已入库', icon: <Box size={18}/>, value: domain('ABOUT')?.applied, of: domain('ABOUT')?.required, note: '频道基础信息' },
    { label: '视频已入库', icon: <Video size={18}/>, value: domain('VIDEO')?.applied, of: domain('VIDEO')?.required, note: '视频与评论' },
    { label: 'Agent 已完成', icon: <Bot size={18}/>, value: domain('AGENT')?.applied, of: domain('AGENT')?.required, note: '需要 Agent 的计划' },
    { label: '本轮已完成', icon: <CircleCheck size={18}/>, value: s?.by_status.COMPLETED, of: s?.total, note: '必需领域全部入库' },
  ];
  const reasonsTotal = s?.waiting_reasons.reduce((sum, r) => sum + r.plans, 0) ?? 0;
  return <>
    <div className="discover-kpis">{kpis.map(k => <section key={k.label} className={`panel discover-kpi tone-${k.tone}`}>
      <span className="kpi-icon">{k.icon}</span><div><small>{k.label}</small><strong>{v(k.value)}</strong><span className="kpi-foot">{k.foot}</span></div>
    </section>)}</div>
    <div className="discover-row row-flow">
      <Card title="全量采集执行漏斗" subtitle="按全部计划累计：领域步骤以需要该领域的计划为基数" className="plans-funnel">
        <div className="funnel">{funnel.map((step, i) => <div key={step.label} className="funnel-step">
          <span className="funnel-icon">{step.icon}</span><small>{step.label}</small><strong>{v(step.value)}</strong><span className="funnel-note">{step.note}</span>
          <span className={`funnel-badge ${i === funnel.length - 1 ? 'green' : 'slate'}`}>{s && step.value !== undefined && step.of ? pct(step.value, step.of) : '—'}</span>
        </div>)}</div>
      </Card>
      <Card title="等待原因分布" subtitle="等待中的计划，按最近上报阶段">
        {s && reasonsTotal === 0 ? <Empty title="当前没有等待中的计划"/> : <div className="source-body"><Donut parts={s?.waiting_reasons.map((r, i) => ({ label: r.reason, count: r.plans, color: reasonColors[i % reasonColors.length]! }))} caption="等待中" emptyCaption={loading ? '查询中' : '—'} label="等待中计划的原因分布"/>
          <div className="legend">{(s?.waiting_reasons ?? []).map((r, i) => <div key={r.reason}><i style={{ background: reasonColors[i % reasonColors.length] }}/><span title={r.reason}>{r.reason}</span><b>{pct(r.plans, reasonsTotal)}</b><small>{r.plans}</small></div>)}</div></div>}
      </Card>
    </div>
  </>;
}

function StatusAndDomains({ s, loading }: { s?: PlansSummary; loading: boolean }) {
  const totalByStatus = s ? Object.values(s.by_status).reduce((a, b) => a + b, 0) : 0;
  return <>
    <Card title="计划状态分布" subtitle="全部计划的当前状态" className="span-2">
      <div className="status-grid six">{statusCells.map(cell => { const n = s?.by_status[cell.status]; return <div key={cell.status} className={`status-cell ${cell.tone}`}>
        {cell.icon}<small title={planLabels[cell.status]}>{shortStatus[cell.status]}</small><strong>{n !== undefined ? fmt(n) : loading ? '…' : '—'}</strong><span>{n !== undefined ? pct(n, totalByStatus) : ''}</span>
      </div>; })}</div>
    </Card>
    <Card title="必需领域完成情况" subtitle="已入库 / 需要该领域的计划">
      {s?.domains.length ? <div className="domain-bars">{(['ABOUT', 'VIDEO', 'AGENT'] as const).map(key => { const d = s.domains.find(x => x.domain === key); if (!d) return null; return <div key={key}>
        <span>{domainLabels[key]}</span><div className="dim-bar"><i style={{ width: `${d.required ? d.applied / d.required * 100 : 0}%` }}/></div><b>{pct(d.applied, d.required)}</b><small>{fmt(d.applied)} / {fmt(d.required)}</small>
      </div>; })}</div> : <Empty title={loading ? '正在查询…' : '暂无计划'}/>}
    </Card>
  </>;
}

function RecentErrors({ sample }: { sample?: typeof import('./plans-sample.js')['plansErrorsSample'] }) {
  const { api } = useAuth();
  const errors = useResource('plans-errors', signal => api.errors('0', 5, signal), true, SUMMARY_INTERVAL_MS);
  const table = (rows: { key: string; at: string; phase: string; kind: ReactNode; link: ReactNode }[]) => <div className="table-scroll"><table><thead><tr><th>时间</th><th>阶段</th><th>错误</th><th>关联</th></tr></thead>
    <tbody>{rows.map(r => <tr key={r.key}><td>{r.at}</td><td><span className="truncate">{r.phase}</span></td><td>{r.kind}</td><td>{r.link}</td></tr>)}</tbody></table></div>;
  return <Card title="最近错误" extra={<More to="/errors"/>}>
    {sample ? table(sample.map(e => ({ key: e.at + e.plan, at: e.at, phase: e.phase, kind: <span className="error-event-tag">{e.message}</span>, link: <span className="text-muted">{e.plan}</span> })))
      : errors.data ? (errors.data.items.length ? table(errors.data.items.map(e => ({ key: e.event_id, at: clock(e.created_at), phase: e.phase, kind: <span className="error-event-tag" title={e.message}>{e.error_code ? errorCodeLabels[e.error_code] : e.kind === 'FAILED' ? '执行失败' : '执行错误'}</span>, link: <Link to={`/errors?event=${encodeURIComponent(e.event_id)}`}>查看</Link> }))) : <Empty title="暂无错误事件"/>)
      : <Empty title={errors.error ? '错误事件查询失败' : '正在查询…'}/>}
  </Card>;
}

function SampleList({ rows }: { rows: PlansSampleRow[] }) {
  return <div className="table-scroll"><table><thead><tr><th>计划编号</th><th>频道</th><th>必需领域</th><th>执行状态</th><th>等待原因</th><th>创建时间</th><th>更新时间</th></tr></thead>
    <tbody>{rows.map(r => <tr key={r.id}><td className="mono">{r.id}</td><td>{r.channel}</td><td><DomainChips domains={r.domains}/></td><td><PlanBadge status={r.status}/></td><td className={r.waiting ? 'text-amber' : 'text-muted'}>{r.waiting ?? '—'}</td><td>{r.created}</td><td>{r.updated}</td></tr>)}</tbody></table></div>;
}
function DomainChips({ domains }: { domains: { domain: 'ABOUT' | 'VIDEO' | 'AGENT'; applied?: boolean }[] }) {
  return <span className="domain-chips">{domains.map(d => <span key={d.domain} className={d.applied === undefined ? '' : d.applied ? 'done' : 'todo'} title={`${domainLabels[d.domain]}${d.applied === undefined ? '' : d.applied ? '：已入库' : '：未入库'}`}>{shortDomain[d.domain]}</span>)}</span>;
}

export default function Plans() {
  const { api, session } = useAuth();
  const paging = usePagination();
  const parsed = PlanStatusSchema.safeParse(paging.params.get('status'));
  const status = parsed.success ? parsed.data : undefined;
  const list = useResource(`plans:${paging.cursor}:${status ?? ''}`, signal => api.plans(paging.cursor, status, 20, signal));
  const summary = useResource('plans-summary', signal => api.plansSummary(signal), true, SUMMARY_INTERVAL_MS);
  const [sampleOn, setSampleOn] = useState(false);
  const [sample, setSample] = useState<typeof import('./plans-sample.js')>();
  // The sample module loads only when asked for, so it never ships with the default view.
  useEffect(() => {
    if (!sampleOn) { setSample(undefined); return; }
    let live = true;
    void import('./plans-sample.js').then(module => { if (live) setSample(module); });
    return () => { live = false; };
  }, [sampleOn]);
  const s = sample ? sample.plansSummarySample : summary.data;
  return <div className="dashboard discover plans-page">
    <header className="dashboard-heading">
      <div><h1>全量采集</h1><p>新频道首次采集的计划、执行、等待与完成情况</p>
        {sample ? <span className="data-freshness failing"><i/>示例数据</span> : summary.updatedAt ? <span className={`data-freshness ${summary.error ? 'failing' : ''}`}><i/>{summary.error ? '统计查询失败' : '数据已同步'} · {new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(summary.updatedAt)}</span> : null}
      </div>
      <div className="dashboard-period">
        <label className="sample-switch" htmlFor="plans-sample"><input id="plans-sample" type="checkbox" checked={sampleOn} onChange={event => setSampleOn(event.target.checked)}/>预览示例数据</label>
        {session.role === 'operator' && <Link className="button small primary" to="/plans/new"><Plus size={14}/>创建样本计划</Link>}
      </div>
    </header>
    {sample && <div className="sample-banner" role="note"><TriangleAlert size={14}/>以下为设计示例数据（频道均为虚构），用于预览生产规模下的页面效果，不是真实统计。关闭开关即显示真实计划数据。</div>}
    <Summary s={s} loading={!sample && summary.loading}/>
    <div className="discover-row row-state"><StatusAndDomains s={s} loading={!sample && summary.loading}/><RecentErrors sample={sample?.plansErrorsSample}/></div>
    <section className="panel plans-list">
      <div className="panel-heading"><div><h2>计划列表</h2><p>{sample ? `示例 ${sample.plansListSample.length} 条` : 'M1 仅支持固定样本计划 · 每页 20 条'}</p></div>
        <label className="filter-inline">计划状态<select value={status ?? ''} disabled={!!sample} onChange={event => { const params = new URLSearchParams(paging.params); params.set('cursor', '0'); event.target.value ? params.set('status', event.target.value) : params.delete('status'); paging.setParams(params); }}><option value="">全部状态</option>{PlanStatusSchema.options.map(value => <option key={value} value={value}>{planLabels[value]}</option>)}</select></label>
      </div>
      {sample ? <SampleList rows={sample.plansListSample}/> : <ResourceView resource={list}>{page => <>{page.items.length ? <div className="table-scroll"><table><thead><tr><th>计划编号</th><th>频道</th><th>必需领域</th><th>执行状态</th><th>版本 / 代次</th><th>创建时间</th><th>更新时间</th><th/></tr></thead>
        <tbody>{page.items.map(plan => <tr key={plan.plan_id}><td><Link to={planPath(plan.plan_id)} className="mono">{plan.plan_id}</Link></td><td><Link to={channelPath(plan.channel_id)}>{plan.channel_id}</Link></td><td><DomainChips domains={plan.required_domains.map(domain => ({ domain }))}/></td><td><PlanBadge status={plan.status}/></td><td>v{plan.version} / {plan.execution_epoch}</td><td>{time(plan.created_at)}</td><td>{time(plan.updated_at)}</td><td><Link to={planPath(plan.plan_id)}>查看详情 →</Link></td></tr>)}</tbody></table></div>
        : <Empty title="没有符合条件的计划">可以调整状态筛选，或创建一轮样本计划。</Empty>}<Pagination cursor={paging.cursor} next={page.next_cursor} count={page.items.length} go={paging.go}/></>}</ResourceView>}
    </section>
    <footer className="dashboard-foot"><span>统计为当前工作空间全部计划；“近 24 小时”按服务器时间滚动计算。</span><span>{s ? `统计时间 ${clock(s.observed_at)}` : ''}</span></footer>
  </div>;
}
