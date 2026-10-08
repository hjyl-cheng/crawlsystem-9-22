import { useState } from 'react';
import { Link } from 'react-router';
import { OVERRIDE_DAYS, type ChannelDetail, type ChannelManagementCommand, type ClockName } from '@crawlsystem/contracts';
import { ApiFailure } from '../api.js';
import { useAuth } from '../auth.js';
import { ErrorBox } from '../ui.js';
import { clockLabels, clockReasonLabels, clockState, dueIn, managementLabels, planPath, time } from '../presentation.js';
import './clock-policy.css';

const actions: Record<string, [ChannelManagementCommand['action'], string][]> = {
  none: [['manage', '纳入持续更新']], removed: [['manage', '重新纳入']], managed: [['pause', '暂停'], ['remove', '移出纳管']], paused: [['resume', '恢复'], ['remove', '移出纳管']],
};
const day = (iso: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(iso));

/**
 * A channel's update policy (M3): the three clocks with interval, next run, state and reason, and for
 * operators the management actions and a per-domain interval override (automatic = policy).
 */
export default function ClockPolicy({ channel, operator, onChanged }: { channel: ChannelDetail; operator: boolean; onChanged: () => void }) {
  const { api } = useAuth();
  const m = channel.management, state = m.state ?? 'none';
  const [busy, setBusy] = useState(false), [error, setError] = useState<ApiFailure>();
  async function run(call: () => Promise<unknown>) {
    setBusy(true); setError(undefined);
    try { await call(); onChanged(); }
    catch (cause) { setError(cause instanceof ApiFailure ? cause : new ApiFailure('操作失败，请刷新后重试')); }
    finally { setBusy(false); }
  }
  const manage = (action: ChannelManagementCommand['action']) => run(() => api.manageChannel(channel.channel_id, { action, expected_version: m.version }));
  const pin = (clock: ClockName, value: string) => run(() => api.overrideClock(channel.channel_id, { clock, interval_days: value === 'auto' ? null : Number(value) as typeof OVERRIDE_DAYS[number], expected_version: m.version }));
  const available = channel.source_mode === 'youtube' ? actions[state]! : [];
  return <div className="clock-policy">
    <div className="clock-policy-head"><span className={`status-chip ${state === 'managed' ? 'green' : state === 'paused' ? 'amber' : ''}`}><i/>{managementLabels[state]}</span>
      {operator && available.map(([action, label]) => <button key={action} className="button small" disabled={busy} onClick={() => void manage(action)}>{label}</button>)}</div>
    {error && <ErrorBox error={error}/>}
    {m.clocks.length ? m.clocks.map(c => {
      const s = clockState(c, m.state);
      return <div key={c.clock} className="policy-row">
        <b>{clockLabels[c.clock]} · 每 {c.interval_days} 天{c.override_days !== null && <small className="pinned">人工</small>}</b>
        <span>下次 {time(c.next_due_at)}（{dueIn(c.next_due_at)}{c.retry_at ? '，重试' : ''}）· {clockReasonLabels[c.reason]}
          {c.refresh_due_at && ` · 近期视频刷新 ${day(c.refresh_due_at)} 起`} · 上次成功 {c.last_success_at ? <>{day(c.last_success_at)}{c.last_plan_id && <> <Link to={planPath(c.last_plan_id)}>计划</Link></>}</> : '—'}</span>
        <em className={s.tone}>{s.label}</em>
        {operator && <label className="policy-edit">更新间隔
          <select aria-label={`${clockLabels[c.clock]}更新间隔`} value={c.override_days ?? 'auto'} disabled={busy} onChange={e => void pin(c.clock, e.target.value)}>
            <option value="auto">自动（按策略）</option>{OVERRIDE_DAYS.map(d => <option key={d} value={d}>固定每 {d} 天</option>)}
          </select></label>}
      </div>;
    }) : <p className="detail-note">{channel.source_mode !== 'youtube' ? '固定样本频道不参与持续更新。' : state === 'removed' ? '已移出纳管，不再自动更新，可重新纳入。' : '首次采集完成后自动纳入持续更新；也可以手动纳入。'}</p>}
    {m.clocks.length > 0 && <p className="detail-note">策略 {m.clocks[0]!.policy_version}：按固定分档自动计算，可按频道人工指定间隔。调度器上线前（M3 第 2 步），到期不会自动执行。</p>}
  </div>;
}
