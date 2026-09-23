import { useEffect, useRef } from 'react';
import { init, use } from 'echarts/core';
import { PieChart } from 'echarts/charts';
import { SVGRenderer } from 'echarts/renderers';
import { TooltipComponent } from 'echarts/components';
import type { PlanDetail } from '@crawlsystem/contracts';
use([PieChart, SVGRenderer, TooltipComponent]);

export default function DomainChart({ detail }: { detail: PlanDetail }) {
  const element = useRef<HTMLDivElement>(null);
  const results = detail.plan.required_domains.map(domain => detail.domains.find(d => d.domain === domain)?.state);
  const applied = results.filter(s => s === 'APPLIED').length;
  const pending = results.filter(s => s === 'PENDING').length;
  const unknown = results.length - applied - pending;
  useEffect(() => {
    if (!element.current) return;
    const chart = init(element.current, undefined, { renderer: 'svg' });
    chart.setOption({ animation: false, tooltip: { trigger: 'item' }, color: ['#18af84', '#dce5f0', '#f1b84c'], series: [{ type: 'pie', radius: ['67%', '85%'], center: ['50%', '50%'], label: { show: false }, data: [{ name: '已入库', value: applied }, { name: '待入库', value: pending }, { name: '状态未提供', value: unknown }].filter(item => item.value > 0) }] });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(element.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [applied, pending, unknown]);
  return <div className="domain-chart"><div className="donut-wrap"><div ref={element} className="donut" aria-hidden="true"/><div className="donut-label"><strong>{applied}<small> / {results.length}</small></strong><span>必需领域已入库</span></div></div><div className="chart-legend"><span><i className="green-dot"/>已入库<strong>{applied}</strong></span><span><i/>待入库<strong>{pending}</strong></span>{unknown > 0 && <span>状态未提供<strong>{unknown}</strong></span>}</div><p className="fine-print">范围：此 Plan 的必需领域。计划完成状态单独以服务端记录为准。</p></div>;
}
