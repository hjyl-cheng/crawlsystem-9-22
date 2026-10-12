# 首页 MinIO 展示验收（2026-10-12）

首页“存储与归档”已增加 MinIO，显示三个业务桶的合计实际用量、合计硬配额和容量状态。入口为 <https://controversy-roughly-kiss-genealogy.trycloudflare.com/>；“查看详情”进入现有存储页。桌面悬停可查看各桶用量、配额、状态和指标采样时间，手机可通过详情页查看三桶数据。容量数据来自已有 `/v1/storage/capacity`，每 30 秒查询，并纳入首页“刷新实时状态”。

验收样本用量约 5.47 GiB、合计硬配额 80 GiB。配额是三个桶的硬配额之和，不代表独占磁盘空间；磁盘余量仍在详情页展示。任一桶预警或严重都会反映在首页，合计用量低时也不会掩盖小桶告警；部分桶未知时合计用量显示“—”，已知的严重状态仍保留。查询失败时清除首页过期容量数字，提供独立重试入口，原 PostgreSQL、ClickHouse、待归档和待处理失败数据仍展示。

实现提交为 `63011e0`，最终布局提交为 `19aff600eacbf6328e811af1d44ee86919954217`。正式控制台 release 为 `19aff600eacb-4768d2055d9a`，前一个 release 为 `63011e0b044d-939224f31407`。本轮只发布控制台；沿用既有容量 API 与监控。Cloudflare 隧道原进程 PID 1882 保持，控制台工作树原密码验收文件的 SHA-256 保持。

公开结果见 [evidence.json](evidence.json)，截图见 [1920 桌面](overview-1920.png)、[1586 桌面](overview-1586.png)、[390 手机](overview-390.png)。完整本地证据在忽略的 `.runtime/homepage-minio/`。

类型检查、正式构建及 release 文件哈希通过。真实 reader 浏览器验收核对了 API 容量和原存储数字，覆盖两个桌面尺寸及手机、详情跳转、全未知和部分未知、单个小桶预警 / 严重、已知严重与未知并存、空桶零用量、首次查询失败、成功后查询失败、独立重试、首页刷新、30 秒轮询和公网刷新。桌面页面无横向或纵向溢出，最近频道第一行完整可见；手机无横向页面溢出。页面错误与其他 API 错误为 0。故障与容量状态场景只拦截验收浏览器响应，未修改正式指标或桶数据。

复核：

```bash
npm run check:safe -- typecheck
npm run check:safe -- homepage-minio-browser
npm run check:safe -- console-release verify
```

容量接口、告警和保留规则的此前验收见 [MinIO 容量监控](../storage-capacity/README.md)。
