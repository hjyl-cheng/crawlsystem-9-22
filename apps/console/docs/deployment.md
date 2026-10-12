# 正式控制台部署（2026-10-12）

当前入口：<https://controversy-roughly-kiss-genealogy.trycloudflare.com/>。网页由用户级 systemd 服务 `console-release-web` 在 `127.0.0.1:18103` 提供，源码与服务模板在 [`deploy/`](../deploy/)。原 `console-preview-tunnel` 继续提供 HTTPS，更新和回滚网页都不重启该隧道。`console-preview-build` 与 `console-preview-web` 已停用。

发布目录为主业务工作树 `/home/ubuntu/workspace/crawlsystem-business/.runtime/console-release/`。`releases/<commit>-<content-hash>/` 保存不可变构建与每个文件的 SHA-256 清单；`current` / `previous` 用原子符号链接切换。发布工具拒绝从未提交源码构建，激活前核对文件哈希。HTML 使用 `no-store`，带哈希的资源使用不可变缓存，并允许已打开页面继续读取旧版本资源。

## 配置与服务

服务模板 `apps/console/deploy/console-release-web.service` 安装到 `~/.config/systemd/user/`。`CONSOLE_RELEASE_ROOT` 指向发布目录，精确公网 Host 及 API 地址沿用控制台工作树的私有 `.runtime/console-preview/preview.env`：

```dotenv
CONSOLE_PREVIEW_HOST=controversy-roughly-kiss-genealogy.trycloudflare.com
CONTROL_API_PROXY_TARGET=http://127.0.0.1:18104
CONTROL_API_BROWSER_ORIGIN=http://127.0.0.1:18102
```

Origin 映射默认保持原预览的 `http://127.0.0.1:18102`，服务也显式设置该值；若后端配置不同，需同步调整。网关先核对精确 Host / 浏览器 Origin，再转发 `/api/v1/*` 至后端 `/v1/*`，Cookie、Bearer、CSRF 请求头原样传递，不注入登录身份。后端继续负责会话、权限及工作空间校验。密码、Cookie、API key 和数据库凭据都不进入前端构建或发布清单。

```bash
install -m 0644 apps/console/deploy/console-release-web.service ~/.config/systemd/user/console-release-web.service
systemctl --user daemon-reload
systemctl --user enable --now console-release-web
```

现网服务已安装并启用，无需重复初始化。`/healthz` 返回 ready 和当前 release，网关仅监听 loopback。

## 发布与回滚

在主业务工作树中，先完成源码提交，然后依次执行：

```bash
npm run check:safe -- console-release prepare
npm run check:safe -- console-release activate
systemctl --user restart console-release-web
npm run check:safe -- console-release verify
curl --fail http://127.0.0.1:18103/healthz
```

网关本身也属于发布版本，重启使服务加载对应网关。修改配置或服务模板时先 `daemon-reload`。`activate` 可接受明确 release ID，省略时激活刚准备的版本。

```bash
npm run check:safe -- console-release rollback
systemctl --user restart console-release-web
curl --fail http://127.0.0.1:18103/healthz
```

回滚只切换控制台，登录会话仍由后端数据库保存。恢复刚才版本可用 `console-release activate <release-id>` 并重启网页服务。不要删除仍供已打开页面或回滚使用的旧 release，也不要启动旧 Vite preview 占用 18103。

## 复核与域名

```bash
systemctl --user status console-release-web console-preview-tunnel
npm run check:safe -- console-gateway
npm run check:safe -- completion-browser
```

浏览器验收会使用既有账号测试登录、刷新、真实回滚、恢复与退出，并执行一批去重 handle 导入；只读账号不能导入。完整结果见 [收尾验收](../../../docs/finish/README.md)。凭据仍从私有运行目录读取，检查输出只含脱敏结果。

当前继续使用既有 Cloudflare Quick Tunnel 地址。它可能在隧道重建时变化；需要固定域名时再接入 Cloudflare 账户或其他入口，并同步精确 Host、允许来源及私有 url 文件。固定域名属于后续运维升级，不是本轮正式版本发布的前提。
