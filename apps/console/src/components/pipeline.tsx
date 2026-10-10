import { useEffect, useRef, useState } from 'react';
import { Handle, MarkerType, Position, ReactFlow, useNodesState, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import { Link } from 'react-router';
import { ArrowRight, Bot, Box, Check, Clock3, CodeXml, Database, FileText, RefreshCw, Search, Send } from 'lucide-react';
import type { Completeness, PlanDetail,QuerySummary,CandidateSummary,ChannelImports,UpdateSummary,AgentSummary,DataApiSummary } from '@crawlsystem/contracts';
import type {DeliverySummary} from '../../../../packages/contracts/src/delivery.ts';
import type { Resource } from '../resource.js';
import { channelPath, planPath } from '../presentation.js';
import '@xyflow/react/dist/style.css';

type IconName = 'search' | 'file' | 'box' | 'clock' | 'refresh' | 'send' | 'database';
const icons = { search: Search, file: FileText, box: Box, clock: Clock3, refresh: RefreshCw, send: Send, database: Database };
type Stage = Node<{ title: string; description: string; value: string; caption?: string; foot: string; footLabel?: string; tone: string; icon: IconName; href?: string; pending?: boolean }>;
type Lane = Node<{ title: string; description: string; tone: string; compact?: boolean; status?: string; href?:string }>;
type Capability = Node<{deliveryEnabled?:boolean}>;
type CompletenessNode = Node<{ resource?: Resource<Completeness>;updates:Resource<UpdateSummary> }>;
type FlowNode = Stage | Lane | Capability | CompletenessNode;
export interface PipelineResources {
 queries:Resource<QuerySummary>;candidates:Resource<CandidateSummary>;imports:Resource<ChannelImports>;
 updates:Resource<UpdateSummary>;agent:Resource<AgentSummary>;dataApi:Resource<DataApiSummary>;delivery:Resource<DeliverySummary>;
}
const value=(resource:Resource<unknown>,n:number|undefined)=>n===undefined?resource.error?'查询失败':'…':n.toLocaleString('zh-CN');
const foot=(resource:Resource<unknown>,text:string)=>resource.error?'查询失败，等待重试':resource.data?text:'正在查询';

function StageCard({ data }: NodeProps<Stage>) {
  const Icon = icons[data.icon];
  const content = <><div className="stage-heading"><span className="stage-icon"><Icon size={18}/></span><div><strong>{data.title}</strong><small>{data.description}</small></div></div><div className={`stage-value ${data.pending ? 'unavailable-value' : /^[\d,.\s/%—-]+$/.test(data.value) ? '' : 'text-value'}`}>{data.value}</div>{data.caption && <span className="stage-caption">{data.caption}</span>}<span className={`stage-foot ${data.pending ? 'pending-foot' : ''}`}>{data.foot}{data.footLabel && <> <span>{data.footLabel}</span></>}</span></>;
  return <div className={`prototype-stage ${data.tone}`}><Handle type="target" position={Position.Left}/>{data.href ? <Link to={data.href} className="nodrag stage-link">{content}</Link> : content}<Handle type="source" position={Position.Right}/><Handle id="agent" type="target" position={Position.Bottom} style={{ left: '18%' }}/><Handle id="data-api" type="target" position={Position.Bottom} style={{ left: '29%' }}/></div>;
}
function LaneCard({ data }: NodeProps<Lane>) {
  const Icon = data.tone === 'purple' ? Bot : CodeXml;
  return <div className={`pipeline-lane ${data.tone} ${data.compact ? 'compact' : ''}`}>{data.compact && <Icon size={28}/>}<div><strong>{data.title}</strong><p>{data.description}</p></div>{data.status && (data.href?<Link className="lane-status nodrag" to={data.href}>{data.status}</Link>:<span className="lane-status">{data.status}</span>)}<Handle type="source" position={Position.Right}/></div>;
}
function Capabilities({data}:NodeProps<Capability>) {
  return <div className="pipeline-capabilities">{[
    ['数据来源可核对', true], ['计划回执可追踪', true], ['统一数据契约', true], ['领域结果可查询', true], ['真实采集已接入', true], [data.deliveryEnabled?'发布交付已启用':'发布交付待启用', !!data.deliveryEnabled],
  ].map(([label, enabled]) => <span key={String(label)} className={enabled ? '' : 'pending'}><i>{enabled ? <Check size={11}/> : '·'}</i>{label}</span>)}</div>;
}

const percent = (part: number, total: number) => total ? `${(part / total * 100).toFixed(1)}%` : '—';
const shortTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
/** Counts come from one backend aggregate; nothing here is derived from list pages. */
function CompletenessCard({ data }: NodeProps<CompletenessNode>) {
  const resource = data.resource, c = resource?.data,u=data.updates.data;
  const value = (n?: number) => c ? n!.toLocaleString('zh-CN') : resource?.error ? '—' : '…';
  const cells: [string, number | undefined, string][] = [['完整可用', c?.complete, 'green'], ['部分可用', c?.partial, 'blue'], ['待补全', c?.missing, 'amber']];
  const reasons: [string, number | undefined][] = [['基础资料未入库', c?.missing_by_domain.ABOUT], ['视频 / 评论未入库', c?.missing_by_domain.VIDEO], ['Agent 结果待返回', c?.missing_by_domain.AGENT]];
  const reasonTotal = c ? c.missing_by_domain.ABOUT + c.missing_by_domain.VIDEO + c.missing_by_domain.AGENT : 0;
  return <div className="completeness-card">
    <header><strong>数据完整性与新鲜度</strong><Link className="nodrag dashboard-more" to="/channels">查看频道<ArrowRight size={12}/></Link></header>
    <div className="completeness-body">
      <div className="completeness-metrics">
        <div className="total"><small>采集频道总数</small><strong>{value(c?.total_channels)}</strong><span/></div>
        {cells.map(([label, n, tone]) => <div key={label} className={tone}><small>{label}</small><strong>{value(n)}</strong><span>{c ? percent(n!, c.total_channels) : ''}</span></div>)}
        {[['到期待更新',u?.due],['跨日逾期',u?.overdue]].map(([label,n])=><div key={label} className="freshness" title="已纳管频道；跨日按 UTC 日界线计算"><small>{label}</small><strong>{n===undefined?data.updates.error?'—':'…':Number(n).toLocaleString('zh-CN')}</strong><span>{u?`${percent(Number(n),u.managed)} 纳管`:'正在查询'}</span></div>)}
      </div>
      <div className="completeness-reasons"><strong>主要未完整原因</strong>
        {c && reasonTotal === 0 ? <p>暂无未完整频道</p> : reasons.map(([label, n]) => <div key={label}><i/><span>{label}</span><b>{value(n)}</b><small>{c ? percent(n!, reasonTotal) : ''}</small></div>)}
      </div>
    </div>
    <footer>{resource?.error||data.updates.error ? <span className="text-red">统计查询失败，可点击刷新重试</span> : <span>完整度：最近计划必需领域；待更新：纳管时钟{c?.latest_channel_update_at && ` · 最近入库 ${shortTime(c.latest_channel_update_at)}`}</span>}</footer>
  </div>;
}

const nodeTypes = { stage: StageCard, lane: LaneCard, capabilities: Capabilities, completeness: CompletenessCard };
// Designed canvas; wider panels stretch it horizontally instead of leaving side margins.
const BASE_WIDTH = 1338, BASE_HEIGHT = 330;
// Shrink to fit narrow or short panels, but never enlarge: text stays at its designed size.
const fitViewOptions = { padding: 0.008, maxZoom: 1 };
type Box = { x: number; y: number; w: number; h: number };

function buildNodes(detail: PlanDetail | undefined, completeness: Resource<Completeness> | undefined, stretch: number, resources:PipelineResources): FlowNode[] {
  const {delivery,queries,candidates,imports,updates,agent,dataApi}=resources,q=queries.data,c=candidates.data,i=imports.data,u=updates.data,a=agent.data,d=dataApi.data;
  const s=delivery.data,deliveryValue=s?s.enabled?String(s.pending):'未启用':delivery.error?'查询失败':'…';
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
    lane('agent', 232, 44, { title: 'Agent 画像', description: '资料与视频入库后生成', tone: 'purple', compact: true, status:foot(agent,`排队 ${a?.waiting} · 运行 ${a?.running}`),href:'/agent' }),
    lane('data-api', 286, 44, { title: 'Data API 兜底', description: '网页按规则取不到字段时使用', tone: 'orange', compact: true, status:foot(dataApi,`已用 ${d?.used_units} / ${d?.limit}`),href:'/data-api' }),
    stage('discover', { x: 132, y: 14, w: 140, h: 92 }, { title: '搜索发现', description: '今日发现的新频道', value:value(queries,q?.runs.new_channels_today), foot:foot(queries,`${q?.runs.enabled?'自动开启':'自动暂停'} · 运行 ${q?.runs.running}`), tone: 'blue', icon: 'search',href:'/discover/queries' }),
    stage('candidate', { x: 282, y: 14, w: 140, h: 92 }, { title: '候选频道', description: '等待首次资格验证', value:value(candidates,c?.by_state.DISCOVERED), foot:foot(candidates,`合格待准入 ${c?.by_state.QUALIFIED}`), tone: 'blue', icon: 'file',href:'/discover/candidates' }),
    stage('full', { x: 432, y: 14, w: 144, h: 92 }, { title: '首次采集', description: '导入等待 / 已规划', value:value(imports,i?i.counts.queued+i.counts.planned:undefined), foot:foot(imports,`完成 ${i?.counts.done} · 失败 ${i?.counts.failed}`), tone: 'blue', icon: 'box',href:'/plans' }),
    stage('clock', { x: 132, y: 138, w: 140, h: 76 }, { title: '时钟到期', description: '到期的纳管频道', value:value(updates,u?.due), foot:foot(updates,`跨日逾期 ${u?.overdue}`), tone: 'green', icon: 'clock',href:'/update?state=due' }),
    stage('update', { x: 292, y: 138, w: 140, h: 76 }, { title: '更新采集', description: '正在运行的更新', value:value(updates,u?.running), foot:foot(updates,`排队 ${u?.queued} · ${u?.limits.enabled?'自动开启':'自动暂停'}`), tone: 'green', icon: 'refresh',href:'/update' }),
    { id: 'completeness', type: 'completeness', ...wide({ x: 608, y: 0, w: 730, h: 138 }), data: { resource: completeness,updates }, zIndex: 2, draggable: false },
    stage('ingest', { x: 608, y: 150, w: 170, h: 100 }, { title: 'Ingest / APPLIED', description: '清洗入库', value: detail ? String(detail.receipts.length) : '—', caption: '本轮持久回执', foot: detail ? `${applied} / ${detail.plan.required_domains.length}` : '等待计划数据', footLabel: detail ? '必需领域已入库' : undefined, tone: 'blue', icon: 'box', href: detail ? planPath(detail.plan.plan_id) : '/plans' }),
    stage('current', { x: 796, y: 150, w: 170, h: 100 }, { title: 'Channel Current', description: '频道当前视图', value: detail ? '查看数据' : '—', caption: '资料 / 视频 / 评论', foot: '以已入库事实为准', tone: 'blue', icon: 'file', href: detail ? channelPath(detail.plan.channel_id) : '/channels' }),
    stage('publish', { x: 996, y: 150, w: 158, h: 100 }, { title: '发布交付', description: '定稿数据分发', value: deliveryValue, caption: '待业务确认版本', foot: s?`失败 ${s.failed} · 未就绪 ${s.not_ready}`:'正在查询交付', tone: 'blue', icon: 'send', pending: !s?.enabled,href:'/delivery' }),
    stage('business', { x: 1180, y: 150, w: 158, h: 100 }, { title: 'Business DB', description: '下游业务数据库', value: s?String(s.delivered):delivery.error?'查询失败':'…', caption: '业务入库已确认版本', foot: s?`今日已交付 ${s.delivered_today}`:'正在查询回执', tone: 'green', icon: 'database', pending: !s?.enabled,href:'/delivery?status=DELIVERED' }),
    { id: 'capabilities', type: 'capabilities', ...wide({ x: 796, y: 260, w: 542, h: 70 }), data: {deliveryEnabled:s?.enabled}, zIndex: 2, draggable: false },
  ];
}
const edge = (source: string, target: string, color: string, pending = false, targetHandle?: string) => ({ id: `${source}-${target}`, source, target, targetHandle, type: 'smoothstep', zIndex: 1, markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color }, style: { stroke: color, strokeWidth: 1.15, ...(pending ? { strokeDasharray: '4 3' } : {}) } });
const edges = [edge('discover', 'candidate', '#377cfa'), edge('candidate', 'full', '#377cfa'), edge('full', 'ingest', '#377cfa'), edge('clock', 'update', '#13bc8b'), edge('update', 'ingest', '#13bc8b'), edge('agent', 'ingest', '#a063ff', false, 'agent'), edge('data-api', 'ingest', '#ff9a45', false, 'data-api'), edge('ingest', 'current', '#377cfa'), edge('current', 'publish', '#377cfa'), edge('publish', 'business', '#377cfa')];

export default function Pipeline({ detail, completeness,resources }: { detail?: PlanDetail; completeness?: Resource<Completeness>;resources:PipelineResources }) {
  const canvas = useRef<HTMLDivElement>(null);
  const [flow, setFlow] = useState<ReactFlowInstance<FlowNode> | null>(null);
  const [stretch, setStretch] = useState(1);
  // React Flow owns the node list (including measured sizes). Polling only swaps
  // node data/geometry in place, so a refresh never re-hides or re-measures nodes.
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(buildNodes(detail, completeness, stretch,resources));
  useEffect(() => {
    const next = buildNodes(detail, completeness, stretch,resources);
    setNodes(current => next.map(node => { const previous = current.find(n => n.id === node.id); return (previous ? { ...previous, data: node.data, position: node.position, width: node.width, height: node.height } : node) as FlowNode; }));
  }, [detail, completeness, stretch, setNodes,...Object.values(resources).flatMap(r=>[r.data,r.error])]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      if (!width || !height) return;
      const scale = Math.min(1, height / BASE_HEIGHT);
      // React Flow remeasures nodes after geometry changes. Commit outside the
      // observer's delivery cycle so a viewport resize cannot recurse into it.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setStretch(Math.max(1, Math.round(width / scale / BASE_WIDTH * 100) / 100)));
    });
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
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
