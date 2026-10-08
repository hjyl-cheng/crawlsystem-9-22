import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Bot, CircleCheck, CircleX, Clock3, RefreshCw } from 'lucide-react';
import type { AgentTask, AgentResult } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { ApiFailure } from '../api.js';
import { useResource } from '../resource.js';
import { Empty, ErrorBox, ResourceView } from '../ui.js';
import { channelPath, clockLabels, planPath, time } from '../presentation.js';
import './overview.css';
import './discover.css';
import './agent.css';

type State = AgentTask['state'];
const stateMeta: Record<State, { label: string; tone: string }> = {
  running: { label: '执行中', tone: 'blue' }, waiting: { label: '等待输入', tone: 'amber' }, completed: { label: '已完成', tone: 'green' }, failed: { label: '失败', tone: 'red' },
};
const triggerText: Record<AgentTask['trigger'], string> = { first: '首次采集', scheduled: '定时更新', manual: '手动更新' };
const tabs: ('all' | State)[] = ['all', 'running', 'waiting', 'completed', 'failed'];
const confidenceText = { low: '低', medium: '中', high: '高' } as const;

function Kpi({ label, tone, icon, value, foot }: { label: string; tone: string; icon: ReactNode; value?: ReactNode; foot: ReactNode }) {
  return <section className={`panel discover-kpi tone-${tone}`}><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value ?? '—'}</strong><span className="kpi-foot"><span>{foot}</span></span></div></section>;
}
const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="kv-row"><dt>{label}</dt><dd>{children}</dd></div>;
const result = (t: AgentTask) => t.state === 'waiting' ? `等待${t.waiting_on.map(d => clockLabels[d]).join('、')}入库`
  : t.state === 'completed' ? '画像已生成并入库' : t.state === 'running' ? '本地模型正在分析' : t.message ?? '本轮未产出画像';

/** The selected task's channel and its current profile in brief; the full profile is on the channel page. */
function Detail({ task }: { task?: AgentTask }) {
  const { api } = useAuth();
  const channel = useResource(task ? `agent-channel:${task.channel_id}` : 'agent-channel:none', signal => task ? api.channel(task.channel_id, signal) : Promise.resolve(undefined), !!task);
  if (!task) return <section className="panel agent-detail"><Empty title="选择任务查看详情">点击左侧任意一行</Empty></section>;
  const agent: AgentResult | null | undefined = channel.data?.agent;
  const f = agent?.facts, meta = stateMeta[task.state];
  return <section className="panel agent-detail">
    <header className="detail-head"><span className="avatar-dot big">{(task.title ?? task.channel_id).slice(0, 1)}</span><div><b>{task.title ?? task.channel_id}</b><small>{task.country ?? '国家未知'}</small></div></header>
    <div className="detail-body">
      <h3>本次任务</h3>
      <dl><Row label="触发方式">{triggerText[task.trigger]}</Row><Row label="状态"><span className={`status-chip ${meta.tone}`}><i/>{meta.label}</span></Row>
        <Row label="开始时间">{time(task.created_at)}</Row><Row label="完成时间">{task.completed_at ? time(task.completed_at) : '—'}</Row>
        <Row label="结果">{result(task)}</Row><Row label="下次画像">{task.next_due_at ? time(task.next_due_at) : '—'}</Row>
        <Row label="计划"><Link to={planPath(task.plan_id)}>查看计划</Link></Row></dl>
      <h3>当前画像 <span className="infer-tag">模型推断 · 非 YouTube 后台实测</span></h3>
      {channel.error ? <ErrorBox error={channel.error}/> : !channel.data ? <p className="detail-note">正在读取…</p> : !f ? <p className="detail-note">这个频道还没有画像。</p> : <dl className="profile">
        <Row label="频道分类"><span>{f.channel_categories.value.level_1} · {f.channel_categories.value.level_2.join('、')}</span><em className="conf">{confidenceText[f.channel_categories.confidence]}</em></Row>
        <Row label="频道标签"><span>{f.channel_tags.value.tags.slice(0, 6).join('、')} 等 {f.channel_tags.value.tags.length} 项</span><em className="conf">{confidenceText[f.channel_tags.confidence]}</em></Row>
        <Row label="创作者国家"><span>{f.country.value}</span><em className="conf">{confidenceText[f.country.confidence]}</em></Row>
        <Row label="创作者语言"><span>{f.creator_language.value}</span><em className="conf">{confidenceText[f.creator_language.confidence]}</em></Row>
        <Row label="活跃订阅者比例"><span>约 {f.active_subscriber_ratio.value}%</span><em className="conf">{confidenceText[f.active_subscriber_ratio.confidence]}</em></Row>
        <Row label="分析时间">{time(agent!.observed_at)}</Row><Row label="模型版本"><span className="mono">{agent!.model_version}</span></Row>
      </dl>}
      <p className="detail-note"><Link to={channelPath(task.channel_id)}>到频道页查看完整画像（10 项）→</Link></p>
    </div>
  </section>;
}

/** Agent tasks: every real plan's profile step, its state, and the current profile of the selected channel. */
export default function Agent() {
  const { api, session } = useAuth();
  const operator = session.role === 'operator';
  const [tab, setTab] = useState<'all' | State>('all'), [cursor, setCursor] = useState('0'), [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState<string>(), [error, setError] = useState<ApiFailure>();
  const summary = useResource('agent-summary', signal => api.agentSummary(signal), true, 15_000);
  const tasks = useResource(`agent-tasks:${tab}:${cursor}`, signal => api.agentTasks(cursor, tab === 'all' ? undefined : tab, signal), true, 15_000);
  const s = summary.data;
  const refresh = () => { summary.refresh(); tasks.refresh(); };
  async function regenerate(task: AgentTask) {
    setBusy(task.plan_id); setError(undefined);
    try { await api.updateChannel(task.channel_id, { request_id: crypto.randomUUID(), expected_version: task.management_version, domains: ['AGENT'] }); refresh(); }
    catch (cause) { setError(cause instanceof ApiFailure ? cause : new ApiFailure('重新生成失败，请重试')); }
    finally { setBusy(undefined); }
  }
  return <div className="dashboard discover agent-page">
    <header className="dashboard-heading">
      <div><h1>Agent 任务</h1><p>基于已入库的频道资料、视频与评论生成频道画像（10 项）；画像到期后自动重新生成</p>
        <span className={`data-freshness ${summary.error ? 'failing' : ''}`}><i/>{s ? `统计时间 ${time(s.observed_at)}` : '正在读取'}</span></div>
      <div className="dashboard-period"><button className="button small" onClick={refresh}><RefreshCw size={13}/>刷新</button></div>
    </header>
    {summary.error && <ErrorBox error={summary.error}/>} {error && <ErrorBox error={error}/>}

    <div className="discover-kpis">
      <Kpi label="执行中" tone="blue" icon={<Bot size={22}/>} value={s?.running} foot="本地模型正在分析"/>
      <Kpi label="等待输入" tone="amber" icon={<Clock3 size={22}/>} value={s?.waiting} foot="等本计划的频道资料、视频入库"/>
      <Kpi label="近 24 小时完成" tone="green" icon={<CircleCheck size={22}/>} value={s?.completed_24h} foot={s?.avg_seconds_24h != null ? `平均 ${Math.round(s.avg_seconds_24h / 60)} 分钟（含采集）` : '—'}/>
      <Kpi label="近 24 小时失败" tone="red" icon={<CircleX size={22}/>} value={s?.failed_24h} foot="计划失败或取消，画像未产出"/>
    </div>

    <div className="discover-row row-agent">
      <section className="panel agent-list">
        <div className="status-tabs" role="tablist">{tabs.map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => { setTab(t); setCursor('0'); }}>
          {t === 'all' ? '全部' : stateMeta[t].label}{t === 'running' || t === 'waiting' ? <span>{s ? s[t] : '—'}</span> : null}</button>)}</div>
        <ResourceView resource={tasks}>{page => <>{page.items.length ? <div className="table-scroll"><table><thead><tr><th>频道</th><th>触发方式</th><th>状态</th><th>开始</th><th>结果</th><th>下次画像</th><th>操作</th></tr></thead>
          <tbody>{page.items.map(t => { const meta = stateMeta[t.state]; return <tr key={t.plan_id} className={t.plan_id === selected ? 'selected' : ''} onClick={() => setSelected(t.plan_id)} aria-selected={t.plan_id === selected}>
            <td><b className="cell-title">{t.title ?? t.channel_id}</b><small className="cell-sub">{t.country ?? '—'}</small></td>
            <td><span className="tag-chip">{triggerText[t.trigger]}</span></td>
            <td><span className={`status-chip ${meta.tone}`}><i/>{meta.label}</span></td>
            <td>{time(t.created_at)}</td>
            <td className={t.state === 'failed' ? 'text-red' : ''}>{result(t)}</td>
            <td>{t.next_due_at ? time(t.next_due_at) : '—'}</td>
            <td className="row-actions" onClick={event => event.stopPropagation()}><Link to={planPath(t.plan_id)}>查看计划</Link>
              {operator && t.management_state === 'managed' && (t.state === 'completed' || t.state === 'failed') && <button className="text-button" disabled={!!busy} onClick={() => void regenerate(t)}>{busy === t.plan_id ? '正在安排…' : '重新生成'}</button>}</td>
          </tr>; })}</tbody></table></div>
          : <Empty title="尚无 Agent 任务">需要画像的采集计划（首次采集或更新）会在这里出现。</Empty>}
          <footer className="pager"><span>每页最多 20 条</span><button className="button small" disabled={cursor === '0'} onClick={() => setCursor(String(Math.max(0, Number(cursor) - 20)))}>上一页</button><button className="button small" disabled={!page.next_cursor} onClick={() => setCursor(page.next_cursor!)}>下一页</button></footer></>}</ResourceView>
      </section>
      <Detail task={tasks.data?.items.find(t => t.plan_id === selected)}/>
    </div>
    <section className="panel discover-card"><div className="panel-heading"><div><h2>模型版本</h2><p>当前画像由哪个模型生成</p></div></div>
      {s?.model_versions.length ? <div className="table-scroll"><table><thead><tr><th>模型版本</th><th className="num">频道数</th></tr></thead>
        <tbody>{s.model_versions.map(m => <tr key={m.model_version}><td className="mono">{m.model_version}</td><td className="num">{m.channels}</td></tr>)}</tbody></table></div>
        : <Empty title="还没有画像">首个画像生成后显示模型版本。</Empty>}</section>
    <footer className="dashboard-foot"><span>Agent 类型：频道画像分析（10 项字段）。画像为模型推断结果，不作为 YouTube 后台实测统计展示。</span><span>同时最多运行 1 个画像任务</span></footer>
  </div>;
}
