# MinIO 容量监控与告警验收（2026-10-12）

“存储与流水线”页已显示 MinIO 三个业务桶的用量、硬配额、配额剩余、对象数量、保留规则和所在磁盘余量，入口为 <https://controversy-roughly-kiss-genealogy.trycloudflare.com/storage>。公开结果见 [evidence.json](evidence.json)，截图见 [桌面](storage-capacity-1920.png) / [手机](storage-capacity-390.png)。完整原始指标、配置备份及部署基线位于忽略的 `.runtime/storage-capacity/`。

随后首页“存储与归档”也已增加 MinIO 合计用量、配额及状态，使用相同容量接口；最终控制台 release 和独立验收见 [首页 MinIO 展示](../homepage-minio/README.md)。以下保留容量监控首次上线时的样本与发布记录。

14:46 已上线[原始响应按完成状态保留](../raw-retention/README.md)：raw 全桶 14 天规则已移除，成功完成并入库后保留 24 小时，由后台按保护条件分批清理。parsed / evidence 仍为 90 天，下文 11:29 的 14 天配置属于历史验收样本。

## 当前容量与页面

北京时间 11:29:03 的 API 样本：

| 桶 | 已用 | 硬配额 | 使用率 | 配额剩余 | 对象数 | 保留配置 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| crawl-raw | 5.27 GiB | 60 GiB | 8.78% | 54.73 GiB | 72,610 | 14 天 |
| crawl-parsed | 192.16 MiB | 15 GiB | 1.25% | 14.81 GiB | 123,451 | 90 天 |
| crawl-evidence | 0.38 MiB | 5 GiB | 0.0074% | 约 5 GiB | 152 | 90 天 |

MinIO 所在文件系统可用约 88.99 GiB，总量约 169.25 GiB，与 a1 上其他服务共享。local PV 的 80 GiB 声明容量、桶配额与实际磁盘是不同口径；页面分别显示，不把配额剩余当成独占磁盘空间。

容量来源是现有 MinIO 的 `/minio/v2/metrics/cluster` 与 `/minio/v2/metrics/bucket`。Prometheus 每 30 秒抓取，仅保留容量、桶配额、对象数及扫描指标；页面查询与 API 缓存为 30 秒。当前用量是后台扫描的估计，页面显示实际指标采样和扫描数据年龄。

抓取停止、采样超过 120 秒、扫描超过六小时、某桶缺少用量 / 有效配额 / 对象数时，相关数据返回未知，不补成零；监控故障不影响原入库、统计与保留信息显示。容量接口只向配置的 `m1-main` 工作空间的 reader / operator 提供实际集群用量，其他工作空间返回未知，node / worker 被拒绝。API 不接收桶名或任意查询，不向 Control 增加 MinIO 管理凭据。

## 告警与部署

新增六条规则，沿用已有 Alertmanager 与通知路由：

| 告警 | 条件与持续时间 |
| --- | --- |
| CrawlMinioMetricsUnavailable | 两个抓取目标未全部正常，5 分钟 |
| CrawlMinioCapacityMetricsIncomplete | 抓取正常但业务桶或磁盘 / 扫描指标不完整，5 分钟 |
| CrawlMinioBucketCapacityWarning | 桶配额使用率 ≥70% 且 <85%，5 分钟 |
| CrawlMinioBucketCapacityCritical | 桶配额使用率 ≥85%，5 分钟 |
| CrawlMinioUsageScanDelayed | 用量扫描超过六小时未更新，15 分钟 |
| CrawlMinioDiskCapacityCritical | MinIO 所在文件系统可用比例 <15%，5 分钟 |

比例按实际配额计算，进入严重状态后不重复发同桶预警。13 个隔离规则场景覆盖空桶、70% / 85% 边界、超配额、单目标停止 / 缺失、用量缺失、零配额、扫描过期、磁盘不足和目标全部缺失；没有向生产写入合成指标或强制发送通知。

Prometheus 仅新增两个 job 与 `storage-capacity.yaml` 规则文件，保留原八个抓取任务和其他规则；经 `promtool` 检查、Kubernetes 服务端 dry-run、配置投影确认后 HUP 热加载。MinIO / Prometheus 未重启，桶规则、配额与数据未修改。首次加载、首轮抓取前出现的 pending 监控告警随后恢复；最终六条均 health=ok、inactive，两个目标均 up。

后端两个 Control API 副本使用 `docker.io/crawlsystem/control-api:main-200abaa94e4c-64651cb7`，正式控制台 release 为 `200abaa94e4c-1b3da5d8a679`，均由提交 `200abaa94e4cf83006d090b4a7ef5532fd246c59` 构建。先上线抓取 / 告警，再发布 API，最后切换控制台；原 `/v1/storage` 响应与其他服务镜像沿用。前端回滚版本为 `ea54cd9a1420-687edbab9e41`。

## 保留规则与实际清理边界

只读导出确认三个桶各有一条启用的全桶过期规则：raw 14 天、parsed / evidence 90 天；硬配额为 60 / 15 / 5 GiB，版本控制未启用。审计使用 Pod 内既有管理身份，临时私有 mc 配置退出即删除，未改变生命周期、配额或对象。

11:24:40 → 11:29:24，已完成桶扫描从 11,828 增至 11,840，用量与对象数继续更新；扫描数据年龄约 23 秒，过期队列为 0。这证明扫描持续运行及配置正确。尚未使用达到保留期限的对象验证实际到期删除，过期版本扫描计数为 0；本轮不缩短生产保留期、不删对象做实验，也不把配置核对描述成真实过期删除验收。自然出现到期样本后，可核对原对象与生命周期删除结果。

## 检查与数据保留

类型检查、正式构建与文件哈希通过，8 项读取 / 权限 / 故障处理检查及 13 个告警场景通过。1920 / 390 与公网浏览器验收核对实际 API 数值、三个桶、未知不补零、预警 / 严重状态、错误后重试与原流水线面板；页面 / API 错误和横向溢出均为 0。预警、严重及故障的页面验收只拦截测试浏览器的响应，没有修改生产指标。

运行基线为北京时间 11:22:47，核对为 11:29:03：原 63,556 个视频身份全部保留，当前 63,628 个；在途 1 个计划的 input_hash / workflow / run / deadline 保持。39 项迁移及校验、运行配置 v5、除 Control API 外的工作负载 spec / Pod UID / 重启数均保持。s2 / s3 Worker 为 RUNNING、心跳有效、指纹网关 ready，部署期间 s2 自然完成三个真实计划。交付已完成 2,362，pending / failed 均为 0，CDC connector / tasks 均 RUNNING。Cloudflare 原进程 PID 1882 保持，控制台原未提交密码验收文件 SHA-256 保持。

## 复核与后续

```bash
npm run check:safe -- storage-capacity-unit
npm run check:safe -- storage-capacity-alert-tests
npm run check:safe -- storage-capacity-monitoring verify
npm run check:safe -- storage-capacity-live browser
npm run check:safe -- storage-capacity-live runtime
npm run check:safe -- console-release verify
```

`storage-capacity-monitoring deploy` 合并当前配置并保存首次备份，`storage-capacity-deploy prepare|import|deploy` 和 `storage-capacity-images` 是有顺序的发布步骤；重跑应先核对当前 revision 和原基线。需要回退监控时，以私有备份逐项恢复两个新增 job / 新规则，保留发布后其他人的修改，确认投影后 HUP；控制台发布与回滚沿用 [部署说明](../../apps/console/docs/deployment.md)。

本轮已补齐 [上轮运营审计](../channel-filters/README.md) 发现的 MinIO 用量监控缺口。后续优先优化现有免费代理池的真实可用率，再根据资源实施高可用；真实删除频道现场验收和自然到期清理验收仍等待合适样本。
