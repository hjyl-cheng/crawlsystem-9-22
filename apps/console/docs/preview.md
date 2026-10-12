# 历史开发预览说明

2026-10-12 起，公开控制台已改为不可变版本发布与正式静态 / API 网关。当前入口：<https://controversy-roughly-kiss-genealogy.trycloudflare.com/>。部署、更新、回滚与复核使用 [正式部署说明](deployment.md)，本文件只记录旧预览状态。

原 `console-preview-build`（监听源码构建）及 `console-preview-web`（Vite preview）已经停用并取消开机启动。`console-preview-api` 更早已停用，API 由集群 `control/control-api-preview` 提供。当前网页服务是 `console-release-web`，原 `console-preview-tunnel` 继续运行；不要用旧服务替换正式网关，也不要为更新前端而重启隧道。

私有 `.runtime/console-preview/url` 与 `preview.env` 继续保存公网入口和精确 Host / API 转发配置。只读账号及凭据记录仍在 `.runtime/console-preview/login.json`，不提交 Git。登录由 Control API 验证，使用 HttpOnly / Secure / SameSite=Strict Cookie，刷新恢复，退出撤销；网关只转发原凭据。

早期的 [账号登录结果](evidence/public-password-results.json)、[登录页](evidence/public-password-login.png)与[登录后截图](evidence/public-password-overview.png)是历史预览证据。当前公网登录、刷新、回滚与退出验收见 [收尾记录](../../../docs/finish/README.md)。

现有地址属于 Cloudflare Quick Tunnel，隧道重建后可能变化；当前可继续使用。固定域名可在后续接入，服务说明见 [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)。
