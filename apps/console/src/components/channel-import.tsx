import { useState } from 'react';
import type { ChannelImportResult } from '@crawlsystem/contracts';
import { ApiFailure } from '../api.js';
import { useAuth } from '../auth.js';
import { ErrorBox, Modal } from '../ui.js';

const outcomeText: Record<ChannelImportResult['items'][number]['outcome'], string> = {
  queued: '已加入队列', already_queued: '已在队列中', known: '已有这个频道', duplicate: '本次重复', handle_unsupported: '@handle 暂不支持，请改用频道 ID', invalid: '无法识别',
};

/**
 * Queue channels for a first collection: one channel ID or /channel/ link per line. The scheduler starts
 * them under the same limits as updates, so a long list is collected a few at a time.
 */
export default function ChannelImport({ open, onOpenChange, onImported }: { open: boolean; onOpenChange: (open: boolean) => void; onImported: () => void }) {
  const { api } = useAuth();
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<ApiFailure>(), [result, setResult] = useState<ChannelImportResult>();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  async function submit() {
    setBusy(true); setError(undefined);
    try { setResult(await api.importChannels({ request_id: crypto.randomUUID(), lines })); setText(''); onImported(); }
    catch (cause) { setError(cause instanceof ApiFailure ? cause : new ApiFailure('导入失败，请重试')); }
    finally { setBusy(false); }
  }
  const close = (next: boolean) => { if (!next) { setResult(undefined); setError(undefined); } onOpenChange(next); };
  const others = result?.items.filter(i => i.outcome !== 'queued') ?? [];
  return <Modal open={open} onOpenChange={close} title="导入频道" description="每行一个频道 ID（UC 开头）或 youtube.com/channel/ 链接，最多 500 行。频道先进入队列，系统按执行名额和接口配额逐个首次采集，完成后自动纳管。" wide>
    {result ? <div className="import-result">
      <p className="notice">已加入队列 <b>{result.queued}</b> 个{others.length ? `；${others.length} 行未加入：` : '。'}</p>
      {others.length > 0 && <div className="table-scroll"><table><thead><tr><th>内容</th><th>结果</th></tr></thead>
        <tbody>{others.map((item, index) => <tr key={`${index}-${item.line}`}><td className="mono">{item.line}</td><td>{outcomeText[item.outcome]}</td></tr>)}</tbody></table></div>}
      <div className="dialog-actions"><button className="button" onClick={() => setResult(undefined)}>继续导入</button><button className="button primary" onClick={() => close(false)}>完成</button></div>
    </div> : <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <textarea className="import-lines" aria-label="频道列表" rows={10} placeholder={'UCxxxxxxxxxxxxxxxxxxxxxx\nhttps://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx'} value={text} onChange={e => setText(e.target.value)}/>
      <small className="muted">{lines.length} 行{lines.length > 500 ? '，超过 500 行，请分批导入' : ''}</small>
      {error && <ErrorBox error={error}/>}
      <div className="dialog-actions"><button className="button primary" disabled={busy || !lines.length || lines.length > 500}>{busy ? '正在导入…' : '加入队列'}</button></div>
    </form>}
  </Modal>;
}
