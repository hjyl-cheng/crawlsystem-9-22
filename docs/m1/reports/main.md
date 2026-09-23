# 主 Agent 交付与未完成项

日期：2026-09-23。工作区 `crawlsystem-business`，分支 `business/crawler-platform`。**后端与控制台已集成验证，M1 整体尚未完成。**原先 18 项后端测试通过不代表主 Agent 全部任务结束；本报告替代此前过于宽泛的 G1 完成表述。

本轮基于 G0 `ca3973f`、后端 `bc720cb`，已集成控制台 `ab6c094`、数据库账号版本 `7760e2f`，以及预览部署清单 `1df6d6e`。主线 `83f1eb6` 增加共享认证、迁移/索引和 Temporal 接入；`a4b177c` 完成账号并发修复与集成验证；本报告所在后续合并补充新预览清单和双副本账号连接预算。完整 SHA 可用 `git log -1 --format=%H -- docs/m1/reports/main.md` 查询，历史测试不冒充当前版本验收。

## 已完成并验证

- 工程：前端依赖纳入集中锁文件；根检查/构建/浏览器命令和 CI 已接入。契约版本仍为 `m1.v1`，固定样本包含频道、视频和评论，不生成伪 Agent 分析。
- Store/Ingest：授权、载荷/schema/Hash 校验、代次隔离、幂等/冲突、Current 版本保护；事实、检查点、APPLIED 和样本收口义务同事务。取消、失败、缺领域与并发收口有真实 PostgreSQL 证据。
- 数据库：迁移 001/002，检查已应用版本和校验值；补齐查询/截止扫描/认证索引以及逐表数据用途、增长边界和回收资格。
- 控制台后端：创建/取消、频道/Plan/回执、输入/检查点、错误和 Worker 查询；持久 START/CANCEL 意图和租约恢复；请求日志、延迟分桶与持久业务指标。
- 认证集成：数据库账号/会话与隔离账号文件模式共用认证接口，登录预算跨副本共享。审查 `7760e2f` 后修复了会话容量并发竞争、进程内限流及改密与会话撤销非原子的问题；登录创建会话时重新校验账号，阻断已验证旧密码的并发请求。
- 页面：合并控制台生产构建后，使用真实 HTTP/PG 验证登录、创建、ABOUT/VIDEO 入库后完成、缺 Agent 等待、页面取消、API 重启保留会话、退出后旧 Cookie 被拒绝。结果由固定样本测试程序提交，未经过业务 Workflow。
- Temporal 环境：mTLS SDK、隔离 namespace 和 7 天历史保留已落地；一个实际 TypeScript Workflow 调用 Activity 并完成。该接入测试不是 `fixturePlanWorkflow`。

逐项任务状态见 [主任务复核](main-audit.md)。

## 实际环境与边界

| 项目 | 本次验证 |
| --- | --- |
| PostgreSQL / PgBouncer | PG 18.6，TLS 和服务域名校验，事务池；独立 crawlsystem_m1_main_test，m1_main_app 连接上限 8 |
| 连接预算 | 实际集成 PG_POOL_MAX=2；浏览器测试每池 1；Control/Ingest/Dispatcher 事实池建议总计 ≤ 6，保留维护余量 |
| 账号库 | 现有控制台预览使用 crawler.console / console_app；主线账号测试只在独立测试库复制同结构，未测试正式库的角色授权或改动正式账号 |
| 私有配置 | .runtime/main.env、pg-ca.crt、jwt-secret、temporal/ 证书及短期 Token；0600，忽略入 Git |
| 开发监听 | Control 18100、Ingest 18101；UI 原预览 API 18104 已由控制台分支停用，改为 control/control-api-preview；主线页面测试临时 API 端口＋前端 18114，测试完成即关闭 |
| Temporal | server 1.32.0、UI 2.54.1、TS SDK 1.24.0；namespace crawlsystem-m1-main，retention 604800 秒；Secret temporal/temporal-smoke-client，本地转发 17233 |
| Temporal 资源 | frontend/history/matching/worker 每容器 request 100m CPU/256Mi，limit 600m/512Mi；现场只读核对，未更改配置 |
| 测试数据 | 每次使用独立 workspace，保留诊断/回执；没有真实采集、业务发布或旧数据迁移 |

本机经 kubectl port-forward 接入 PgBouncer。转发曾因连接 reset 和集群代理错误退出，引起测试 ECONNREFUSED/登录 503；现有监督脚本会重连。直接 ClusterIP 从当前主机访问被拒绝，因此最终仍用已恢复的 TLS 转发完成 26 项回归。该开发转发不能当作生产网络可靠性验收。

共用主机出现明显 IO 压力，初次并行浏览器回归超时；限制单 worker 后 16/16 通过。没有通过放宽业务断言来隐藏超时，也未由这组小样本宣称生产性能或线性伸缩已经达标。

## 验证证据

| 命令 / 场景 | 结果与证据 |
| --- | --- |
| 干净目录 npm ci | 通过，310 个包；集中锁文件已包含控制台依赖，后续账号合并未新增依赖 |
| npm run typecheck | 通过；最新合并的认证源码在干净安装目录再次检查 |
| npm run test:contracts | 3/3 通过 |
| npm run test:auth | 6/6 通过 |
| npm run test:console | 6/6 通过 |
| npm run build:console | 通过，Vite 生产构建；本轮后续认证合并未修改前端源码 |
| npm run test:browser | 单 worker 16/16 通过；[回归输出](main-browser-regression.log)，使用受控 API 响应 |
| PG_POOL_MAX=2 node --env-file=.runtime/main.env --import tsx --test --test-concurrency=1 tests/integration/*.test.ts | 26/26 通过，24.4 秒，真实 TLS PgBouncer → PostgreSQL；[当前 TAP](main-integration-current.tap) |
| scripts/dev/verify-integrated-console.ts | 真实 HTTP/PG 浏览器联调通过；[业务身份和结果](main-browser.json)、[取消页面](main-browser-cancelled.png) |
| scripts/dev/prepare-temporal.ts / temporal-readiness.ts | namespace 核对及真实 Workflow/Activity 通过；[接入结果](main-temporal-readiness.json) |

26 项集成测试包括原 Store/API 的幂等、冲突、越权、8 路重复提交、并发收口、缺领域、冻结目标、事务异常回滚、COMMIT 前 SIGKILL、提交成功但 HTTP 响应丢失、新连接查询回执、取消竞争/迟到结果、Current 防旧覆盖、数据库不可用、期限和意图租约恢复；本轮增加持久业务指标、共享会话/预算/容量以及数据库账号改密和停用一致性。

START/CANCEL 的恢复测试仍用 WorkflowStarter 测试替身，证明数据库意图恢复，不证明真实 Temporal 重复启动/历史重放。浏览器重启验证使用隔离账号文件适配器和真实 PG 会话；数据库账号适配器由单独的真实 PG 测试覆盖。账号生产授权/公网部署没有在本轮重复执行。

主线页面测试已完成 Plan：`a80e00c9-a1aa-476f-b7e9-581795089735`；已取消 Plan：`0479d56f-8f1e-4308-820d-91cb8330fac7`。Temporal readiness ID：`m1-readiness-97342360-8e09-4727-a466-171571f0586e`，与上述业务 Plan 不是同一条执行链。

## 尚未完成及下一步责任

1. 执行模块尚无交付：本次核对执行分支 `451e3af`，未实现 execution-client、fixturePlanWorkflow、Activity/Worker。主线派发入口在模块缺失时明确失败。
2. 主 Agent 需审查并合入执行模块，补根依赖/CI/运行配置，验证稳定 Workflow 身份、启动确认丢失、实际取消传播和有限预算。数据库意图的测试不能替代这些验证。
3. 主 Agent 联合执行模块完成 Worker 强杀重启、重复 Activity、历史重放与 Ingest 恢复，并从浏览器核对同一 Plan/Worker/Workflow/Receipt，之后才具备 MAIN-05/M1 完成条件。
4. 完整分布式追踪、生产容量/背压压测、正式身份审计与恢复演练仍未完成；真实采集/代理/API/Agent、分发和历史迁移属于后续里程碑。

运行命令、认证配置与测试预算见 [集成基线](../integration-baseline.md)，可立即交给执行 Agent 的具体事项见 [执行集成交接](../execution-integration-handoff.md)。UI 页面继续由 Claude 负责，主 Agent 保留全部后端与最终集成责任。本轮未重新部署控制台公网预览。最新清单来自控制台分支 `1df6d6e`；主线把账号池改为可配置且默认 1，清单双副本各 1、滚动 maxSurge=0，以适配 console_app 的 3 连接预算。配置校验和类型检查通过；这一后续改动不改变已通过的 Store/认证事务。新镜像尚未由主线部署，不能把代码修复视为已在公网预览生效。
