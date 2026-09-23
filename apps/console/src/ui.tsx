import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertCircle, Inbox, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import type { Plan, PlanStatus } from '@crawlsystem/contracts';
import { ApiFailure } from './api.js';
import type { Resource } from './resource.js';
import { planLabels, time } from './presentation.js';

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function PlanBadge({ status }: { status: PlanStatus }) {
  const tones: Record<PlanStatus, string> = { QUEUED: 'neutral', RUNNING: 'blue', WAITING: 'amber', COMPLETED: 'green', CANCELLED: 'neutral', FAILED: 'red' };
  return <Badge tone={tones[status]}><span className="status-dot"/>{planLabels[status]}</Badge>;
}
export function SampleBadge() { return <Badge tone="purple">固定样本</Badge>; }
export function PageHeading({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <header className="page-heading"><div><h1>{title}</h1><p>{description}</p></div><div className="heading-actions">{children}</div></header>;
}
export function Panel({ title, extra, children, className = '' }: { title?: string; extra?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{title && <div className="panel-heading"><h2>{title}</h2>{extra}</div>}{children}</section>;
}
export function Empty({ title = '暂无记录', children }: { title?: string; children?: ReactNode }) {
  return <div className="empty-state"><Inbox size={28}/><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}
export function ErrorBox({ error, refresh }: { error: ApiFailure; refresh?: () => void }) {
  return <div role="alert" className="error-box"><div className="inline"><AlertCircle size={17}/><strong>{error.message}</strong></div>
    {error.detail && <p>{error.detail}</p>}
    {error.correlationId && <small>请求关联：<code>{error.correlationId}</code></small>}
    {refresh && <button className="button small" onClick={refresh}>重新查询</button>}
  </div>;
}
export function ResourceView<T>({ resource, children, showMeta = true }: { resource: Resource<T>; children: (data: T) => ReactNode; showMeta?: boolean }) {
  return <>
    {(showMeta || resource.error || resource.paused) && <div className="resource-meta"><span>{resource.updatedAt ? `最近查询 ${time(resource.updatedAt)}` : '等待查询结果'}{resource.refreshing && <LoaderCircle size={13} className="spin"/>}</span>
      <button className="icon-button" aria-label="刷新数据" title="刷新数据" onClick={resource.refresh} disabled={resource.refreshing}><RefreshCw size={15}/></button></div>}
    {resource.error && <ErrorBox error={resource.error} refresh={resource.refresh}/>}
    {resource.error && resource.data !== undefined && <div className="notice warning">数据可能已过期。以下保留最近一次成功查询的结果。</div>}
    {resource.paused && <div className="notice">自动更新已暂停，可点击刷新重新查询。</div>}
    {resource.loading && <div className="loading-state" role="status"><LoaderCircle className="spin" size={22}/>正在加载…</div>}
    {resource.data !== undefined && children(resource.data)}
  </>;
}
export function Fields({ rows }: { rows: [string, ReactNode][] }) { return <dl className="fields">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>; }
export function SafeLink({ href, children }: { href: string; children: ReactNode }) {
  try { if (!['http:', 'https:'].includes(new URL(href).protocol)) return <span>{children}</span>; } catch { return <span>{children}</span>; }
  return <a href={href} target="_blank" rel="noopener noreferrer">{children} ↗</a>;
}
export function Modal({ open, onOpenChange, title, description, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="dialog-content">
    <Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description>
    <Dialog.Close className="dialog-close icon-button" aria-label="关闭对话框"><X size={18}/></Dialog.Close>{children}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function usePagination() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('cursor') ?? '0';
  const cursor = /^\d+$/.test(raw) && Number(raw) <= 100000 ? raw : '0';
  return { cursor, params, setParams, go: (next: string) => { const copy = new URLSearchParams(params); copy.set('cursor', next); setParams(copy); } };
}
export function Pagination({ cursor, next, count, go }: { cursor: string; next: string | null; count: number; go: (next: string) => void }) {
  return <footer className="pagination"><span>本页 {count} 条 · 每页最多 20 条</span><div>
    <button className="button small" disabled={cursor === '0'} onClick={() => go(String(Math.max(0, Number(cursor) - 20)))}>上一页</button>
    <button className="button small" disabled={!next} onClick={() => next && go(next)}>下一页</button>
  </div></footer>;
}
export function PlanIdentity({ plan }: { plan: Plan }) { return <><SampleBadge/> <Link className="mono" to={`/plans/${encodeURIComponent(plan.plan_id)}`}>{plan.plan_id}</Link></>; }
