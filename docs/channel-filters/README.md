# 频道搜索、筛选与运营核对（2026-10-12）

频道管理页的搜索和筛选已接真实数据并上线。入口沿用 <https://controversy-roughly-kiss-genealogy.trycloudflare.com/channels>，公开验收结果见 [evidence.json](evidence.json)，完整私密证据位于忽略的 `.runtime/channel-filters/`。本记录补充 [三项收尾验收](../finish/README.md)，运营核对与升级建议不代表整体高可用已实施。

## 页面行为

- 名称、`@handle`、频道 ID 搜索在工作空间全部频道中执行，先筛选再分页；大小写不敏感，`%`、`_`、反斜杠按字面匹配。
- 国家 / 地区、19 类业务分类、更新 / 纳管状态、Agent 状态可以组合筛选。未提供国家、尚未分类和未纳管频道可单独查看。
- 全部 / 正常 / 逾期 / 已暂停标签及数量采用同一筛选口径；数量保留其他条件，忽略当前标签。暂停和移出纳管不计入逾期，重试日期覆盖原到期日期。
- Agent 状态取最近一次包含画像的计划，单独更新频道资料不会覆盖之前的画像失败；业务分类来自当前已入库画像。
- 筛选保存在网址，刷新恢复；改变条件会重置分页，清除筛选可回到全部频道，无结果时清空旧频道详情。快速连续切换时按最新条件组合，避免带回上一轮标签。
- 侧栏发布交付显示最新计划的真实交付状态，并可跳到该频道交付记录。原更新策略编辑、导入及权限继续沿用。

截图：[桌面组合筛选](channels-filtered-1920.png)、[手机组合筛选](channels-filtered-390.png)、[桌面末页频道搜索](channels-search-1920.png)、[手机末页频道搜索](channels-search-390.png)。

## 发布与验收

后端镜像 `docker.io/crawlsystem/control-api:main-78f6a588e3e4-1a2170a4`，控制台 release `ea54cd9a1420-687edbab9e41`。后端先升级两个 Control API 副本，再激活控制台；旧客户端不传 `include_details=1` 时保持原响应字段，避免升级间隙触发严格契约错误。其他服务沿用原镜像，本次无数据库迁移。

类型检查、10 项相关数据库集成、Kubernetes 服务端 dry-run、正式构建与发布文件哈希通过。浏览器验收覆盖 1920 / 390 两种宽度及公网，检查首页之外的频道搜索、组合条件、网址与标签一致性、刷新保留、分页重置、无结果、侧栏清空、筛选信息失败后重试、reader 权限。页面 / API 错误及页面横向溢出为 0；表格在自身容器内横向滚动。

首轮截图发现手机快速切换可能恢复旧的“正常”条件，修复后补充网址、标签、分页数量和详情检查，最终浏览器验收通过。三次本地网关读取样本为：列表 298 ms、筛选数量 / 选项 321 ms、组合筛选 300 ms；这是当前约 2,243 条频道记录下的单次样本，不是吞吐或压力测试。

部署基线为北京时间 10:42:59，运行核对为 10:46:02，最终浏览器验收为 10:50:41：

| 核对项 | 结果 |
| --- | --- |
| 采集库迁移与配置 | 全部 39 项迁移及校验保持；运行配置 v5 保持 |
| 视频身份 | 升级前 63,261 个全部保留，运行核对时 63,293 个 |
| 在途计划 | 1 个计划的 input_hash / workflow / run / deadline 保持 |
| 其他工作负载 | 除 Control API 外的 spec、Pod UID、重启数保持 |
| 采集 | s2 / s3 两 Worker 均 RUNNING，心跳有效，指纹网关 ready |
| 交付 | 已交付 2,350；pending / failed 为 0；CDC connector / tasks 均 RUNNING |
| 公网入口 | Cloudflare 原进程 PID 1882 保持，正式网页服务 ready |

数据库集成只使用 `.runtime/r3-test.env`。正式库仅做只读查询、部署和有限浏览器验收；本次未向正式库写测试频道或删除证据，未连接旧生产服务器。

## 运营核对与具体后续

北京时间 10:53:29 的只读快照如下，详细数值见公开证据。

| 节点 | 根盘可用 GiB | 根盘可用比例 |
| --- | ---: | ---: |
| a1 | 88.9 | 50.4% |
| a2 | 34.3 | 43.9% |
| a3 | 30.3 | 38.8% |
| s1 | 48.5 | 62.1% |
| s2 | 43.0 | 55.0% |
| s3 | 45.8 | 58.6% |

采集库约 904 MiB，ClickHouse 业务数据约 5.3 MiB；待归档 outbox 为 0。s2 CPU 约 16.9%、内存约 52.3%，s3 CPU 约 28.7%、内存约 33.8%。这份快照没有显示立即扩容的压力，但不能外推长期增长。MinIO 的 80 GiB local PV 是声明容量，与同节点根盘共享空间；声明容量不能替代实际桶用量。

1. **真实删除现场验收**：已纳管 / 暂停频道关联的失败清单中，没有 `NOT_FOUND` 候选（0 个）。已有隔离检查及原始响应重放结果保持，真实现场验收待出现符合条件的已纳管删除频道。届时核对两份原始来源证据、持久入库、移出纳管 / 停止更新、同事务下线 outbox 及旧结构业务库下线结果，保留原资料。普通网络失败不能作为样本。
2. **代理来源**：99 条启用线路中，90 秒内健康 59 条。iplocate 为 3 / 0，proxifly 为 22 / 6，proxyscrape 为 13 / 2，公共订阅 s2 为 43 / 33、s3 为 18 / 18（启用 / 健康）。这些是公共来源；`kind=static` 只表示地址类型。现有订阅继续运行，稳定供应需确定来源、巴西出口与线路预算；新来源先少量接入，复用真实出口检测、两节点短采集及原配额限制，通过后逐步替换不健康线路。
3. **容量**：Prometheus 当前无 `minio.*` 用量指标，MinIO 桶实际用量尚未由监控核实；一次限时目录扫描超时，未将其视为零用量。下一步先接磁盘 / 桶用量及配额指标，核对 raw 14 天、parsed / evidence 90 天的生命周期回收。建议桶配额使用达到 70% / 85% 分别预警 / 严重告警，并结合实际日增量与更新任务量决定扩盘；这些新阈值尚未部署。
4. **高可用**：MinIO 在 a1、ClickHouse 在 s3，Temporal 的 frontend / internal-frontend / history / matching / worker 都在 a1 且单副本；增加采集 Worker 没有解决这些单点。优先确定恢复时间与数据丢失目标，核对可用资源及保留中的备份。Temporal 可按资源逐服务增加副本并分散到节点，验证进行中计划与 mTLS、持久化后再做维护演练，保留 a1 上的现有副本。MinIO 需独立故障域的多盘或托管存储、迁移校验和可回退切换；ClickHouse 需副本、Keeper 与历史数据校验。简单增加单机 Pod 或移动同一 local PV 不能提供存储冗余。最终迁移取决于确定的机器 / 磁盘资源与预算。

本轮完成频道 UI 补齐、上线、运行验收及上述实际运营审计；真实删除现场样本、稳定代理、MinIO 用量监控和整体高可用仍有明确后续工作。

## 复核入口

```bash
npm run check:safe -- typecheck
npm run check:safe -- channel-filters-integration
npm run check:safe -- console-release verify
npm run check:safe -- channel-filters-live browser
npm run check:safe -- channel-filters-live runtime
npm run check:safe -- channel-filters-live operations
```

`channel-filters-deploy prepare|import|deploy` 及 `channel-filters-images` 是本次有顺序的发布步骤，baseline 和原镜像记录保留在私有运行目录；重跑应先审阅当前版本与原基线。控制台发布 / 回滚沿用 [部署说明](../../apps/console/docs/deployment.md)。
