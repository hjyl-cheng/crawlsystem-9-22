import { Link, useParams } from 'react-router';
import { useAuth } from '../auth.js';
import { useResource } from '../resource.js';
import { Badge, Fields, PageHeading, Panel, ResourceView } from '../ui.js';
import { domainLabels, planPath, time } from '../presentation.js';

export default function ReceiptDetail() {
  const { id = '' } = useParams(); const { api } = useAuth();
  const resource = useResource(`receipt:${id}`, signal => api.receipt(id, signal), false);
  return <><PageHeading title="持久回执" description="回执证明这笔结果已入库，完整计划状态请查看对应 Plan。"/><Panel><ResourceView resource={resource}>{receipt => <><div className="plan-summary"><Badge tone="green">已应用 / APPLIED</Badge><Link className="button" to={planPath(receipt.plan_id)}>查看对应 Plan →</Link></div><Fields rows={[
    ['提交身份', <code>{receipt.submission_id}</code>], ['Plan 身份', <Link to={planPath(receipt.plan_id)}>{receipt.plan_id}</Link>], ['领域', domainLabels[receipt.domain]], ['逻辑批次', receipt.logical_batch_key], ['内容 Hash', <code>{receipt.payload_hash}</code>], ['入库时间', time(receipt.applied_at)], ['契约版本', receipt.schema_version],
  ]}/></>}</ResourceView></Panel></>;
}
