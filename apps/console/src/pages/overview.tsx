import { lazy, Suspense } from 'react';
import { Link } from 'react-router';
import { ArrowUpRight, Bot, Layers, Plus, Radio, Send } from 'lucide-react';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Badge, Empty, PageHeading, Panel, PlanBadge, ResourceView, SampleBadge } from '../ui.js';
import { channelPath, isTerminal, planPath, shortId, time } from '../presentation.js';
import Pipeline from '../components/pipeline.js';

const DomainChart = lazy(() => import('../components/domain-chart.js'));
function LatestPlan({ id }: { id: string }) {
  const { api } = useAuth();
  const resource = useResource(`overview-plan:${id}`, signal => api.plan(id, signal), d => !isTerminal(d.plan));
  return <ResourceView resource={resource}>{detail => <div className="overview-flow-grid"><div><div className="flow-caption"><span><SampleBadge/> 最近创建的计划 <Link to={planPath(id)} className="mono">{shortId(id)}</Link></span><PlanBadge status={detail.plan.status}/></div><Pipeline detail={detail}/></div><div className="flow-summary"><span className="eyebrow">DOMAIN RESULTS</span><h3>本轮入库情况</h3><Suspense fallback={<p>正在加载领域图表…</p>}><DomainChart detail={detail}/></Suspense><Link className="button full" to={planPath(id)}>查看计划与回执<ArrowUpRight size={15}/></Link></div></div>}</ResourceView>;
}

export default function Overview() {
  const { api, session } = useAuth();
  const plans = useResource('overview-plans', signal => api.plans('0', undefined, 5, signal));
  const channels = useResource('overview-channels', signal => api.channels('0', 5, signal));
  const workers = useResource('overview-workers', signal => api.workers('0', 5, signal));
  const errors = useResource('overview-errors', signal => api.errors('0', 5, signal));
  return <>
    <PageHeading title="采集链路总览" description="从计划到持久回执，查看真实状态与等待原因。">{session.role === 'operator' && <Link className="button primary" to="/plans/new"><Plus size={16}/>创建样本计划</Link>}</PageHeading>
    <div className="capability-grid">
      <div className="capability"><span className="icon-tile"><Layers size={20}/></span><div><small>当前采集范围</small><strong>固定样本验证</strong><span>基础资料 · 视频 · 评论</span></div></div>
      <div className="capability"><span className="icon-tile purple"><Bot size={20}/></span><div><small>Agent 执行</small><strong>尚未接入</strong><span>不计为真实分析完成</span></div></div>
      <div className="capability"><span className="icon-tile amber"><Radio size={20}/></span><div><small>代理资源</small><strong>样本不使用代理</strong><span>真实采集接入后展示</span></div></div>
      <div className="capability"><span className="icon-tile green"><Send size={20}/></span><div><small>对外交付</small><strong>未启用</strong><span>与采集入库分别记录</span></div></div>
    </div>
    <Panel title="固定样本采集链路" extra={<Link to="/plans">查看全部计划 →</Link>}>
      <ResourceView resource={plans} showMeta={!plans.data?.items.length}>{page => page.items[0] ? <LatestPlan id={page.items[0].plan_id}/> : <><Pipeline/><div className="notice">还没有样本计划。创建计划后，这里将显示本轮领域结果与持久回执。</div></>}</ResourceView>
    </Panel>
    <div className="two-columns">
      <Panel title="最近创建的计划" extra={<Link to="/plans">查看列表 →</Link>}><ResourceView resource={plans}>{page => page.items.length ? <div className="table-scroll"><table><thead><tr><th>Plan</th><th>状态</th><th>创建时间</th></tr></thead><tbody>{page.items.map(plan => <tr key={plan.plan_id}><td><Link to={planPath(plan.plan_id)} className="mono">{shortId(plan.plan_id)}</Link></td><td><PlanBadge status={plan.status}/></td><td>{time(plan.created_at)}</td></tr>)}</tbody></table></div> : <Empty title="尚无计划"/>}</ResourceView></Panel>
      <Panel title="Worker / 节点" extra={<Link to="/workers">查看列表 →</Link>}><ResourceView resource={workers}>{page => page.items.length ? <div className="worker-preview">{page.items.map(worker => <Link to={`/workers?highlight=${encodeURIComponent(worker.worker_id)}`} key={worker.worker_id}><div className="worker-icon"><Radio size={20}/></div><div><strong>{worker.worker_id}</strong><small>{worker.server_id} · {worker.build_version}</small></div><Badge tone={worker.stale ? 'red' : 'green'}>{worker.stale ? '心跳失联' : '心跳正常'}</Badge></Link>)}</div> : <Empty title="尚无登记的 Worker">等待 Worker 注册并上报心跳。</Empty>}</ResourceView></Panel>
    </div>
    <div className="two-columns">
      <Panel title="最近更新的频道" extra={<Link to="/channels">查看列表 →</Link>}><ResourceView resource={channels}>{page => page.items.length ? <div className="table-scroll"><table><thead><tr><th>频道</th><th>来源</th><th>更新时间</th></tr></thead><tbody>{page.items.map(channel => <tr key={channel.channel_id}><td><Link to={channelPath(channel.channel_id)}>{channel.title ?? '基础资料待入库'}</Link><small className="cell-note">{channel.channel_id}</small></td><td><SampleBadge/></td><td>{time(channel.updated_at)}</td></tr>)}</tbody></table></div> : <Empty title="尚无频道记录"/>}</ResourceView></Panel>
      <Panel title="错误与追踪" extra={<Link to="/errors">查看全部事件 →</Link>}><ResourceView resource={errors}>{page => page.items.length ? <div className="event-preview">{page.items.map(event => <Link key={event.event_id} to={`/errors?event=${encodeURIComponent(event.event_id)}`}><Badge tone="red">{event.error_code ?? event.kind}</Badge><strong>{event.message}</strong><small>{event.phase} · {time(event.created_at)}</small></Link>)}</div> : <Empty title="查询范围内暂无错误事件">这里只展示后端登记的错误。</Empty>}</ResourceView></Panel>
    </div>
    <p className="scope-note">总览各列表最多展示 5 条记录。系统总量与趋势统计尚未提供，当前列表条数不代表系统总量。</p>
  </>;
}
