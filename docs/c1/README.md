# C1 发布交付上线与验收

2026-10-10 已接通定稿交付链路，并完成真实全量、增量更新、接收端停机恢复和控制台验收。运行核验时间为北京时间 19:18:49，页面核验时间为 19:23:32；详细数据见 [evidence.json](evidence.json)。控制服务运行 `29938cb`，执行器运行 `2ed9fd0`，采集库 schema 31。

## 业务库结构与发布规则

按用户要求沿用老服务器的业务数据库结构：新集群独立数据库 `crawlsystem_business_main` 使用旧系统原始 DDL，`public` / `publication` / `raw_crawler` / `result` 的 64 张表及约束保持一致。DDL 文件为 [bootstrap.sql](../../database/business/bootstrap.sql)，SHA256 为 `8e2964ef1b322c95dea3ea00894213e3ce25030b70e718367782f00b45b1f3f5`。Kafka 接收信息放在独立 `delivery_transport` schema；不改旧 inbox 的不可变证据。旧生产服务器和旧生产业务库未连接、未修改。

采集计划完成时，在同一事务冻结频道资料、视频与 Agent 的发布版本，并写入不可变 outbox。Debezium `c1-delivery` 将完整 JSON 文本发到 `business.delivery`，以频道分区。业务接收端仅连接业务库，复用旧发布合同、连续序号激活和公共表投影；投影成功后发送 `business.receipts`。采集端核验交付身份、manifest hash 和版本向量，收到回执才显示“已交付”。

首次发布要求已完成的资料与画像，以及采集配置至少覆盖 30 个视频 / 90 天范围的已完成 VIDEO 计划、APPLIED 域和冻结目标清单；频道实际视频可以少于 30 个。失败或未完成计划写下的半截资料不能发布。首次交付完整快照，以后按领域变化和视频 delta 交付；资料无变化不增加数据版本。人工移出纳管会交付频道下线，明确不可访问的视频按 private / deleted / unavailable 撤回。自动识别频道被 YouTube 删除尚未实现。

评论正文、评论对象引用及抓取状态不交付给业务库。历史 Agent 输入视频 ID 未保存在新采集合同中，旧合同列表设为空并计算对应哈希；原 `input_hash` 留在 source provenance，不能从当前窗口倒推历史输入。

## 真实运行与恢复

验收快照共 444 条记录：442 条 DELIVERED、PENDING 0、FAILED 0，另有 2 条历史小范围采集记录因缺少完整首次视频窗口而 NOT_READY。它们未进入下游；应完成正常范围的真实采集后再定稿，不能重发半截数据绕过发布资格。

业务库有 441 个可搜索频道、442 份频道快照、8,780 份视频快照和 4,420 条画像事实。采集端有 11,997 个视频身份，交付启用前全部 11,136 个身份均保留，PG 评论正文为 0。C1 启用后完成 33 个自动全量采集和 1 个真实 ABOUT＋VIDEO 手动更新，另有 2 个全量正在运行；本轮 1 个 Worker UNAVAILABLE 已恢复。全部 9 类服务就绪，当前 Pod / 容器均健康且重启数为 0；Debezium connector 与 task RUNNING，复制槽 active，验收时保留 WAL 约 20 MiB。每笔成功回执均与实际 published 业务批次的版本向量逐项核对。

停机恢复使用真实频道 `UC--FL6OwLFWGIZfLfazY4yA`，更新计划 `cd33fa83-3660-4f38-b927-fd6a90b5afd8`。业务接收端停机时更新完成，交付保持 PENDING；以同一 command ID 重发两次仅产生一次重发操作。接收端恢复后原消息与重发消息均被消费，同一定稿版本只投影一次并收到 DELIVERED 回执。验收时当日更新已达 100 个，因此临时暂停自动调度、允许第 101 个手动验收更新；结束后自动搜索、准入、更新与原 100 个每日上限均已恢复。没有清库、删除消息、调整消费 offset 或抬高常态预算。

上线中修复了三类真实问题：

1. Connect 的 ZSTD 压缩需要在 KafkaJS 中注册 Node 22 内置 codec。EventRouter 的 JSON 展开会丢失 null 与异构领域字段，因此关闭展开，保留完整 JSON 文本；真实 CDC 内容逐字段比较及哈希校验通过。之前的错误消息保留，通过操作员重发恢复 422 个原定稿版本。
2. 两个频道把同一外部 URL 显示为多个链接，旧公共表唯一约束导致整批 25 个投影等待重试。投影现在按旧表身份保留首个链接标题和位置，重复项仍保存在原 inbox / revision；25 个原投影任务恢复成功。投影耗尽重试会回传失败，原版本重发可恢复对应死信投影。
3. 发布列表的状态曾被通用计划分页器误判为 PlanStatus，筛选返回 400。交付接口现在独立严格校验状态与分页，实际 HTTP 注入覆盖全部交付状态。

## 页面与检查

发布交付页面已使用真实概况、状态列表、搜索、详情、回执与操作员幂等重发；频道详情、计划详情和首页交付节点接入真实状态。采集计划 COMPLETED 但交付 PENDING 时，页面继续轮询回执。只读账号隐藏重发按钮，真实重发 API 返回 403。

162 项单元测试、18 项 C1 集成测试、10 项流水线集成测试、16 项流水线单元测试、类型检查、控制台构建及 10 项相关前端浏览器测试通过。真实浏览器覆盖发布交付和其余 9 个既有页面，包含状态筛选、搜索、详情、390px 手机宽度和权限；运行错误与失败读接口均为 0。公网 [发布交付](https://controversy-roughly-kiss-genealogy.trycloudflare.com/delivery) 返回 HTTP 200，原 Cloudflare 隧道保持运行。

页面证据：[桌面](delivery-desktop.png)、[手机](delivery-mobile.png)、[首页](overview.png)。浏览器在本机控制台上携带验收身份调用真实后端；公网检查为入口 HTTP 可达性。

## 运维与暂停

使用顺序执行的 `npm run check:safe -- …`：

| 命令 | 用途 |
| --- | --- |
| `publication-prepare test` / `live` | 建隔离测试库 / 独立业务库与旧结构；live 核验目标库名 |
| `publication-infra` | Kafka、专用身份 / ACL、网络策略及 Debezium connector |
| `publication-integration` | 隔离采集库与业务库合同、乱序、重复、资格、失败恢复测试 |
| `publication-control-image` / `publication-control-deploy` | 提交干净代码后构建、导入控制镜像到节点并滚动部署 |
| `publication-live snapshot` / `verify` | 状态快照 / 含真实恢复证据的整体验收 |
| `publication-browser` | 真实 UI、权限与既有页面验收 |

部署、原始工作负载与恢复证据分别保存在主工作树 `.runtime/c1/deployment.json`、`control-fix.json`、`previous-workloads.json`、`recovery.json`。该目录及环境文件含运行机密，不能提交。R5 备份、R6 部署与回滚记录保持原样。

暂停新交付可在采集库执行 `UPDATE delivery.targets SET enabled=false WHERE workspace_id='m1-main';`。保留 outbox、状态、复制槽、业务库和消费 offset；消费者继续完成已有交付。恢复时将 target 启用，新的完成计划继续交付；暂停期间已完成或移出纳管的频道，应通过 `queuePublication` 按当前完成资料逐一对账补发，仍执行相同资格检查。当前 bootstrap 命令只处理尚无交付状态的纳管频道，不能代替完整暂停期对账。

若需撤回功能，优先关闭新交付，再处理已有积压。不要直接运行旧 R5 / R6 降级脚本重启旧契约的 Worker；C1 之后的计划包含发布状态，执行器必须使用兼容契约。业务库表结构、不可变发布证据及 schema 30 / 31 不回退、不删除。

## 后续范围

C1 与发布交付 UI 已完成，C2 已由 R5 完成。C3 仍有首页资源 / 时间范围，以及首页链路图的发现、候选、到期与更新节点待接实数据；对应业务页面和自动流程已经可用。B2 自动收集搜索词、阶段 D 集中配置 / Worker 资源与操作 / 用户审计 / IP 趋势、阶段 E 备份恢复 / 多采集节点 / 正式控制台与固定域名 / 告警和代理来源仍需继续。此次为用户要求的短期真实运行验收，不替代长期运维工作。
