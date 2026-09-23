# Control API 账号登录

React 静态前端与 Fastify API 独立运行。新增账号入口使用公共 `LoginSchema`、`LogoutSchema` 和既有 `SessionSchema`；原有 Worker/联调 Bearer 接入保留。

| 接口 | 行为 |
| --- | --- |
| POST `/v1/auth/login` | 输入 username/password，成功返回 Session 并设置不透明会话 Cookie；错误密码和未知账号均为 401 |
| GET `/v1/session` | 从 Cookie 或原有 Bearer 验证身份，供页面刷新恢复登录 |
| POST `/v1/auth/logout` | 撤销服务端会话并清除 Cookie，旧 Cookie 重放返回 401 |

登录、退出和使用 Cookie 的写请求需发送 `X-Console-Request: 1`，Origin 必须符合 `CONSOLE_ORIGIN`。代理应先验证公开来源再映射受信后端来源。请求最大 2 KiB（账号接口），密码只进入登录 POST 正文，不进入日志、URL、响应或浏览器存储。

## 配置

`M1_CONSOLE_ACCOUNTS_FILE` 指向权限为 0600 的账号 JSON 文件（不提交 Git）；未配置时账号登录明确返回尚未接入，Bearer 接口仍可使用。每条账号包含：

```json
{
  "username": "preview",
  "subject": "console-preview-reader",
  "workspace_id": "已有工作空间身份",
  "role": "reader",
  "salt": "16 字节随机盐的 32 位十六进制",
  "password_hash": "scrypt 输出 64 字节的 128 位十六进制"
}
```

文件顶层为数组，最多 100 个账号。用户名唯一；角色仅支持 reader/operator，权限与工作空间都由服务端账号记录决定，登录输入不能指定它们。

使用本模块 `console-auth.ts` 的 `passwordRecord(password)` 生成加盐 scrypt 摘要，`AccountsSchema.parse(...)` 校验最终文件。密码长度 12～256 字符，建议随机生成；原始密码由受限文件或标准输入提供，避免放在命令行参数中。更新账号文件后重启对应 Control API，使旧会话全部失效。

默认 Cookie 使用 `__Host-crawlsystem-session`、Secure、HttpOnly、SameSite=Strict、Path=/，最长 8 小时。仅本机 HTTP 开发可设置 `CONSOLE_COOKIE_SECURE=false`，此时使用非 `__Host-` 的开发 Cookie；公网预览必须保持默认 Secure。

密码校验最多 2 个并发；全局每分钟最多 60 次、单用户名每分钟最多 10 次登录尝试，超限返回 429。最多 200 个活动会话，定期在登录时移除过期记录，达到容量时明确拒绝。会话使用 32 字节随机身份，内存仅保存其 SHA-256 索引；退出即撤销。

当前是内部开发账号实现：会话存在单个 API 进程内，重启后重新登录。尚未实现账号管理页面、密码找回、MFA 或多副本会话存储。后续正式身份服务可替换这一认证层，业务权限检查继续由 Store 执行。

## 当前预览部署与验证

为落实用户的账号密码登录要求，本分支补充了 Control API、共享 HTTP 认证扩展和公共登录契约。预览单独运行本分支 API 在 loopback `18104`（`console-preview-api` 用户服务，PG_POOL_MAX=1），连接既有隔离样本库；没有重启原有 `18100/18101` 联调服务。主 Agent 集成时需同时合入上述后端与契约变化，不能只合入前端。

```bash
node --import tsx --test apps/control-api/test/console-auth.test.ts
```

测试覆盖 Cookie/会话恢复、密码错误、撤销退出、8 小时过期、登录预算、CSRF、权限输入拒绝和 Worker Bearer 兼容。真实公网浏览器证据见 [public-password-results.json](../console/docs/evidence/public-password-results.json)。
