# 主 Agent 当前交付状态

更新：2026-09-24（Asia/Shanghai）。**执行与控制台已合入主线，固定样本的真实执行、恢复、持久取消和页面联合验收通过；常驻执行部署、跨 Temporal 追踪和生产验收仍未完成。**

最近已验收的预览部署源码：`653a09601e8188c6643cfae840ad0f60cdf8e3ea`。镜像：`docker.io/crawlsystem/control-api:main-653a09601e81-52eabbc4`，基础镜像固定 Node 22.22.1-alpine digest。本轮后端修复和执行集成尚未发布到该预览部署；以镜像内 healthz.build_version 为部署版本依据。

## 2026-09-24 主线联合验收

- 控制台合入 `f6e3c8a`（包含 `67a1774`），执行模块合入 `e07e955`，合并点 `d544be5`。其他 worktree 的未提交文件未被复制或提交。
- 根锁文件登记执行客户端/Worker，干净 `npm ci` 成功；新增执行构建、模块与 SDK 测试到 CI。远端 CI 本轮未触发，不能把本机结果当作 GitHub 运行结果。
- 修复未派发计划取消/截止/失败导致 CANCEL 无限重试：只有 START 已 SKIPPED 且 attempts=0 才省略远端取消；任何曾派发且结果不确定的 START 保留取消义务，无迁移改动。
- 真正调用 Temporal start 成功后让测试派发器退出，30 秒租约过期后新进程恢复同一 run；取消先入库，新派发器恢复 CANCEL 并使 Workflow 进入取消终态。测试使用生产 IntentDispatcher/Store/执行适配器，故障注入入口只允许独立 `main-joint-*` workspace。
- Worker 强杀重启、APPLIED 响应丢失、503、重复启动、旧代次迟到提交和实际历史重放共 **13 项真实链路检查通过**；频道视频和首屏评论由 Worker 经 Ingest 提交。
- 浏览器实际读取这次运行的数据库结果，核对同一 Plan/Workflow/Worker/APPLIED，以及缺 AGENT 的取消计划；没有用测试驱动代替 Worker 提交数据。

| 本轮验证 | 结果与证据 |
| --- | --- |
| 根锁文件、干净安装、合并后全仓类型检查 | 通过；新增依赖均使用原固定版本 |
| 公共/HTTP/认证/前端请求/执行模块 | **34/34**，[TAP](main-joint-unit.tap) |
| 真实 TLS PgBouncer → PG | **30/30**，含 2 个新增派发取消回归，[TAP](main-cancellation-integration.tap) |
| 控制台生产构建、Workflow 构建 | 通过；实际浏览器使用本次生产产物 |
| 真实 mTLS Temporal + Control/Ingest/PG | **13 项通过**，[结果](main-joint-execution.json)、[实际恢复历史](main-joint-history.json) |
| 实际页面关联核对 | 通过、pageerror=0，[结果](main-execution-browser.json)、[截图](main-execution-browser.png) |
| 资源边界 | 全部重检查串行且使用临时 1 GiB scope；真实联调采样峰值约 577 MiB，[记录](main-joint-resources.json) |

恢复 Plan：`54e66e61-9084-4f3f-85be-66eea468fbad`，workspace：`main-joint-c0381ba8-e771-4f50-9ea7-d8429dee4924`。回执与页面证据保留同一身份。本轮测试结束后已退出自己创建的 API/派发器/Worker，不能据此宣称已经常驻运行。

首次数据库测试因主机重启后本机转发未恢复而初始化失败；恢复现有 15432/15433 转发后 30 项通过。首次全仓类型检查在 V8 512 MiB 堆限制内退出；整组 1 GiB 限额不变，将 V8 堆调为 640 MiB 后通过，合并执行模块后再次通过。上述失败不计为通过，也未修改全用户限额或 swap。

## 2026-09-23 已完成发布

1. 审查控制台新增的公共契约/Store/API；频道列表补充真实国家、订阅数、已存视频数及最近计划状态。将采集统计改为单条 SQL 的一致快照，修复任务并发变化时总数/状态/领域分项可能不一致的问题，并补 schema 约束与真实 PG 测试。
2. 发布主线后端到既有 control/control-api-preview，两个副本分布在 A1/S2。每副本事实池 1、账号池 1，滚动 maxSurge=0；镜像先导入六台节点。readyz 同时核对账号表与共享登录预算依赖，healthz 返回源码提交。没有新建外围系统。
3. 验证发布前的 Cookie 在两个新副本都可恢复；登录预算跨副本共享；一个副本退出后另一个副本拒绝 Cookie；只读账号不能创建计划。实际公网浏览器登录、刷新、CSRF/来源拒绝、权限与退出测试通过。
4. 接入 OpenTelemetry HTTP server spans 和 W3C 上下文传播；队列、采样、字段有界。现有 Alloy → Loki 已收集两个节点的 span；现有 Prometheus 新增一个业务采集 job，两个副本均 up，业务指标已查询到。
5. 生成 Worker 专用 allowlist 环境和短期令牌，不带数据库凭据或签名密钥；实际 18100/18101 readyz 均为 200。该配置供执行模块交付后接入，不表示 Worker 已运行。
6. 核验账号库角色权限与连接限额。Temporal mTLS 连接正常，但现有证书可读取 crawlsystem namespace 元数据；namespace 权限隔离未成立，已记录真实结果，不擅自修改共享 Temporal 全局认证配置。

## 验证与证据

| 验证 | 结果 |
| --- | --- |
| 新干净目录 npm ci、类型检查 | 通过；新增 OTel/esbuild 依赖均固定在根锁文件 |
| 契约 / 认证 / 前端请求测试 | 3/3、6/6、6/6 |
| HTTP 追踪测试 | 2/2：父子传播、错误状态、无效上下文、并发隔离、敏感字段不进入 span |
| 真实 TLS PgBouncer → PostgreSQL 18.6 | **28/28**，约 11.7 秒；[TAP](main-integration-current.tap) |
| 控制台生产构建及页面回归 | 构建通过，**29/29**；[输出](main-browser-regression.log) |
| 合并后真实页面＋HTTP＋PG | 创建/完成、缺 Agent 等待、取消、API 重启保留登录、退出重放 401；[证据](main-browser.json) |
| 打包后的 API | 实际启动打包文件，healthz 版本、readyz、统计接口及 schema 通过 |
| 发布后的两个副本 | 版本一致、旧 Cookie 恢复、共享限流、跨副本撤销、只读写入拒绝；[证据](preview-replicas.json) |
| 实际公网浏览器 | 1/1，约 5.4 秒；[证据](public-main/public-password-results.json)、[页面](public-main/public-password-overview.png) |
| 实际监控 | 两个 Prometheus targets up，2 条副本业务指标；Loki 查得同一 trace_id 的 12 条 span，来自 A1/S2；[证据](runtime-observability.json) |
| 权限与运行配置 | [实际权限](runtime-access.json)、[镜像与导入](main-deployment.json) |

本机开发 PG 转发会在连接 reset 后短暂重连；这轮有一次测试初始化等待重连。套件只在初始化对 ECONNREFUSED/ECONNRESET 等待，最多 5 次；断言、事务故障注入和业务重试预算不自动重置。当前部署 API 通过集群 Service 接入数据库，不使用此开发转发。

本节旧页面证据使用受控程序提交 ABOUT/VIDEO，旧 Temporal readiness 仅验证基础接入；这些证据边界仍保持。2026-09-24 新增的联合验收已使用实际 fixturePlanWorkflow、Worker、持久派发器和同一业务页面，结果在上节单独记录。固定样本依然不等于真实外部采集。

## 未完成及责任

- **常驻运行与发布**：本轮是受控联合验收；执行 Worker、派发器的持久部署、短期令牌轮换和运行资源限额仍需接入。预览后端仍为上节已部署版本，尚未包含本轮修复。
- **完整链路追踪**：页面已核对实际同一 Workflow/Worker/Receipt；HTTP 日志/指标已接通，但 Temporal/Activity 的 W3C 上下文传播仍未接入，不能宣称端到端 trace 已完整。
- **Temporal namespace 授权**：已核验并确认缺口，当前证书不是限定到 M1 namespace 的身份。部署新的 namespace authorizer 必须统筹现有客户端，当前仅内部固定样本联调，不宣称生产租户隔离达标。
- **生产验收**：容量/伸缩/背压压测、正式账号审计、业务级恢复演练尚未完成。真实采集、代理、API/Agent、分发和历史迁移属后续里程碑。

启动与接口见 [集成基线](../integration-baseline.md)，监控与追踪见 [observability.md](../observability.md)，执行接入见 [交接单](../execution-integration-handoff.md)。UI 设计继续由 Claude 负责，全部后端和最终验收责任保留在主 Agent。
