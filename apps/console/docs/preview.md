# 公网开发预览

当前预览入口：<https://occupations-ferry-advanced-recommends.trycloudflare.com>。

这是 Cloudflare Quick Tunnel 提供的免费 HTTPS 子域名，用于开发预览，不是固定注册域名。隧道进程重建后可能分配不同域名；公网地址以工作区 `.runtime/console-preview/url` 和隧道日志为准。服务当前运行在本工作机器上。

## 页面与登录

入口提供实际构建的 UI，`/api/v1/*` 转发至独立 Fastify Control API `127.0.0.1:18104`。页面使用账号和密码登录，没有匿名数据接口或自动注入操作员令牌。

只读预览账号为 `preview`，密码已单独交付给用户，私有记录位于 `.runtime/console-preview/login.json`（0600，不提交 Git）。Fastify 只读取 `.runtime/console-preview/accounts.json` 中的加盐 scrypt 摘要。账号范围为已有固定样本工作空间 `console-e2e-3814487a386c`，无创建/取消权限。

登录成功后使用 HttpOnly / Secure / SameSite=Strict Cookie，刷新页面恢复会话，最长 8 小时；退出会撤销服务端会话。API 重启后需重新输入账号密码。旧的手动令牌登录已从公开页面移除。

## 更新与进程

前端有独立的 `dist-preview/` 构建目录，源码变更会触发重新构建；浏览器刷新后看到新版本。预览提供静态构建文件，不开放 Vite 开发源码服务。

当前安装了四个用户级 systemd 服务，配置位于 `/home/ubuntu/.config/systemd/user/`，用户 lingering 已启用，以便退出终端后继续运行：

| 服务 | 作用 |
| --- | --- |
| `console-preview-build` | `npm run build:preview --workspace @crawlsystem/console`，监听并构建源码 |
| `console-preview-api` | 独立 Fastify 账号验证与业务 API，loopback `18104`，PG_POOL_MAX=1 |
| `console-preview-web` | `npm run serve:preview --workspace @crawlsystem/console`，在 loopback `18103` 提供静态页面与受控 API 转发 |
| `console-preview-tunnel` | `cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:18103`，建立免费 HTTPS 入口 |

服务在进程异常退出后重启。本机使用 `cloudflared 2026.9.1`，从官方 GitHub Release 下载并核对其发布的 SHA-256。程序位于 `/home/ubuntu/.local/bin/cloudflared`，没有安装公共监听端口或改动防火墙。

```bash
# 查看状态和日志
systemctl --user status console-preview-build console-preview-web console-preview-tunnel console-preview-api
journalctl --user -u console-preview-tunnel -n 40 --no-pager
journalctl --user -u console-preview-build -n 20 --no-pager

# 停止公开预览及后台构建；同时取消开机启动
systemctl --user disable --now console-preview-tunnel console-preview-web console-preview-build console-preview-api
```

预览 API 使用本分支的账号功能，PG 转发复用原有联调环境；它们不可用时页面会显示真实错误，不切换测试数据。原有 `18100/18101` API 继续供其他模块联调。

## 域名变更

隧道日志会给出新 `https://*.trycloudflare.com` 地址。变更后更新根目录私有运行文件 `.runtime/console-preview/preview.env`：

```dotenv
CONSOLE_PREVIEW_HOST=实际分配的域名.trycloudflare.com
CONTROL_API_PROXY_TARGET=http://127.0.0.1:18104
CONTROL_API_BROWSER_ORIGIN=http://127.0.0.1:18102
```

同步 `.runtime/console-preview/url`，然后运行 `systemctl --user restart console-preview-web`。域名需要精确配置，不使用允许所有 Host 的设置；浏览器 API 来源也必须匹配配置域名或本机预览地址。反向代理完成公开来源校验后，将来源映射为后端允许的本机来源，转发 HttpOnly 会话 Cookie；Fastify 继续验证身份、CSRF 和业务权限。

这是开发入口：Cloudflare 不保证免费 Quick Tunnel 的可用性，地址不承诺永久保留。需要长期固定地址时可再接入正式域名或具备账户的托管服务。

## 公网验证

- HTTPS 首页和 SPA 深层地址均返回 200；未登录 API 返回 401。
- 浏览器通过公网地址登录只读身份，实际打开总览与 Plan 列表。
- 非允许来源的 API 请求被预览网关拒绝（403）。
- 账号密码登录、密码错误、刷新恢复和退出撤销均已通过真实公网浏览器验证。
- [账号登录验证结果](evidence/public-password-results.json)、[账号登录页](evidence/public-password-login.png)、[登录后截图](evidence/public-password-overview.png)均不包含密码或 Cookie。早期令牌版本的 `public-preview.*` 为历史证据。

服务说明：[Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)。
