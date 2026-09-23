import { useEffect, useRef, useState } from 'react';

export interface Series { key: string; label: string; color: string; area?: boolean }
/** One-axis line chart with a recessive grid, sparse x labels and a hover
 * crosshair + tooltip. All series share the y scale, so they must share a unit. */
export default function LineChart({ points, series, max, format = v => v.toLocaleString('zh-CN'), empty, label }: {
  points?: { x: string; values: Record<string, number> }[]; series: Series[]; max?: number; format?: (v: number) => string; empty: string; label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<number>();
  useEffect(() => {
    const el = box.current; if (!el) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: entry!.contentRect.width, h: entry!.contentRect.height }));
    observer.observe(el); return () => observer.disconnect();
  }, []);
  const pad = { l: 44, r: 12, t: 8, b: 22 }, w = Math.max(0, size.w - pad.l - pad.r), h = Math.max(0, size.h - pad.t - pad.b);
  const top = max ?? (points ? Math.ceil(Math.max(1, ...points.flatMap(p => Object.values(p.values))) / 1000) * 1000 : 1);
  const x = (i: number) => pad.l + (points && points.length > 1 ? i / (points.length - 1) * w : w / 2), y = (v: number) => pad.t + h - v / top * h;
  const path = (key: string) => points?.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.values[key] ?? 0).toFixed(1)}`).join('') ?? '';
  // Label roughly every 7th point, never the one just before the last.
  const every = points && points.length > 10 ? 7 : 1;
  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!points || !w) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(points.length - 1, Math.round((event.clientX - rect.left - pad.l) / w * (points.length - 1)))));
  };
  const p = hover !== undefined ? points?.[hover] : undefined;
  return <div className="trend-box" ref={box}>
    {size.w > 0 && <svg width={size.w} height={size.h} onPointerMove={onMove} onPointerLeave={() => setHover(undefined)} role="img" aria-label={points ? label : empty}>
      {/* Without data the grid stays but the y labels would be meaningless, so they are omitted. */}
      {[0, top / 2, top].map(t => <g key={t}><line x1={pad.l} x2={pad.l + w} y1={y(t)} y2={y(t)} className="grid"/>{points && <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" className="axis">{format(t)}</text>}</g>)}
      {points && <>
        {points.map((pt, i) => (i % every === 0 && i < points.length - (every > 1 ? 3 : 0)) || i === points.length - 1 ? <text key={pt.x} x={x(i)} y={pad.t + h + 15} textAnchor="middle" className="axis">{pt.x}</text> : null)}
        {series.map(s => <g key={s.key}>{s.area && <path d={`${path(s.key)}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill={s.color} fillOpacity=".1"/>}<path d={path(s.key)} fill="none" stroke={s.color} strokeWidth="2"/></g>)}
        {p && <><line x1={x(hover!)} x2={x(hover!)} y1={pad.t} y2={pad.t + h} className="crosshair"/>{series.map(s => <circle key={s.key} cx={x(hover!)} cy={y(p.values[s.key] ?? 0)} r="4" fill={s.color} stroke="#fff" strokeWidth="2"/>)}</>}
      </>}
    </svg>}
    {!points && <div className="trend-empty">{empty}</div>}
    {p && <div className="trend-tip" style={{ left: Math.max(0, Math.min(x(hover!) + 10, size.w - 150)) }}><b>{p.x}</b>{series.map(s => <span key={s.key}><i style={{ background: s.color }}/>{s.label} {format(p.values[s.key] ?? 0)}</span>)}</div>}
  </div>;
}
