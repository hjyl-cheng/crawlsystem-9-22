import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Ban, CheckCircle2, Clock3 } from 'lucide-react';
import { CancelPlanSchema, type Plan, type PlanDetail, type Receipt } from '@crawlsystem/contracts';
import { z } from 'zod';
import { ApiFailure } from '../api.js';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Badge, Empty, ErrorBox, Fields, Modal, PageHeading, Panel, PlanBadge, ResourceView, SampleBadge } from '../ui.js';
import { channelPath, domainLabels, isTerminal, planLabels, receiptPath, time } from '../presentation.js';

export function Receipts({ receipts }: { receipts: Receipt[] }) {
  return receipts.length ? <div className="table-scroll"><table><thead><tr><th>提交身份</th><th>领域</th><th>持久状态</th><th>入库时间</th></tr></thead><tbody>{[...receipts].sort((a, b) => b.applied_at.localeCompare(a.applied_at)).map(receipt => <tr key={receipt.submission_id}><td><Link className="mono" to={receiptPath(receipt.submission_id)}>{receipt.submission_id}</Link></td><td>{domainLabels[receipt.domain]}</td><td><Badge tone="green">已应用 / APPLIED</Badge></td><td>{time(receipt.applied_at)}</td></tr>)}</tbody></table></div> : <Empty title="尚无持久回执">等待执行结果提交并入库。</Empty>;
}

function CancelAction({ plan, refresh, refreshing }: { plan: Plan; refresh: () => void; refreshing: boolean }) {
  const { api, session } = useAuth();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [denied, setDenied] = useState(false);
  const [error, setError] = useState<ApiFailure>(), [message, setMessage] = useState('');
  const command = useRef<z.infer<typeof CancelPlanSchema> | null>(null);
  const busyRef = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  if (session.role !== 'operator') return <span className="muted">只读身份 · 不可取消</span>;
  if (isTerminal(plan)) return <span className="muted">本轮已结束</span>;
  const conflict = error?.status === 409;
  function begin() {
    command.current ??= CancelPlanSchema.parse({ command_id: crypto.randomUUID(), expected_version: plan.version });
    setOpen(true);
  }
  async function cancel() {
    if (busyRef.current || !command.current || conflict || denied) return;
    busyRef.current = true; setBusy(true); setError(undefined);
    const abort = new AbortController(); controller.current = abort;
    try {
      const result = await api.cancel(plan.plan_id, command.current, abort.signal);
      command.current = null; setOpen(false); setMessage(`服务端已返回“${planLabels[result.status]}”，版本 ${result.version}。`); refresh();
    } catch (cause) {
      if (!abort.signal.aborted) {
        const failure = cause instanceof ApiFailure ? cause : new ApiFailure('取消结果尚待核对');
        setError(failure); if (failure.status === 403) setDenied(true);
      }
    } finally { busyRef.current = false; setBusy(false); }
  }
  return <><button className="button danger" disabled={refreshing || denied} onClick={begin}><Ban size={15}/>取消本轮</button>{message && <span role="status">{message}</span>}
    <Modal open={open} onOpenChange={value => { if (!busy) setOpen(value); }} title="确认取消本轮计划" description="取消后本轮将停止接收新的执行结果，已持久保存的数据和回执仍可查询。">
      <Fields rows={[["Plan", <code>{plan.plan_id}</code>], ["提交时的期望版本", command.current?.expected_version]]}/>
      {error && <ErrorBox error={error}/>}
      {conflict && <div className="notice warning">计划状态或版本已经变化。请刷新后重新查看并决定是否取消，系统不会自动重提。</div>}
      {error && !conflict && !denied && <div className="notice">结果未确认时，再次提交会使用同一个取消身份和期望版本。</div>}
      <div className="dialog-actions"><button className="button" disabled={busy} onClick={() => setOpen(false)}>返回查看</button>{conflict ? <button className="button primary" onClick={() => { command.current = null; setError(undefined); setOpen(false); refresh(); }}>刷新计划</button> : <button className="button danger" disabled={busy || denied} onClick={() => void cancel()}>{busy ? '正在提交取消…' : '确认取消'}</button>}</div>
    </Modal>
  </>;
}

function Content({ detail, refresh, refreshing }: { detail: PlanDetail; refresh: () => void; refreshing: boolean }) {
  const { plan, input, domains, receipts, events } = detail;
  const applied = plan.required_domains.filter(domain => domains.some(result => result.domain === domain && result.state === 'APPLIED')).length;
  const latestEvent = [...events].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const reasons = events.filter(event => ['WAITING', 'ERROR', 'FAILED'].includes(event.kind));
  return <>
    <div className="plan-summary"><div className="inline"><SampleBadge/><PlanBadge status={plan.status}/><span className={`summary-progress ${applied < plan.required_domains.length ? 'partial' : ''}`} title="必需领域入库进度"><span><i style={{ width: `${applied / plan.required_domains.length * 100}%` }}/></span>{applied} / {plan.required_domains.length} 必需领域已入库</span><span className="muted">状态更新于 {time(plan.updated_at)}</span></div><CancelAction plan={plan} refresh={refresh} refreshing={refreshing}/></div>
    {applied > 0 && applied < plan.required_domains.length && <div className="notice warning">部分必需领域已有入库结果（{applied} / {plan.required_domains.length}）。请继续核对本轮计划状态与未完成领域。</div>}
    <div className="detail-grid"><Panel title="本轮目标与业务身份"><Fields rows={[
      ['Plan ID', <code>{plan.plan_id}</code>], ['业务轮次 ID', <code>{plan.run_id}</code>], ['频道', <Link to={channelPath(plan.channel_id)}>{plan.channel_id}</Link>], ['工作空间', plan.workspace_id],
      ['样本', plan.fixture_id], ['必需领域', plan.required_domains.map(domain => domainLabels[domain]).join('、')], ['目标视频', input.target_video_ids.join('、') || '本轮没有视频目标'],
      ['输入版本', <code>{plan.input_hash}</code>], ['来源修订', plan.source_revision], ['计划版本', plan.version], ['创建时间', time(plan.created_at)], ['总期限', time(plan.deadline_at)], ['结束时间', plan.finished_at ? time(plan.finished_at) : '尚未结束'],
    ]}/></Panel><div><Panel title="必需领域结果"><div className="domain-list">{plan.required_domains.map(domain => {
      const result = domains.find(item => item.domain === domain);
      return <div key={domain} className="domain-row">{result?.state === 'APPLIED' ? <CheckCircle2 className="text-green" size={21}/> : <Clock3 className="text-amber" size={21}/>}<div><strong>{domainLabels[domain]}</strong><small>{result?.state === 'APPLIED' ? `入库于 ${time(result.completed_at)}` : domain === 'AGENT' ? 'M1 尚未接入执行，本轮仍要求该结果' : result ? '等待本轮完整入库证明' : '后端尚未提供领域状态'}</small></div><Badge tone={result?.state === 'APPLIED' ? 'green' : 'amber'}>{result?.state === 'APPLIED' ? '已入库' : '待核对'}</Badge></div>;
    })}</div></Panel><Panel title="当前阶段 / 等待原因"><Fields rows={[["最近上报阶段", latestEvent?.phase ?? '尚无执行阶段上报'], ['执行代次', plan.execution_epoch], ['Workflow 身份', <code>{plan.workflow_id}</code>]]}/>
      {reasons[0] ? <div className="notice warning"><strong>{reasons[0].kind} · {reasons[0].phase}</strong><p>{reasons[0].message}</p><small>{time(reasons[0].created_at)}</small></div> : <p className="muted inset">尚无等待或失败原因上报。</p>}
      <p className="fine-print inset">Workflow 身份已分配不代表执行已启动，请核对阶段事件与持久回执。</p></Panel><Panel title="Agent 与交付"><Fields rows={[["真实 Agent 执行", '尚未接入'], ['对外交付', '未启用']]}/></Panel></div></div>
    <Panel title="持久回执" extra={<span className="muted">本轮最多返回 300 笔</span>}><Receipts receipts={receipts}/></Panel>
    <Panel title="执行事件与关联错误" extra={<span className="muted">最近最多 100 条事件</span>}>{events.length ? <div className="timeline">{events.map(event => <article key={event.event_id} className={['ERROR','FAILED'].includes(event.kind) ? 'event-error' : ''}><span className="timeline-dot"/><div className="inline"><Badge tone={['ERROR','FAILED'].includes(event.kind) ? 'red' : 'blue'}>{event.kind}</Badge><strong>{event.phase}</strong><time>{time(event.created_at)}</time></div><p>{event.message}</p><div className="muted">Worker：<Link to={`/workers?highlight=${encodeURIComponent(event.worker_id)}`}>{event.worker_id}</Link> · 代次 {event.execution_epoch}{event.domain && ` · ${domainLabels[event.domain]}`}{event.error_code && <> · <Link to={`/errors?event=${encodeURIComponent(event.event_id)}`}>{event.error_code}</Link></>}</div></article>)}</div> : <Empty title="尚无执行事件">等待 Worker 上报。不会由创建成功推断执行已经启动。</Empty>}</Panel>
  </>;
}
export default function PlanDetailPage() {
  const { id = '' } = useParams(); const { api } = useAuth();
  const resource = useResource(`plan:${id}`, signal => api.plan(id, signal), d => !isTerminal(d.plan));
  return <><PageHeading title="Plan 详情" description="核对本轮领域结果、执行阶段与持久回执。"><Link className="button" to="/plans">返回计划列表</Link></PageHeading><ResourceView resource={resource}>{detail => <Content key={id} detail={detail} refresh={resource.refresh} refreshing={resource.refreshing}/>}</ResourceView></>;
}
