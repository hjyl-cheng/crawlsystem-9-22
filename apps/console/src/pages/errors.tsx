import { Link } from 'react-router';
import type { StoredEvent } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Badge, Empty, Fields, PageHeading, Panel, Pagination, ResourceView, usePagination } from '../ui.js';
import { domainLabels, errorCodeLabels, failureCode, planPath, time } from '../presentation.js';
import './discover.css';
import { Receipts } from './plan-detail.js';

function ErrorContext({ event }: { event: StoredEvent }) {
  const { api } = useAuth();
  const resource = useResource(`error-plan:${event.plan_id}`, signal => api.plan(event.plan_id, signal), false);
  return <Panel title="错误关联"><Fields rows={[
    ['事件身份', <code>{event.event_id}</code>], ['类别', event.error_code ? `${errorCodeLabels[event.error_code]}（${event.error_code}）` : event.kind], ['阶段', event.phase], ['发生时间', time(event.created_at)], ['原因', <span title={event.message}>{errorMessageText(event.message)}</span>], ['领域', event.domain ? domainLabels[event.domain] : '未指定'], ['执行代次', event.execution_epoch], ['关联 Plan', <Link to={planPath(event.plan_id)}>{event.plan_id}</Link>], ['关联 Worker', <Link to={`/workers?highlight=${encodeURIComponent(event.worker_id)}`}>{event.worker_id}</Link>],
  ]}/><div className="panel-heading"><h3>关联任务的最近回执</h3><Link to={planPath(event.plan_id)}>进入任务详情 →</Link></div><ResourceView resource={resource}>{detail => <Receipts receipts={[...detail.receipts].sort((a,b) => b.applied_at.localeCompare(a.applied_at)).slice(0, 5)}/>}</ResourceView><p className="fine-print inset">错误按单次事件展示。事件未提供直接关联的回执、节点或首次/最近发生时间聚合。</p></Panel>;
}
/** "UNAVAILABLE; retryable=true; attempt=2; correlation=web:network" in words; other messages stay as they are. */
const correlationText: Record<string, string> = { 'web:network': '网页请求网络异常', 'web:blocked': '网页请求被风控拦截', 'web:parse': '网页结构无法解析', 'web:upstream': 'YouTube 上游异常' };
export function errorMessageText(message: string): string {
  const parts = message.split(/;\s*/), code = parts[0] ?? '';
  if (!/^[A-Z_]+$/.test(code)) return message;
  const fields = Object.fromEntries(parts.slice(1).map(p => p.split('=') as [string, string]));
  return [failureCode(code), fields.attempt && `第 ${fields.attempt} 次尝试`, fields.retryable === 'true' ? '会自动重试' : fields.retryable === 'false' ? '不会自动重试' : '',
    fields.correlation && (correlationText[fields.correlation] ?? fields.correlation)].filter(Boolean).join(' · ');
}
/** Consecutive events of one plan, phase and code are one problem: one row with its count and first/last time. */
export function groupEvents(events: StoredEvent[]) {
  const groups: { latest: StoredEvent; first: StoredEvent; count: number }[] = [];
  for (const event of events) {
    const last = groups.at(-1), key = (e: StoredEvent) => `${e.plan_id}|${e.phase}|${e.error_code ?? e.kind}`;
    if (last && key(last.latest) === key(event)) { last.first = event; last.count++; } else groups.push({ latest: event, first: event, count: 1 });
  }
  return groups;
}
export default function Errors() {
  const { api } = useAuth(); const paging = usePagination();
  const selected = paging.params.get('event');
  const resource = useResource(`errors:${paging.cursor}`, signal => api.errors(paging.cursor, 20, signal));
  const select = (id: string) => { const params = new URLSearchParams(paging.params); params.set('event', id); paging.setParams(params); };
  return <><PageHeading title="错误与追踪" description="后端登记的错误事件：同一计划同一阶段的连续重试合并为一行，可定位到计划、Worker 和回执。"/><Panel title="错误事件"><ResourceView resource={resource}>{page => <>
    {selected && !page.items.some(e => e.event_id === selected) && <div className="notice">当前页未包含所选事件。可继续翻页，或从对应 Plan 查看最近事件。</div>}
    {page.items.length ? <div className="table-scroll"><table><thead><tr><th>最近发生</th><th>类别 / 阶段</th><th>错误原因</th><th className="num">次数</th><th>Worker</th><th>关联对象</th></tr></thead><tbody>{groupEvents(page.items).map(({ latest: event, first, count }) =>
      <tr key={event.event_id} className={selected === event.event_id ? 'highlight-row' : ''}>
        <td>{time(event.created_at)}{count > 1 && <span className="cell-sub">首次 {time(first.created_at)}</span>}</td>
        <td><span title={event.error_code ?? event.kind}><Badge tone="red">{event.error_code ? errorCodeLabels[event.error_code] : event.kind === 'FAILED' ? '执行失败' : '执行错误'}</Badge></span><span className="cell-sub">{event.phase}</span></td>
        <td className="message-cell" title={event.message}>{errorMessageText(event.message)}</td>
        <td className="num">{count}</td>
        <td><Link to={`/workers?highlight=${encodeURIComponent(event.worker_id)}`}>{event.worker_id}</Link></td>
        <td><Link to={planPath(event.plan_id)}>查看 Plan</Link> <button className="text-button" onClick={() => select(event.event_id)}>查看错误关联</button></td></tr>)}</tbody></table></div> : <Empty title="查询范围内暂无错误事件"/>}
    <Pagination cursor={paging.cursor} next={page.next_cursor} count={page.items.length} go={paging.go}/>
    </>}</ResourceView></Panel>{resource.data?.items.find(event => event.event_id === selected) && ![401,403].includes(resource.error?.status ?? 0) && <ErrorContext event={resource.data.items.find(event => event.event_id === selected)!}/>}</>;
}
