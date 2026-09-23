# M1 控制台交付记录

日期：2026-09-23。独立前端已实现，固定样本的真实 Fastify API + PostgreSQL 浏览器验证通过。具备模块集成条件；共享锁文件、正式身份服务和 Temporal/实际 Worker 全链路仍需对应负责人集成，本文不代表 M1 整体验收通过。

## 分支与版本

- 工作目录：`/home/ubuntu/workspace/crawlsystem-console`。
- 分支：`business/m1-console`。
- G0 公共代码：`ca3973f43d4ee3bc355cb0cc3ab1a373f5292a92`。
- G1 后端：`bc720cb2d3dfc47f3505ed0ed7fabac9508a4bb8`。
- 本模块实现基线：`0438484c1a22c9cb777290b4941f5c752b4fd2c6`（包含开发 PG 隧道重连）。
- 应用、测试与证据提交：`fdd8501b5eb8c3bd7e1a72c9eda813861059d272`。本报告在其后独立提交；报告提交可通过 `git log -1 --format=%H -- docs/m1/reports/console.md` 查询。
- 接口与 schema：`@crawlsystem/contracts` 的 `m1.v1`。本次仅修改 `apps/console/` 与本报告，未修改后端、数据库、公共契约或根锁文件。

## 已实现范围

| 任务 | 实现与证据 |
| --- | --- |
| UI-01 基础与 API | React 19 / TypeScript / Vite 独立静态应用；Tailwind CSS、自建组件、Radix Dialog；导入公共契约校验请求和响应；Bearer 登录验证、reader/operator 权限、Worker 登录拒绝、401 退出、403/404 清理受限结果。 |
| UI-02 频道与 Plan | 总览、频道列表/详情、Plan 列表/详情、创建页面和回执详情。状态筛选、20 条分页、必需领域、输入版本、执行代次、阶段事件、等待/失败原因、持久回执。React Flow 展示最近 Plan 链路，ECharts 仅统计该 Plan 的必需领域。 |
| UI-03 Worker 与错误 | 展示登记节点、Worker 版本/容量/接单上报、最后心跳和服务端 `stale`。错误关联 Plan、Worker 及该 Plan 的最近回执。没有代理、节点资源或错误聚合数据时明确说明。 |
| UI-04 操作交互 | 创建采用稳定 `request_id` 和同步连点保护；未确认的创建输入按工作空间/用户存入 sessionStorage，导航后可重放原操作。取消需确认，携带 `command_id` 和捕获的期望版本，冲突要求显式刷新、不自动换版本重提；后端拒绝不会显示成功。 |
| UI-05 验证与文档 | 6 项客户端测试、16 项浏览器行为测试、3 条真实 API E2E，类型检查和生产构建通过；运行说明、环境变量、Nginx 示例及实际页面截图已提交。 |

应用不包含演示数据回退，不直接连接数据库、Temporal 或代理服务。测试替身仅在 `tests/` 中。正式账号/Keycloak 尚未接入，登录页明确标识 M1 联调令牌；令牌仅在页面内存保存，退出或刷新后清除。

页面区分当前已入库数据、本轮领域结果、Agent 执行和对外交付。未知值不会填零；评论未入库、已采集为空和已关闭分别呈现。M1 样本不使用代理、Agent 尚未执行、交付未启用均按现有能力如实显示。

## 请求与操作预算

- 请求超时 10 秒；每个资源只有一个在途请求，离开页面取消请求。
- 成功后 5 秒轮询；失败退避 10/20/40/60 秒。最多 60 次请求、连续 5 次失败或累计 10 分钟后暂停，手动刷新可重启预算。
- `retryable=false` 停止自动重试；`Retry-After` 超过 60 秒则暂停；页面隐藏暂停；终态 Plan 不继续轮询。
- 网络失败可保留上次成功数据，同时显示过期提示、失败原因和查询时间。身份失效清除登录；受限/不存在对象不保留原查询内容。
- 总览各列表最多 5 条，普通列表每页 20 条。详情按契约最多 100 条事件、300 笔回执、100 条视频；没有全量计数时不推断系统总量。

## 验证命令与结果

环境：Node `22.22.1`、npm `9.2.0`、Chromium `153.0.8010.12`，Linux。根目录运行：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，公共工程类型检查 |
| `npm run typecheck --workspace @crawlsystem/console` | 通过，包含页面及测试 |
| `npm run test:contracts` | 3 / 3 通过 |
| `npm run test --workspace @crawlsystem/console` | 6 / 6 通过 |
| `npm run test:browser --workspace @crawlsystem/console` | 16 / 16 通过，最终命令退出码 0 |
| `npm run build --workspace @crawlsystem/console` | 通过，输出 `apps/console/dist/`；路由与 ECharts 分包 |
| `npm run test:live --workspace @crawlsystem/console`（凭据变量见下文） | 3 / 3 通过，约 1.8 分钟 |

浏览器行为测试使用独立端口 `18112` 和明确的 API 拦截，覆盖空结果、加载、等待、部分入库、终态、只读入口、创建连点、响应丢失后重试、取消冲突与权限拒绝、服务端失联状态、错误至回执关联、网络过期与恢复、schema 不兼容、分页筛选、401、移动导航、离页停止轮询及有限失败预算。这些测试与真实接口测试分别记录。

### 真实 API 浏览器验证

实际 Control `http://127.0.0.1:18100`、Ingest `http://127.0.0.1:18101`，前端 `http://127.0.0.1:18102`，PG 测试库 `crawlsystem_m1_main_test`。所有新增测试对象属于独立工作空间 `console-e2e-3814487a386c`，仅通过公开受控 API 写入，没有删除已有对象或直接执行 SQL。

```bash
CONSOLE_OPERATOR_TOKEN_FILE=/home/ubuntu/workspace/crawlsystem-console/.runtime/console-e2e/operator-token \
CONSOLE_READER_TOKEN_FILE=/home/ubuntu/workspace/crawlsystem-console/.runtime/console-e2e/reader-token \
CONSOLE_WORKER_TOKEN_FILE=/home/ubuntu/workspace/crawlsystem-console/.runtime/console-e2e/worker-token \
npm run test:live --workspace @crawlsystem/console
```

上述文件是当前机器的私有短期凭据，未提交到 Git，过期后须由后端重新签发。控制台不持有签名密钥。

| 场景 | 已观察结果 |
| --- | --- |
| 创建 → 部分入库 → 等待 → 错误/回执定位 → 冲突 → 取消 | 页面创建 Plan，ABOUT 后显示 1/3、VIDEO 后显示 2/3 且仍等待 AGENT。错误入口打开正确 Plan 的真实回执；打开取消确认框后由 API 改变版本，原版本提交被拒绝；显式刷新后取消成功，持久查询为 CANCELLED，迟到新提交返回 409 PLAN_TERMINAL。 |
| 样本完成、频道评论及只读权限 | ABOUT + VIDEO 入库后显示 COMPLETED；频道展示真实固定样本和评论，Agent 尚未执行。切换 reader 后写入口消失，直接创建/取消请求均返回 403。 |
| Worker 实际心跳过期 | 通过真实 API 登记并确认心跳正常；停止心跳并等待服务端 90 秒过期，查询返回 `stale=true`，页面显示心跳失联。未修改服务端时钟或直接改写数据库心跳时间。 |

最后一轮真实测试时间为 `2026-09-23T04:25:12Z` 至 `04:26:55Z`。等待心跳过期期间，PG 开发隧道出现 2 次服务端标记可重试的依赖失败；测试在 110 秒上限内恢复查询后验证失联，没有忽略非重试错误。

真实测试通过 Ingest API 提交受控固定样本并登记事件，验证的是浏览器 + Fastify + PostgreSQL。它没有启动 Temporal Workflow 或实际执行 Worker，不能替代主 Agent 与执行 Agent 的执行恢复验收。

### 可复核证据

- [结构化结果、Plan/回执/事件身份](../../../apps/console/docs/evidence/live-results.json)
- [总览页面](../../../apps/console/docs/evidence/live-overview.png)
- [Plan 等待与部分入库](../../../apps/console/docs/evidence/live-plan-waiting.png)
- [Plan 已取消](../../../apps/console/docs/evidence/live-plan-cancelled.png)
- [频道和评论](../../../apps/console/docs/evidence/live-channel.png)
- [Worker 服务端失联](../../../apps/console/docs/evidence/live-worker-stale.png)

截图均在登录后指定页面生成。真实测试关闭网络 trace、录像和自动失败截图，证据中没有令牌或认证头。

## 启动、部署与集成依赖

[应用 README](../../../apps/console/README.md) 包含完整命令与预算说明；[环境示例](../../../apps/console/.env.example) 和 [Nginx 示例](../../../apps/console/deploy/nginx.conf.example) 可用于部署接入。

根锁文件由主 Agent 管理。本次使用 `npm install --package-lock=false --ignore-scripts --no-audit --no-fund` 安装模块依赖，没有改写共享锁。主 Agent 集成后需要按 `apps/console/package.json` 更新根锁并在干净环境验证 `npm ci`。该项尚未完成，不能宣称锁文件集成已验收。

```bash
npm run dev --workspace @crawlsystem/console
npm run build --workspace @crawlsystem/console
```

前端开发端口 `18102`；构建为纯静态文件。`VITE_API_BASE_URL` 默认 `/api`；开发代理 `CONTROL_API_PROXY_TARGET` 默认 `http://127.0.0.1:18100`。生产网关按示例把 `/api/` 转发至独立 Fastify。跨域直接接入时需后端允许控制台 Origin。

本模块无数据库迁移；运行依赖主 Agent 的 `001_m1.sql` 和 G1 服务。页面只需要公开 API 地址和用户令牌，不需要 PG、Temporal、JWT 签名或代理供应商凭据。

## 已知限制与后续联调

1. 正式登录、Keycloak、账户/角色管理尚未实现。当前接入既有 G0/G1 的 reader/operator 开发身份；后端鉴权是写入权限的最终依据。
2. 实际 Worker/Temporal 的启动、恢复、取消传播与端到端执行证据由主 Agent 和执行 Agent 集成后补齐。当前 UI 已显示契约中的 Workflow 身份、执行代次和上报事件，不以身份已分配推断执行已经启动。
3. 当前错误 API 没有首次/最近时间聚合或直接回执/节点身份。页面展示单次事件时间、关联 Worker 和该 Plan 的最近回执，不虚构直接关联。Worker/错误定位依赖有界列表翻页，当前页缺少目标会明确提示。
4. 频道详情只有契约规定的有界数据，没有视频/评论的游标分页接口。系统总量、趋势统计、节点 CPU/内存和代理资源查询尚未提供。
5. 真实采集、真实 Agent 和正式发布交付不属于当前 M1 实现；页面没有相应可执行按钮。

模块代码与验证证据已具备集成条件。主线接入共享锁文件并完成实际执行链路后，按共同任务单继续 G2/M1 验收。
