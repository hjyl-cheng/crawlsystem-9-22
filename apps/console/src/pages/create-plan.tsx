import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { CreatePlanSchema, type CreatePlan } from '@crawlsystem/contracts';
import { Plus } from 'lucide-react';
import { ApiFailure } from '../api.js';
import { useAuth } from '../auth.js';
import { ErrorBox, PageHeading, Panel, SampleBadge } from '../ui.js';
import { planPath } from '../presentation.js';

function readPending(key: string): CreatePlan | undefined {
  try { const raw = sessionStorage.getItem(key); if (raw) { const parsed = CreatePlanSchema.safeParse(JSON.parse(raw)); if (parsed.success) return parsed.data; } } catch { /* Storage is optional. */ }
}
export default function CreatePlanPage() {
  const { api, session } = useAuth();
  const storageKey = `crawlhub:pending-create:${session.workspace_id}:${session.subject}`;
  const [pending, setPending] = useState<CreatePlan | undefined>(() => readPending(storageKey));
  const pendingRef = useRef(pending);
  const [requireAgent, setRequireAgent] = useState(pending?.required_domains.includes('AGENT') ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure>();
  const busyRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const navigate = useNavigate();
  useEffect(() => () => controller.current?.abort(), []);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(undefined);
    const body = pendingRef.current ?? CreatePlanSchema.parse({ request_id: crypto.randomUUID(), fixture_id: 'channel-basic-v1', required_domains: requireAgent ? ['ABOUT', 'VIDEO', 'AGENT'] : ['ABOUT', 'VIDEO'] });
    pendingRef.current = body; setPending(body);
    try { sessionStorage.setItem(storageKey, JSON.stringify(body)); } catch { /* Keep the identity in memory if storage is unavailable. */ }
    const abort = new AbortController(); controller.current = abort;
    try {
      const plan = await api.create(body, abort.signal);
      try { sessionStorage.removeItem(storageKey); } catch { /* No credentials are stored here. */ }
      navigate(planPath(plan.plan_id), { replace: true });
    } catch (cause) {
      if (!abort.signal.aborted) setError(cause instanceof ApiFailure ? cause : new ApiFailure('创建失败，请核对后重试'));
    } finally { busyRef.current = false; setBusy(false); }
  }
  return <><PageHeading title="创建样本计划" description="创建一轮范围明确、可追溯的固定样本执行。"><Link className="button" to="/plans">返回计划列表</Link></PageHeading>
    {session.role !== 'operator' ? <Panel><div role="alert" className="notice warning">当前为只读身份，没有创建计划的权限。</div></Panel> : <div className="create-layout"><Panel title="本轮采集目标"><form className="create-form" onSubmit={submit}>
      <div className="sample-choice"><SampleBadge/><strong>频道基础样本</strong><code>channel-basic-v1</code><p>验证频道资料、1 条视频与首屏评论的持久入库。</p></div>
      <fieldset disabled={busy || !!pending}><legend>本轮必需领域</legend><label className="checkbox-row"><input type="checkbox" checked readOnly/>频道基础信息<span>必需</span></label><label className="checkbox-row"><input type="checkbox" checked readOnly/>视频与评论<span>必需</span></label><label className="checkbox-row"><input type="checkbox" checked={requireAgent} onChange={e => setRequireAgent(e.target.checked)}/>Agent 分析<span>等待场景验证</span></label></fieldset>
      {requireAgent && <div className="notice warning">M1 尚未接入 Agent 执行。将它设为必需领域后，计划会等待该结果，不能完整完成；可用于验证等待与取消路径。</div>}
      {pending && <div className="notice">已保留本次创建身份。结果不明时重试会核对同一轮计划。<small className="cell-note mono">{pending.request_id}</small></div>}
      {error && <ErrorBox error={error}/>}
      <button className="button primary" disabled={busy || error?.status === 403}><Plus size={16}/>{busy ? '正在提交…' : pending ? '核对并重试本次创建' : '创建并查看计划'}</button>
    </form></Panel><Panel title="本次会发生什么"><ol className="steps"><li><strong>持久创建 Plan</strong><p>冻结本轮目标、必需领域与样本输入。</p></li><li><strong>等待执行与入库</strong><p>Worker 提交结果后，后端产生持久回执。</p></li><li><strong>核对本轮状态</strong><p>可用数据、领域结果与计划状态分别查看。</p></li></ol><div className="notice">固定样本不执行真实网络采集、不使用代理，也不触发对外交付。</div></Panel></div>}
  </>;
}
