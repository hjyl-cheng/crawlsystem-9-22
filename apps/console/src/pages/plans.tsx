import { Link } from 'react-router';
import { Plus } from 'lucide-react';
import { PlanStatusSchema } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Empty, PageHeading, Panel, Pagination, PlanBadge, ResourceView, SampleBadge, usePagination } from '../ui.js';
import { domainLabels, planLabels, planPath, channelPath, time } from '../presentation.js';

export default function Plans() {
  const { api, session } = useAuth();
  const paging = usePagination();
  const parsed = PlanStatusSchema.safeParse(paging.params.get('status'));
  const status = parsed.success ? parsed.data : undefined;
  const resource = useResource(`plans:${paging.cursor}:${status ?? ''}`, signal => api.plans(paging.cursor, status, 20, signal));
  return <><PageHeading title="全量采集" description="每一轮采集的目标、执行状态和数据入库分别核对。">{session.role === 'operator' && <Link className="button primary" to="/plans/new"><Plus size={16}/>创建样本计划</Link>}</PageHeading>
    <Panel><div className="filters"><label>计划状态<select value={status ?? ''} onChange={event => { const params = new URLSearchParams(paging.params); params.set('cursor', '0'); event.target.value ? params.set('status', event.target.value) : params.delete('status'); paging.setParams(params); }}><option value="">全部状态</option>{PlanStatusSchema.options.map(value => <option key={value} value={value}>{planLabels[value]}</option>)}</select></label><SampleBadge/><span className="muted">M1 仅支持固定样本计划</span></div>
    <ResourceView resource={resource}>{page => <>{page.items.length ? <div className="table-scroll"><table><thead><tr><th>Plan / 频道</th><th>本轮状态</th><th>必需领域</th><th>版本 / 代次</th><th>更新时间</th><th/></tr></thead><tbody>{page.items.map(plan => <tr key={plan.plan_id}><td><Link to={planPath(plan.plan_id)} className="mono">{plan.plan_id}</Link><small className="cell-note"><Link to={channelPath(plan.channel_id)}>{plan.channel_id}</Link></small></td><td><PlanBadge status={plan.status}/></td><td>{plan.required_domains.map(domain => domainLabels[domain]).join('、')}</td><td>v{plan.version} / {plan.execution_epoch}</td><td>{time(plan.updated_at)}</td><td><Link to={planPath(plan.plan_id)}>查看详情 →</Link></td></tr>)}</tbody></table></div> : <Empty title="没有符合条件的计划">可以调整状态筛选，或创建一轮样本计划。</Empty>}<Pagination cursor={paging.cursor} next={page.next_cursor} count={page.items.length} go={paging.go}/></>}</ResourceView></Panel>
  </>;
}
