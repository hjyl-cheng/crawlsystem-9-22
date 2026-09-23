import { Handle, Position, ReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { Link } from 'react-router';
import type { Domain, PlanDetail } from '@crawlsystem/contracts';
import { channelPath, planPath } from '../presentation.js';
import '@xyflow/react/dist/style.css';

type StageNode = Node<{ title: string; eyebrow: string; description: string; tone: string; href?: string }>;
function Stage({ data }: NodeProps<StageNode>) {
  return <div className={`pipeline-node ${data.tone}`}><Handle type="target" position={Position.Left}/><small>{data.eyebrow}</small><strong>{data.title}</strong><span>{data.description}</span>{data.href && <Link className="nodrag" to={data.href}>查看详情 →</Link>}<Handle type="source" position={Position.Right}/></div>;
}
const nodeTypes = { stage: Stage };

export default function Pipeline({ detail }: { detail?: PlanDetail }) {
  const state = (domain: Domain) => {
    if (!detail) return '暂无计划数据';
    if (!detail.plan.required_domains.includes(domain)) return '本轮未要求';
    const result = detail.domains.find(d => d.domain === domain);
    return result?.state === 'APPLIED' ? '本轮结果已入库' : result?.state === 'PENDING' ? '本轮结果待入库' : '尚未提供领域状态';
  };
  const stage = (id: string, x: number, y: number, title: string, eyebrow: string, description: string, tone: string, href?: string): StageNode => ({ id, type: 'stage', position: { x, y }, data: { title, eyebrow, description, tone, href }, draggable: false });
  const nodes: StageNode[] = [
    stage('plan', 0, 70, '样本 Plan', '01 / PLAN', detail ? `执行代次 ${detail.plan.execution_epoch}` : '创建一轮固定样本计划', 'blue', detail ? planPath(detail.plan.plan_id) : '/plans'),
    stage('about', 220, 0, '频道基础信息', '02 / ABOUT', state('ABOUT'), 'blue'),
    stage('video', 220, 140, '视频与评论', '02 / VIDEO', state('VIDEO'), 'green'),
    stage('ingest', 450, 70, '结果入库 / 回执', '03 / INGEST', detail ? `${detail.receipts.length} 笔持久回执 · 本轮` : '等待持久回执', 'blue', detail ? planPath(detail.plan.plan_id) : undefined),
    stage('current', 680, 70, '频道当前数据', '04 / CURRENT', '查看当前可用的资料与来源', 'green', detail ? channelPath(detail.plan.channel_id) : '/channels'),
    stage('agent', 220, 280, 'Agent 分析', 'RESERVED / AGENT', 'M1 尚未接入真实执行', 'purple'),
    stage('publish', 680, 280, '发布交付', 'RESERVED / DELIVERY', '未启用', 'neutral'),
  ];
  const edges = [['plan','about'],['plan','video'],['about','ingest'],['video','ingest'],['ingest','current']].map(([source, target]) => ({ id: `${source}-${target}`, source: source!, target: target!, type: 'smoothstep', style: { stroke: '#8daedb', strokeWidth: 1.5 } }));
  return <div className="pipeline" aria-label="固定样本采集链路"><ReactFlow<StageNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.12 }} nodesDraggable={false} nodesConnectable={false} edgesFocusable={false} elementsSelectable={false} zoomOnScroll={false} panOnScroll={false} minZoom={0.4} maxZoom={1.4}/></div>;
}
