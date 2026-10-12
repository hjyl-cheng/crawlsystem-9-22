# 本轮三项收尾验收（2026-10-12）

本页保留三项收尾当时的版本与数据快照。后续频道搜索 / 筛选补齐已发布，当前版本、浏览器验收及代理 / 容量 / 高可用实际缺口见 [频道筛选与运营核对](../channel-filters/README.md)。

控制台正式部署、业务告警、频道删除识别与 `@handle` 导入均已上线，按已约定的采集系统范围，本轮可验收收尾。公网沿用 <https://controversy-roughly-kiss-genealogy.trycloudflare.com/>，无需先提供新域名。公开结果见 [evidence.json](evidence.json)，完整运行证据与备份在忽略的 `.runtime/finish/`。

## 上线结果

| 项目 | 当前行为与验收 |
| --- | --- |
| 正式控制台 | `console-release-web` 提供不可变构建与 API 转发；提交版本 / 内容哈希 / 文件校验、原子激活、旧资源保留、实际回滚 / 恢复均通过。旧 Vite 构建监听与预览服务已停用 |
| 公网登录 | 既有账号实际登录、刷新恢复，HttpOnly / Secure / SameSite=Strict Cookie 跨回滚保持；退出后重放原 Cookie 为 401，未登录 API 为 401，外来 Origin 为 403 |
| 业务告警 | 八条规则已在 Prometheus 加载，两个 API 副本均提供真实指标；全部 health=ok，验收快照为 inactive。沿用已有 Alertmanager / 钉钉通道，桥接健康接口 200 |
| handle 导入 | 裸 `@handle`、YouTube `/@` 链接及 Unicode / URL 编码支持；官方解析后按频道 ID 入原队列。公网手机导入结果为 known / duplicate / duplicate / handle_not_found，reader 写入 403 |
| 删除识别 | 网页明确不可用证据与官方接口成功返回不存在同时满足，经原始响应独立解析、持久入库确认后下线，并同事务写原交付 outbox。隔离数据库及原始响应重放通过 |
| 真实采集与交付 | 两个人工验收计划各 2 个视频、ABOUT / VIDEO / AGENT 全部 APPLIED、4 步 / 5 个持久单元，旧结构业务投影版本核验通过。两计划均分配 s2；s3 新版本另有一个自动计划完成 |

正式部署与日常发布入口见 [部署说明](../../apps/console/docs/deployment.md)。当前前端 release 为 `f383f57fde2a-4045424b93c8`；回滚演练曾切到 `3905f8b8497d-24c1dd80874d`，随后恢复当前版本。Control / raw-parser / pg-sink 使用 `control-api:main-3905f8b8497d-0ee4ca1c`，s2 / s3 Worker 使用 `execution-worker:main-3905f8b8497d-6ab22a30`；指纹网关、画像、dispatcher 及其他基础设施沿用原镜像。最后的网关 / UI 修正只发布前端。

## 导入与删除规则

handle 解析使用已有官方 Data API key；许可与全局每日 `used + reserved` 预算共享账本，失败进入原接口统计。每批最多三个并发，解析总期限 20 秒；成功缓存一小时，官方不存在缓存十分钟，临时网络失败不缓存。页面分别显示不存在、解析暂时失败和今日额度不足，正规频道 ID 仍可独立导入。reader 在外部请求和额度消费前被拒绝。

删除必须由同一采集单元中的两个来源确认：成功的 YouTube `/browse` 响应具有明确频道不可用 / 账号终止告警，且已取得配额许可的官方 channels 接口以 200 返回空 `items`。同单元若有有效频道资料则不判删除；普通 404、代理 / 网络错误、解析失败或单一来源不触发下线。独立解析器只验证捕获的原始响应，不信任采集结果里声明的删除结论。

入库程序只写事实账本，Control 在 ABOUT 清单及持久单元齐全后处理删除，拒绝早于已有资料的观测。已纳管 / 暂停频道改为 removed、取消本轮后续采集、停止继续视频 / Agent，并按原协议下线发布；保存原资料、视频、画像及恢复身份。首次导入即不存在的频道为 FAILED / NOT_FOUND。重复消息或重复确认不重复发布。

删除流程本轮采用隔离检查和原始响应重放验收；未找到可用于现场验证的已纳管真实删除频道，也未向正式库伪造删除。此记录不把隔离验证描述为真实删除频道的现场端到端验收。

## 告警与实际运行

| 规则 | 触发条件 |
| --- | --- |
| CrawlControlMetricsUnavailable | 两个 Control API 均不可采集，持续 5 分钟 |
| CrawlIntentDispatchDelayed | 派发指令等待超过 300 秒，持续 5 分钟 |
| CrawlPlansPastDeadline | 有进行中任务超过截止时间，持续 5 分钟 |
| CrawlPipelineIngestionDelayed | 进行中任务入库确认等待超过 600 秒，持续 5 分钟 |
| CrawlDeliveryDelayed | 交付等待回执超过 600 秒，持续 5 分钟 |
| CrawlDeliveryFailed | 交付失败记录大于零，持续 5 分钟 |
| CrawlNoReadyWorker | 有真实活动计划却没有可接单 Worker，持续 5 分钟 |
| CrawlNoHealthyProxy | 有真实活动计划与可接单 Worker，却没有近期健康代理，持续 10 分钟 |

重复 API 副本用 max 聚合，闲置时返回零；Worker / 代理告警要求有实际工作，避免无任务时误报。原基础设施和 R5 告警保持。12 个规则场景在 Prometheus Pod 的隔离规则测试中通过，没有向生产通知通道发送人为测试消息；本轮核对规则加载与桥接健康，未强制触发一次新的钉钉通知。

北京时间 09:50:00 → 10:08:47，全部 62,967 个原视频身份保留，当前 63,065 个；新版本 s2 完成 4 个计划、s3 完成 1 个。业务交付已完成 2,343 条，pending / failed 均为 0，另有 2 条未就绪及 7 条内容未变记录。CDC connector / tasks 均为 RUNNING，PG 评论正文为 0。两 Worker 为 RUNNING、心跳有效、指纹网关 ready。

## 检查与保留

类型检查、25 项相关数据库集成、9 项单元检查、Kubernetes 服务端 dry-run、12 个告警场景通过。网关补充浏览器 POST 默认 Origin 回归通过；六页 × 1920 / 390 共 12 个布局检查及公网 handle / 登录 / 回滚验收通过，页面 / API 错误与横向溢出均为 0。截图：[手机导入结果](handle-import-390.png)、[桌面 Worker](workers-1920.png)。

升级前完成 170,400,781 字节采集库备份并记录 SHA-256，仅追加迁移 038 / 039 与新表对应应用角色授权。原 37 项迁移校验、配置 v5、在途计划 input_hash / workflow / run / deadline、旧业务库原 64 表、未升级工作负载配置 / Pod / 重启数全部保持。两 Worker 先完整排空再升级，两套 PVC UID 与 281 + 18 共 299 份加密浏览器身份文件哈希保持，随后恢复原接单状态。Cloudflare 原进程 PID 1882 保持；控制台工作树原未提交密码验收文件 SHA-256 保持 `57b4c57b3d8240d236feb8ec08845f17038adb1895afe9a4ae7e760ae8b4c709`。

复核使用同一共享锁、资源边界和单次 300 秒上限，重检查依次运行：

```bash
npm run check:safe -- typecheck
npm run check:safe -- completion-integration
npm run check:safe -- completion-unit
npm run check:safe -- business-alert-tests
npm run check:safe -- console-release verify
npm run check:safe -- completion-browser
npm run check:safe -- completion-live runtime
```

隔离集成测试只连接 `.runtime/r3-test.env`，浏览器与 runtime 使用正式连接做本轮有限验收；不重建正式库。`completion-deploy prepare|import|drain|control|workers|resume` 是本轮有顺序的升级流程，不作为无条件重跑的检查。私密数据库备份、凭据、会话和完整原始证据不进入 Git。

## 本轮范围

已约定的采集架构、主要控制台业务与本轮三项收尾已完成。固定域名、稳定代理供应、整体高可用、永久故障自动跨节点接管及容量扩展属于后续运营增强；继续使用现有域名，Temporal 保留 a1、dispatcher 在 s1。本轮按用户要求采用短期真实运行验收，不把它解释为长期吞吐或连续数日稳定性的证明。
