import { Link } from 'react-router';
import type { StoredEvent } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Badge, Empty, Fields, PageHeading, Panel, Pagination, ResourceView, usePagination } from '../ui.js';
import { domainLabels, errorCodeLabels, planPath, time } from '../presentation.js';
import { Receipts } from './plan-detail.js';

function ErrorContext({ event }: { event: StoredEvent }) {
  const { api } = useAuth();
  const resource = useResource(`error-plan:${event.plan_id}`, signal => api.plan(event.plan_id, signal), false);
  return <Panel title="错误关联"><Fields rows={[
    ['事件身份', <code>{event.event_id}</code>], ['类别', event.error_code ? `${errorCodeLabels[event.error_code]}（${event.error_code}）` : event.kind], ['阶段', event.phase], ['发生时间', time(event.created_at)], ['原因', event.message], ['领域', event.domain ? domainLabels[event.domain] : '未指定'], ['执行代次', event.execution_epoch], ['关联 Plan', <Link to={planPath(event.plan_id)}>{event.plan_id}</Link>], ['关联 Worker', <Link to={`/workers?highlight=${encodeURIComponent(event.worker_id)}`}>{event.worker_id}</Link>],
  ]}/><div className="panel-heading"><h3>关联 Plan 的最近回执</h3><Link to={planPath(event.plan_id)}>进入 Plan 详情 →</Link></div><ResourceView resource={resource}>{detail => <Receipts receipts={[...detail.receipts].sort((a,b) => b.applied_at.localeCompare(a.applied_at)).slice(0, 5)}/>}</ResourceView><p className="fine-print inset">错误按单次事件展示。事件未提供直接关联的回执、节点或首次/最近发生时间聚合。</p></Panel>;
}
export default function Errors() {
  const { api } = useAuth(); const paging = usePagination();
  const selected = paging.params.get('event');
  const resource = useResource(`errors:${paging.cursor}`, signal => api.errors(paging.cursor, 20, signal));
  return <><PageHeading title="错误与追踪" description="从后端登记的错误事件定位 Plan、Worker 和持久回执。"/><Panel title="错误事件"><ResourceView resource={resource}>{page => <>
    {selected && !page.items.some(e => e.event_id === selected) && <div className="notice">当前页未包含所选事件。可继续翻页，或从对应 Plan 查看最近事件。</div>}
    {page.items.length ? <div className="table-scroll"><table><thead><tr><th>发生时间</th><th>类别 / 阶段</th><th>错误原因</th><th>Worker</th><th>关联对象</th></tr></thead><tbody>{page.items.map(event => <tr key={event.event_id} className={selected === event.event_id ? 'highlight-row' : ''}><td>{time(event.created_at)}</td><td><span title={event.error_code ?? event.kind}><Badge tone="red">{event.error_code ? errorCodeLabels[event.error_code] : event.kind === 'FAILED' ? '执行失败' : '执行错误'}</Badge></span><small className="cell-note">{event.phase}</small></td><td className="message-cell">{event.message}</td><td><Link to={`/workers?highlight=${encodeURIComponent(event.worker_id)}`}>{event.worker_id}</Link></td><td><Link to={planPath(event.plan_id)}>查看 Plan</Link><button className="text-button" onClick={() => { const params = new URLSearchParams(paging.params); params.set('event', event.event_id); paging.setParams(params); }}>查看错误关联</button></td></tr>)}</tbody></table></div> : <Empty title="查询范围内暂无错误事件"/>}
    <Pagination cursor={paging.cursor} next={page.next_cursor} count={page.items.length} go={paging.go}/>
    </>}</ResourceView></Panel>{resource.data?.items.find(event => event.event_id === selected) && ![401,403].includes(resource.error?.status ?? 0) && <ErrorContext event={resource.data.items.find(event => event.event_id === selected)!}/>}</>;
}
