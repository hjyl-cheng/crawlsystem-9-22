# CrawlerHub Console

独立 React / TypeScript / Vite 前端，调用 Fastify Control API。生产输出为静态文件，无 SSR、Server Actions、前端数据库连接或内置业务 API。

界面使用 Tailwind CSS、自建组件、Radix Dialog 和 React Flow，没有套用第三方 Dashboard 工程。保留 ECharts 依赖供后续真实统计接入；当前首页未提供无数据来源的统计图。业务实体、状态、输入和响应校验统一导入 `@crawlsystem/contracts`，接口版本 `m1.v1`。

## 开发与构建

Node `22.22.1`、npm `9.2.0`。前端依赖已纳入主线根锁文件，干净目录验证过 `npm ci`。以下命令均在仓库根目录运行：

```bash
npm ci
```

```bash
npm run dev --workspace @crawlsystem/console
npm run build --workspace @crawlsystem/console
npm run preview --workspace @crawlsystem/console
```

开发地址 `http://127.0.0.1:18102`，构建目录 `apps/console/dist`。

公网开发预览已通过 Cloudflare 免费 HTTPS 子域名接入，自动构建、只读登录与停止方式见[预览说明](docs/preview.md)。

共享锁文件由主 Agent 管理。新增依赖由主线集中更新；浏览器回归在当前共用主机使用单 worker（根命令 `npm run test:browser`）。

前端构建只需要公共契约包，不需要数据库、Temporal 或 Worker 凭据。

## API 与登录

将本目录 `.env.example` 复制为本地 `.env.local`，按环境配置：

| 变量 | 使用位置 | 默认值 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | 浏览器可见，构建时替换 | `/api` |
| `CONTROL_API_PROXY_TARGET` | Vite 开发代理 | `http://127.0.0.1:18100` |

开发代理将 `/api/v1/*` 转发到独立 Fastify `/v1/*`。生产由网关执行同样转发，参考 [Nginx 示例](deploy/nginx.conf.example)。也可配置独立 HTTPS API 地址；后端必须明确允许控制台 Origin。`VITE_*` 不得包含密钥或账号凭据。

默认使用账号和密码登录，Fastify 通过 `/v1/auth/login` 校验加盐 scrypt 密码摘要，并设置 HttpOnly / Secure / SameSite=Strict 会话 Cookie。页面刷新通过 `/v1/session` 恢复登录，最长 8 小时；退出调用 `/v1/auth/logout` 撤销服务端会话。账号密码与会话身份不写入浏览器存储、URL 或前端构建。`reader` 只读，`operator` 可创建和取消；`worker` 不可进入管理界面。

账号与会话存于 `crawler` 库的 `console` schema，重启 API 不影响登录。Keycloak、账号管理页面、密码找回与审计表尚未接入。[后端账号配置](../control-api/README.md)说明凭据配置和测试方式。仅兼容旧 API 联调时显式设置 `VITE_AUTH_MODE=token`，公网预览不使用该模式。

后端基础服务启动与 Worker 令牌签发见 [集成基线](../../docs/m1/integration-baseline.md)。静态前端不签发令牌，不需要 JWT 签名密钥。账号验证位于独立 Fastify API。

## 页面与状态

- 总览：按用户原型采用 174px 深色侧栏、46px 工具栏、四条采集分支汇入 Ingest / Channel Current 的链路，以及两排三列看板。最近计划、频道、Worker 和错误各最多查询 5 条；IP 和趋势区域明确显示尚未接入。手机上链路可横向滑动，列表纵向排列。[桌面截图](docs/evidence/overview-prototype-aligned.png) / [手机截图](docs/evidence/overview-mobile.png)。
- Plan：状态筛选、20 条分页、固定样本创建、目标与必需领域、输入版本、领域证明、事件及回执；取消带期望版本与命令身份。
- 频道：当前基础资料、视频、首屏评论、指标来源/时间/可用性和 Agent 区域。当前数据与本轮结果分开；未知不填零，未采集不当空结果。
- Worker / 节点：登记关系、版本、最后心跳、服务端失联判定、接单上报、关联 Plan。节点 CPU/内存、代理额度未接入。
- 错误：按实际事件展示，可打开 Plan 及其最近回执。当前 API 没有错误聚合、直接回执关联或独立节点详情，不推测这些关联。
- Agent 未接入、固定样本不使用代理、交付未启用，界面明确标识。样本完成不表示真实采集或模型已执行。

## 数据来源与后端依赖

Fastify 是前端统一查询与操作入口。现有 `@crawlsystem/store` 读取采集 PostgreSQL 中的 Plan、领域结果、频道、视频、回执、Worker 心跳和事件；这些是采集业务事实，不是独立的一套控制台展示数据。内部预览账号来自受保护的账号文件，会话暂存在 API 进程内，并未接入 Keycloak。

完整系统还需由后端接入 ClickHouse 历史分析和监控数据源：历史趋势、跨频道统计来自分析投影；节点 CPU / 内存等来自监控；执行详情结合 Temporal 和持久执行事件。当前 M1 API 尚无这些查询，相关页面不能靠前端推算或填入示例数字。分析延迟不改变 PostgreSQL 中的 Plan 完成与回执事实，接入后应显示统计时间与数据更新时间。浏览器始终只访问 API，不持有数据库或监控系统凭据。

## 请求与写操作约束

请求超时 10 秒。每个页面资源最多一个在途请求，成功后 5 秒刷新；连续错误退避 10/20/40/60 秒，连续 5 次失败、最多 60 次请求或累计 10 分钟后停止自动更新。服务端 `retryable=false` 停止重试；`Retry-After` 超过 60 秒则暂停。页面隐藏暂停轮询，离开页面中止请求；手动刷新重新开始有界查询。终态 Plan 停止轮询，可手动刷新。

网络失败保留上次成功结果并标注过期和最近查询时间。401 清除登录身份；403/404 不继续展示该查询之前的结果。响应不符合公共 schema 时显示兼容性错误，不回退到演示数据。

创建提交期间锁定表单，使用同步互斥避免连点。未确认的创建身份与输入按用户/工作空间存入 `sessionStorage`，方便导航或重新登录后用原身份核对；其中没有令牌。确认成功后清除，结果不明时不生成新的创建身份。浏览器禁止存储时仅在当前组件内存保留。

取消有明确确认，保存确认时的期望版本和命令身份。冲突后只提供刷新，不自动用新版本重提；状态依据后端返回及重新查询。页面按钮控制不替代后端角色和对象授权。

## 测试

```bash
npm run typecheck --workspace @crawlsystem/console
npm run test --workspace @crawlsystem/console
npx playwright install --with-deps chromium
npm run test:browser --workspace @crawlsystem/console
```

`test:browser` 使用端口 `18112`，通过 Playwright 显式拦截 API，数据源为公共契约和公共固定样本，仅证明界面行为；应用构建不包含测试数据。

真实接口测试使用已运行的 Control `18100`、Ingest `18101` 和页面 `18102`，所有测试凭据须属于同一独立 `console-e2e-*` 工作空间，角色分别为 operator / reader / worker。没有凭据时测试会明确失败，不跳过为成功。

```bash
CONSOLE_OPERATOR_TOKEN_FILE=/private/path/operator-token \
CONSOLE_READER_TOKEN_FILE=/private/path/reader-token \
CONSOLE_WORKER_TOKEN_FILE=/private/path/worker-token \
npm run test:live --workspace @crawlsystem/console
```

可用 `CONSOLE_CONTROL_URL` / `CONSOLE_INGEST_URL` 指定实际服务，前端开发代理也需指向相同 Control。真实测试通过受控固定样本提交验证 API + PostgreSQL，包含实际等待、回执、错误事件、版本冲突、取消、只读拒绝和 90 秒心跳过期。不拦截网络、不伪造服务端失联、不修改数据库，也不模拟已经启动 Temporal。真实 Worker / Temporal 全链路由主 Agent 和执行 Agent 集成后另行验收。

真实测试关闭网络 trace、录像和失败自动截图，以免记录认证头或表单。只在登录后的指定页面截图。证据写到 `docs/evidence/`，结果详见 [控制台报告](../../docs/m1/reports/console.md)。

账号登录的公网测试：提供 `CONSOLE_LOGIN_FILE`（私有 JSON，含 username/password）和 `CONSOLE_PREVIEW_URL` 后执行 `npm run test:login-live --workspace @crawlsystem/console`。它验证密码错误、登录、刷新恢复、只读写入拒绝、CSRF、退出及旧 Cookie 重放拒绝，不采集网络 trace 或表单凭据。
