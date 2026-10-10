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
/** Accepts a canonical channel ID or a /channel/UC… link; handles need resolving first. */
export function channelIdFrom(text: string): string | undefined {
  const value = text.trim(), direct = /^UC[A-Za-z0-9_-]{22}$/;
  if (direct.test(value)) return value;
  try { const id = new URL(value).pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/|$)/)?.[1]; if (id) return id; } catch { /* Not a URL. */ }
}
type Mode = 'youtube' | 'fixture';
export default function CreatePlanPage() {
  const { api, session } = useAuth();
  const storageKey = `crawlhub:pending-create:${session.workspace_id}:${session.subject}`;
  const [pending, setPending] = useState<CreatePlan | undefined>(() => readPending(storageKey));
  const pendingRef = useRef(pending);
  const [mode, setMode] = useState<Mode>(pending && !('source_mode' in pending) ? 'fixture' : 'youtube');
  const [requireAgent, setRequireAgent] = useState(pending?.required_domains.includes('AGENT') ?? false);
  const [channel, setChannel] = useState(pending && 'source_mode' in pending ? pending.channel_id : '');
  const [scope, setScope] = useState(pending && 'source_mode' in pending ? pending.scope : { video_limit: 30, max_age_days: 90, comments_per_video: 20, comment_sort: 'TOP_COMMENTS' as const });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure>();
  const busyRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const navigate = useNavigate();
  useEffect(() => () => controller.current?.abort(), []);
  const channelId = channelIdFrom(channel);
  function build(): CreatePlan | undefined {
    if (mode === 'fixture') return CreatePlanSchema.parse({ request_id: crypto.randomUUID(), fixture_id: 'channel-basic-v1', required_domains: requireAgent ? ['ABOUT', 'VIDEO', 'AGENT'] : ['ABOUT', 'VIDEO'] });
    const parsed = CreatePlanSchema.safeParse({ request_id: crypto.randomUUID(), source_mode: 'youtube', channel_id: channelId, scope });
    if (!parsed.success) { setError(new ApiFailure('请填写有效的频道 ID（UC 开头 24 位），采集范围需在允许区间内。', 400, 'INVALID_REQUEST')); return undefined; }
    return parsed.data;
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busyRef.current) return;
    const body = pendingRef.current ?? build();
    if (!body) return;
    busyRef.current = true; setBusy(true); setError(undefined);
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
  const locked = busy || !!pending;
  const number = (key: 'video_limit' | 'max_age_days' | 'comments_per_video', label: string, min: number, max: number, unit: string) =>
    <label className="scope-field">{label}<span><input type="number" aria-label={label} min={min} max={max} value={scope[key]} disabled={locked}
      onChange={e => setScope({ ...scope, [key]: Number(e.target.value) })}/>{unit}</span><small>{min}～{max}</small></label>;
  return <><PageHeading title="创建计划" description="冻结目标与范围，创建一轮可追溯、可恢复的采集执行。"><Link className="button" to="/plans">返回计划列表</Link></PageHeading>
    {session.role !== 'operator' ? <Panel><div role="alert" className="notice warning">当前为只读身份，没有创建计划的权限。</div></Panel> : <div className="create-layout"><Panel title="本轮采集目标"><form className="create-form" onSubmit={submit}>
      <fieldset className="mode-choice" disabled={locked}><legend>计划类型</legend>
        <label className="checkbox-row"><input type="radio" name="mode" checked={mode === 'youtube'} onChange={() => { setMode('youtube'); setError(undefined); }}/>真实 YouTube 频道<span>基础信息 · 视频 · 首屏评论 · Agent 画像</span></label>
        <label className="checkbox-row"><input type="radio" name="mode" checked={mode === 'fixture'} onChange={() => { setMode('fixture'); setError(undefined); }}/>固定样本<span>联调与故障验证，不访问 YouTube</span></label></fieldset>
      {mode === 'youtube' ? <>
        <label className="scope-field wide">频道<input aria-label="频道 ID 或链接" placeholder="UC… 或 https://www.youtube.com/channel/UC…" value={channel} disabled={locked} onChange={e => setChannel(e.target.value)}/>
          <small>{channel && !channelId ? '需要 UC 开头的频道 ID 或 /channel/ 链接；@handle 暂不支持直接解析。' : channelId ? <span className="mono">{channelId}</span> : '规范频道 ID 作为计划身份，重试与恢复都针对同一频道。'}</small></label>
        <fieldset className="scope-grid" disabled={locked}><legend>采集范围（创建时冻结）</legend>
          {number('video_limit', '最近视频数', 1, 100, '个')}{number('comments_per_video', '每个视频的首屏评论', 0, 100, '条')}</fieldset>
        <div className="notice">必需领域：频道基础信息、视频与评论、Agent 画像。任一领域未完成，计划不会显示为完成。</div>
      </> : <>
        <div className="sample-choice"><SampleBadge/><strong>频道基础样本</strong><code>channel-basic-v1</code><p>验证频道资料、1 条视频与首屏评论的持久入库。</p></div>
        <fieldset disabled={locked}><legend>本轮必需领域</legend><label className="checkbox-row"><input type="checkbox" checked readOnly/>频道基础信息<span>必需</span></label><label className="checkbox-row"><input type="checkbox" checked readOnly/>视频与评论<span>必需</span></label><label className="checkbox-row"><input type="checkbox" checked={requireAgent} onChange={e => setRequireAgent(e.target.checked)}/>Agent 分析<span>等待场景验证</span></label></fieldset>
        {requireAgent && <div className="notice warning">固定样本没有 Agent 执行。将它设为必需领域后，计划会等待该结果，不能完整完成；可用于验证等待与取消路径。</div>}
      </>}
      {pending && <div className="notice">已保留本次创建身份。结果不明时重试会核对同一轮计划。<small className="cell-note mono">{pending.request_id}</small></div>}
      {error && <ErrorBox error={error}/>}
      <button className="button primary" disabled={busy || error?.status === 403}><Plus size={16}/>{busy ? '正在提交…' : pending ? '核对并重试本次创建' : '创建并查看计划'}</button>
    </form></Panel><Panel title="本次会发生什么"><ol className="steps"><li><strong>持久创建 Plan</strong><p>冻结本轮目标、范围与必需领域。</p></li><li><strong>执行与分批入库</strong><p>{mode === 'youtube' ? 'Worker 先列出并冻结目标视频，再分批提交视频与评论，最后基于入库事实生成 Agent 画像；每批都有持久回执，中断后只补未完成部分。' : 'Worker 提交固定样本结果后，后端产生持久回执。'}</p></li><li><strong>核对本轮状态</strong><p>可用数据、领域结果与计划状态分别查看。</p></li></ol>
      <div className="notice">{mode === 'youtube' ? '真实采集经节点代理访问 YouTube；视频详情失败时按配额使用 Data API 补采。' : '固定样本不执行真实网络采集、不使用代理，也不触发对外交付。'}</div></Panel></div>}
  </>;
}
