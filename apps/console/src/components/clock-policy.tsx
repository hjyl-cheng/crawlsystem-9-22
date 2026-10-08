import { useState } from 'react';
import type { ChannelDetail, ClockName } from '@crawlsystem/contracts';
import { ApiFailure } from '../api.js';
import { useAuth } from '../auth.js';
import { ErrorBox } from '../ui.js';
import { clockLabels, clockReasonLabels, clockState, dueIn } from '../presentation.js';
import './clock-policy.css';

/** Interval choices offered to operators; "auto" lets the policy decide. */
const choices: [string, string][] = [['auto', '自动（推荐）'], ['1', '每天'], ['3', '每 3 天'], ['7', '每周'], ['14', '每 2 周'], ['30', '每月'], ['90', '每 3 个月'], ['180', '每半年']];
const day = (iso: string) => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(iso));

/**
 * A channel's update policy in plain terms: an on/off switch for automatic updates, and per kind of
 * data how often, when next, when last, plus an interval choice for operators. Reasons stay in tooltips.
 */
export default function ClockPolicy({ channel, operator, onChanged }: { channel: ChannelDetail; operator: boolean; onChanged: () => void }) {
  const { api } = useAuth();
  const m = channel.management, on = m.state === 'managed';
  const [busy, setBusy] = useState(false), [error, setError] = useState<ApiFailure>();
  async function run(call: () => Promise<unknown>) {
    setBusy(true); setError(undefined);
    try { await call(); onChanged(); }
    catch (cause) { setError(cause instanceof ApiFailure ? cause : new ApiFailure('操作失败，请刷新后重试')); }
    finally { setBusy(false); }
  }
  if (channel.source_mode !== 'youtube') return <p className="detail-note">固定样本频道不参与自动更新。</p>;
  // Paused ⇄ managed is the switch; a channel never managed (or removed) is switched on by managing it.
  const toggle = () => run(() => api.manageChannel(channel.channel_id, { action: on ? 'pause' : m.state === 'paused' ? 'resume' : 'manage', expected_version: m.version }));
  const pin = (clock: ClockName, value: string) => run(() => api.overrideClock(channel.channel_id, { clock, interval_days: value === 'auto' ? null : Number(value) as 1, expected_version: m.version }));
  return <div className={`clock-policy ${on ? '' : 'off'}`}>
    <div className="clock-policy-head"><span>自动更新</span>
      <button role="switch" aria-checked={on} aria-label="自动更新" className={`switch ${on ? 'on' : ''}`} disabled={!operator || busy} onClick={() => void toggle()}><i/></button>
      <small>{on ? '已开启' : '已关闭'}</small></div>
    {error && <ErrorBox error={error}/>}
    {m.clocks.length > 0 && <table className="clock-table"><tbody>{m.clocks.map(c => {
      const s = clockState(c, m.state), pinned = c.override_days !== null;
      return <tr key={c.clock}>
        <th>{clockLabels[c.clock]}</th>
        <td title={pinned ? '人工指定的间隔' : `为什么是这个间隔：${clockReasonLabels[c.reason]}`}>每 {c.interval_days} 天</td>
        <td>下次 {day(c.next_due_at)}{on && (s.tone === 'muted' ? <small>（{dueIn(c.next_due_at)}）</small> : <em className={s.tone}>{s.tone === 'bad' ? '已过期' : '今天'}</em>)}</td>
        <td className="muted">上次 {c.last_success_at ? day(c.last_success_at) : '—'}</td>
        {operator && <td><select aria-label={`${clockLabels[c.clock]}更新间隔`} value={pinned ? String(c.override_days) : 'auto'} disabled={busy} onChange={e => void pin(c.clock, e.target.value)}>
          {choices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          {pinned && !choices.some(([value]) => value === String(c.override_days)) && <option value={String(c.override_days)}>每 {c.override_days} 天</option>}
        </select></td>}
      </tr>;
    })}</tbody></table>}
    <p className="detail-note">{on ? '到时间后系统会自动更新这个频道（自动执行功能即将上线）。'
      : m.state === 'paused' ? '已关闭：到时间也不会自动更新，数据都保留，随时可以重新打开。'
      : '未开启自动更新。打开后，系统会按上面的频率定期更新这个频道。'}</p>
  </div>;
}
