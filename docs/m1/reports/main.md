# 主 Agent：G1 后端交付记录

日期：2026-09-23。工作区 `crawlsystem-business`，分支 `business/crawler-platform`。

G0 代码基线：`ca3973f43d4ee3bc355cb0cc3ab1a373f5292a92`，已合入执行与控制台 worktree。G1 代码与本报告同批提交，具体 SHA 以主分支本报告的提交及交付消息为准。接口版本 `m1.v1`，迁移 `001_m1.sql`。

## 完成范围

- MAIN-01：核对六节点、PG 18.6、PgBouncer 事务池及 Temporal 服务地址；准备独立测试库、专用数据库角色、CA 和私有配置。
- MAIN-02：固定 Node/npm/TypeScript、Temporal/React/Vite 依赖；发布共享 schema、样本、稳定身份和 Hash、WorkflowStarter 接口；创建迁移、CI 与运行说明。
- MAIN-03：实现 Store/Ingest 的角色与对象权限、schema/Hash、执行代次、幂等与冲突、持久 APPLIED、冻结目标覆盖与领域收口；事实/检查点/回执/测试收口义务处于同一事务。旧计划不能覆盖新的 Current。
- MAIN-04：实现全部 G0 控制台查询/操作接口、Worker 心跳/错误事件、幂等创建与版本取消、持久 START/CANCEL 租约派发、到期 Plan 收口。日志/指标包含请求关联与时长，响应体不泄漏数据库错误和凭据。
- MAIN-05：完成后端实际 HTTP 与 PostgreSQL 验证；真实 Temporal、Worker 重启、浏览器全链路仍待执行与控制台分支交付，**M1 尚未整体验收**。

目录：`packages/contracts`、`packages/store`、`packages/http`、`apps/control-api`、`apps/ingest`、`database/migrations`、`tests/integration`、`scripts/dev`，以及根依赖/CI 和本文档。

## 实际环境

| 项目 | 本次接入 |
| --- | --- |
| PG | 18.6，`db/crawler-pg-1`，应用不使用 postgres 超级用户 |
| PgBouncer | `crawler-pg-pool.db.svc.cluster.local:5432`，事务池，CA 校验及池域名校验 |
| 测试库 / 角色 | `crawlsystem_m1_main_test` / `m1_main_app`，角色连接上限 8 |
| 配置与凭据 | `.runtime/main.env`、`.runtime/pg-ca.crt`、`.runtime/jwt-secret`、令牌文件；忽略入 Git，文件 0600 |
| Control / Ingest | loopback `18100` / `18101`；实际启动并验证 |
| PG 本地转发 | `15432`；故障子进程可用独立 `15433` |
| Temporal | 现有服务已发现；预留 namespace/queue `crawlsystem-m1-main`，业务启动尚未验证 |
| Console | 预留 `18102`，前端分支开发中 |

修复过两个真实接入问题：PgBouncer 不接受连接启动参数 `statement_timeout`，现改角色默认值和事务内设置；数据库空闲连接异常必须有处理器，失效连接不能复用。测试过程中也观察到 `kubectl port-forward` 遇连接 reset 会整条退出，导致后续访问拒绝连接；重启转发后验证通过。此转发是本地联调方式，不是正式运行拓扑。

## 验证证据

| 命令 / 场景 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:contracts` | 3 / 3 通过 |
| `node --env-file=.runtime/main.env --import tsx --test --test-concurrency=1 tests/integration/*.test.ts` | 18 / 18 通过，约 11.3 秒，实际 TLS PgBouncer → PostgreSQL |
| `scripts/dev/backend-smoke.ts` | 实际 HTTP 创建计划、提交 ABOUT/VIDEO、读取 2 份回执，COMPLETED |
| `/healthz`、`/readyz` | 实际服务返回健康/数据库就绪 |
| `git diff --check` | 通过 |

集成测试涵盖：创建幂等与冲突、8 路重复提交、并发最终领域收口、Agent 缺失等待、冻结目标约束、插入回执后异常事务回滚、COMMIT 前 SIGKILL 恢复、提交后 HTTP 响应丢失与新连接恢复、版本取消/迟到提交、取消与完成竞争、Current 防旧覆盖、角色/租户/请求大小与来源校验、真实查询 schema、数据库不可用返回 503 而非 404、持久截止时间、派发确认丢失、租约回收与旧确认隔离、START 中取消及 CANCEL 确认重试。

持久派发测试使用 WorkflowStarter 测试替身，验证的是数据库意图恢复；不等于真实 Temporal 重复启动/重放已经通过。SIGKILL 测试实际中断持有未提交事务的 Node 子进程。

本次实际后端样本计划：`93365bcc-8055-42bd-bf82-a5418a4927e6`；回执 `f23366e3-3777-8b30-b2b8-f5bee95a7d7c`、`26114f82-68ae-8914-a4af-6eccd9c2cbc5`。仅固定样本/后端测试，未启动 Temporal，未发布业务事件。完整测试输出和 HTTP 样本结果附在本目录的 `main-integration.tap`、`main-backend-smoke.json`。

## 接入说明与下一步

启动、环境变量、Token 生成和连接预算见 [G0/G1 接入基线](../integration-baseline.md)。本次本地配置可用于同机联调；不要复制密钥进其他分支或报告。

执行 Agent 需要交付 `@crawlsystem/execution-client` 和 `apps/execution-worker`，按公共 `WorkflowStarter` / `WorkflowInput` 及稳定 Workflow 身份接入；超过预算时上报 `FAILED`，不要误报 COMPLETED。启动派发器将通过真实模块导入，缺实现会明确报错。

控制台 Agent 使用 Control `18100`，允许的浏览器来源 `http://127.0.0.1:18102`。开发 operator token 由本地私有文件提供，默认 1 小时有效；仅保存在页面内存。所有页面读取同一 API，已有真实样本可以查询。浏览器验收仍需要前端的具体提交。

主 Agent 后续审查并合入两个分支，准备独立 Temporal namespace/证书引用，贯通 API → Temporal → Worker → Ingest → PG → Console；再测试 Worker 重启、真实重复启动核对、浏览器取消/错误/失联状态，才能完成 MAIN-05。

未声明生产吞吐量/伸缩比例、完整分布式追踪或正式身份系统已达标。真实采集、代理、API/Agent、正式 Outbox 分发、历史迁移和生产保留策略属于后续里程碑。
