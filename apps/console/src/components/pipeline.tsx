import { useEffect, useRef, useState } from 'react';
import { Handle, MarkerType, Position, ReactFlow, useNodesState, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import { Link } from 'react-router';
import { ArrowRight, Bot, Box, Check, Clock3, CodeXml, Database, FileText, RefreshCw, Search, Send } from 'lucide-react';
import type { Completeness, PlanDetail } from '@crawlsystem/contracts';
import type { Resource } from '../resource.js';
import { channelPath, planPath } from '../presentation.js';
import '@xyflow/react/dist/style.css';

type IconName = 'search' | 'file' | 'box' | 'clock' | 'refresh' | 'send' | 'database';
const icons = { search: Search, file: FileText, box: Box, clock: Clock3, refresh: RefreshCw, send: Send, database: Database };
type Stage = Node<{ title: string; description: string; value: string; caption?: string; foot: string; footLabel?: string; tone: string; icon: IconName; href?: string; pending?: boolean }>;
type Lane = Node<{ title: string; description: string; tone: string; compact?: boolean; status?: string }>;
type Capability = Node<Record<string, never>>;
type CompletenessNode = Node<{ resource?: Resource<Completeness> }>;
type FlowNode = Stage | Lane | Capability | CompletenessNode;

function StageCard({ data }: NodeProps<Stage>) {
  const Icon = icons[data.icon];
  const content = <><div className="stage-heading"><span className="stage-icon"><Icon size={18}/></span><div><strong>{data.title}</strong><small>{data.description}</small></div></div><div className={`stage-value ${data.pending ? 'unavailable-value' : /^[\d,.\s/%—-]+$/.test(data.value) ? '' : 'text-value'}`}>{data.value}</div>{data.caption && <span className="stage-caption">{data.caption}</span>}<span className={`stage-foot ${data.pending ? 'pending-foot' : ''}`}>{data.foot}{data.footLabel && <> <span>{data.footLabel}</span></>}</span></>;
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

const percent = (part: number, total: number) => total ? `${(part / total * 100).toFixed(1)}%` : '—';
const shortTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
/** Counts come from one backend aggregate; nothing here is derived from list pages. */
function CompletenessCard({ data }: NodeProps<CompletenessNode>) {
  const resource = data.resource, c = resource?.data;
  const value = (n?: number) => c ? n!.toLocaleString('zh-CN') : resource?.error ? '—' : '…';
  const cells: [string, number | undefined, string][] = [['完整可用', c?.complete, 'green'], ['部分可用', c?.partial, 'blue'], ['待补全', c?.missing, 'amber']];
  const reasons: [string, number | undefined][] = [['基础资料未入库', c?.missing_by_domain.ABOUT], ['视频 / 评论未入库', c?.missing_by_domain.VIDEO], ['Agent 结果待返回', c?.missing_by_domain.AGENT]];
  const reasonTotal = c ? c.missing_by_domain.ABOUT + c.missing_by_domain.VIDEO + c.missing_by_domain.AGENT : 0;
  return <div className="completeness-card">
    <header><strong>数据完整性与新鲜度</strong><Link className="nodrag dashboard-more" to="/channels">查看频道<ArrowRight size={12}/></Link></header>
    <div className="completeness-body">
      <div className="completeness-metrics">
        <div className="total"><small>纳管频道总数</small><strong>{value(c?.total_channels)}</strong><span/></div>
        {cells.map(([label, n, tone]) => <div key={label} className={tone}><small>{label}</small><strong>{value(n)}</strong><span>{c ? percent(n!, c.total_channels) : ''}</span></div>)}
        {['待更新', '更新逾期'].map(label => <div key={label} className="pending" title="更新策略与 Clock 尚未接入"><small>{label}</small><strong>—</strong><span>未接入</span></div>)}
      </div>
      <div className="completeness-reasons"><strong>主要未完整原因</strong>
        {c && reasonTotal === 0 ? <p>暂无未完整频道</p> : reasons.map(([label, n]) => <div key={label}><i/><span>{label}</span><b>{value(n)}</b><small>{c ? percent(n!, reasonTotal) : ''}</small></div>)}
      </div>
    </div>
    <footer>{resource?.error ? <span className="text-red">统计查询失败：{resource.error.message}</span> : <span>口径：各频道最近一轮计划的必需领域是否全部入库{c?.latest_channel_update_at && ` · 最近入库 ${shortTime(c.latest_channel_update_at)}`}</span>}</footer>
  </div>;
}

const nodeTypes = { stage: StageCard, lane: LaneCard, capabilities: Capabilities, completeness: CompletenessCard };
// Designed canvas; wider panels stretch it horizontally instead of leaving side margins.
const BASE_WIDTH = 1338, BASE_HEIGHT = 330;
// Shrink to fit narrow or short panels, but never enlarge: text stays at its designed size.
const fitViewOptions = { padding: 0.008, maxZoom: 1 };
type Box = { x: number; y: number; w: number; h: number };

function buildNodes(detail: PlanDetail | undefined, completeness: Resource<Completeness> | undefined, stretch: number): FlowNode[] {
  const applied = detail?.domains.filter(domain => detail.plan.required_domains.includes(domain.domain) && domain.state === 'APPLIED').length;
  // Containers stretch fully; cards stretch a little and stay centred in their slot.
  const wide = ({ x, y, w, h }: Box) => ({ position: { x: x * stretch, y }, width: w * stretch, height: h });
  const card = ({ x, y, w, h }: Box) => { const width = w * Math.min(stretch, 1.18); return { position: { x: x * stretch + (w * stretch - width) / 2, y }, width, height: h }; };
  const stage = (id: string, box: Box, data: Stage['data']): Stage => ({ id, type: 'stage', ...card(box), data, zIndex: 2, draggable: false });
  const lane = (id: string, y: number, h: number, data: Lane['data']): Lane => ({ id, type: 'lane', ...wide({ x: 0, y, w: 584, h }), data, zIndex: 0, draggable: false });
  // Collection lanes on the left, completeness above the shared ingest → delivery path on the right (as in the mockup).
  return [
    lane('first-lane', 0, 120, { title: '首次采集链', description: '新频道的发现与全量抓取', tone: 'blue' }),
    lane('update-lane', 130, 92, { title: '持续更新链', description: '已纳管频道的增量更新', tone: 'green' }),
    lane('agent', 232, 44, { title: 'Agent 任务（并行分支）', description: '补充信息抓取、复杂场景、定期采集', tone: 'purple', compact: true, status: '尚未接入' }),
    lane('data-api', 286, 44, { title: 'Data API（条件/兜底分支）', description: '无法直接抓取时，通过数据 API 获取', tone: 'orange', compact: true, status: '尚未接入' }),
    stage('discover', { x: 132, y: 14, w: 140, h: 92 }, { title: 'Query Discover', description: '发现线索', value: '未接入', foot: '真实发现待接入', tone: 'blue', icon: 'search', pending: true }),
    stage('candidate', { x: 282, y: 14, w: 140, h: 92 }, { title: '候选频道', description: '评估与过滤', value: '未接入', foot: '候选筛选待接入', tone: 'blue', icon: 'file', pending: true }),
    stage('full', { x: 432, y: 14, w: 144, h: 92 }, { title: '全量抓取', description: 'Main + Agent', value: '固定样本', foot: '当前为样本验证', tone: 'blue', icon: 'box', href: detail ? planPath(detail.plan.plan_id) : '/plans' }),
    stage('clock', { x: 132, y: 138, w: 140, h: 76 }, { title: 'Clock 到期', description: '触发更新', value: '未接入', foot: '更新调度待接入', tone: 'green', icon: 'clock', pending: true }),
    stage('update', { x: 292, y: 138, w: 140, h: 76 }, { title: '更新采集', description: '增量抓取', value: '未接入', foot: '增量采集待接入', tone: 'green', icon: 'refresh', pending: true }),
    { id: 'completeness', type: 'completeness', ...wide({ x: 608, y: 0, w: 730, h: 138 }), data: { resource: completeness }, zIndex: 2, draggable: false },
    stage('ingest', { x: 608, y: 150, w: 170, h: 100 }, { title: 'Ingest / APPLIED', description: '清洗入库', value: detail ? String(detail.receipts.length) : '—', caption: '本轮持久回执', foot: detail ? `${applied} / ${detail.plan.required_domains.length}` : '等待计划数据', footLabel: detail ? '必需领域已入库' : undefined, tone: 'blue', icon: 'box', href: detail ? planPath(detail.plan.plan_id) : '/plans' }),
    stage('current', { x: 796, y: 150, w: 170, h: 100 }, { title: 'Channel Current', description: '频道当前视图', value: detail ? '查看数据' : '—', caption: '资料 / 视频 / 评论', foot: '以已入库事实为准', tone: 'blue', icon: 'file', href: detail ? channelPath(detail.plan.channel_id) : '/channels' }),
    stage('publish', { x: 996, y: 150, w: 158, h: 100 }, { title: '发布交付', description: '内容分发', value: '未启用', caption: '当前不触发交付', foot: '交付能力待接入', tone: 'blue', icon: 'send', pending: true }),
    stage('business', { x: 1180, y: 150, w: 158, h: 100 }, { title: 'Business DB', description: '下游业务数据库', value: '未接入', caption: '等待交付链路', foot: '暂无交付记录', tone: 'green', icon: 'database', pending: true }),
    { id: 'capabilities', type: 'capabilities', ...wide({ x: 796, y: 260, w: 542, h: 70 }), data: {}, zIndex: 2, draggable: false },
  ];
}
const edge = (source: string, target: string, color: string, pending = false, targetHandle?: string) => ({ id: `${source}-${target}`, source, target, targetHandle, type: 'smoothstep', zIndex: 1, markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color }, style: { stroke: color, strokeWidth: 1.15, ...(pending ? { strokeDasharray: '4 3' } : {}) } });
const edges = [edge('discover', 'candidate', '#377cfa', true), edge('candidate', 'full', '#377cfa', true), edge('full', 'ingest', '#377cfa'), edge('clock', 'update', '#13bc8b', true), edge('update', 'ingest', '#13bc8b', true), edge('agent', 'ingest', '#a063ff', true, 'agent'), edge('data-api', 'ingest', '#ff9a45', true, 'data-api'), edge('ingest', 'current', '#377cfa'), edge('current', 'publish', '#377cfa', true), edge('publish', 'business', '#377cfa', true)];

export default function Pipeline({ detail, completeness }: { detail?: PlanDetail; completeness?: Resource<Completeness> }) {
  const canvas = useRef<HTMLDivElement>(null);
  const [flow, setFlow] = useState<ReactFlowInstance<FlowNode> | null>(null);
  const [stretch, setStretch] = useState(1);
  // React Flow owns the node list (including measured sizes). Polling only swaps
  // node data/geometry in place, so a refresh never re-hides or re-measures nodes.
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(buildNodes(detail, completeness, stretch));
  useEffect(() => {
    const next = buildNodes(detail, completeness, stretch);
    setNodes(current => next.map(node => { const previous = current.find(n => n.id === node.id); return (previous ? { ...previous, data: node.data, position: node.position, width: node.width, height: node.height } : node) as FlowNode; }));
  }, [detail, completeness, stretch, setNodes]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      if (!width || !height) return;
      const scale = Math.min(1, height / BASE_HEIGHT);
      setStretch(Math.max(1, Math.round(width / scale / BASE_WIDTH * 100) / 100));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Fit only after the stretched node sizes are in the store (two frames after
  // the node update), otherwise the view is fitted to the previous layout.
  useEffect(() => {
    if (!flow) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => { void flow.fitView(fitViewOptions); }); });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
  }, [flow, nodes]);
  return <div className="prototype-pipeline" role="region" aria-label="采集链路图，小屏可左右滚动" tabIndex={0}><div ref={canvas} className="pipeline-canvas"><ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} nodeTypes={nodeTypes} onInit={setFlow} fitView fitViewOptions={fitViewOptions} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false} panOnDrag={false} preventScrolling={false} minZoom={0.25} maxZoom={1}/></div></div>;
}
