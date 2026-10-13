# 8 号审计：其余大型 / 含糊旧文件的规则清单

- 旧系统 L = `/home/ubuntu/workspace/oldsystem/services/qybullmq/src/`（测试 `…/qybullmq/test/`）；部署 = `/home/ubuntu/workspace/oldsystem/deploy/compose.yml`
- 新系统 N = `/home/ubuntu/workspace/crawlsystem-business/`（下文路径相对于此）
- 只读审计，2026-10-13。已在新系统《推进计划_2026-10-08.md》缺口登记（D1–D18）中出现的问题，在备注里标出编号。

## 0 生产路径结论（先回答"哪些代码当时真的在跑"）

1. **全量频道采集默认不走 `pipelineV2.processChannelCrawlV2`**。`worker.js:1305-1312` 按任务的抓取合约分流：YouTube.js 合约走 `fullCrawlYoutubeJs.executeFullCrawlYoutubeJs`，只有 `legacy_full_v2` 走 `processChannelCrawlV2`。`compose.yml:64` 设默认 `FULL_CRAWL_FETCH_CONTRACT_DEFAULT=youtubejs_full_v3`，所以 `processChannelCrawlV2`（pipelineV2.js:1057-2114）只处理遗留合约的任务，归为 c 类。不过它里面的设置值和判定函数被生产路径共用，例如 `getCrawlSettingsV2`、内容窗口、迁移活跃门。
2. **pipelineV2 的其余入口都在生产里运行**：
   - `processContentDetailBatchV2`：处理 `channel-detail-repair` 任务和迁移重试的 content-detail 任务（worker.js:1306，repairPolicy.js:133，contentRepair.js:444）
   - `processCheckpointRepairV2`：Rota 预算耗尽后的断点修复（repairPolicy.js:115-121）
   - `processDataApiBatchV2`：compose.yml:569 的 `youtube-data-api-batch` worker
   - `processAgentBatchV2`：compose.yml:591
   - `processFinalizeV2`：compose.yml:617
3. **youtube.js（旧 Innertube 抓取器）里仍在生产中使用的部分**：
   - 搜索：`fetchPopularThisYearVideoSearchInitial`、`fetchSearchContinuation`、`findContinuationToken`、`extractVideoOwnerCandidates`、`classifyYoutubeError`，由发现页 worker 使用（worker.js:116-121、496-501）；`fetchSearchInitial`、`fetchVideoOwnerSearchInitial`、`extractChannelCandidates`，由 query-quality worker 使用（queryQuality.js:1-8，compose.yml:549）
   - Data API：`fetchVideoDataApiDetails`、`fetchVideoCommentThreadsDataApi`，由 data-api-batch 使用
   - yt-dlp 详情：`fetchVideoYtDlpDetail`，由 content-enrich（incrementalVideo.js:534-556）和 detail repair（pipelineV2.js:2505-2527）使用
   - 只有遗留合约路径才用：`fetchChannelInitial`、`parseChannelHeader`、`fetchChannelUploads`、`fetchChannelYtDlpMetadata`、`fetchChannelDataApiDetails`
   - 全仓库无调用方（c 类）：`fetchChannelTabInitial`、`fetchBrowseContinuation`、`fetchVideoQuickDetail`、`fetchVideoDetail`、`fetchVideoInnertubeDetail`、`extractTabItems`、`isWithinRecentWindow`、`isOlderThanRecentWindow`、`publishedAgeDays`（28 天 `YOUTUBE_RECENT_DAYS` 窗口只存在于这些死代码中）
4. **yt-dlp 在生产中用过，但不在默认的全量和增量主路径上**：
   - `compose.yml:491/507/526` 把 `YTDLP_PERSISTENT_POOL_ENABLED` 设为 true
   - 按 `channelExtractorCapabilities.js:11-17`：`channel_full` 用 `youtubejs_full_v3` 合约时不需要 yt-dlp，`channel_incremental` 用 `youtubejs_checkpoint_v1` 时也不需要；`content_enrich` 和遗留合约全量需要
   - 由于 `FINGERPRINT_TRANSPORT_REQUIRED=true`，没有租到持久会话时 yt-dlp 直接报错，不会退回一次性直连（ytdlpSession.js:498-501）
   - `youtubeJs.js:70-81` 的 `extractorMode()` 默认 `full`，compose.yml:66/506 也是 `full`；worker.js:1668 规定 YouTube.js 全量和增量必须在 `full` 模式下运行
   - 结论：yt-dlp 在生产里只用于三处——内容补全（content-enrich）、detail repair 的回退，以及"YouTube.js 判定评论关闭"的复核
5. **QUERY_METADATA_COLLECTION_ENABLED 在 deploy/ 中没有设置**，因此 queryCollector 的自动收集在生产里没有开启（queryCollector.js:235-246）。`FULL_CRAWL_CANARY_WORKER` 也没有设置，canary 通道没有部署。

## 1 文件分类

| 文件 | 类别 | 依据 |
|---|---|---|
| pipelineV2.js | a（主体）；其中 processChannelCrawlV2 为 c | 见 §0-1/0-2。生产在用：详情归一与合并、窗口与直播排除、Data API 批与预算、Agent 批、定稿判定 |
| youtube.js | a（搜索、Data API、yt-dlp 映射）+ c（其余） | 见 §0-3 |
| ytdlpSession.js | b（生产在用的传输机制） | 见 §0-4。持久 yt-dlp 进程、档案与代理绑定、失败重启。新系统用指纹网关 + youtubei.js 代替，没有 yt-dlp |
| migrationSystemRetryRecovery.js | b | 迁移重试的 BullMQ/fence 对账（controller.js、worker.js:108）。只有"迁移完成"的判定含业务语义（O-50） |
| migrationActivityGate.js | a | 每次结算 run 明细状态都会调用（runDetailStatus.js:267）；包含休眠判定和入库 |
| migrationActivityPolicy.js | a | 生产全量路径也调用（fullCrawlYoutubeJsFactory.js:25,156-189）和 pipelineV2.js:1887 |
| fullAgentMigrationRetryGuard.js | b | 只有行锁 fence（pipelineV2.js:4323-4346） |
| finalizePolicy.js | a | processFinalizeV2 的完成判定，以及 controller、finalizeDispatch 等 |
| finalizeDeferral.js | b | 定稿遇到锁冲突时的退避与延后（5–60 秒） |
| businessRunBudgetRecovery.js | b | Rota 业务 run 预算耗尽时终止 run（worker.js:1631）。新系统不沿用 Rota 模型 |
| channelRegistryPromotion.js | a（小） | 候选晋升去重规则 |
| queryCollector.js | c | 功能开关在生产中关闭（§0-5） |
| discoveryPageWakeup.js | a（小）+ b | "本页候选全部校验完才判定是否翻页"的时机规则；Redis 唤醒属于机制 |
| baselineBundle.js | b（含少量 a） | 迁移基线导出格式；initialFullObservations.js:2-6 用它的 about/discovery 完整度规则判定初始观测是否完整 |
| storage.js | b | MinIO 写入与 raw_objects 登记 |
| checkpointRepair.js | b（含 a） | 断点修复的 run 物化和候选重置范围 |
| runDetailStatus.js | a | run 明细状态的结算规则 |
| channelExecutionContext.js | b | 执行上下文、请求统计、代理身份不变检查 |
| channelRunBinding.js | b（含 a） | run 准备与绑定；晋升 run 未定稿前不能开新 run |
| rawCompression.js | b | gzip 存储 |
| fullCrawlCanary.js | b / c | canary 路由（queues.js 生产侧一直启用，但 canary worker 没有部署） |
| fullCrawlCollector.js | b | 采集器接口断言（无规则） |
| localFullCrawlCollector.js | b | YouTube.js 适配器（无规则） |

## 2 规则表

状态说明：一致 / 缺失 / 不同 / 不适用（括号内说明原因）。"另见 X 审计"表示该规则的主体在其他审计员负责的文件里，这里只记录它在本组文件中的出现位置。

### A. 采集设置与内容窗口

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| O-1 | pipelineV2.js:284,570,582 | 每频道视频数上限默认 30，可设 1–100 | packages/contracts/src/index.ts:128；activities.ts:216 | 一致 | — | |
| O-2 | pipelineV2.js:285,571,583；2415-2427；2556-2567；4068-4092；2116-2179 | 内容窗口 90 天（0–3650，0 表示不限）。采集时就排除窗口外的视频：上传列表的日期已在窗外就不采详情；详情或 API 返回后再判一次，在窗外则排除（scope=excluded/older_than_max_age，content_key 置空，删除本 run 已写入的 contents 行，disposition 记为 outside_content_window） | 采集阶段没有年龄截断：contracts/index.ts:125-129（"web collection has no age cutoff"）、activities.ts:215、store/index.ts:645-647；只在交付时过滤：store/publication-map.ts:36-41 | 不同 | contentWindow.test.js；pipelineContentDetailPolicy.test.js | 新系统一律取最新 30 条，超过 90 天的视频也会采详情和评论并入库，只在交付时剔除；对低频频道，交付的视频可能远少于 30 条。计划文档 :535 仍把"90 天内容窗口是否恢复"列为待定 |
| O-3 | publicationTimeEvidence.js:226-268（由 contentWindow.js:32-38 调用） | 窗口边界：只对 published_at_status=exact 的视频做判定，否则记为 unresolved，不排除。精确到秒：发布时间 ≤ cutoff 算窗外。仅日期：早于 cutoff 那天算窗外；正好是 cutoff 当天记为 cutoff_overlap，采集时不排除（交付时按窗外处理，videoPublicationCurrent.js:425）。发布时间晚于 as_of 记为 after_as_of | publication-map.ts:40：`published_at>=cutoff && <=asOf`，并且 status ∈ exact/relative/estimated | 不同 | contentWindow.test.js；migrationActivityPolicy.test.js「an exact date-only cutoff overlap…」 | ① 新系统允许 estimated/relative 发布时间进入交付窗口，旧系统交付要求 exact + 精度 second/date_only + 有来源（videoPublicationCurrent.js:156-161,412-418）；② 恰好在 cutoff 上的秒级时间，两边处理相反（影响很小） |
| O-4 | pipelineV2.js:2428-2451 | 上传列表的日期无法判断窗口关系（unresolved）时，标记 detail_request=initial_publication_unresolved，强制采详情，并计数 details_requested_due_to_unresolved_count | — | 不适用（新系统不在采集时预筛，所有目标都采详情） | migrationActivityGate.test.js「records one Channel-level dormant reversal after detail」 | |
| O-5 | pipelineV2.js:2181-2248，检查点 2404-2413（频道页）/2491-2500（YouTube.js）/2529-2538（yt-dlp）/3964-3975（Data API）；detailPolicy.js:66-70 | 未结束的直播（upcoming_live、live_in_progress）在四个来源上逐个检查，命中就排除出内容：类型记为 live，content_key 置空，删除已存的 contents 行，disposition 记为 terminal_excluded | web-scrape.ts:123,129（预告和直播都存为 live）；map.ts:99-102；publication-map.ts:40 不排除 | 缺失 | pipelineVideoDisposition.test.js「records an upcoming Live exclusion」「excludes a Live in progress after detail detection」「accepts live_status as the only current-Live signal」 | D4。预告和正在进行的直播会进入业务库窗口，排期时间被写进 live_started_at |
| O-6 | migrationActivityGate.js:88-90；pipelineVideoDisposition | 已结束直播的回放（有 live_ended_at 或时长）按正常内容保留 | web-scrape.ts:123,136；map.ts:126 | 一致 | pipelineVideoDisposition.test.js「stores an ended Live replay」 | 新系统没有区分"已结束"和"未结束"，见 O-5 |
| O-7 | pipelineV2.js:286,3127-3140；detailConcurrency.js | 详情并发 2（YOUTUBE_DETAIL_CONCURRENCY），按顺序预取；遇到窗外候选不中断后面的候选 | web-collector.ts:153-176（逐个顺序处理） | 不同（只影响性能） | pipelineContentDetailPolicy.test.js | 只影响吞吐，不影响结果 |

### B. 视频详情的归一与多来源合并（pipelineV2 生产在用；主体另见视频详情、评论审计）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| O-8 | pipelineV2.js:678-686；detailPolicy.js:93-102 | 点赞数缺失，且视频可公开观看（public、OK，或已有播放数/评论数/发布时间），记为 0（zero_from_empty）；会员、私密、不可用、需登录的视频不这样处理 | web-scrape.ts:127,133；map.ts:120（缺失记为 unresolved/unavailable） | 缺失 | incrementalYoutubeJsVideo.test.js；youtubeJs.test.js | D15（旧库中 57% 的点赞为 0） |
| O-9 | pipelineV2.js:687-689 | comments_disabled=true 时，评论数记为 0，状态 disabled | web-scrape.ts:134、map.ts:123 有映射，但 scrape.ts:80-109 的 topComments 从不返回 `disabled` | 缺失（实际效果） | pipelineVideoDisposition.test.js「normalizes disabled comments to zero」 | D3 |
| O-10 | pipelineV2.js:694-702 | 评论没有关闭且有状态来源时，评论数 0（zero_from_surface）；预告且 public 时，评论数 0（zero_from_upcoming） | — | 缺失 | youtubeCommentPage.test.js；youtubeJsStrictDetail.test.js | D15 |
| O-11 | pipelineV2.js:683-685,704,720,722 | 缺失字段的状态：经过 API 之后记 unavailable，之前记 unresolved | map.ts:107-120（API 路径记 unavailable）；web-scrape.ts:121（网页路径记 unresolved） | 一致 | — | |
| O-12 | pipelineV2.js:707-721 | 时长只认正整数秒；正在直播时状态为 unavailable，来源 live_in_progress_not_applicable | map.ts:121（API：upcoming/live 记为 unavailable）；web-scrape.ts:133（网页：一律 unresolved） | 不同（小） | — | 网页路径没有区分直播 |
| O-13 | pipelineV2.js:723-731 | 会员专属视频没有播放数时，用 点赞/0.028 + 评论/0.0028 估算播放数（estimated，来源 likes_comments_estimate） | — | 缺失 | youtubeJs.test.js（同一公式） | D6：新系统把会员视频记成不可用，连元数据都没有 |
| O-14 | pipelineV2.js:651-671 | 访问状态来源的优先级：Data API privacy > 详情里的显式值 > YouTube.js microformat 的 unlisted > 提取器推断 | web-scrape.ts:135；map.ts:125（每条只有一个来源） | 不同（简化） | pipelineDataApiRecovery.test.js「returned public Data API evidence overrides unresolved scrape access」 | 另见视频详情审计；D1 |
| O-15 | pipelineV2.js:493-508 | 合并多个来源时：已知的访问状态不会被 unknown 覆盖；unlisted 和 public 冲突时取 unlisted | 新系统每个视频只用一个来源；pg-sink 整条替换（apps/pg-sink/src/sink.ts:71-78） | 不同 | pipelineVideoDisposition.test.js「preserves explicit YouTube.js unlisted access while yt-dlp fills missing detail」 | |
| O-16 | pipelineV2.js:326-428,519-524 | 评论证据按强弱合并：有可见评论 > 已关闭 > 已观测 > 无；有可见评论时推翻"已关闭"；评论数和评论首屏分别取各自最强的证据 | — | 不同（新系统没有多来源合并） | pipelineVideoDisposition.test.js「does not let a yt-dlp disabled result erase visible YouTube.js comments」 | 另见评论审计 |
| O-17 | pipelineV2.js:526-555 | 描述：取状态更好的（exact > empty > unavailable > unresolved），同为 exact 时取较长的；关键词取最新一次观测 | web-scrape.ts:118（单一来源） | 不同（小） | videoMetadata.test.js | |
| O-18 | pipelineV2.js:509-517,763-771；publicationTimeEvidence | 发布时间证据择优（更精确的优先，冲突时记录 publication_evidence_conflict） | web-scrape.ts:109-110,131-132（microformat 优先，其次 /next 日期） | 一致（近似） | publicationTimeEvidence.test.js | 新系统不记录冲突 |
| O-19 | pipelineV2.js:447-464,2461-2484 | YouTube.js 说评论关闭时不直接采信，先清掉这些字段，再用 yt-dlp 复核（comments_disabled_verification） | — | 缺失 | pipelineVideoDisposition.test.js「verifies a YouTube.js disabled result and keeps visible yt-dlp comments」 | 与 O-9 同一根源 |
| O-20 | pipelineV2.js:2453-2554,775-785；detailPolicy.js:124-152 | 详情回退链：先 YouTube.js；如果字段缺失、访问受限、是直播、需要换客户端、类型不权威或出错，再用 yt-dlp（web_safari→android）；评论首屏缺失时用 YouTube.js 评论接口 | web-scrape.ts:139-168（WEB→IOS）；web-collector.ts:158-199 | 不同（用户已确认） | pipelineVideoDisposition.test.js | 10-09 用户确认：只有"YouTube.js 试 3 次都失败"才用 Data API 批量补；新系统没有 yt-dlp |
| O-21 | pipelineV2.js:2937-2994；youtubeDataApiEvidence.js:33-48；detailPolicy.js:155-173 | 字段缺失也触发 API：描述、发布时间、时长、播放、点赞、评论数、评论首屏任一缺失，就进入 api_pending（emergency 模式，每个候选最多一次） | web-collector.ts:160-183（只有 3 次网页尝试都失败才走 API） | 不同（用户已确认） | pipelineDetailRecovery.test.js | 字段缺失的视频在新系统里直接以 unresolved 入库（D15） |
| O-22 | pipelineV2.js:2716-2753,4037-4061 | 内容类型（video/short/live）没有权威证据时，不写入 contents，重试；达到上限后类型记为 unavailable | web-scrape.ts:129；map.ts:100-102（默认 video，来源 default:shorts_unknown） | 不同 | pipelineVideoDisposition.test.js「defers public content without authoritative type evidence」 | 另见视频详情审计。D11 提到：API 兜底时会丢掉网页给出的 Shorts 判断 |
| O-23 | pipelineV2.js:572,2589-2647 | 详情最多尝试 3 次（可设 1–10）；遇到瞬时错误且仍缺字段时记为 failed，等待重试 | web-collector.ts:160 | 一致 | pipelineDetailRecovery.test.js | |
| O-24 | pipelineV2.js:2755-2854；detailPolicy.js:175-203 | 只能分类、不能入库的视频（会员/私密/不可用/需登录）：明确的终态直接结束；访问状态不明时先用 API 核实，再按次数重试 | web-scrape.ts:95-106,161-167（需登录要 WEB 和 IOS 都确认才算终态） | 不同 | pipelineDetailRecovery.test.js「classified-only candidates use access-status API fallback」 | D6；另见视频详情审计 |
| O-25 | pipelineV2.js:2856-2929,3976-4008 | 已存在的视频访问状态变了（比如变私密）时，只更新访问字段，保留原来的类型和内容（update_access） | pg-sink sink.ts:71-78（新的不可用记录整条覆盖旧事实）；交付端改为撤回（publication-map.ts:61） | 不同 | pipelineVideoDisposition.test.js「preserves an existing Video when access changes」 | 交付语义上的撤回一致，但库里原有的视频事实会丢 |
| O-26 | pipelineV2.js:820-848 | run 完成后，取消那些已被重新抓取解决的待办 API 任务（scrape_repair_completed） | — | 不适用（新系统没有独立的 API 任务队列） | — | |

### C. Data API 批与预算

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| O-27 | youtube.js:2173-2213；youtubeApiSettings.js:22 | videos.list 每批最多 50 个 id；part=snippet,contentDetails,statistics,status,liveStreamingDetails；超时 12 秒 | data-api.ts:113-118（50 个，超时 15 秒）；web-collector.ts:178 | 一致 | youtubeApiSettings.test.js | |
| O-28 | youtube.js:2140-2145 | public 视频的 statistics 里没有 commentCount，就判定评论关闭，评论数 0（disabled） | map.ts:123（记为 null，状态 unavailable）；scrape.ts:105（无计数时记为 unavailable） | 不同 | youtubeDataApiComments.test.js「classifies a public video without comment statistics as disabled zero」 | D3/D15 |
| O-29 | youtube.js:2116-2134 | 直播判定：只有 liveBroadcastContent=live 才算正在直播；upcoming，或有计划时间但还没开始，算预告；有 actualEndTime 算已结束（was_live）；已开始但没结束、又没有 live 标志的，记为未决 | map.ts:99-102（只要有 liveStreamingDetails 就记为 live，包括回放和预告） | 不同 | youtubeDataApiComments.test.js「only marks an explicitly active broadcast as currently live」「does not infer a current live from a start time…」 | 新系统无法区分回放、预告和正在直播，与 O-5 相关 |
| O-30 | youtube.js:2155；detailPolicy.js:72-91 | privacyStatus 映射为访问状态 | map.ts:125 | 一致 | — | |
| O-31 | youtube.js:2219-2317；pipelineV2.js:3373-3502,3825-3889 | 评论首屏缺失（或订阅方要求评论）时调用 commentThreads.list（relevance、20 条、纯文本）；返回 commentsDisabled 判定关闭，评论数 0；返回空列表记为 confirmed_no_visible_threads，7 天后重查 | 新系统评论只走网页（web-collector.ts:186-192） | 不同（用户已确认） | youtubeDataApiComments.test.js「commentThreads.list returns disabled comments…」；pipelineDataApiRecovery.test.js「official zero-thread evidence…」 | 用户已否决用 Data API 采评论（memory: comments-via-web-not-api），不建议移植 |
| O-32 | pipelineV2.js:3308-3371,3437-3473,3765-3793；youtubeApiSettings.js:24；compose.yml:571 | Data API 每日上限 500 次请求（按请求次数，不按配额单位；以数据库 CURRENT_DATE 为日界）；用完后批次延到次日 00:05 继续，不算失败 | store/src/update-budget.ts:4-19（每天 10,000 单位，按太平洋时间分日，按计划预留）；contracts/index.ts:502；activities.ts:144-149（用完即 BUDGET_EXHAUSTED，计划结束） | 不同 | — | D11：旧系统等配额重置后继续，新系统直接结束计划 |
| O-33 | pipelineV2.js:3764-3802,3386-3426 | 多个 API key 轮换：一个失败就换下一个 | apps/execution-worker/src/main.ts:57（只有一个 key） | 不同（低） | — | |
| O-34 | pipelineV2.js:4063-4122；youtubeDataApiEvidence.js:50-58 | API 之后仍缺的字段记为终态缺失；访问状态为 unknown 或 login_required 时，把 access_status 也记为缺失 | map.ts:107-130（缺的字段留在事实里，状态 unavailable） | 一致（语义相近） | pipelineDataApiRecovery.test.js「terminal API evidence keeps unresolved access explicit」 | |
| O-35 | pipelineV2.js:3688-3719,4125-4128 | API 没有返回某个视频，任务记为 unavailable；批失败后重试间隔 5 秒（有订阅请求时）或 5 分钟 | web-collector.ts:194（记为不可用视频）；重试交给 Temporal | 一致 | pipelineDataApiRecovery.test.js | |

### D. 完成 / 定稿判定（"频道这一轮算完成"）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| O-36 | finalizePolicy.js:7-22,115-119；pipelineV2.js:4635-4654 | 只给 active/dormant 频道定稿，并且只接受频道最新的 run（旧 run 跳过，记为 stale_run） | store/src/publication.ts:13-26（要求 managed/paused 且计划 COMPLETED） | 一致 | finalizePolicy.test.js「finalize accepts only the channel latest run」「Channel eligibility…」 | |
| O-37 | finalizePolicy.js:188-210；pipelineV2.js:4778-4807 | 完成状态按顺序判定：还有未完成的详情 → pending_detail；还有未完成的 API → pending_api；频道休眠 → ready_partial；没有 Agent 或 Agent 缺字段 → pending_agent；频道或内容缺字段、有不可用视频、初始观测不完整 → ready_partial；否则 ready_auto。只有 ready_auto 和 ready_partial 算完成（finalizedRunState:212-219） | store/index.ts:693-716：VIDEO 域要求每个冻结目标都有结果，所有必需域都 APPLIED 后计划 COMPLETED | 不同 | finalizePolicy.test.js | 新系统没有"部分完成"和"自动完成"之分，也没有休眠状态（见 O-45） |
| O-38 | pipelineV2.js:4786-4793 | Agent 必需字段：creator_gender、creator_age_range、creator_language、audience_region、audience_age_gender、audience_language、active_subscriber_ratio、channel_tags、channel_categories；只有爬虫没拿到国家时才要求 country | contracts/index.ts:109-118（严格 schema，所有字段必填，country 一直必填） | 一致（新系统更严） | — | D17：没有 unknown 状态，模型证据不足时只能填先验值；另见 Agent 审计 |
| O-39 | pipelineV2.js:4783-4785 | 频道必需字段：title，以及订阅数或订阅数文本 | web-scrape.ts:55（没有标题直接报错）；订阅数可以是 unresolved | 不同（小） | — | 旧系统缺订阅数记为 ready_partial |
| O-40 | pipelineV2.js:4612-4626,4838-4842 | 爬虫从 About 解析出的国家覆盖 Agent 的 country 结果（来源 crawler，置信度 high，证据 "YouTube About country field"） | apps/profile-agent/profile_agent/adapter.py:49-52 把 About 国家作为输入传给 Agent，不做覆盖 | 不同（待 Agent 审计确认） | — | D14：同一国家出现两种写法 |
| O-41 | finalizePolicy.js:179-186 | 同一 run 的定稿状态不回退：ready_auto 只能保持 ready_auto；ready_partial 只能保持或升为 ready_auto | 新系统每次交付按当前快照重新计算（publication-map.ts:35-71） | 不适用（新系统没有分级状态） | finalizePolicy.test.js「a later complete source observation invalidates a ready_partial Finalize」 | |
| O-42 | finalizePolicy.js:121-177 | 定稿幂等：同一 run、同一 source_revision（包括三类初始观测的结果）直接复用已有定稿 | publication.ts:15-16（按计划去重）；publication-map.ts:51-52（result_hash 不变就不发） | 一致 | finalizePolicy.test.js「existing finalized profile is reusable only for the same run and revision」 | |
| O-43 | pipelineV2.js:4844-4879 | 质量报告：只有 ready_auto 且没有缺字段、没有不可用视频时，publish_ready/data_complete 才为 true；同时记录窗外排除数、不可用数、缺字段明细 | publication-map.ts:42（window_proof 只有计数；complete 写死为 true，terminal_condition 写死为 'durable_finalized_window'） | 不同 | — | 旧系统的交付窗口还要求"截止条件得到证明"（videoPublicationCurrent.js:574-589，列表到底/越过年龄边界/满 30 条/锚点连续等），否则不允许交付；新系统直接写 complete:true |
| O-44 | runDetailStatus.js:189-282 | run 明细状态：有 failed 或终态但未定 disposition → failed；还有未完成的 API → api_pending；全部终态 → done，并转入 waiting_agent；预期内容数 = 候选总数 − 排除数 | store/index.ts:693-699（全部目标有结果才能封闭域） | 一致（语义） | pipelineDetailRecovery.test.js | |
| O-45 | finalizePolicy.js:201；migrationSystemRetryRecovery.js:246-251 | 休眠频道不需要 Agent，定稿为 ready_partial 即算完成 | — | 缺失 | finalizePolicy.test.js | 随 D18 一起移植 |
| O-46 | finalizeDeferral.js:233-307 | 定稿遇到行锁或写锁冲突时延后 5–60 秒（指数退避）；增量正在执行时，二次定稿延后 | publication.ts:18（事务 + advisory lock） | 不适用（机制不同） | finalizeDeferral.postgres.integration.test.js | |
| O-47 | finalizePolicy.js:59-113 | 修复类定稿的 as-of 时间和修订类型（repair 或 incremental） | publication-map.ts:67（bootstrap/incremental/retraction） | 不适用 | finalizePolicy.test.js「Publication Repair identity and clock…」 | |
| O-48 | baselineBundle.js:77-121 | 初始 About 观测：订阅、总播放、视频数三项都解析出来（exact/estimated）才算 complete，否则 partial；不编造未解析的数值 | store：ABOUT 一经提交就 APPLIED；ChannelFacts 的各项 metric 自带状态 | 不同（小） | baselineBundle.test.js「never invents an unresolved count」 | 旧系统中 partial 会让定稿变成 ready_partial（O-37） |
| O-49 | baselineBundle.js:130-195 | 初始视频观测：首见视频最多 30 条；扫描证明的终止条件属于 qualified_item_limit、age_boundary_crossed、list_end、初始候选上限之一，且解析缺口为 0，才算 complete | — | 不同（同 O-43） | baselineBundle.test.js | |
| O-50 | migrationSystemRetryRecovery.js:229-268,763-776 | 迁移频道算"完成"的条件：候选已 accepted；run 和明细都是 done；定稿为 ready_auto/partial，且定稿时间晚于频道、Agent、候选、内容的最后更新 | — | 不适用（新系统没有迁移任务） | migrationSystemRetryRecovery.test.js | |

### E. 迁移活跃门 / 休眠

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| O-51 | migrationActivityPolicy.js:24-91；pipelineV2.js:1887-1959；fullCrawlYoutubeJsFactory.js:156-189 | 活跃门（reject_if_no_recent_content）：上传列表证据完整时，90 天 UTC 窗口内有已发布内容 → continue；只有日期不确定的内容 → inconclusive，继续采；全部日期确定且都在窗外 → dormant：不采详情、不跑 Agent，直接定稿 | — | 缺失 | migrationActivityPolicy.test.js | D18（10-13 用户决定恢复）。10-09 曾定"迁移专用的暂不做"，已被推翻 |
| O-52 | migrationActivityGate.js:105-490；runDetailStatus.js:267-282 | 详情全部终态后用候选证据再判一次：passed/inconclusive → 频道激活，排 Agent；dormant → 频道转 dormant（记录 dormant_since、recheck_day、cycle），候选 accepted，写一条空的初始视频观测，run 完成 | — | 缺失 | migrationActivityGate.test.js | D18 |
| O-53 | migrationActivityPolicy.js:14-22,45-52；migrationActivityGate.js:68-79 | 判定活跃时，预告不计入；正在直播算"不确定"（不能据此判休眠） | — | 缺失 | migrationActivityPolicy.test.js「upcoming Live is excluded but a running Live remains uncertain」 | 随 D18 |
| O-54 | migrationActivityPolicy.js:80-84,141-152 | 证据不完整（上传扫描有缺口、日期未知）时，不能判为休眠 | — | 缺失 | migrationActivityPolicy.test.js「unknown publication evidence cannot be misclassified…」；migrationActivityGate.test.js「an incomplete Uploads scan cannot become dormant…」 | 移植时必须带上这条，否则会误判休眠 |
| O-55 | migrationActivityGate.js:139-141,281,383 | 上传列表为空（empty_uploads outcome=dormant）也触发休眠（EMPTY_UPLOADS_REASON） | — | 缺失 | migrationActivityGate.test.js | D8/D18 |
| O-56 | migrationActivityGate.js:124-137 | 频道已被移除时，活跃门直接判 rejected | activities.ts:180-189；channel-removal.ts | 一致 | — | |

### F. 搜索 / 发现

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| O-57 | youtube.js:53,1293-1332；worker.js:496-501 | 发现搜索的参数：类型视频 + 按观看次数排序 + 今年上传（sp=CAMSBAgFEAE=），hl/gl 取页面意图里的语言和国家 | apps/execution-worker/src/youtube/web-search.ts:60-65（sp 字节 [8,3,18,4,8,窗口,16,1]，窗口为今年/本月/本周，按搜索绑定的时钟决定） | 不同（B2 已确认） | youtubeSearch.test.js「discover search filter is video popularity plus this year」 | 窗口取"今年"时编码与旧系统完全相同 |
| O-58 | youtube.js:1334-1357 | 续页：用页面 ytcfg 里的 INNERTUBE_API_KEY、clientName、clientVersion 和 context，POST 到 youtubei/v1/search | web-search.ts:68-83 | 一致 | — | |
| O-59 | youtube.js:1365-1370,1415-1468 | 从 videoRenderer 取频道：依次看 ownerText、longBylineText、shortBylineText 第一个 run 的 browseId，必须以 UC 开头，否则丢弃 | web-search.ts:31-57（另外支持 lockupViewModel；有视频但读不出任何频道身份时报解析错误） | 一致（新系统更严） | youtubeSearch.test.js | |
| O-60 | youtube.js:1424-1432 | 搜索结果的播放数文本必须能解析，否则抛 ParserContractError，整页失败 | — | 不适用（新系统不读播放数） | — | |
| O-61 | discoveryPagePolicy.js（controller.js:1808-1820 调用）；discoveryPageWakeup.js:3-27；pipelineV2.js:569,581 | 翻页条件：等本页候选全部完成快照校验后，若合格比例 (accepted+existing)/总数 ≥ 1/3 且有续页，才翻页；有校验失败时本页失败，不再翻页 | store/src/query-runs.ts:119；contracts/index.ts:674-676（本页新频道 ≥3 个且页数 <5 就翻页，不等资格判定） | 不同（B2 已确认） | discoveryPagePolicy.test.js；discoveryPageWakeup.test.js | 计划 B2：每页至少 3 个新频道才翻页，最多 5 页，已获用户确认 |
| O-62 | pipelineV2.js:283,568 | 准入的订阅门槛 1,000 | contracts/index.ts:677；store/index.ts:844-846 | 一致 | — | |
| O-63 | pipelineV2.js:1501-1547；channelApiFallback.js:78-92 | 订阅数未知时不直接拒绝：如果是拦截或网络错误，抛错重试；否则抛 ParserContractError，作为可见的失败。只有 Data API 确认订阅数被隐藏才拒绝（subscriber_count_hidden）；API 查不到频道则记为 channel_unavailable | store/index.ts:845-846：订阅数为 null 一律 REJECTED（hidden_subscribers） | 不同 | channelQualification.test.js；pipelineAboutOnlyRouting.test.js | 网页没读到订阅数（unresolved）也会被当成"隐藏"拒绝，可能错拒合格频道 |
| O-64 | channelRegistryPromotion.js:87-199 | 同一频道有多个候选时，主键插入成功的那个唯一晋升，其余标 existing（channel_already_promoted）；候选尝试的 fence 过期就整体回滚 | store/src/query-runs.ts:108-113,150-157（known_before 加 ON CONFLICT 去重） | 一致 | channelRegistryPromotion.test.js | |
| O-65 | pipelineV2.js:1106-1164 | 频道已被移除，或候选已是 rejected/existing 时，直接终止，不采集 | query-runs.ts:110-112（已知频道不再成为新候选）；store/index.ts:390-391 | 一致 | — | |
| O-66 | queryCollector.js:91-127,158-215 | 从元数据自动收集搜索词：频道关键词、视频关键词、视频 hashtag；做 NFKC 归一、转小写、去掉 #；已存在的词（不区分大小写）不重复插入；新词排入质量评估批 | 新系统 B2 第 4 部分有自己的自动收集规则（至少两个频道支持等，见 b2/README.md） | 不适用（c 类，生产未开启） | queryCollector.test.js | |

### G. 遗留合约全量路径（processChannelCrawlV2，c 类，只做记录）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| O-67 | pipelineV2.js:1340-1492,466-474 | 频道资料多层回退：先 YouTube.js；缺标题、handle、订阅或描述，或描述以 …/... 结尾（被截断）时，补抓旧 HTML 头；仍缺就用 yt-dlp 元数据，再不行用 Data API channels.list；描述取较长的那个 | web-collector.ts:111-131（网页 About → 频道页不可用时按本国重查 → Data API 资料） | 不适用（生产路径是 youtubejs_full_v3，另见 About 审计） | pipelineAboutOnlyRouting.test.js | |
| O-68 | pipelineV2.js:1782-1813 | 复采已有频道（不是候选）时订阅未达门槛：频道改为 rejected，run 记为 skipped，不再扫上传 | — | 不适用（c；新系统的纳管频道更新时不重新判门槛） | — | |
| O-69 | channelRunBinding.js:259-306 | 同一频道的晋升 run 定稿之前，不能开始后续 run | store/index.ts:390-391（每个频道同时只允许一个活动计划） | 一致 | channelRunBinding.test.js | |
| O-70 | pipelineV2.js:1977-2045 | 扫描上传列表后，先把该频道所有 contents 的 is_recent 置为 false，再写入本次候选 | activities.ts:214-223（目标冻结） | 不适用 | — | |

### H. 断点修复、传输与存储

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| O-71 | businessRunBudgetRecovery.js:38-335；checkpointRepair.js:124-170；pipelineV2.js:3235-3302,2502-2504 | 业务 run 的 Rota 预算耗尽时：run 记为 failed，候选 failed，不再重试。之后开一个新的修复 run，只重置未完成的候选（queued/failed/running，以及访问状态为 unknown/login_required 的只分类候选），只用 YouTube.js 和 API 批继续采 | workflows.ts:425-426、activities.ts:112（到截止时间 → BUDGET_EXHAUSTED，计划失败）；store/index.ts:484-497（下一个计划冻结 recovery_video_ids，最多 100 个） | 不同（机制已被替换） | checkpointRepair.test.js；businessRunBudgetRecovery.test.js | 旧系统会重试 login_required；新系统在 WEB 和 IOS 都确认后把它当终态，不重试 |
| O-72 | ytdlpSession.js:413-425,493-604；scripts/ytdlp_session.py:897-930 | yt-dlp 会话：每个频道执行租用一个持久进程，绑定指纹档案（impersonate、UA、visitor_data、cookie、时区）和代理；强制指纹传输时不允许一次性直连；客户端顺序 web_safari→android | apps/execution-worker/src/youtube/fingerprint.ts（指纹网关，没有 yt-dlp） | 不适用（另见会话审计） | ytdlpSession.integration.test.js；ytdlpSessionCancellation.test.js | |
| O-73 | channelExecutionContext.js:143-151 | 一次频道执行内代理身份不能变：地址漂移就报 ProxyIdentityChangedError | web-collector.ts:25-70（每个视频单独租代理） | 不同（另见会话审计） | channelExecutionContext.test.js「rejects proxy address drift…」 | D7 |
| O-74 | storage.js:8-10,130-202；rawCompression.js:65-98 | 原始对象：HTML/JSON 超过 1 KB 就 gzip；视频 watch HTML 默认不保存（RAW_STORE_VIDEO_WATCH_HTML=false） | apps/execution-worker/src/raw-archive.ts（每个采集单元的全部响应都 gzip 后入 MinIO） | 不适用 | rawCompression.test.js | |
| O-75 | fullCrawlCanary.js:113-122 | canary 通道只接受迁移快照：reject_if_no_recent_content=true、crawl_mode=full、没有 query | — | 不适用（没有部署） | fullCrawlCanary.test.js | |

## 3 不同 / 缺失项按影响排序

| 名次 | 编号 | 状态 | 影响 | 说明 / 建议 |
|---|---|---|---|---|
| 1 | O-5、O-29 | 缺失 / 不同 | 交付错误数据 | 预告和正在进行的直播会被当成内容交付（排期时间写进 live_started_at）；Data API 只要有 liveStreamingDetails 就记为 live。应按旧规则在采集或交付时排除未结束的直播（D4） |
| 2 | O-2、O-3、O-43、O-49 | 不同 | 交付窗口语义 | 采集阶段没有 90 天截断，交付端 window_proof 写死为 complete；estimated 发布时间也能进窗口。需要用户决定是否恢复 90 天采集窗口（计划 :535）；交付端至少应只认 exact 发布时间，并给出真实的截止证明 |
| 3 | O-51–O-55、O-45 | 缺失 | 成本与 Agent 质量 | 休眠判定（90 天无发布或上传列表为空 → 不采详情、不跑 Agent、定稿 ready_partial）没有移植。用户已定恢复（D18）。必须连"证据不完整不能判休眠"（O-54）一起移植 |
| 4 | O-63 | 不同 | 错拒频道 | 订阅数只是没读到也按"隐藏"拒绝。旧系统只有 API 确认隐藏才拒绝，其余情况重试或报失败 |
| 5 | O-8、O-9、O-10、O-19、O-28 | 缺失 / 不同 | 字段覆盖率（D3/D15） | 点赞 0、评论关闭、评论 0（表层、预告）以及 Data API 无 commentCount 判关闭的规则都没有移植，大量字段记成 unresolved |
| 6 | O-25、O-15、O-16 | 不同 | 数据保留 | 新系统一个视频只用一个来源，入库时整条替换：已有视频变私密后，原有事实被不可用记录覆盖；不同来源之间也不按强弱合并 |
| 7 | O-22、O-24、O-13 | 不同 / 缺失 | 类型与会员内容（D6/D11） | 内容类型没有权威性检查；会员视频没有元数据，也没有播放数估算公式 |
| 8 | O-37、O-39、O-48 | 不同 | 完成语义 | 没有 ready_partial/ready_auto 之分；缺订阅数、初始观测不完整都不影响 COMPLETED。如果下游依赖质量标记，需要补上 |
| 9 | O-32 | 不同 | 运行连续性（D11） | Data API 配额用完时计划直接结束；旧系统延到次日继续 |
| 10 | O-40 | 不同 | Agent 国家（D14） | 旧系统用爬虫解析的国家覆盖 Agent 的 country；新系统只作为输入。待 Agent 审计确认 |
| 11 | O-71、O-73 | 不同 | 修复与身份（D7） | 断点修复改成了下一个计划补采（recovery targets），login_required 不再重试；一次执行内代理不再固定 |
| 12 | O-12、O-17、O-33、O-7 | 不同 | 低 | 直播时长状态、描述择优、多 key 轮换、详情并发 |
| — | O-20、O-21、O-31、O-57、O-61 | 不同（用户已确认） | — | API 兜底只在 3 次网页失败后才用；评论不用 Data API；搜索窗口和翻页规则按 B2。只记录在案，不建议回退 |

### 统计

- 文件：23 个（a 类 8、b 类 14、c 类 1）
  - pipelineV2.js 中的 processChannelCrawlV2，以及 youtube.js 中的部分函数，属于 c
  - fullCrawlCanary.js 记为 b/c，计入 b
- 规则：75 条（O-1…O-75）
  - 一致 20（含"近似 / 语义相近 / 新系统更严"）
  - 不同 29（其中 5 条用户已确认：O-20、O-21、O-31、O-57、O-61）
  - 缺失 12
  - 不适用 14
