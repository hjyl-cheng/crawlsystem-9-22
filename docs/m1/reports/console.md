# M1 控制台交付记录

日期：2026-09-23。独立前端已实现，固定样本的真实 Fastify API + PostgreSQL 浏览器验证通过。具备模块集成条件；共享锁文件、正式身份管理和 Temporal/实际 Worker 全链路仍需对应负责人集成，本文不代表 M1 整体验收通过。

## 分支与版本

- 工作目录：`/home/ubuntu/workspace/crawlsystem-console`。
- 分支：`business/m1-console`。
- G0 公共代码：`ca3973f43d4ee3bc355cb0cc3ab1a373f5292a92`。
- G1 后端：`bc720cb2d3dfc47f3505ed0ed7fabac9508a4bb8`。
- 本模块实现基线：`0438484c1a22c9cb777290b4941f5c752b4fd2c6`（包含开发 PG 隧道重连）。
- 应用、测试与证据提交：`fdd8501b5eb8c3bd7e1a72c9eda813861059d272`。本报告在其后独立提交；报告提交可通过 `git log -1 --format=%H -- docs/m1/reports/console.md` 查询。
- 接口与 schema：`@crawlsystem/contracts` 的 `m1.v1`。首轮仅修改 `apps/console/` 与本报告。后续用户要求账号密码登录，本分支新增了所需 Control API、公共登录契约和共享 HTTP 认证支持，详见本文末尾补充；未修改数据库迁移或根锁文件。

## 已实现范围

| 任务 | 实现与证据 |
| --- | --- |
| UI-01 基础与 API | React 19 / TypeScript / Vite 独立静态应用；Tailwind CSS、自建组件、Radix Dialog；导入公共契约校验请求和响应；账号密码与 Cookie 登录，显式兼容开发 Bearer 模式；reader/operator 权限、Worker 登录拒绝、401 退出、403/404 清理受限结果。 |
| UI-02 频道与 Plan | 总览、频道列表/详情、Plan 列表/详情、创建页面和回执详情。状态筛选、20 条分页、必需领域、输入版本、执行代次、阶段事件、等待/失败原因、持久回执。总览按原型展示 React Flow 四路链路和六块看板，最近 Plan 的必需领域与回执使用真实查询；统计未接入时显示明确占位。 |
| UI-03 Worker 与错误 | 展示登记节点、Worker 版本/容量/接单上报、最后心跳和服务端 `stale`。错误关联 Plan、Worker 及该 Plan 的最近回执。没有代理、节点资源或错误聚合数据时明确说明。 |
| UI-04 操作交互 | 创建采用稳定 `request_id` 和同步连点保护；未确认的创建输入按工作空间/用户存入 sessionStorage，导航后可重放原操作。取消需确认，携带 `command_id` 和捕获的期望版本，冲突要求显式刷新、不自动换版本重提；后端拒绝不会显示成功。 |
| UI-05 验证与文档 | 6 项客户端测试、16 项浏览器行为测试、3 条真实 API E2E，类型检查和生产构建通过；运行说明、环境变量、Nginx 示例及实际页面截图已提交。 |

应用不包含演示数据回退，不直接连接数据库、Temporal 或代理服务。测试替身仅在 `tests/` 中。默认登录已改为账号密码与 HttpOnly 会话 Cookie，刷新页面可恢复。Keycloak 和正式账号管理尚未接入；显式开发令牌模式只用于旧接口 E2E。

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
| `npm run build --workspace @crawlsystem/console` | 通过，输出 `apps/console/dist/`；按路由分包 |
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

1. 已提供内部账号密码登录，账号与会话存于 `crawler` 库 `console` schema（见下文“账号入库”）；Keycloak、账号/角色管理页面、登录与操作审计尚未实现。业务权限继续使用 reader/operator 并由后端验证。
2. 实际 Worker/Temporal 的启动、恢复、取消传播与端到端执行证据由主 Agent 和执行 Agent 集成后补齐。当前 UI 已显示契约中的 Workflow 身份、执行代次和上报事件，不以身份已分配推断执行已经启动。
3. 当前错误 API 没有首次/最近时间聚合或直接回执/节点身份。页面展示单次事件时间、关联 Worker 和该 Plan 的最近回执，不虚构直接关联。Worker/错误定位依赖有界列表翻页，当前页缺少目标会明确提示。
4. 频道详情只有契约规定的有界数据，没有视频/评论的游标分页接口。系统总量、趋势统计、节点 CPU/内存和代理资源查询尚未提供。
5. 真实采集、真实 Agent 和正式发布交付不属于当前 M1 实现；页面没有相应可执行按钮。

模块代码与验证证据已具备集成条件。主线接入共享锁文件并完成实际执行链路后，按共同任务单继续 G2/M1 验收。

## 开发预览入口（2026-09-23 补充）

按用户要求已开放免费 HTTPS 预览：<https://occupations-ferry-advanced-recommends.trycloudflare.com>。使用 Cloudflare Quick Tunnel、独立静态预览端口 `18103` 和自动构建监听，当前采用 Fastify 账号密码登录与权限。四个用户级 systemd 服务负责 API、构建、静态预览和隧道，退出终端后继续运行。

实际公网验证首页/SPA 深层地址 200、未登录 API 401、只读身份登录及查询成功、非允许来源 403，浏览器无运行错误。登录后的数据来自既有固定样本工作空间；只读账号密码存于忽略的私有运行目录，服务端仅保存密码摘要，未写入链接或构建。

免费地址随隧道重建可能变化；当前地址、更新/停止命令、域名变更处理及测试证据见[公网预览说明](../../../apps/console/docs/preview.md)。本入口用于开发预览，不代表正式生产部署或正式账户系统已完成。


## 账号密码登录补充（2026-09-23）

用户反馈手动令牌登录不便后，已部署标准账号密码表单。核对时原预览令牌在后端与公网接口均返回 200，尚未过期，因此不能把用户看到的泛化 401 提示解释为已确认的令牌过期。新表单将密码错误与会话过期分别提示，并以 Cookie 恢复刷新后的登录。

为完成这项明确追加的登录需求，改动包含 `apps/control-api/`、`packages/contracts/` 的可追加登录 schema/路由、`packages/http/` 的认证扩展，以及前端和测试。`m1.v1` 既有业务字段未改变；Worker Bearer 兼容。主 Agent 需一起集成后端、公共契约与前端，不能只合入 UI。

独立预览 Control API 在 `18104` 运行，使用本分支代码和既有隔离测试库，单连接池。原 `18100/18101` 服务未重启。服务端密码为随机盐 scrypt 摘要；8 小时不透明会话 Cookie、退出撤销、登录预算与 Cookie 写入 CSRF 校验均已实现。账号文件和会话说明见 [Control API README](../../../apps/control-api/README.md)。

新增验证：`node --import tsx --test apps/control-api/test/console-auth.test.ts` 6/6 通过；原 16 项浏览器测试、6 项客户端测试和 3 项契约测试通过。公网 `test:login-live` 1/1 通过，包含密码错误、正确登录、页面刷新恢复、只读写入 403、缺失 CSRF/外部来源 403、退出后旧 Cookie 重放 401，浏览器无运行错误。[完整公网结果](../../../apps/console/docs/evidence/public-password-results.json)。

根类型检查与前端生产构建通过。使用现有隔离 PG 环境运行 `node --env-file=.runtime/main.env --import tsx --test --test-name-pattern='HTTP authentication|all console query' /home/ubuntu/workspace/crawlsystem-console/tests/integration/main.test.ts`（工作目录为主 Agent worktree，`PG_POOL_MAX=1`），2/2 通过，验证原有 Bearer 身份/权限/来源/输入限制和全部控制台查询的持久结果契约。

## 总览原型对齐（2026-09-23）

针对用户反馈“首页与提供的 UI 图差距很大”，按原图 `UI/cd46e11a7a47704ab025b79383e90687.png` 重做首页布局：174px 深色层级导航、46px 顶栏、四条彩色采集分支汇入 Ingest / Channel Current，再到发布与 Business DB；下方采用节点 / IP / Worker、频道 / 错误 / 趋势两排三列看板。移除了首页顶部大块能力卡片与侧边领域圆环，调整了表格、间距、边框和文字密度。

链路状态标注为最近 Plan 的状态；回执数与必需领域入库数来自该 Plan 的持久查询。首次发现、增量调度、真实 Agent、Data API 和交付路径明确标记待接入；虚线不表示任务已经执行。节点列表按已登记 Worker 展示，不从样本数量推断节点或 Worker 总量；CPU / 内存 / IP 和趋势无 API 支撑，显示“—”或“尚未接入”。日期范围与尚未实施的菜单不可执行；已有导航、Plan 定位、频道与错误关联保持可用。

桌面在 1586×992（与原图一致）下完整容纳链路和六块面板，无页面横向溢出或链路卡片文字溢出。图随桌面尺寸变化重新适配；390×844 手机采用可原生触摸横向滚动的链路、纵向看板和导航抽屉。失败/轮询暂停时面板允许增高，错误信息与重试按钮不会被固定高度裁掉。

本次验证：生产构建及类型检查通过；现有浏览器回归 16/16，通过真实公网 Fastify + PostgreSQL 的密码登录验证 1/1；另检查桌面缩放、手机触摸滚动及导航、链路卡片到 Plan / 频道的跳转、首页错误关联跳转和轮询暂停后的手动恢复，无浏览器运行错误。Worker 查询 503 的布局验证使用浏览器明确注入的故障，和真实接口结果分开记录。验证期间共享 PG 开发转发曾报告 reset / Kubernetes 代理 502，API 返回 503；已有重连脚本恢复后，真实查询及最终截图检查通过，未修改集群或数据库。

证据：[桌面总览](../../../apps/console/docs/evidence/overview-prototype-aligned.png)、[手机总览](../../../apps/console/docs/evidence/overview-mobile.png)、[受控查询失败](../../../apps/console/docs/evidence/overview-query-failure.png)、[尺寸与交互核对结果](../../../apps/console/docs/evidence/overview-prototype-check.json)。旧 `live-*.png` 保留为之前真实业务 E2E 的历史证据。

后端数据依赖说明已补入应用 README：当前 Fastify 直接通过 Store 查询采集 PostgreSQL 事实；完整系统的 ClickHouse 分析、Prometheus 等资源监控和 Temporal 执行查询仍需后端逐项接入，前端始终只调用 API。当前页面可视布局对齐不等于这些能力已经实现。

## 账号入库（2026-09-23，Claude Agent）

按用户要求，后台账号和会话从运行文件与 API 进程内存迁入数据库。

- 位置：正式业务库 `crawler` 新建 `console` schema，表 `console.accounts`、`console.sessions`，SQL 为 `database/console/001_console.sql`。表归 `crawler_owner`；新增登录角色 `console_app`（连接上限 3，只有上述两表的必要权限，已验证不能建表、删账号或建 schema）。用户确认账号表放正式库；M1 采集样本仍在 `crawlsystem_m1_main_test`，未写入 `crawler`。
- 代码：`console-auth.ts` 抽出 `AccountStore` 接口（测试用内存实现），`console-db.ts` 为 PostgreSQL 实现与独立连接池，`console-accounts.ts` 为账号管理命令（`npm run console:accounts`）。`main.ts` 由 `CONSOLE_DATABASE_URL` 启用数据库账号，旧 `M1_CONSOLE_ACCOUNTS_FILE` 已移除。
- 迁移：原 `preview` 账号以原摘要导入，密码不变。预览服务 `console-preview-api` 改为读取 `.runtime/console-preview/console-db.env`；旧 `accounts.json` 不再使用。
- 验证：`tsc --noEmit` 通过；`apps/control-api/test/console-auth.test.ts` 6 / 6 通过；公网 `test:login-live` 1 / 1 通过；公网实测登录 → 重启 API → 会话仍有效（200）→ 退出 → 旧 Cookie 401。
- 待主 Agent 审查：`crawler` 库中的 `console` schema 与 `console_app` 角色属于新增正式库对象，需纳入数据库变更管理与备份核对；审计表待定。

## 首页第二版原型与完整性统计（2026-09-23，Claude Agent）

按用户提供的第二张原型（`/home/ubuntu/workspace/UI/8593fa717e6a8de413bfa4f77f77bb61.png`）调整首页，并修复用户指出的对齐与滚动问题。

- **新增接口（待主 Agent 审查）**：`GET /v1/overview/completeness`，reader/operator 可读。契约 `CompletenessSchema`（`packages/contracts`），查询 `Store.completeness`（`packages/store`）。口径：各频道 `latest_plan_id` 对应计划的必需领域是否全部 APPLIED，得到完整 / 部分 / 待补全三类，三者之和等于频道总数（契约校验）；另按缺失领域计数。一次聚合查询，测试库实测 0.1 ms。更新策略与 Clock 尚未实现，契约固定 `freshness: 'NOT_IMPLEMENTED'`，页面“待更新 / 更新逾期”显示“未接入”。
- **布局**：首页按窗口高度排版，1920×937 与 1586×992 无滚动；更矮窗口保持最小可读高度并允许滚动。上下两排卡片共用列模板，边缘对齐。完整性卡片作为链路图节点放在右上方，随链路缩放。新增“容量与增长风险”占位（监控指标未接入控制台 API）。侧栏仅展开当前页面所在分组。错误码显示中文短标签；最小字号 10px。
- **验证**：类型检查通过；浏览器行为测试 18 / 18（新增完整性展示、单屏无滚动与列对齐、手机无横向溢出）；控制 API 测试 6 / 6、契约测试 3 / 3。集群 `control-api-preview` 已更新镜像，公网接口返回 `total_channels=1, complete=1`。`live.spec.ts` 的两处导航改为先展开分组，本轮未重新运行真实 API E2E。

## 全量采集页与计划统计接口（2026-09-23，Claude Agent）

- **新增接口（待主 Agent 审查）**：`GET /v1/overview/plans`，reader/operator 可读。契约 `PlansSummarySchema`，查询 `Store.plansSummary`：按状态计数、全部计划数、近 24 小时新建 / 完成数与平均完成用时、各必需领域“已入库 / 需要该领域的计划数”、等待中计划按最近 WAITING/ERROR 事件阶段分组（最多 6 组）。测试库实测每条查询 1～2 ms。未提供“已派发”：固定样本不经启动意图即完成，该口径会出现“派发 0、完成 2”的矛盾。
- **页面**：`/plans` 按用户第三张原型改为看板布局，指标、漏斗、等待原因、状态分布、领域完成与最近错误均用真实接口；计划列表保留原有筛选、分页、只读限制与轮询预算。原型第 5 个指标并入“近 24 小时完成”卡片以符合 4 列网格；“全量样本 Top 10”无对应数据，已移除。“预览示例数据”开关仅用于查看生产规模下的版式。
- **验证**：页面测试 22 / 22（新增统计展示用例；轮询预算用例改为只统计计划列表请求），控制 API 6 / 6，契约 3 / 3；集群 API 已更新镜像，公网 1920×937 / 1586×992 单屏无截断。
