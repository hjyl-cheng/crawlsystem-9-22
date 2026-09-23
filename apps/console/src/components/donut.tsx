/** Ring chart shared by the discover and full-collection pages. With no parts it
 * draws an empty ring and the given empty caption instead of a total. */
export default function Donut({ parts, caption, emptyCaption = '尚未接入', label }: { parts?: { label: string; count: number; color: string }[]; caption: string; emptyCaption?: string; label: string }) {
  const total = parts?.reduce((sum, part) => sum + part.count, 0) ?? 0, r = 42, c = 2 * Math.PI * r;
  let offset = 0;
  const value = parts ? total.toLocaleString('zh-CN') : '—';
  return <svg className="discover-donut" viewBox="0 0 110 110" role="img" aria-label={label}>
    <circle cx="55" cy="55" r={r} fill="none" stroke="#e9eff7" strokeWidth="16"/>
    {total > 0 && parts!.map(part => { const length = part.count / total * c; const el = <circle key={part.label} cx="55" cy="55" r={r} fill="none" stroke={part.color} strokeWidth="16" strokeDasharray={`${length} ${c - length}`} strokeDashoffset={-offset} transform="rotate(-90 55 55)"/>; offset += length; return el; })}
    {/* Five or more characters would overrun the ring's hole at the default size. */}
    <text x="55" y="53" textAnchor="middle" className={`donut-value ${value.length > 4 ? 'long' : ''}`}>{value}</text>
    <text x="55" y="68" textAnchor="middle" className="donut-caption">{parts ? caption : emptyCaption}</text>
  </svg>;
}
