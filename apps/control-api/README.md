# Control API 账号登录

React 静态前端与 Fastify API 独立运行。新增账号入口使用公共 `LoginSchema`、`LogoutSchema` 和既有 `SessionSchema`；原有 Worker/联调 Bearer 接入保留。

| 接口 | 行为 |
| --- | --- |
| POST `/v1/auth/login` | 输入 username/password，成功返回 Session 并设置不透明会话 Cookie；错误密码和未知账号均为 401 |
| GET `/v1/session` | 从 Cookie 或原有 Bearer 验证身份，供页面刷新恢复登录 |
| POST `/v1/auth/logout` | 撤销服务端会话并清除 Cookie，旧 Cookie 重放返回 401 |

登录、退出和使用 Cookie 的写请求需发送 `X-Console-Request: 1`，Origin 必须符合 `CONSOLE_ORIGIN`。代理应先验证公开来源再映射受信后端来源。请求最大 2 KiB（账号接口），密码只进入登录 POST 正文，不进入日志、URL、响应或浏览器存储。

## 配置：账号与会话存放在数据库

账号和会话保存在正式业务库 `crawler` 的 `console` schema，建表 SQL 见 [`database/console/001_console.sql`](../../database/console/001_console.sql)。采集事实（Plan、频道、回执等）在 M1 阶段仍在隔离测试库 `crawlsystem_m1_*_test`，两者使用不同连接池和数据库角色。

| 表 | 内容 |
| --- | --- |
| `console.accounts` | 用户名、subject、工作空间、角色（reader/operator）、加盐 scrypt 摘要、停用时间 |
| `console.sessions` | Cookie 秘密的 SHA-256、所属账号、创建与过期时间；退出即删除该行 |

`CONSOLE_DATABASE_URL` 指向 `crawler` 库，使用 `console_app` 角色连接（与 `DATABASE_URL` 共用 `PG_CA_FILE` / `PG_TLS_SERVERNAME` 的 TLS 校验，连接池最多 2）。未配置时可用 `M1_CONSOLE_ACCOUNTS_FILE` 指向隔离测试的账号摘要文件，此模式的会话和限流同样写入 M1 PostgreSQL；两项都未配置时账号登录明确返回尚未接入，Bearer 接口仍可使用。

`console_app` 只有 `console` schema 的 USAGE、`accounts` 的 SELECT/INSERT/UPDATE、`sessions` 的读写删；表归 `crawler_owner` 所有，该角色不能建表、删账号或访问其他 schema。角色由管理员单独创建（连接上限 3，`statement_timeout=5s`），密码只以 SCRAM 校验值发送给数据库，运行密码存于忽略的 0600 运行文件。

账号管理使用命令行，密码只从标准输入读取：

```bash
# 环境需含 CONSOLE_DATABASE_URL、PG_CA_FILE、PG_TLS_SERVERNAME
printf '%s\n' "$PASSWORD" | npm run console:accounts -- add alice --role operator --workspace <workspace_id>
printf '%s\n' "$PASSWORD" | npm run console:accounts -- set-password alice   # 同时撤销该账号现有会话
npm run console:accounts -- disable alice                                     # 立即失效，已有会话一并删除
npm run console:accounts -- enable alice
npm run console:accounts -- list
npm run console:accounts -- import accounts.json                              # 迁入旧 JSON 账号，保留原摘要
```

每次请求都从 `accounts` 读取当前角色和停用状态，改角色或停用即时生效；登录输入不能指定角色或工作空间。密码长度 12～256 字符。修改密码、停用及撤销会话在同一短事务完成；创建会话会重新锁定并核对账号的密码摘要，防止旧密码已经验证、随后改密的并发登录继续签发会话。

默认 Cookie 使用 `__Host-crawlsystem-session`、Secure、HttpOnly、SameSite=Strict、Path=/，最长 8 小时。仅本机 HTTP 开发可设置 `CONSOLE_COOKIE_SECURE=false`，此时使用非 `__Host-` 的开发 Cookie；公网预览必须保持默认 Secure。

每个 API 的密码校验最多 2 个并发；共享预算为全局每分钟最多 60 次、单用户名每分钟最多 10 次登录尝试，超限返回 429 和 `Retry-After: 60`。预算存于事实库的 `m1.console_login_limits`（固定 authority `console.accounts.v1`），因此所有副本必须使用同一个事实库；账号和会话仍在独立 `console` 库连接。账号库故障或预算库故障均不能绕过校验。

最多 200 个活动会话，以数据库事务锁约束并发创建；登录时有界清理过期记录，达到容量时明确拒绝。过期判断使用数据库时钟。API 重启或多副本部署不会使未过期登录失效。

尚未实现：账号管理页面、登录与操作审计表、密码找回、MFA。后续正式身份服务（如 Keycloak）可替换这一认证层，业务权限检查继续由 Store 执行。

## 当前预览部署与验证

为落实用户的账号密码登录要求，本分支补充了 Control API、共享 HTTP 认证扩展和公共登录契约。预览单独运行本分支 API 在 loopback `18104`（`console-preview-api` 用户服务，PG_POOL_MAX=1），连接既有隔离样本库；没有重启原有 `18100/18101` 联调服务。主线现已合入前端、后端账号库与共享契约，并补上跨副本限流、并发会话容量及原子改密；这次主线验证没有重启该预览服务。预览的历史部署证据与主线验证证据分开记录。

```bash
node --import tsx --test apps/control-api/test/console-auth.test.ts
```

测试（内存账号存储）覆盖 Cookie/会话恢复、密码错误、撤销退出、8 小时过期、登录预算、CSRF、权限输入拒绝和 Worker Bearer 兼容。真实公网浏览器证据见 [public-password-results.json](../console/docs/evidence/public-password-results.json)。

主线另在隔离 PostgreSQL 验证账号/角色/停用即时生效、改密撤销与旧验证阻断、并发会话容量、跨 API 会话恢复和共享预算。实际页面创建/等待/取消、API 重启及退出重放的证据见 [主 Agent 报告](../../docs/m1/reports/main.md)；此页面联调由测试程序提交固定样本，尚不是 Temporal 业务执行验收。
