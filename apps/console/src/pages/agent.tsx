import { useEffect, useState, type ReactNode } from 'react';
import { Bot, CircleCheck, CircleX, Clock3, MoreHorizontal, Pause, Pencil, Play, Plus, Search, Settings, TriangleAlert } from 'lucide-react';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Empty } from '../ui.js';
import type { AgentStatus, AgentTask, AgentView } from './agent-sample.js';
import './overview.css';
import './discover.css';
import './agent.css';

const NOT_CONNECTED = 'Agent 执行尚未接入';
const statusMeta: Record<AgentStatus, { label: string; tone: string }> = {
  running: { label: '运行中', tone: 'blue' }, waiting: { label: '等待中', tone: 'amber' }, done: { label: '已完成', tone: 'green' }, failed: { label: '失败', tone: 'red' }, paused: { label: '已暂停', tone: 'slate' },
};
const tabs: ('all' | AgentStatus)[] = ['all', 'running', 'waiting', 'done', 'failed', 'paused'];
const priorityTone = { 高: 'red', 中: 'amber', 低: 'blue' } as const;

function Kpi({ label, tone, icon, value, foot }: { label: string; tone: string; icon: ReactNode; value?: ReactNode; foot: ReactNode }) {
  return <section className={`panel discover-kpi tone-${tone}`}><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value ?? '—'}</strong><span className="kpi-foot"><span>{foot}</span></span></div></section>;
}
const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="kv-row"><dt>{label}</dt><dd>{children}</dd></div>;

function Detail({ task, view }: { task?: AgentTask; view?: AgentView }) {
  if (!task || !view) return <section className="panel agent-detail"><Empty title="选择任务查看详情">{view ? '点击左侧任意一行' : NOT_CONNECTED}</Empty></section>;
  const meta = statusMeta[task.status];
  return <section className="panel agent-detail">
    <header className="detail-head"><span className="avatar-dot big" style={{ background: task.color }}>{task.channel[0]}</span><div><b>{task.channel}</b><small>{task.handle} · {task.subscribers} 订阅</small></div></header>
    <div className="detail-tabs" role="tablist"><button role="tab" aria-selected="true" className="on">任务详情</button><button role="tab" aria-selected="false" disabled title={NOT_CONNECTED}>执行记录</button></div>
    <div className="detail-body">
      <h3>任务</h3>
      <dl><Row label="任务编号"><span className="mono">{task.id}</span></Row><Row label="Agent 类型">频道画像分析</Row><Row label="触发来源">{task.trigger}</Row><Row label="优先级"><span className={`status-chip ${priorityTone[task.priority]}`}>{task.priority}</span></Row><Row label="状态"><span className={`status-chip ${meta.tone}`}><i/>{meta.label}</span></Row><Row label="国家 / 分类">{task.region} / {task.category}</Row></dl>
      <h3>画像结果 <span className="infer-tag">模型推断 · 非 YouTube 后台实测</span></h3>
      {task.status === 'done' ? <dl className="profile">{view.profile.map(p => <Row key={p.label} label={p.label}><span>{p.value}</span><em className={`conf c-${priorityTone[p.confidence]}`}>{p.confidence}</em></Row>)}</dl>
        : <p className="detail-note">{task.status === 'failed' ? `本轮未产出有效画像：${task.detail}` : `本轮画像尚未完成（${task.fields} / 10 项），完成后在此展示。`}</p>}
      <h3>最近执行</h3>
      <dl><Row label="执行时间">{task.last}</Row><Row label="结果">{task.result} · {task.detail}</Row><Row label="模型版本"><span className="mono">{view.run.model}</span></Row><Row label="分类体系"><span className="mono">{view.run.taxonomy}</span></Row><Row label="输入">视频 {view.run.inputVideos} 个 · 首屏评论 {view.run.inputComments} 份</Row></dl>
    </div>
    <footer className="detail-actions"><button className="button small" disabled title={NOT_CONNECTED}><Play size={13}/>立即执行</button><button className="button small" disabled title={NOT_CONNECTED}><Pause size={13}/>暂停</button><button className="button small" disabled title={NOT_CONNECTED}><Pencil size={13}/>编辑配置</button></footer>
  </section>;
}

export default function Agent() {
  const { api } = useAuth();
  // Real figure available today: plans (any status) whose required AGENT domain is not applied.
  const summary = useResource('agent-plans-summary', signal => api.plansSummary(signal), true, 15_000);
  const agentDomain = summary.data?.domains.find(d => d.domain === 'AGENT');
  const [sampleOn, setSampleOn] = useState(false);
  const [data, setData] = useState<AgentView>();
  const [tab, setTab] = useState<'all' | AgentStatus>('all');
  const [selected, setSelected] = useState<string>();
  // The sample module loads only when asked for, so it never ships with the default view.
  useEffect(() => {
    if (!sampleOn) { setData(undefined); setSelected(undefined); setTab('all'); return; }
    let live = true;
    void import('./agent-sample.js').then(module => { if (live) { setData(module.agentSample); setSelected(module.agentSample.tasks[0]!.id); } });
    return () => { live = false; };
  }, [sampleOn]);
  const rows = data?.tasks.filter(t => tab === 'all' || t.status === tab) ?? [];
  const task = data?.tasks.find(t => t.id === selected);
  const k = data?.kpis;
  return <div className="dashboard discover agent-page">
    <header className="dashboard-heading">
      <div><h1>Agent 任务</h1><p>基于已入库的频道资料、视频与评论生成频道画像（10 项）</p>
        {data ? <span className="data-freshness failing"><i/>示例数据</span> : <span className="data-freshness failing" title="来自计划统计：需要 Agent 结果但尚未入库的计划（含已结束的计划）"><i/>{NOT_CONNECTED}{agentDomain ? ` · ${agentDomain.required - agentDomain.applied} 个计划的 Agent 结果未入库` : ''}</span>}
      </div>
      <div className="dashboard-period"><label className="sample-switch" htmlFor="agent-sample"><input id="agent-sample" type="checkbox" checked={sampleOn} onChange={event => setSampleOn(event.target.checked)}/>预览示例数据</label>
        <button className="button small" disabled title={NOT_CONNECTED}><Settings size={13}/>Agent 配置</button><button className="button small primary" disabled title={NOT_CONNECTED}><Plus size={13}/>创建 Agent 任务</button></div>
    </header>
    {data && <div className="sample-banner" role="note"><TriangleAlert size={14}/>以下为设计示例数据（频道均为虚构），用于预览页面效果，不是真实任务。画像结果为模型推断示例。</div>}

    <div className="discover-kpis">
      <Kpi label="总任务" tone="blue" icon={<Bot size={22}/>} value={k?.total} foot={k ? `运行中 ${k.running}` : NOT_CONNECTED}/>
      <Kpi label="今日已完成" tone="green" icon={<CircleCheck size={22}/>} value={k?.doneToday} foot={k ? `近 7 天成功率 ${k.successRate}` : NOT_CONNECTED}/>
      <Kpi label="等待中" tone="amber" icon={<Clock3 size={22}/>} value={k?.waiting} foot={k ? '等待模型配额或输入数据' : NOT_CONNECTED}/>
      <Kpi label="失败" tone="red" icon={<CircleX size={22}/>} value={k?.failed} foot={k ? '需要重试或检查输出' : NOT_CONNECTED}/>
    </div>

    <div className="discover-row row-agent">
      <section className="panel agent-list">
        <div className="status-tabs" role="tablist">{tabs.map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} disabled={!data} onClick={() => setTab(t)}>{t === 'all' ? '全部' : statusMeta[t].label}<span>{data ? data.tabs[t] : '—'}</span></button>)}</div>
        <div className="list-tools agent-filters">
          <label className="list-search" htmlFor="agent-search"><Search size={13}/><input id="agent-search" placeholder="搜索频道名称 / 任务编号…" disabled/></label>
          {['触发来源', '执行状态', '业务分类', '国家 / 地区', '优先级'].map(label => <select key={label} aria-label={label} disabled><option>{label}</option></select>)}
          <button className="button small" disabled>重置</button>
        </div>
        {data ? <div className="table-scroll"><table><thead><tr><th>频道</th><th>触发来源</th><th>任务内容</th><th>上次执行</th><th>下次执行</th><th>状态</th><th>优先级</th><th>执行结果</th><th>操作</th></tr></thead>
          <tbody>{rows.map(t => { const meta = statusMeta[t.status]; return <tr key={t.id} className={t.id === selected ? 'selected' : ''} onClick={() => setSelected(t.id)} aria-selected={t.id === selected}>
            <td><div className="channel-cell"><span className="avatar-dot" style={{ background: t.color }}>{t.channel[0]}</span><div><b>{t.channel}</b><small>{t.subscribers} 订阅</small></div></div></td>
            <td><span className="tag-chip">{t.trigger}</span></td>
            <td><b className="cell-title">频道画像</b><small className="cell-sub">{t.fields} / 10 项</small></td>
            <td>{t.last}</td><td>{t.next}</td><td><span className={`status-chip ${meta.tone}`}><i/>{meta.label}</span></td>
            <td><span className={`status-chip ${priorityTone[t.priority]}`}>{t.priority}</span></td>
            <td><b className={`cell-title ${t.status === 'failed' ? 'text-red' : t.status === 'done' ? 'text-green' : ''}`}>{t.result}</b><small className="cell-sub">{t.detail}</small></td>
            <td className="row-actions"><span title={NOT_CONNECTED}>{t.status === 'running' ? <Pause size={14}/> : <Play size={14}/>}</span><MoreHorizontal size={14}/></td>
          </tr>; })}</tbody></table></div>
          : <Empty title="尚无 Agent 任务">Agent 执行尚未接入。完成全量或更新采集的频道会在这里生成画像任务。</Empty>}
        <footer className="pager">{data ? <span>共 {data.tabs.all} 条（示例）</span> : <span>—</span>}</footer>
      </section>
      <Detail task={task} view={data}/>
    </div>
    <footer className="dashboard-foot"><span>Agent 类型：频道画像分析（10 项字段）。画像为模型推断结果，不作为 YouTube 后台实测统计展示。</span><span>“预览示例数据”仅用于查看页面设计</span></footer>
  </div>;
}
