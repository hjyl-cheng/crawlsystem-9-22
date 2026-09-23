# 主 Agent 当前交付状态

更新：2026-09-23 21:10（Asia/Shanghai）。**已完成本轮后端发布、双副本验收、权限核验及 HTTP 观测接入；M1 完整业务链仍未验收。**

实际部署源码：`653a09601e8188c6643cfae840ad0f60cdf8e3ea`。镜像：`docker.io/crawlsystem/control-api:main-653a09601e81-52eabbc4`，基础镜像固定 Node 22.22.1-alpine digest。该提交合入控制台至 `2aea207`，保留既有页面和显式设计示例开关。当前后续提交只更新审计脚本、测试证据输出位置及交付文档；以镜像内 healthz.build_version 为部署版本依据。

## 本轮完成

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

公共样本仍是独立测试数据。页面联调用受控程序提交 ABOUT/VIDEO，经真实 Ingest/PG 入库；它没有经过 fixturePlanWorkflow。已有 Temporal readiness Workflow 只验证 SDK/mTLS/Activity 可用。数据库 START/CANCEL 恢复测试仍使用启动适配器测试替身，不能据此宣称真实执行链恢复已通过。

## 未完成及责任

- **执行模块集成（MAIN-02/04/05）**：执行分支已开始编写 execution-client 和 execution-worker，当前仍是未提交工作，没有可集成的交付 SHA 或执行验收结果。主 Agent 仍负责审查合并、共享依赖/CI、运行配置和最终集成。
- **真实执行恢复（MAIN-03/04/05）**：启动确认丢失、重复派发、实际取消传播、Worker 强杀重启、重复 Activity、有限预算、历史重放及同一业务回执联合验证尚未完成。
- **完整链路追踪和页面验收**：HTTP 基础与现有日志/指标已接通；Temporal/Worker 的上下文传播、业务因果链及页面对应的同一 Workflow/Worker/Receipt 尚需执行模块交付。
- **Temporal namespace 授权**：已核验并确认缺口，当前证书不是限定到 M1 namespace 的身份。部署新的 namespace authorizer 必须统筹现有客户端，当前仅内部固定样本联调，不宣称生产租户隔离达标。
- **生产验收**：容量/伸缩/背压压测、正式账号审计、业务级恢复演练尚未完成。真实采集、代理、API/Agent、分发和历史迁移属后续里程碑。

启动与接口见 [集成基线](../integration-baseline.md)，监控与追踪见 [observability.md](../observability.md)，执行接入见 [交接单](../execution-integration-handoff.md)。UI 设计继续由 Claude 负责，全部后端和最终验收责任保留在主 Agent。
