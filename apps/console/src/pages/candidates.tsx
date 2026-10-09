import { useState, type ReactNode } from 'react';
import { CircleCheck, CircleX, ExternalLink, ListChecks, RefreshCw, Search, Sparkles, UserCheck } from 'lucide-react';
import { BUSINESS_CATEGORIES, type BusinessCategory, type Candidate } from '@crawlsystem/contracts';
import { useAuth } from '../auth.js';
import { ApiFailure } from '../api.js';
import { useResource } from '../resource.js';
import { Empty, ErrorBox, ResourceView } from '../ui.js';
import { categoryLabels, time } from '../presentation.js';
import './overview.css';
import './discover.css';

const stateMeta: Record<Candidate['state'], { label: string; tone: string }> = {
  QUALIFIED: { label: '合格，待准入', tone: 'blue' }, ADMITTED: { label: '已准入', tone: 'green' }, UNQUALIFIED: { label: '未达标', tone: 'slate' },
  UNAVAILABLE: { label: '频道不存在', tone: 'slate' }, REJECTED: { label: '已拒绝', tone: 'red' },
};
const reasonText: Record<NonNullable<Candidate['reason']>, string> = { below_threshold: '订阅不足 1000', hidden_subscribers: '隐藏了订阅数', not_found: 'YouTube 上已不存在' };
const importText: Record<NonNullable<Candidate['import_state']>, string> = { queued: '排队等待采集', planned: '正在采集', done: '已采集', failed: '采集失败' };
const fmt = (n?: number | null) => n === undefined || n === null ? '—' : n.toLocaleString('zh-CN');

function Kpi({ label, tone, icon, value, foot }: { label: string; tone: string; icon: ReactNode; value?: ReactNode; foot: ReactNode }) {
  return <section className={`panel discover-kpi tone-${tone}`}><span className="kpi-icon">{icon}</span><div><small>{label}</small><strong>{value ?? '—'}</strong><span className="kpi-foot"><span>{foot}</span></span></div></section>;
}

/** Candidate channels found by query searches: admitted automatically when qualified, or decided by an operator. */
export default function Candidates() {
  const { api, session } = useAuth();
  const operator = session.role === 'operator';
  const [filter, setFilter] = useState<{ state?: Candidate['state']; category?: BusinessCategory; search?: string }>({});
  const [cursor, setCursor] = useState('0'), [busy, setBusy] = useState<string>(), [error, setError] = useState<ApiFailure>();
  const summary = useResource('candidate-summary', signal => api.candidateSummary(signal), true, 30_000);
  const list = useResource(`candidates:${cursor}:${JSON.stringify(filter)}`, signal => api.candidates(cursor, filter, signal), true, 30_000);
  const s = summary.data;
  const refresh = () => { summary.refresh(); list.refresh(); };
  const set = (next: typeof filter) => { setFilter(next); setCursor('0'); };
  async function decide(c: Candidate, action: 'admit' | 'reject') {
    const needsReason = action === 'reject' || c.state !== 'QUALIFIED';
    const reason = window.prompt(action === 'reject' ? '拒绝原因' : needsReason ? '准入原因（未达标或已拒绝的频道需要说明）' : '准入备注（可不填）')?.trim();
    if (reason === undefined || (needsReason && !reason)) return;
    setBusy(c.channel_id); setError(undefined);
    try {
      await api.candidateCommand(c.channel_id, action === 'reject' ? { action, reason, expected_version: c.version } : { action, ...(reason ? { reason } : {}), expected_version: c.version });
      refresh();
    } catch (cause) { setError(cause instanceof ApiFailure ? cause : new ApiFailure('操作失败，请刷新后重试')); }
    finally { setBusy(undefined); }
  }
  const categoryMax = Math.max(1, ...(s?.by_category.map(c => c.qualified + c.admitted) ?? [1]));
  return <div className="dashboard discover">
    <header className="dashboard-heading">
      <div><h1>候选频道</h1><p>自动搜索新发现的频道：订阅 ≥1000 为合格，按分类轮流自动进入采集队列；可以人工拒绝，或手动准入</p>
        {s && <span className={`data-freshness ${s.auto_admit ? '' : 'failing'}`}><i/>{s.auto_admit ? `自动准入已开启：采集队列保持 ${fmt(s.import_buffer)} 个，当前排队 ${fmt(s.import_queue)} 个` : '自动准入已关闭，只能人工准入'}</span>}</div>
      <div className="dashboard-period"><button className="button small" onClick={refresh}><RefreshCw size={13}/>刷新</button></div>
    </header>
    {summary.error && <ErrorBox error={summary.error}/>} {error && <ErrorBox error={error}/>}

    <div className="discover-kpis">
      <Kpi label="合格，待准入" tone="blue" icon={<Sparkles size={22}/>} value={fmt(s?.by_state.QUALIFIED)} foot="按分类轮流进入采集队列"/>
      <Kpi label="已准入" tone="green" icon={<UserCheck size={22}/>} value={fmt(s?.by_state.ADMITTED)} foot={s ? `今天 ${fmt(s.admitted_today)} 个` : '—'}/>
      <Kpi label="未达标 / 不存在" tone="amber" icon={<ListChecks size={22}/>} value={s ? `${fmt(s.by_state.UNQUALIFIED)} / ${fmt(s.by_state.UNAVAILABLE)}` : undefined} foot="不会自动采集，可人工准入"/>
      <Kpi label="已拒绝" tone="red" icon={<CircleX size={22}/>} value={fmt(s?.by_state.REJECTED)} foot="人工拒绝，保留原因"/>
    </div>

    <div className="discover-row row-list">
      <section className="panel discover-card query-list">
        <div className="panel-heading"><div><h2>候选列表</h2></div><div className="list-tools">
          <select aria-label="候选状态" value={filter.state ?? ''} onChange={e => set({ ...filter, state: (e.target.value || undefined) as Candidate['state'] | undefined })}>
            <option value="">全部状态</option>{Object.entries(stateMeta).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
          <select aria-label="业务分类" value={filter.category ?? ''} onChange={e => set({ ...filter, category: (e.target.value || undefined) as BusinessCategory | undefined })}>
            <option value="">全部分类</option>{BUSINESS_CATEGORIES.map(c => <option key={c} value={c}>{categoryLabels[c]}</option>)}</select>
          <label className="list-search"><Search size={13}/><input aria-label="搜索候选" placeholder="频道名、ID 或搜索词…" maxLength={200} value={filter.search ?? ''} onChange={e => set({ ...filter, search: e.target.value || undefined })}/></label>
        </div></div>
        <ResourceView resource={list}>{page => <>{page.items.length ? <div className="table-scroll"><table><thead><tr><th>频道</th><th>国家</th><th>订阅</th><th>视频</th><th>由哪个搜索词发现</th><th>状态</th><th>发现时间</th>{operator && <th>操作</th>}</tr></thead>
          <tbody>{page.items.map(c => { const meta = stateMeta[c.state]; return <tr key={c.channel_id}>
            <td className="query-term"><a href={`https://www.youtube.com/channel/${c.channel_id}`} target="_blank" rel="noreferrer">{c.title ?? c.channel_id} <ExternalLink size={11}/></a><small className="cell-sub">{c.channel_id}</small></td>
            <td>{c.country ?? '—'}</td><td>{fmt(c.subscriber_count)}</td><td>{fmt(c.video_count)}</td>
            <td>{c.found_by.text}<small className="cell-sub">{c.found_by.country} · {categoryLabels[c.found_by.category]}{c.found_count > 1 ? ` · 共被搜到 ${c.found_count} 次` : ''}</small></td>
            <td><span className={`status-chip ${meta.tone}`}><i/>{meta.label}</span>
              {c.reason && <small className="cell-sub">{reasonText[c.reason]}</small>}
              {c.import_state && <small className="cell-sub">{importText[c.import_state]}</small>}
              {c.decided_by && c.decided_by !== 'auto' && <small className="cell-sub" title={c.decision_reason ?? ''}>{c.decided_by}{c.decision_reason ? `：${c.decision_reason}` : ''}</small>}</td>
            <td>{time(c.discovered_at)}</td>
            {operator && <td className="row-actions">
              {['QUALIFIED', 'UNQUALIFIED', 'REJECTED'].includes(c.state) && <button className="text-button" disabled={!!busy} onClick={() => void decide(c, 'admit')}>准入</button>}
              {c.state !== 'REJECTED' && (c.state !== 'ADMITTED' || c.import_state === 'queued') && <button className="text-button" disabled={!!busy} onClick={() => void decide(c, 'reject')}>拒绝</button>}
            </td>}
          </tr>; })}</tbody></table></div> : <Empty title="没有符合条件的候选频道">自动搜索发现新频道后会显示在这里。</Empty>}
          <footer className="pager"><span>每页最多 20 条</span><button className="button small" disabled={cursor === '0'} onClick={() => setCursor(String(Math.max(0, Number(cursor) - 20)))}>上一页</button><button className="button small" disabled={!page.next_cursor} onClick={() => setCursor(page.next_cursor!)}>下一页</button></footer></>}</ResourceView>
      </section>
      <section className="panel discover-card">
        <div className="panel-heading"><div><h2>业务分类</h2><p>待准入 / 已准入（按发现它的搜索词分类）</p></div></div>
        {s?.by_category.length ? <div className="reason-bars">{s.by_category.map(c => <div key={c.category} title={`待准入 ${c.qualified}，已准入 ${c.admitted}`}><span>{categoryLabels[c.category]}</span><div className="dim-bar"><i style={{ width: `${((c.qualified + c.admitted) / categoryMax) * 100}%` }}/></div><b>{fmt(c.qualified)} / {fmt(c.admitted)}</b></div>)}</div>
          : <Empty title="还没有合格候选">自动搜索发现合格频道后显示各分类的数量。</Empty>}
      </section>
    </div>
    <footer className="dashboard-foot"><span><CircleCheck size={12}/> 合格 = 订阅 ≥1000；采集队列有空位时，各分类轮流准入（近 7 天准入少的分类优先），同一分类内订阅多的优先。</span><span>统计时间：{s ? time(s.observed_at) : '—'}</span></footer>
  </div>;
}
