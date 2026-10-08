import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Box, CalendarClock, CircleCheck, Clock3, FileText, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import type { UpdateChannel } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { ApiFailure } from '../api.js';
import { useResource } from '../resource.js';
import { Empty, ErrorBox, ResourceView } from '../ui.js';
import { channelPath, clockLabels, planPath, time } from '../presentation.js';
import Donut from '../components/donut.js';
import './overview.css';
import './discover.css';
import './update.css';

const states = { scheduled: '未到期', due: '待安排', queued: '已排队', running: '执行中', completed: '已完成', failed: '需要恢复' };
const reasons = { scheduler_disabled: '自动调度已暂停', manual_only: '暂未开启自动更新，可手动更新', active_plan: '本频道已有采集计划', concurrency: '等待执行名额', agent_capacity: '等待画像执行名额', daily_plans: '今日计划预算已用完', api_quota: '等待 Data API 配额', attempted_today: '今天已尝试，下一天再安排' };
const tones = { scheduled: 'slate', due: 'blue', queued: 'amber', running: 'blue', completed: 'green', failed: 'red' };
const fmt = (value?: number) => value === undefined ? '—' : value.toLocaleString('zh-CN');
function Card({ title, subtitle, extra, className = '', children }: { title: string; subtitle?: ReactNode; extra?: ReactNode; className?: string; children: ReactNode }) {
  return <section className={`panel discover-card ${className}`}><div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{extra}</div>{children}</section>;
}
const Step = ({ icon, title, note, value }: { icon: ReactNode; title: string; note: string; value?: ReactNode }) => <div className="flow-step"><span className="flow-icon">{icon}</span><div><b>{title}</b><small>{note}</small>{value !== undefined && <em>{value}</em>}</div></div>;

export default function Update() {
  const { api, session } = useAuth();
  const operator = session.role === 'operator';
  const [state, setState] = useState(''), [search, setSearch] = useState(''), [cursor, setCursor] = useState('0');
  const [busy, setBusy] = useState<string>(), [error, setError] = useState<ApiFailure>();
  const [requests] = useState(() => new Map<string, { request_id: string; expected_version: number; domains: UpdateChannel['due_domains'] }>());
  const summary = useResource('updates-summary', signal => api.updatesSummary(signal), true, 15_000);
  const tasks = useResource(`updates:${cursor}:${state}:${search}`, signal => api.updates(cursor, state, search, signal), true, 15_000);
  const data = summary.data;
  const refresh = () => { summary.refresh(); tasks.refresh(); };
  async function update(row: UpdateChannel) {
    setBusy(row.channel_id); setError(undefined);
    // Preserve both identity and input after an uncertain response so another click is an exact replay.
    const command = requests.get(row.channel_id) ?? { request_id: crypto.randomUUID(), expected_version: row.management_version, domains: row.due_domains };
    requests.set(row.channel_id, command);
    try { await api.updateChannel(row.channel_id, command); requests.delete(row.channel_id); refresh(); }
    catch (cause) {
      const failure = cause instanceof ApiFailure ? cause : new ApiFailure('更新请求失败，请重试');
      if (!['NETWORK', 'TIMEOUT'].includes(failure.code) && failure.status < 500) requests.delete(row.channel_id);
      setError(failure);
    } finally { setBusy(undefined); }
  }
  const figures = [
    { label: '当前到期频道', value: data?.due, icon: <CalendarClock size={22}/>, tone: 'blue', foot: '至少一类数据到期，含正在更新的频道' },
    { label: '近24小时已完成', value: data?.completed_24h, icon: <CircleCheck size={22}/>, tone: 'green', foot: '本轮必需领域全部入库的更新计划' },
    { label: '已排队 / 执行中', value: data ? `${fmt(data.queued)} / ${fmt(data.running)}` : undefined, icon: <Clock3 size={22}/>, tone: 'blue', foot: '真实更新计划的当前状态' },
    { label: '逾期频道', value: data?.overdue, icon: <TriangleAlert size={22}/>, tone: 'red', foot: '至少一类数据在今天之前到期（UTC）' },
  ];
  const waiting = data?.waiting.map((row, i) => ({ label: reasons[row.reason], count: row.channels, color: ['#f4ad38', '#277cf7', '#8057d8', '#ef6666'][i % 4]! }));
  return <div className="dashboard discover update-page">
    <header className="dashboard-heading"><div><h1>更新采集</h1><p>已纳管频道的持续更新与调度执行，聚焦待执行、逾期、异常与恢复</p>
      <span className={`data-freshness ${data?.limits.enabled && data.last_scan_at ? '' : 'failing'}`}><i/>{data ? data.limits.enabled ? data.last_scan_at ? '自动调度已开启' : '等待首次调度扫描' : '自动调度已暂停' : '正在读取调度状态'}</span></div>
      <div className="dashboard-period"><button className="button small" onClick={refresh}><RefreshCw size={13}/>刷新</button><Link className="button small" to="/channels">管理更新策略<ArrowRight size={13}/></Link></div></header>
    {summary.error && <ErrorBox error={summary.error}/>} {error && <ErrorBox error={error}/>}
    <div className="discover-kpis">{figures.map(k => <section key={k.label} className={`panel discover-kpi tone-${k.tone}`}><span className="kpi-icon">{k.icon}</span><div><small>{k.label}</small><strong>{typeof k.value === 'string' ? k.value : fmt(k.value)}</strong><span className="kpi-foot"><span>{k.foot}</span></span></div></section>)}</div>
    <div className="discover-row row-schedule">
      <Card title="更新调度概览" subtitle="每30秒检查到期频道；同一频道已有活动计划时等待，自动调度每类数据每天最多安排一次" className="schedule-card"><div className="schedule-flow">
        <Step icon={<CalendarClock size={18}/>} title="到期策略" note="频道资料、视频、画像独立到期" value={data ? `${fmt(data.managed)} 个纳管频道` : undefined}/><ArrowRight className="flow-arrow" size={16}/>
        <Step icon={<FileText size={18}/>} title="待执行队列" note="冻结本次要更新的内容" value={data ? `${fmt(data.queued)} 个已排队` : undefined}/><ArrowRight className="flow-arrow" size={16}/>
        <Step icon={<RefreshCw size={18}/>} title="更新采集" note="按当前有界范围采集到期数据" value={data ? `${fmt(data.running)} 个执行中` : undefined}/><ArrowRight className="flow-arrow" size={16}/>
        <Step icon={<Box size={18}/>} title="入库与回执" note="失败保留到期时间，成功推进时钟" value={data ? `近24小时完成 ${fmt(data.completed_24h)}` : undefined}/>
      </div></Card>
      <Card title="执行预算" className="notes-card"><ul className="schedule-notes">
        <li>自动更新：{data ? data.limits.enabled && data.limits.auto_domains.length ? data.limits.auto_domains.map(d => clockLabels[d]).join('、') : '已暂停' : '—'}；其余到期内容需手动更新</li>
        <li>活动计划上限：{fmt(data?.limits.max_active_plans)}；画像计划上限：{fmt(data?.limits.max_agent_plans)}</li>
        <li>今日更新计划：{fmt(data?.daily_plans)} / {fmt(data?.limits.daily_plan_limit)}（UTC）</li>
        <li>Data API 已使用：{fmt(data?.api_used_units)} / {fmt(data?.limits.api_daily_limit)} 单位</li>
        <li>为活动计划预留：{fmt(data?.api_reserved_units)} 单位</li>
      </ul><p className="schedule-hint">API 配额按太平洋时间午夜重置：{data ? time(data.api_reset_at) : '—'}。代理请求受节点租约与并发限制。</p></Card>
    </div>
    <div className="discover-row row-tasks">
      <Card title="更新任务列表" className="task-list" extra={<div className="list-tools">
        <select aria-label="更新状态" value={state} onChange={e => { setState(e.target.value); setCursor('0'); }}><option value="">全部状态</option>{Object.entries(states).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <label className="list-search"><Search size={13}/><input aria-label="搜索更新频道" placeholder="搜索频道名称 / ID…" maxLength={160} value={search} onChange={e => { setSearch(e.target.value); setCursor('0'); }}/></label>
      </div>}><ResourceView resource={tasks}>{page => <>{page.items.length ? <div className="table-scroll"><table><thead><tr><th>频道</th><th>本次更新内容</th><th>上次成功</th><th>下次到期</th><th>当前状态</th><th>等待原因 / 最近结果</th><th>执行 Worker</th><th>操作</th></tr></thead>
        <tbody>{page.items.map(row => <tr key={row.channel_id}><td><Link to={channelPath(row.channel_id)} className="cell-title">{row.title ?? row.channel_id}</Link><small className="cell-sub">{row.country ?? '—'}</small></td>
          <td>{(row.active_plan_id === row.plan?.plan_id ? row.plan.required_domains : row.due_domains).map(d => clockLabels[d]).join('、') || '未到期'}</td>
          <td>{time(row.last_success_at)}</td><td>{time(row.due_at)}</td><td><span className={`status-chip ${tones[row.state]}`}><i/>{states[row.state]}</span></td>
          <td>{row.waiting_reason ? reasons[row.waiting_reason] : row.event ? `${row.event.phase} · ${row.event.message}` : row.state === 'completed' ? '本轮必需领域全部入库' : '—'}</td><td className="mono">{row.event?.worker_id ?? '—'}</td>
          <td className="row-actions">{row.active_plan_id || row.plan ? <Link to={planPath(row.active_plan_id ?? row.plan!.plan_id)}>查看计划</Link> : <Link to={channelPath(row.channel_id)}>查看频道</Link>}
            {operator && !row.active_plan_id && row.due_domains.length > 0 && <button className="text-button" disabled={!!busy} onClick={() => void update(row)}>{busy === row.channel_id ? '正在安排…' : row.state === 'failed' ? '重试更新' : '立即更新'}</button>}</td></tr>)}</tbody></table></div>
        : <Empty title="尚无更新任务">纳管真实频道后，这里显示到期状态、更新计划与执行结果。</Empty>}
        <footer className="pager"><span>每页最多20个频道</span><button className="button small" disabled={cursor === '0'} onClick={() => setCursor(String(Math.max(0, Number(cursor) - 20)))}>上一页</button><button className="button small" disabled={!page.next_cursor} onClick={() => setCursor(page.next_cursor!)}>下一页</button></footer></>}</ResourceView></Card>
      <div className="side-stack"><Card title="等待原因分布">{waiting?.length ? <div className="source-body"><Donut parts={waiting} caption="等待安排" label="更新等待原因"/><div className="legend">{waiting.map(w => <div key={w.label}><i style={{ background: w.color }}/><span>{w.label}</span><small>{fmt(w.count)}</small></div>)}</div></div> : <Empty title="当前没有等待安排的频道">预算不足时频道保持到期，额度或名额恢复后继续安排。</Empty>}</Card>
        <Card title="调度与恢复"><p className="detail-note">最近扫描：{time(data?.last_scan_at)}</p><p className="detail-note">近24小时失败：{fmt(data?.failed_24h)} 个更新计划。查看计划可核对已入库部分、错误与回执；自动重试只处理仍到期的内容。</p><p className="detail-note">视频目前按原采集范围刷新；新视频发现与近期视频增量刷新将在下一步补齐。</p></Card></div>
    </div>
    <footer className="dashboard-foot"><span>统计来自持久时钟、真实更新计划和回执；固定样本不计入。暂停或移出纳管的频道不参与自动更新。</span><span>统计时间：{time(data?.observed_at)}</span></footer>
  </div>;
}
