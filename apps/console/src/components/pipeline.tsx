import { useEffect, useRef, useState } from 'react';
import { Handle, MarkerType, Position, ReactFlow, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import { Link } from 'react-router';
import { Bot, Box, Check, Clock3, CodeXml, Database, FileText, RefreshCw, Search, Send } from 'lucide-react';
import type { PlanDetail } from '@crawlsystem/contracts';
import { channelPath, planPath } from '../presentation.js';
import '@xyflow/react/dist/style.css';

type IconName = 'search' | 'file' | 'box' | 'clock' | 'refresh' | 'send' | 'database';
const icons = { search: Search, file: FileText, box: Box, clock: Clock3, refresh: RefreshCw, send: Send, database: Database };
type Stage = Node<{ title: string; description: string; value: string; caption?: string; foot: string; footLabel?: string; tone: string; icon: IconName; href?: string; pending?: boolean }>;
type Lane = Node<{ title: string; description: string; tone: string; compact?: boolean; status?: string }>;
type Capability = Node<Record<string, never>>;
function StageCard({ data }: NodeProps<Stage>) {
  const Icon = icons[data.icon];
  const content = <><div className="stage-heading"><span className="stage-icon"><Icon size={25}/></span><div><strong>{data.title}</strong><small>{data.description}</small></div></div><div className={`stage-value ${data.pending ? 'unavailable-value' : ''}`}>{data.value}</div>{data.caption && <span className="stage-caption">{data.caption}</span>}<span className={`stage-foot ${data.pending ? 'pending-foot' : ''}`}>{data.foot}{data.footLabel && <> <span>{data.footLabel}</span></>}</span></>;
  return <div className={`prototype-stage ${data.tone}`}><Handle type="target" position={Position.Left}/>{data.href ? <Link to={data.href} className="nodrag stage-link">{content}</Link> : content}<Handle type="source" position={Position.Right}/><Handle id="agent" type="target" position={Position.Bottom} style={{ left: '18%' }}/><Handle id="data-api" type="target" position={Position.Bottom} style={{ left: '29%' }}/></div>;
}
function LaneCard({ data }: NodeProps<Lane>) {
  const Icon = data.tone === 'purple' ? Bot : CodeXml;
  return <div className={`pipeline-lane ${data.tone} ${data.compact ? 'compact' : ''}`}>{data.compact && <Icon size={28}/>}<div><strong>{data.title}</strong><p>{data.description}</p></div>{data.status && <span className="lane-status">{data.status}</span>}<Handle type="source" position={Position.Right}/></div>;
}
function Capabilities() {
  return <div className="pipeline-capabilities">{[
    ['数据来源可核对', true], ['计划回执可追踪', true], ['统一数据契约', true], ['领域结果可查询', true], ['真实采集待接入', false], ['发布交付未启用', false],
  ].map(([label, enabled]) => <span key={String(label)} className={enabled ? '' : 'pending'}><i>{enabled ? <Check size={11}/> : '·'}</i>{label}</span>)}</div>;
}
const nodeTypes = { stage: StageCard, lane: LaneCard, capabilities: Capabilities };
export default function Pipeline({ detail }: { detail?: PlanDetail }) {
  const canvas = useRef<HTMLDivElement>(null);
  const [flow, setFlow] = useState<ReactFlowInstance<Stage | Lane | Capability> | null>(null);
  useEffect(() => {
    if (!flow || !canvas.current) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { void flow.fitView({ padding: 0.008 }); });
    });
    observer.observe(canvas.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [flow]);
  const applied = detail?.domains.filter(domain => detail.plan.required_domains.includes(domain.domain) && domain.state === 'APPLIED').length;
  const stage = (id: string, x: number, y: number, width: number, data: Stage['data']): Stage => ({ id, type: 'stage', position: { x, y }, data, style: { width, height: data.caption ? 124 : id === 'clock' || id === 'update' ? 86 : 99 }, zIndex: 2, draggable: false });
  const lane = (id: string, y: number, height: number, data: Lane['data']): Lane => ({ id, type: 'lane', position: { x: 0, y }, data, style: { width: 574, height }, zIndex: 0, draggable: false });
  const nodes: (Stage | Lane | Capability)[] = [
    lane('first-lane', 0, 126, { title: '首次采集链', description: '新频道的发现与全量抓取', tone: 'blue' }),
    lane('update-lane', 138, 101, { title: '持续更新链', description: '已纳管频道的增量更新', tone: 'green' }),
    lane('agent', 250, 47, { title: 'Agent 任务（并行分支）', description: '补充信息抓取、复杂场景、定期采集', tone: 'purple', compact: true, status: '尚未接入' }),
    lane('data-api', 307, 47, { title: 'Data API（条件/兜底分支）', description: '无法直接抓取时，通过数据 API 获取', tone: 'orange', compact: true, status: '尚未接入' }),
    stage('discover', 152, 23, 124, { title: 'Query Discover', description: '发现线索', value: '未接入', foot: '真实发现待接入', tone: 'blue', icon: 'search', pending: true }),
    stage('candidate', 285, 23, 124, { title: '候选频道', description: '评估与过滤', value: '未接入', foot: '候选筛选待接入', tone: 'blue', icon: 'file', pending: true }),
    stage('full', 418, 23, 143, { title: '全量抓取', description: 'Main + Agent', value: '固定样本', foot: '当前为样本验证', tone: 'blue', icon: 'box', href: detail ? planPath(detail.plan.plan_id) : '/plans' }),
    stage('clock', 152, 150, 139, { title: 'Clock 到期', description: '触发更新', value: '未接入', foot: '更新调度待接入', tone: 'green', icon: 'clock', pending: true }),
    stage('update', 317, 150, 139, { title: '更新采集', description: '增量抓取', value: '未接入', foot: '增量采集待接入', tone: 'green', icon: 'refresh', pending: true }),
    stage('ingest', 607, 69, 169, { title: 'Ingest / APPLIED', description: '清洗入库', value: detail ? String(detail.receipts.length) : '—', caption: '本轮持久回执', foot: detail ? `${applied} / ${detail.plan.required_domains.length}` : '等待计划数据', footLabel: detail ? '必需领域已入库' : undefined, tone: 'blue', icon: 'box', href: detail ? planPath(detail.plan.plan_id) : '/plans' }),
    stage('current', 798, 69, 169, { title: 'Channel Current', description: '频道当前视图', value: detail ? '查看数据' : '—', caption: '资料 / 视频 / 评论', foot: '以已入库事实为准', tone: 'blue', icon: 'file', href: detail ? channelPath(detail.plan.channel_id) : '/channels' }),
    stage('publish', 1015, 101, 145, { title: '发布交付', description: '内容分发', value: '未启用', caption: '当前不触发交付', foot: '交付能力待接入', tone: 'blue', icon: 'send', pending: true }),
    stage('business', 1188, 101, 150, { title: 'Business DB', description: '下游业务数据库', value: '未接入', caption: '等待交付链路', foot: '暂无交付记录', tone: 'green', icon: 'database', pending: true }),
    { id: 'capabilities', type: 'capabilities', position: { x: 995, y: 252 }, style: { width: 343, height: 103 }, data: {}, zIndex: 2, draggable: false },
  ];
  const edge = (source: string, target: string, color: string, pending = false, targetHandle?: string) => ({ id: `${source}-${target}`, source, target, targetHandle, type: 'smoothstep', zIndex: 1, markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color }, style: { stroke: color, strokeWidth: 1.15, ...(pending ? { strokeDasharray: '4 3' } : {}) } });
  const edges = [edge('discover', 'candidate', '#377cfa', true), edge('candidate', 'full', '#377cfa', true), edge('full', 'ingest', '#377cfa'), edge('clock', 'update', '#13bc8b', true), edge('update', 'ingest', '#13bc8b', true), edge('agent', 'ingest', '#a063ff', true, 'agent'), edge('data-api', 'ingest', '#ff9a45', true, 'data-api'), edge('ingest', 'current', '#377cfa'), edge('current', 'publish', '#377cfa', true), edge('publish', 'business', '#377cfa', true)];
  return <div className="prototype-pipeline" role="region" aria-label="采集链路图，小屏可左右滚动" tabIndex={0}><div ref={canvas} className="pipeline-canvas"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={setFlow} fitView fitViewOptions={{ padding: 0.008 }} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} panOnDrag={false} preventScrolling={false} minZoom={0.25} maxZoom={1.3}/></div></div>;
}
