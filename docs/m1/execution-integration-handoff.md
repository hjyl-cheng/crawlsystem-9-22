# 执行模块集成交接

日期：2026-09-23。由主 Agent 维护，补充 [执行任务单](agent-execution.md)，不替代执行 Agent 自己的交付报告。

## 可立即使用的基线

G0 已发布（`ca3973f43d4ee3bc355cb0cc3ab1a373f5292a92`），后端与控制台已继续集成。接口仍为 `m1.v1`；同步主线本文件所在的具体提交后，从根目录运行 `npm ci`、`npm run typecheck`、`npm run test:contracts`。主线已有 Control/Ingest、持久 START/CANCEL 意图、固定输入、回执查询、心跳/错误接口和测试资源，执行开发无须再等待 G0。

截至本次核对，执行分支为 `451e3af`，没有 `apps/execution-worker` 或 `packages/execution-client`。旧准备报告中“G0 尚未发布”的信息已经过时。

## 需要交付的实际模块

1. `@crawlsystem/execution-client` 导出 `createWorkflowStarter(options)`，实现公共 `WorkflowStarter` 及 close；options、稳定 Workflow ID 和冻结输入规则以 [集成基线](integration-baseline.md)为准。
2. `apps/execution-worker` 提供确定性的 `fixturePlanWorkflow`、HTTP Activity、有限重试/总期限、持久等待和取消；只有 Ingest 回执能够证明结果已应用。要求 AGENT 的样本不伪造成功。
3. Worker 心跳包含真实实例/节点/构建信息，代理未接入按未配置表示；不得持有 PG 连接串或 JWT 签名密钥。
4. 模块测试、真实 Temporal 接入结果、Worker 强杀恢复和历史重放证据，写入自己的 `docs/m1/reports/execution.md`，提交具体 SHA 给主线集成。

## 现场资源与凭据边界

| 项目 | 已准备内容 |
| --- | --- |
| Control / Ingest | loopback 18100 / 18101；启动命令在集成基线，需实际检查进程和 readyz |
| namespace / task queue | crawlsystem-m1-main；namespace 已注册，历史保留 604800 秒 |
| Temporal 地址 | 本机转发 17233 → temporal-frontend.temporal.svc.cluster.local:7233 |
| mTLS | Secret temporal/temporal-smoke-client；主线私有文件 .runtime/temporal/ca.crt、tls.crt、tls.key |
| API 身份 | workspace m1-main；Worker subject 与 WORKER_ID 必须相同；开发 JWT 默认 1 小时，到期需重新签发 |
| 资源预算 | 先单 Worker、小并发；共享主机运行基础设施且 IO 压力高，浏览器单 worker；不能把测试吞吐当生产容量 |

主线 `.runtime/main.env` 包含数据库和签名密钥，不能整个提供给 Worker。Worker 仅注入 CONTROL_API_URL、INGEST_API_URL、WORKER_TOKEN_FILE、WORKER_ID、SERVER_ID、BUILD_VERSION 和 TEMPORAL_*；具体新增运行参数由执行模块说明。证书仅通过本地私有文件引用，不进入 Git。

主 Agent 已验证真实 mTLS Workflow + Activity，证据见 [main-temporal-readiness.json](reports/main-temporal-readiness.json)。这只能排除基础接入问题；不能证明客户端身份被 namespace 授权隔离，也不能证明 fixturePlanWorkflow 已完成。

## 主线待执行的联合验收

- 创建计划后派发器退出，再启动仍恢复同一业务身份；Temporal 已启动但确认丢失时核对原 Workflow，而非创建第二次执行。
- Worker 强杀后恢复原输入/检查点；重复 Activity 和提交确认丢失只产生原回执。
- 缺 AGENT 保持等待，取消由持久意图可靠传播；迟到新提交被 Store 拒绝，已成功提交的回执仍可查询。
- 浏览器显示的 Plan、Worker、领域回执与 Temporal Workflow ID 一一对应；保存实际历史和数据库证据。

上述最终集成由主 Agent负责。启动派发器依赖真实 execution-client，模块缺失时明确报错；不提供假执行器来替代验收。
