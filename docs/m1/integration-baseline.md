# G0：M1 公共代码基线

接口版本：`m1.v1`。迁移：`database/migrations/001_m1.sql`。本文件随代码基线提交；同步具体 SHA 见发布消息或主分支日志。

## 工程与职责

Node `22.22.1`、npm `9.2.0`、TypeScript `5.9.3`，ESM，npm workspaces，`tsx` 运行 TypeScript。根安装使用 `npm ci`；检查使用 `npm run typecheck` 与 `npm run test:contracts`。子模块不要修改根锁文件，新增依赖交由主 Agent 统一锁定。

Temporal SDK `1.24.0`、React/React DOM `19.3.0`、Vite `8.3.0`、React 插件 `6.1.1`、Playwright `1.63.0` 已统一固定。执行和控制台可在自己的 workspace package 中声明相同版本，锁文件仍由主 Agent 集中更新。

导入公共类型/运行时校验：`@crawlsystem/contracts`；样本：`@crawlsystem/contracts/fixtures`；Node 侧 Hash/稳定提交构造：`@crawlsystem/contracts/hash`。前端不要导入 Node Hash 模块。

执行 Agent 的 `@crawlsystem/execution-client` 请导出 `createWorkflowStarter(options)`，返回 `Promise<WorkflowStarter & {close(): Promise<void>}>`。options 为 `{address,namespace,taskQueue,tls?:{serverRootCACertificate:Buffer,clientCertPair:{crt:Buffer,key:Buffer},serverNameOverride:string}}`，沿 Temporal SDK 连接配置；模块拥有运行时校验。Workflow 类型固定 `fixturePlanWorkflow`，接收公共 `WorkflowInput`，返回 `FixtureWorkflowResult`。

主 Agent 负责持久 START/CANCEL 意图及派发；执行适配器负责实际 Temporal start/cancel 和重复启动核对。Workflow ID 为 `m1/<workspace_id>/<plan_id>`。必须防止已关闭 Workflow 的重复启动，保留期外也不可自行另起业务计划；已存在执行核对类型与最初的输入身份/Hash。

## HTTP 契约

所有 `/v1/*` 接口使用 `Authorization: Bearer <JWT>`；JWT 为 HS256，issuer=`crawlsystem-m1`、audience=`crawlsystem-api`，含 `sub`、`workspace_id`、`role` (`reader/operator/worker`)、`iat/exp`。后端签发开发令牌，不向浏览器提供签名密钥；前端可在开发登录入口手动输入操作令牌，仅存内存。TLS 与凭据来自运行配置，生产身份服务可替换此开发接入。

| 方法与路径 | 使用者 | 输入/输出 |
| --- | --- | --- |
| GET `/v1/session` | 全部 | `Session` |
| POST `/v1/plans` | operator | `CreatePlan` → `Plan`；`request_id` 幂等 |
| GET `/v1/plans?limit=20&cursor=0&status=…` | reader/operator | `Page<Plan>` |
| GET `/v1/plans/:id` | 全部 | `PlanDetail`（含 plan/input/domains/receipts/events） |
| GET `/v1/plans/:id/input` | worker | `PlanInput`，取消状态仍可读取供执行器停止 |
| POST `/v1/plans/:id/cancel` | operator | `{command_id,expected_version}` → `Plan`；相同命令回原结果 |
| POST `/v1/plans/:id/events` | worker | `ExecutionEvent` → `{accepted:true}`；worker_id 必须等于令牌 sub |
| POST `/v1/submissions`（Ingest 端口） | worker | `Submission` → `Receipt` |
| GET `/v1/receipts/:submission_id`（Control 端口） | 全部 | `Receipt`；不存在 404，查询失败不是 404 |
| GET `/v1/channels?limit=20&cursor=0` | reader/operator | `Page<ChannelSummary>` |
| GET `/v1/channels/:channel_id` | reader/operator | `ChannelDetail`；M1 视频有界至 100 条，Agent 尚未接入为 null |
| POST `/v1/workers/heartbeat` | worker | `Heartbeat` → `Worker`；worker_id 必须等于令牌 sub |
| GET `/v1/workers?limit=20&cursor=0` | reader/operator | `Page<Worker>`，心跳超过 90 秒 stale=true |
| GET `/v1/errors?limit=20&cursor=0` | reader/operator | `Page<StoredEvent>`，仅 ERROR 事件 |

错误统一 `ApiError`；400 INVALID_REQUEST，401 UNAUTHENTICATED，403 FORBIDDEN，404 NOT_FOUND；状态/Hash/代次冲突 409（细分 code）；请求超限 413，过载/依赖不可用 503。只对 retryable=true 的响应执行有界重试。列表 limit 1～100，cursor 为十进制偏移量，最大 100000，无全表 total。页面仅显示已知数量，不推算系统总量。

## 状态、回执与样本执行

- Plan status：QUEUED / RUNNING / WAITING / COMPLETED / CANCELLED / FAILED。领域为 ABOUT / VIDEO / AGENT，结果 PENDING / APPLIED。公共代码为唯一枚举来源。
- M1 `source_mode=fixture`，不能创建真实 Full。默认必需 ABOUT+VIDEO；显式要求 AGENT 的测试计划会保留待完成领域，M1 不提供伪 Agent 成功。真实 API/Agent 属于 M2。
- PlanInput 返回完整冻结样本、target_video_ids、input_hash、deadline_at、max_attempts=3，以及已持久回执。创建后默认总期限 30 分钟，重启不得延长。
- 调用 `fixtureSubmission(context,'ABOUT'|'VIDEO')` 产生稳定提交；观察时间来自样本而非重试时的当前时刻。`payload_hash` 覆盖除自身外的完整提交，规范化对象键排序、数组保持顺序。自定义小批次沿同一 Hash 规则。
- Fast Apply 返回 APPLIED；M1 不提供虚假的 RECEIVED。重复已提交的同一内容返回原 Receipt；Receipt 不能解释为 Plan 已完整成功。
- 若还缺 AGENT，执行器上报 WAITING 并依照总期限与取消进行持久等待，不能用不断新建 Activity 延长预算。Workflow 最终结果以 Store 查询为准。
- `ExecutionEvent.kind=ERROR` 记录可重试错误；预算耗尽或不可恢复时上报 `FAILED`，由 Store 原子封闭未结束的 Plan 写入权限。已完成/已取消的状态不可被覆盖。总期限由后台派发器兜底扫描，避免 Worker 退出后永久等待。错误列表包含 ERROR 和 FAILED。
- 固定样本不执行计费/网络采集，max_attempts 约束 Temporal Activity 及 HTTP 的有限重试；已完成 Activity 的预算由 Temporal 历史保持，HTTP 每次最多 2 次尝试，总业务期限保持。M2 的外部调用累计预算另行持久化实现。
- Submission 限 1MiB，视频批次至多 100，评论首屏至多 100，事件消息至多 1000 字。数据库/网络重试不可修改原身份与内容。

## 数据语义

数字指标采用 `{value,status,source,observed_at}`，对应旧字段的值、状态、来源和时间列；不是新增业务评分。评论和 Agent 十项字段来自既有字段参考。字段以具体 schema 为准，不允许 worker 带任意透传大 JSON。Current 使用实体身份与 `source_revision` 防止旧计划结果覆盖新计划当前态；各 Plan 仍保有自己的完成证明。

数据集：plans/domains/plan_items/receipts/commands/intents/obligations 为活动执行与重放证据；channels/videos 为 Current；workers 只更新当前心跳；events 为有界诊断。M1 无自动清理，测试计划与证据保留到人工核对和受控测试环境回收；不得删除仍活动/可重放的证据。M2 上线前补充实际增长预算与批准保留期限。FIXTURE_PLAN_SETTLED 只是内部测试收口义务，不产生正式 publication/Kafka 交付。

## 运行资源与当前状态

已于 2026-09-23 现场核对六节点 Ready、PG 18.6、PgBouncer 事务池和 Temporal 服务存在。地址与 Secret 引用采用部署资料；不重复安装外围组件。

主 Agent 联调保留端口：Control 18100、Ingest 18101、Console 18102；本地 PG 转发 15432、Temporal 转发 17233。测试库 `crawlsystem_m1_main_test`、Temporal namespace/queue `crawlsystem-m1-main`。执行与 UI 单元测试使用独立 mock/server 端口；需要独立实际库时先向主 Agent申请资源名，避免共用破坏性测试。

`.env.example` 是配置模板，不含可用密钥。G0 发布时 API 尚在实现；G1 现已提供下述运行入口，测试结果见 [主 Agent 报告](reports/main.md)。真实 Temporal 和浏览器集成通过后才标记 M1 完成。

## G1 后端运行

预先提供独立数据库、Owner/应用角色及 TLS CA：数据库名必须匹配 `crawlsystem_m1_*_test`；不接受指向正式数据库的配置。现场主 Agent 使用 `m1_main_app`，连接上限 8；角色 `statement_timeout=5s`、`idle_in_transaction_session_timeout=10s`。应用事务额外设置 `lock_timeout=2s`、`statement_timeout=5s`、`transaction_timeout=10s`，需要 PostgreSQL 17+（现场和 CI 固定 18.6）。不要把这些作为 PgBouncer 不支持的启动参数。

凭据只保存在忽略的 `.runtime/` 中，目录 0700、文件 0600。用 `.env.example` 填写实际运行文件 `.runtime/main.env`，JWT 密钥至少 32 个随机字节。服务均默认监听 loopback；远程使用已有 TLS 入口或加密隧道。浏览器允许来源由 `CONSOLE_ORIGIN` 精确配置；M1 开发令牌不等于正式身份系统。

```bash
npm ci
node --env-file=.runtime/main.env --import tsx scripts/dev/migrate.ts
node --env-file=.runtime/main.env --import tsx scripts/dev/token.ts operator m1-operator m1-main .runtime/operator-token
node --env-file=.runtime/main.env --import tsx scripts/dev/token.ts worker m1-worker-1 m1-main .runtime/worker-token

# 各自前台运行；三个进程各 2 个连接，总预算 6，保留维护余量。
PG_POOL_MAX=2 node --env-file=.runtime/main.env --import tsx apps/control-api/src/main.ts
PG_POOL_MAX=2 node --env-file=.runtime/main.env --import tsx apps/ingest/src/main.ts

# 执行 Agent 的 execution-client 提交集成后才可启动，缺模块会直接报错。
PG_POOL_MAX=2 node --env-file=.runtime/main.env --import tsx apps/control-api/src/dispatch-main.ts
```

派发器只处理 `M1_WORKSPACE_ID` 对应的意图与到期 Plan，该 workspace 必须与 Worker 的令牌一致；M1 一个 queue 配一个 workspace。START/CANCEL 意图使用 30 秒租约和 10 秒网络确认期限，失败退避最大 60 秒，租约过期可重新领取；过期持有者不能覆盖新确认。START 过期后不能继续启动；取消意图保留至确认。截止时间由派发器兜底检查；未启动派发器时，截止写入仍被 Ingest 拒绝，但 Plan 的 FAILED 状态要等派发器恢复后形成。

独立终端准备测试连接：

```bash
K3S_CONFIG_FILE=/dev/null kubectl -n db port-forward --address 127.0.0.1 service/crawler-pg-pool 15432:5432
# 仅 SIGKILL 测试建议独立转发 15433；main.env 的 M1_CRASH_DATABASE_URL 指向它。
K3S_CONFIG_FILE=/dev/null kubectl -n db port-forward --address 127.0.0.1 service/crawler-pg-pool 15433:5432

npm run typecheck
npm run test:contracts
node --env-file=.runtime/main.env --import tsx --test --test-concurrency=1 tests/integration/*.test.ts
node --env-file=.runtime/main.env --import tsx scripts/dev/backend-smoke.ts
```

持续同机联调可用 `node --import tsx scripts/dev/pg-tunnel.ts 15432` 替代第一条手动转发（不要同时占用同一个端口）。该开发脚本在 kubectl 因单连接 reset 退出后 1 秒重连，Ctrl-C 会结束子进程；不会创建或修改集群资源。15433 同理。断线期间 API 返回 retryable 503，不能把隧道重连理解为请求自动成功。

测试每次创建独立 workspace，保留测试证据；故障触发器只匹配该次 workspace，并在 finally 中删除。SIGKILL 测试只结束自己创建的子进程。`backend-smoke.ts` 直接提交固定样本，仅用于 HTTP/数据库验收，不能算作 Temporal 完整闭环。

服务提供 `/healthz`、`/readyz`、`/metrics`；日志记录请求 ID、路由模板、状态和时长，不记录 Bearer、正文和数据库连接串。每个进程最多 64 个在途请求，超出返回 retryable 503；指标使用固定路由标签，避免 Plan/频道 ID 形成高基数。分布式追踪和正式可观测性看板仍需 G2 联调补齐，未宣称达到生产 SLO。
