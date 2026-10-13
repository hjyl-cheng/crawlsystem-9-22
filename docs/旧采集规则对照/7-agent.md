# 7 · Agent（频道画像）输入、策略与输出 —— 旧规则清单与新系统对照

审计日期 2026-10-13。只读审计，未改动任何仓库、数据库或存储。

路径缩写：
- `L/` = `/home/ubuntu/workspace/oldsystem/services/qybullmq/src/`
- `LT/` = `/home/ubuntu/workspace/oldsystem/services/qybullmq/test/`
- `LA/` = `/home/ubuntu/workspace/oldsystem/services/local-agent/src/qy_channel_profile/`
- `LAT/` = `/home/ubuntu/workspace/oldsystem/services/local-agent/tests/`
- `N/` = `/home/ubuntu/workspace/crawlsystem-business/`
- `NP/` = `N/apps/profile-agent/`（`NP/qy_channel_profile/` 下除 `contracts.py`、`processor.py` 外的推理模块与 `LA/` 逐字节相同；这两个文件的差异只在于放开了 NEWEST_FIRST 评论页，见 A-24）

背景：旧系统**自动执行只允许 local-offline 配置**（`L/agentExecutionPolicy.js:21-36`），即与新系统相同的 Python 模型（qy_channel_profile）。外部 LLM 路径（llmAgent.js、agentConfig.js 中的 Prompt、agentIdentityContext.js）只在 `external_agent_opt_in=true` 时启用。新系统没有外部 LLM，因此这些规则统一标为“不适用”，但仍逐条列出，供“是否保留外部 LLM 选项”这一决策参考。

状态含义：**一致** = 规则已等价移植；**不同** = 有实现，但行为不同；**缺失** = 没有对应实现；**不适用** = 架构不同，规则失去意义（备注写明原因）。

---

## 一、触发、资格与跳过

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| A-1 | L/agentExecutionPolicy.js:21-36 | 自动执行必须使用已启用的 `provider=local-offline` 配置；队列里残留的旧外部配置 ID 会被忽略 | N/apps/execution-worker/src/activities.ts:281（没有 profiler 时报 DEPENDENCY_NOT_IMPLEMENTED，不可重试）；main.ts:86 | 一致 | LT/agentExecutionPolicy.test.js「automatic jobs use local offline config even when an old Grok config ID is queued」 | 新系统只有本地模型 |
| A-2 | L/agentExecutionPolicy.js:17-30 | 只有 `job.data.external_agent_opt_in===true` 且配置为非 local 时才走外部 LLM，否则报错 | — | 不适用 | LT/agentExecutionPolicy.test.js「external Agent execution requires an explicit opt-in marker and config」 | 新系统没有外部 LLM 通道；是否保留人工 opt-in 需要决策 |
| A-3 | L/llmAgent.js:643-644 | `provider='rules'`（默认占位配置）或频道列表为空时，整批 skipped | — | 不适用 | — | 没有配置表 |
| A-4 | L/agentBatchDispatch.js:84-99,117-130 | 派发资格：`ready_for_agent=true`、`agent_status IN (pending,failed)`、`status='active'`、标题非空、`subscriber_count IS NOT NULL`、`agent_next_retry_at` 已到期、没有进行中的增量刷新请求、不处于迁移重试 | N/apps/execution-worker/src/workflows.ts:40-44（同一计划内 ABOUT、VIDEO 完成后立即执行 AGENT）；N/packages/store/src/index.ts:1156-1158 | 不同 | LT/controllerAgentRefreshConflict.test.js「Full Crawl Agent dispatch ignores terminal incremental refresh failures」 | 各子条件拆在 A-5～A-10 |
| A-5 | L/agentBatchDispatch.js:99,129,213 | **订阅数为空（隐藏订阅）的频道不派发 Agent** | N/packages/store/src/index.ts:844-847（只有带 discovery_qualification 的计划才检查订阅数；`override=true` 可以人工准入隐藏订阅频道）；agentInput 不检查订阅数 | 不同 | — | 新系统中，人工准入的隐藏订阅频道、导入或托管频道（无资格判定）都会跑 Agent，`subscriber_count=null` 时由模型的 complete_estimate 补值（active_subscriber_ratio 失去分母） |
| A-6 | L/agentBatchDispatch.js:98,128；L/pipelineV2.js:4307（只取 status='active'）；L/finalizePolicy.js:201 | 只有 active 频道跑 Agent；dormant 频道不派发，Finalize 时不等 Agent，直接 ready_partial | N/packages/contracts/src/index.ts:298（只有 managed/paused/removed，没有 dormant 状态） | 不同 | — | 新系统没有 dormant 概念，休眠频道到期仍会跑 Agent；与休眠组的结论联动 |
| A-7 | L/agentBatchDispatch.js:99,130 | 标题为空不派发 | N/packages/contracts/src/index.ts:45（ChannelFactsSchema 要求 title.min(1)） | 一致 | — | |
| A-8 | L/pipelineV2.js:1782-1790；L/fullCrawlAgentState.js:46-47 | 订阅门槛未通过：`ready_for_agent=false`，`agent_status` 置为 skipped（已是 done 的保留） | N/packages/store/src/index.ts:858-862（计划 CANCELLED，后续不再采集视频和画像） | 一致 | LT/fullCrawlAgentState.test.js「Full Crawl preserves done only for current publication Agent metadata」 | |
| A-9 | L/pipelineV2.js:1611-1613,1696,1702-1705 | `reject_if_no_recent_content=true` 的候选频道 `readyForAgent=false`（不跑 Agent） | — | 缺失 | — | 新系统没有“无近期内容就拒绝或不跑 Agent”的分支（discovery 组也应记一条） |
| A-10 | L/fullCrawlAgentState.js:12-53 | 重跑全量采集时，若已有有效的当前画像（success，basic 模式，model/config 非空；local 时 prompt 字段为 null 且 variant=local_offline；`input_content_ids` 非 null，`input_content_hash` 与 `agent_version_hash` 符合 sha256 格式，taxonomy 等于当前版本），保留 done 不重跑；否则置为 pending（或 skipped） | N/apps/execution-worker/src/activities.ts:280（只在本计划 AGENT 已 APPLIED 时跳过） | 不同 | LT/fullCrawlAgentState.test.js 三个用例 | 新系统每个包含 AGENT 的计划都会重新推理（本地推理成本低，影响小）；taxonomy 升级强制重跑的机制也随之消失 |
| A-11 | L/pipelineV2.js:4357-4373 | 批内已 done 的频道不重跑，只补发 Finalize（agent-already-complete） | N/apps/execution-worker/src/activities.ts:280 | 一致 | — | 计划级等价 |
| A-12 | L/pipelineV2.js:4312-4322,4323-4356 | 全量 Agent 必须有 `latest_run_id`（运行围栏），否则 skipped（full_agent_run_fence_required）；另有迁移重试围栏 | N/packages/store/src/index.ts:682-685（execution_epoch 加 input_hash 校验）；index.ts:1161-1167（r3 路径锁加内容哈希） | 一致 | LT/pipelineAgentWriterTransaction.test.js「a migration recovery Agent leaves Finalize dispatch to the fenced reconciler」 | 迁移围栏不适用 |
| A-13 | L/incrementalAgent.js:1-21；L/incrementalAgentBacklog.js:33-72 | 增量 Agent 请求按 plan 登记；频道非 active 时跳过（channel_inactive）；同一 plan 绑定到其他频道或 Run 时抛 AgentRefreshConflict | N/packages/store/src/index.ts:386-391（只有 managed 频道可更新；同一频道已有活动计划时不再建计划） | 一致 | LT/incrementalAgentBacklog.test.js 三个用例；LT/controllerAgentRefreshConflict.test.js | |
| A-14 | L/incrementalAgentResultStore.js:142-172；L/pipelineV2.js:4375-4380 | 增量 Agent 一律 `force_refresh`，即使已 done 也重新推理 | N/packages/store/src/index.ts:396-403（到期的 AGENT 时钟会建 UPDATE 计划，必定重新推理） | 一致 | LT/incrementalAgentEventPayload.test.js「Agent running state is written through a Publication writer transaction」 | |
| A-15 | 旧派发不检查视频详情是否完成（L/agentBatchDispatch.js 只看 latest_run_id） | 旧 Agent 可能在视频详情未全部完成时读到不完整的 contents | N/packages/store/src/index.ts:1157-1158,682-683（ABOUT、VIDEO 未 APPLIED 时拒绝提供 Agent 输入或接收提交） | 不同 | — | 新系统更严格（良性） |

## 二、输入：哪些视频、评论、文本，各多少

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| A-16 | LA/snapshot_repository.py:251-281；L/localOfflineProfileExecutor.js:187-188；LA/cli.py:346 | 内容集合：频道**全部已存** contents 中 `content_type IN (video,short,live)`，按 `published_at DESC NULLS LAST, position ASC NULLS LAST, source_content_id` 排序后取前 N 条；N=`LOCAL_PROFILE_CONTENT_LIMIT`，默认 30，范围 1-100 | N/packages/store/src/index.ts:1136-1139（首采：本计划冻结的 VIDEO 目标，即最新 30 条上传；UPDATE 含 VIDEO：库内最新 `video_limit` 条，按 published_at 降序再按 video_id；仅 AGENT 的更新：创建时冻结的 `agent_video_ids`，index.ts:401-403）；contracts index.ts:127-130（video_limit 默认 30，最大 100） | 不同 | — | 数量一致（30）。差异：①首采只看本计划的目标，不含历史 contents；②同时间并列时没有 position 次序；③index.ts:402 按文本 `data->>'published_at'` 排序，而 1137 按 timestamptz 排序，两处不一致 |
| A-17 | （旧 contents 表中没有不可用占位） | 不可用视频不进入画像 | N/packages/store/src/index.ts:1145（过滤 isVideoUnavailable） | 一致 | — | |
| A-18 | LA/snapshot_repository.py:67-102 | 每条内容传入：标题、描述、description_status/source、缩略图、keywords、hashtags、发布时间及其状态/来源/精度、first_seen_at、view/like/comment 计数及状态和来源、comments_disabled、时长、extractor_version | NP/profile_agent/adapter.py:66-96 | 不同 | — | 偏差：description_status 只推成 exact/empty（77）；**description_source 错取了 published_at_source**（78）；first_seen_at 恒为 None（86）。这些字段只影响快照哈希，以及无发布时间内容的 observed_at 回退（creator_evidence.py:351、comment_features.py:393 回退到 as_of），影响低 |
| A-19 | LA/snapshot_repository.py:42-64 | 频道字段：url、handle、title、country、country_source、country_code、**country_canonical_name**、avatar、summary、keywords、about_description、joined_at、external_links、is_verified、订阅/播放/视频数、channel_extractor | NP/profile_agent/adapter.py:44-64 | 不同 | — | country_canonical_name 恒为 None（52），见 A-37；web 抓取路径的 summary 和 is_verified 恒为 null（N/apps/execution-worker/src/youtube/web-scrape.ts:58,65），旧系统 summary（权重 2.5）会作为文本单元参与 |
| A-20 | LA/text_features.py:32-67 | 文本单元与截断：频道标题 300 / handle 100 / summary 1500 / About 5000 / keywords 2500；每条内容标题 400、描述 1500、keywords+hashtags 1500；近期权重 `max(0.35, 0.5^(age/180))`；去重；少于 3 字符丢弃 | NP/qy_channel_profile/text_features.py（逐字节相同） | 一致 | LAT/test_features.py | |
| A-21 | LA/snapshot_repository.py:99-101,140；LA/contracts.py:166-167 | 评论：默认包含每条内容的首页 Top 评论 `comments_first_page`，来自 PG 当前投影 | N/packages/store/src/index.ts:1148-1150（从对象存储按 `comments_ref` 回填，4 条并发）；contracts index.ts:128-130（comments_per_video 默认 20） | 不同 | LAT/test_comment_integration.py | 对象过期时 loadComments 返回 null，Agent 静默失去评论证据（见 videoComments 的 EXPIRED 语义，index.ts:889-896）；回填异常会让整个 agentInput 失败 |
| A-22 | LA/creator_evidence.py:357-362 | 频道主本人评论（is_channel_owner）作为创作者身份证据 | NP/qy_channel_profile/creator_evidence.py（相同） | 一致 | LAT/test_processor.py「test_creator_evidence_is_extracted_once_per_analysis」 | |
| A-23 | LA/comment_features.py:469,513,549 | 受众评论排除频道主；单作者文本上限 3000/1000 字符 | NP/qy_channel_profile/comment_features.py（相同） | 一致 | LAT/test_comment_features.py | |
| A-24 | LA/contracts.py:166-167 | 评论页 sort 必须是 TOP_COMMENTS，否则视为非法 | NP/qy_channel_profile/contracts.py:166-167；processor.py:92-102（接受 NEWEST_FIRST，诊断码改为 FIRST_PAGE_COMMENTS_SAMPLE_USED） | 不同 | — | 有意改动；冻结输入仍声明 comment_sort=TOP_COMMENTS（contracts index.ts:162） |
| A-25 | LA/runtime.py:19-53 | 非法评论页（格式错，或 collected_at 晚于 as_of）**只丢弃该页**，频道照常分析，并在 provenance.invalid_comment_pages 中记录 | NP/profile_agent/adapter.py:136-139（直接 ChannelSnapshot.from_mapping，没有净化，SnapshotError 返回 422 且不可重试） | 缺失 | LAT/test_runtime.py「test_invalid_comment_page_is_dropped_instead_of_failing_the_channel」 | TS 端 CommentPageSchema 先行校验，触发概率低，但一旦触发整个 Agent 不可重试地失败 |
| A-26 | LA/snapshot_repository.py:228-233 | 快照 as_of 取数据库事务时间 | NP/profile_agent/adapter.py:29-36,100（取输入中最新的 observed_at 或 collected_at） | 不同 | — | 有意改为确定性。近 30/90 天上传数、文本近期权重都按 as_of 计算，结果略有差异 |
| A-27 | LA/snapshot_repository.py:186-227 | 一致快照：REPEATABLE READ READ ONLY；statement_timeout 默认 60s（1-300）；校验数据库身份，拒绝迁移库 | N/packages/store/src/index.ts:1153-1171（r3 路径在事务内重算并比对内容哈希，写入 pipeline_agent_hash/snapshot） | 一致 | LAT/test_snapshot_repository.py「test_postgres_repository_freezes_one_read_only_snapshot」「…rejects_legacy_crawler_identity」 | 数据库身份守卫不适用（Agent 服务无库） |
| A-28 | LA/snapshot_repository.py:302-312 | provenance：data_lineage_version、comment_page_source_status、content_set_boundary=`repeatable_read_transaction_latest_30`、comments_included 等 | NP/profile_agent/adapter.py:101-104 | 不同 | — | 只有 lineage 和评论来源两项；仅进入快照哈希与诊断，影响低 |
| A-29 | LA/contracts.py:371-397 | 快照校验：内容 ID 不得重复；发布时间、first_seen、评论采集时间都不得晚于 as_of | 相同代码（NP/qy_channel_profile/contracts.py） | 一致 | LAT/test_processor.py「test_snapshot_rejects_future_content」 | |
| A-30 | 旧系统对视频数没有下限 | 零视频也照常推理，complete_estimate 补全全部字段 | NP/tests/test_profile_agent.py「test_profile_without_videos_still_completes」 | 一致 | LAT/test_processor.py「test_complete_estimate_fills_sparse_hidden_statistics_channel」 | |
| A-31 | L/localOfflineProfileExecutor.js:200-209 | 子进程输出上限：stdout 64MB（≤256MB），stderr 2MB（≤16MB），超限 SIGKILL | NP/profile_agent/server.py:25,60-61（请求体超过 16MB 返回 413，为 0 返回 400） | 不同 | — | 形态不同，影响低 |
| A-32 | L/pipelineV2.js:4224-4264；L/agentIdentityContext.js:1-89 | （仅 LLM）第一方身份上下文：每个频道最新 8 条内容；About 截 800 字；最多 6 条视频，标题 160、描述 180；最多 4 条频道主评论，每条 120；空白折叠，超长加省略号 | — | 不适用 | LT/agentIdentityContext.test.js 三个用例；LT/llmAgentTransport.test.js「first-party identity …」两个用例 | 本地模型直接读完整快照（A-20、A-22） |
| A-33 | L/llmAgent.js:31-37,245-250,269-270 | （仅 LLM）把 crawler 内容 ID 上下文写入 Prompt | — | 不适用 | LT/llmAgentTransport.test.js「crawler Content identities become Prompt input only when explicitly supplied」 | |

## 三、国家与语言的规范化；爬取事实覆盖模型推测

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| A-34 | L/agentCountryPolicy.js:4-140 | About 国家规范化：A-Z 两位码枚举 Intl 英文名，弃用码映射到规范码；加别名表（Türkiye、Czech Republic、Viet Nam…）；NFKC，去零宽和双向控制字符，统一撇号，折叠空白，小写；去变音的折叠匹配；匹配不到时再加载全部 YouTube UI 语言的本地化国名；**只接受唯一匹配**。输出 `{raw, code, name(英文)}` | — | 缺失 | LT/agentCountryPolicy.test.js「YouTube locale country labels round-trip to one canonical country」「deprecated region aliases do not make canonical country names ambiguous」「crawler country normalization treats blank text as missing」 | 新系统原样保存 pt-BR 本地化国名（web-scrape.ts:59；map.ts:66-68），country_code 只能来自 Data API snippet.country（web 路径为 null，region.ts:32-35 可能补上） |
| A-35 | L/agentCountryPolicy.js:147-157；L/pipelineV2.js:1494-1497；L/fullCrawlYoutubeJsFactory.js:102-105 | About 中出现**无法识别的本地化国名时抛 ParserContractError**（采集失败，不允许绕过 Agent 或带着脏国名继续） | — | 缺失 | LT/agentCountryPolicy.test.js「an observed but unknown About country fails instead of bypassing Agent」 | |
| A-36 | L/agentCountryPolicy.js:159-170 | 爬取国家视为“已确定”的条件：`country_code` 是两位码（或能规范化出码）**并且** `country_source==='youtube_about'` | — | 缺失 | LT/agentCountryPolicy.test.js「only a nonblank YouTube About country bypasses Agent country lookup」 | 新系统的 country_source 取值为 `youtubei:about` 或 `data_api:snippet.country`，没有任何“已确定国家”的判定 |
| A-37 | LA/snapshot_repository.py:49-52；LA/analyzers.py:137-146,274-336 | 模型输入的国家用 **`country_canonical_name`（英文规范名）优先，其次 country**，同时传 ISO 码；国名和码都存在且矛盾时降为 weak（complete 模式）或弃权（evidence-first） | NP/profile_agent/adapter.py:49-52（canonical 恒为 None，country 为本地化文本） | 不同 | LAT/test_country_precision.py「test_explicit_localized_country_is_normalized_to_english」（只覆盖 Brasil）「test_conflicting_structured_country_fields_are_not_treated_as_fact」 | **高影响**。analyzers.py 的别名表只认少数西语/葡语名，“Índia”“França”等原样输出为 country 值；有 ISO 码时走结构冲突分支（值仍是“Índia”，weak，confidence 降为 low） |
| A-38 | LA/analyzers.py:1958-1972 | 受众地区：创作者国家按证据强度并入“国家×语言”联合分布，**要求国家名与先验目录（英文）一致** | NP/qy_channel_profile/analyzers.py（相同代码），输入的国名不同 | 不同 | LAT/test_comment_integration.py「test_comments_shift_audience_marginals_but_keep_valid_totals」 | **高影响**。本地化国名与目录英文名各占一项，出现“França”+“France”重复；agent_contract.py:81-82 的 casefold 去重拦不住 |
| A-39 | LA/analyzers.py:149-157；LA/processor.py:113 | 语言识别不足时，按国家推主语言作为 creator_language 的回退 | 相同代码，输入的国名不同 | 不同 | LAT/test_country_precision.py「test_missing_country_does_not_default_sparse_language_to_english」 | 国名为“Índia”“Alemanha”等时查表失败，回退失效，稀疏频道的语言准确性下降 |
| A-40 | L/pipelineV2.js:4612-4626,4838-4842 | Finalize 用**爬取国家覆盖 Agent 的 country 事实**：value、country_code、canonical_name，source=crawler，confidence=high，evidence=["YouTube About country field"]（仅当 A-36 成立时） | N/packages/store/src/publication-map.ts:30-34（facts 原样发布） | 缺失 | — | 旧系统发布的 Agent country 来自模型（输入为英文规范名），finalized profile 中被爬取事实覆盖。新系统既没有覆盖，模型输入也没有规范化 |
| A-41 | L/pipelineV2.js:4787-4793 | 爬取国家已确定时，country 不计入“缺失 Agent 字段” | N/packages/contracts/src/index.ts:110（country 总是必填） | 不同 | — | 本地模型总会输出 country，影响低 |
| A-42 | L/localOfflineProfileExecutor.js:343；L/pipelineV2.js:4405-4409,4457-4459 | 本地路径 `country_required=false`，`prompt_variant='local_offline'` | N/packages/store/src/publication-map.ts:33（prompt_variant=null） | 不同 | LT/agentPublicationCurrent.test.js「a complete local profile publishes without fabricated Prompt metadata」 | 见 A-75 |
| A-43 | L/llmAgent.js:192-230,232-277,535-555,645-651 | （仅 LLM）country_required/resolved 分组 Prompt 与覆盖段；已确定国家时直接拷贝 crawler 值（source=crawler，confidence high），缺国家时绝不默认 Brazil | — | 不适用 | LT/llmAgentTransport.test.js「mixed country requirements stay in one prompt with per-URL rules」「missing agent country is never replaced with Brazil」「Agent accepts an omitted country when About already resolved it」 | |
| A-44 | LA/analyzers.py:337-431 | 无显式国家时：公开信号（自述所在地、电话区号、国家域名、货币）加权；决定性组合不足时走语言市场先验（forced_for_legacy_completeness） | 相同代码 | 一致 | LAT/test_country_precision.py 其余 8 个用例 | |
| A-45 | LA/agent_contract.py:14-26,94-96,111-113 | country 及 audience_region 前五项不得为 global、worldwide、other 或洲名 | 相同代码 | 一致 | LAT/test_agent_contract.py「test_validator_rejects_each_structural_invariant」 | |

## 四、模型输出校验与 unknown/低置信处理

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| A-46 | LA/runtime.py:100-105,155-160 | 运行时只接受 `complete_estimate` 策略 | NP/profile_agent/adapter.py:141 | 一致 | LAT/test_runtime.py「test_runtime_batch_emits_agent_payloads」 | |
| A-47 | L/localOfflineProfileExecutor.js:85-91；LA/agent_contract.py:226-236 | 任一字段为 None 或 abstained 时报错，**绝不提交不完整画像** | NP/profile_agent/adapter.py:143-147（返回 422） | 一致 | LT/localOfflineProfileExecutor.test.js「local executor sends only Channel IDs and maps evidence-rich local output」 | |
| A-48 | L/localOfflineProfileExecutor.js:102-129 | 运行结果校验：channel_id、input_url 非空且与 analysis_result 一致；analysis_status 必须为 completed_with_estimates；兼容 payload 与 facts 十个字段逐一相等；input_content_ids 必须是数组 | NP/profile_agent/adapter.py:142-159（直接取 payload 值）；N/packages/store/src/index.ts:685（payload.channel_id 必须等于计划频道） | 一致 | 同上 | input_content_ids 见 A-71 |
| A-49 | LA/agent_contract.py:88-184 | 严格结构：键集与顺序；禁止 ""/unknown/null/n/a/unavailable/uncertain；gender ∈ {male, female, brand_team}；age 为 0-120 的整数；region 恰好 6 项，末项为 Other，前五降序；age_gender 6 个固定段，合计 100；language 降序，Other 只能在末尾；tags 10 个、唯一、非泛词、属受控词表；top5 与前 5 个 tag 一致、末项为 Other、降序；categories 属同一 level_1 分支，level_2 为 1-3 个且唯一 | 相同代码（NP/qy_channel_profile/agent_contract.py） | 一致 | LAT/test_agent_contract.py 四个用例 | |
| A-50 | L/agentPublicationCurrent.js:276-424 | 发布就绪的二次校验（JS）：region 6 项且末项 Other、标签唯一（不分大小写）、合计 100；age_gender 顺序固定且合计 100；categories 在分类树内；tags 与 top5 对齐；confidence ∈ {low, medium, high}；evidence 非空；source_urls 可规范化且非空；reason 为 null 或非空；source 非空 | N/packages/contracts/src/index.ts:104-118（AgentFactsSchema） | 不同 | LT/agentPublicationCurrent.test.js「Agent Current rejects malformed distributions and taxonomy values」 | TS 契约更弱：region 和 language 允许 1-20 项，不要求末项 Other，标签不去重；categories 不对照分类树；tags 不与 top5 对齐；evidence 和 source_urls 可为空数组。目前全靠 Python 端把关，Store 与发布端没有兜底 |
| A-51 | L/localOfflineProfileExecutor.js:21-34 | 置信度 = min(model_confidence, evidence_confidence) 截断到 [0,1]；≥0.8 为 high，≥0.55 为 medium，其余 low | NP/profile_agent/adapter.py:108-110 | 一致 | LT/localOfflineProfileExecutor.test.js「local executor sends only Channel IDs and maps evidence-rich local output」 | |
| A-52 | L/localOfflineProfileExecutor.js:70-83 | evidence：evidence_refs 去重；为空时生成 “Local {field} estimate; source_type=…; truth_status=…; evidence_strength=…” | NP/profile_agent/adapter.py:113-117 | 一致 | 同上 | 新增每条截断到 1000 字符、最多 20 条 |
| A-53 | L/localOfflineProfileExecutor.js:95 | source = `local_profile:{source_type 或 estimate}` | NP/profile_agent/adapter.py:153 | 一致 | 同上 | 截断到 120 字符 |
| A-54 | L/localOfflineProfileExecutor.js:94 | reason 恒为 null | NP/profile_agent/adapter.py:158（非 observed 字段填 bundle 的 field_status） | 不同 | — | 有意改动，下游可读到“仅为估计”的原因；业务库若假设 reason 为 null 需要确认 |
| A-55 | L/localOfflineProfileExecutor.js:98 | source_urls = [input_url] | NP/profile_agent/adapter.py:156 | 一致 | — | |
| A-56 | L/llmAgent.js:198-200；LA/agent_contract.py:98-99 | **没有 unknown 状态**：gender 只有 male/female/brand_team（LLM 的 unknown 映射为 brand_team）；低置信度照常输出值，只靠 confidence 标签区分；本地路径从不输出 unknown | AgentFactsSchema 同样只有三值，confidence 为三档 | 一致 | LT/llmAgentTransport.test.js「new agent metrics preserve category hierarchy and brand-team gender」 | 已知问题“Agent 字段无 unknown 状态”**在旧系统中同样存在**，不是移植回退；若要引入 unknown 或弃权，需新定规则 |
| A-57 | L/localOfflineProfileExecutor.js:348-355 | 结果校验失败记为 invalid_local_result，不可重试 | N/apps/execution-worker/src/profile-client.ts:22-23（AgentProfileSchema 不通过时报 INTERNAL_ERROR，不可重试） | 一致 | — | |
| A-58 | LA/processor.py:39-281 | 推理流程与依赖顺序（language → categories → tags → gender → age → country → audience markets → age_gender → active ratio）；PROCESSOR_VERSION=agent-free-v0.7-identity-evidence；诊断码 UNVALIDATED_BOOTSTRAP_PRIOR、MODEL_BUNDLE_NOT_PRODUCTION_ELIGIBLE、APPROXIMATE_HISTORICAL_REPLAY、TOP_COMMENTS_SAMPLE_USED | NP/qy_channel_profile/processor.py（只有评论诊断码不同） | 一致 | LAT/test_processor.py 全部用例 | |
| A-59 | LA/model_bundle.py；LA/priors.py；catalogs/bootstrap_shadow_v1.json | 模型包逐个按 sha256 校验；先验目录 bootstrap_shadow_v1；可用 `--prior-catalog` 覆盖 | NP/qy_channel_profile（相同）；NP/model-manifest.json；server.py:91（启动时 warm_up 预加载） | 一致 | LAT/test_model_bundle.py | 新系统不能覆盖先验目录（只用内置默认），影响低 |
| A-60 | L/agentTaxonomy.js:1-99；L/publicationContract.js:7 | 分类树（19 个一级）与 taxonomy_version=qy-taxonomy-v1 | NP/qy_channel_profile/taxonomy.py（内容相同） | 一致 | LT/llmAgentTransport.test.js「channel categories enforce one level-1 branch」 | |
| A-61 | L/llmAgent.js:44-230 | （仅 LLM）归一化回退：百分比重排到 100、region 补齐 6 项、age_gender 默认 [8,14,10,7,4,7]、gender 回退 brand_team、age 回退 0、语言回退 Portuguese、活跃率回退 30、标签补齐（General Topic N）、扁平分类数组转树、默认 Uncategorized | — | 不适用 | LT/llmAgentTransport.test.js「default audience age and gender distribution totals 100 percent」等 | 本地模型不经过这些回退 |
| A-62 | L/llmAgent.js:523-555 | （仅 LLM）按 input_url 或位置对齐结果行；agentRowMissingFields 必填检查 | — | 不适用 | LT/llmAgentTransport.test.js「incomplete Agent output retries within the same batch before failing the Clock request」 | |

## 五、批处理、并发与超时

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| A-63 | L/localOfflineProfileExecutor.js:304-307；LA/runtime.py:162-169；LA/snapshot_repository.py:187-191 | 每次运行时调用 1-50 个去重后的频道 ID；请求只允许 channel_ids 一个字段 | NP/profile_agent/server.py（每次 POST 一个频道） | 不适用 | LAT/test_snapshot_repository.py「test_database_runtime_accepts_only_channel_ids_and_derives_url」「…request_contains_only_channel_ids」 | 新系统按计划逐频道推理 |
| A-64 | L/agentBatchDispatch.js:7-14,40,66,141-146,196-232；L/agentConfig.js:292,400 | 全量批大小 = 配置 batch_size（默认 `AGENT_BATCH_SIZE=30`，1-50）；不满一批时，只有该发现批次收尾（`agentTailReady`）才允许部分 flush，并记录 agent_tail_flushed_at | — | 不适用 | — | 没有批量 |
| A-65 | L/incrementalAgentBatchPolicy.js:5-40；L/incrementalAgentBacklog.js:74-158 | 增量批次：满 30 个频道立即派发；不满时，所有到期 Agent 计划都已登记则派发尾批，否则等待；计划状态不可得时退回 15 分钟静默窗；按频道而非请求计数（advisory lock 781137217） | — | 不适用 | LT/incrementalAgentBatchPolicy.test.js 五个用例；LT/incrementalAgentBacklog.test.js「Agent backlog sends the known Plan tail without waiting for the quiet window」 | |
| A-66 | L/agentDispatchPolicy.js:1-52；L/agentBatchDispatch.js:17-35 | 并发上限 = min(已注册 worker 数, 已启用配置的 max_workers 之和)；按占用率公平分配批次，每 tick 最多 100 批 | NP/profile_agent/server.py:93（单线程 HTTPServer，串行处理）；N/apps/execution-worker/src/profile-client.ts:9（60s 超时） | 不同 | LT/agentDispatchPolicy.test.js 五个用例 | 新系统调用方没有并发闸门。多个 worker 同时请求时在服务端排队，可能超过 60s 超时后反复重试（是否多副本需结合部署核实） |
| A-67 | L/localOfflineProfileExecutor.js:195-199 | 运行时超时：默认 10 分钟（`LOCAL_PROFILE_TIMEOUT_MS`，上限 60 分钟），超时 SIGKILL | N/apps/execution-worker/src/profile-client.ts:9（60s，与活动取消信号合并） | 不同 | — | 单频道推理很快，影响低（但与 A-66 叠加） |
| A-68 | LA/runtime.py:111-131,172-190；L/localOfflineProfileExecutor.js:323-357 | 单个频道失败不影响同批其他频道 | 天然按计划隔离 | 一致 | LT/localOfflineProfileExecutor.test.js「local executor keeps one channel failure isolated from successful channels」；LAT/test_runtime.py「test_one_bad_envelope_does_not_abort_the_batch」；LAT/test_snapshot_repository.py「…reports_missing_channels_without_aborting_batch」 | |
| A-69 | L/agentBatchSettlement.js:1-29；L/pipelineV2.js:4523-4535 | 全量批结算：有任一行失败则 throw（BullMQ 重试）；全部被围栏拒绝则 skip；否则 complete | — | 不适用 | LT/agentBatchSettlement.test.js 两个用例 | |
| A-70 | L/incrementalAgentBacklog.js:160-216；L/agentBatchDispatch.js:173-180 | 入队失败时释放认领（回到 pending，30s 后重试）；孤儿恢复：queued 超过 300s、running 超过 3900s 置为 failed，立即可重试 | Temporal 心跳与活动重试（workflows.ts:24-27） | 不适用 | LT/incrementalAgentBacklog.test.js「Incremental Agent Batcher releases only its claimed batch when BullMQ rejects it」 | |

## 六、版本与溯源（provenance）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| A-71 | LA/runtime.py:75；L/localOfflineProfileExecutor.js:345；L/agentPublicationCurrent.js:175-176 | **input_content_ids = 本次快照全部内容 ID**（去重、去空、按 UTF-8 字节排序），随画像持久化和发布 | N/packages/store/src/publication-map.ts:31-33（恒为 `[]`） | 缺失 | LT/agentPublicationCurrent.test.js「Agent publication run freezes exact config and canonical Content identity input」「an explicit empty Content input is valid and remains distinguishable from missing audit」 | 已知问题。r3 路径的输入快照已写入 `control.plans.pipeline_agent_snapshot`（index.ts:1168），可以由此恢复 ID；AgentResult 契约本身不含 ID |
| A-72 | L/agentPublicationCurrent.js:215,251,479-490 | input_content_hash = observationFactsHash(排序后的 ID 列表)，格式 `sha256:<hex>`，必须与 ID 列表一致 | N/packages/store/src/publication-map.ts:33（`hash([])` 常量） | 不同 | LT/agentPublicationCurrent.test.js「Agent Current binds persisted input, output and version hashes」 | 发布的是“空输入”的哈希，相当于虚假溯源。真实的 input_hash（含 plan_id）只放在 envelope 的 source.agent_input_hash（publication-map.ts:67） |
| A-73 | L/agentPublicationCurrent.js:180-239 | 本地 **agent_version_hash** = hash{executor_mode=local_offline, provider, model(runtime id), agent_config_id, processor_version, model_bundle_version, model_bundle_hash, prior_catalog_version, prior_catalog_hash, taxonomy_version} | N/packages/store/src/publication-map.ts:33（null） | 缺失 | LT/agentPublicationCurrent.test.js「local publication run has no Prompt dependency and binds the real runtime identity」 | LLM 变体（241-273，含 prompt_hash 与 tools）不适用 |
| A-74 | L/agentPublicationCurrent.js:184-214；L/pipelineV2.js:4469 | 本地运行身份完整性：model 必须等于 runtime_model_id；processor、bundle、prior 的版本和哈希必须齐全；两个哈希须为 `sha256:` 格式；运行时 taxonomy 必须等于期望值（环境变量 `AGENT_TAXONOMY_VERSION`，默认 qy-taxonomy-v1） | N/apps/execution-worker/src/activities.ts:288,303-304（只透传 taxonomy_version，不比对） | 缺失 | 同上 | |
| A-75 | L/agentPublicationCurrent.js:228-235,459,520-528；L/fullCrawlAgentState.js:27-32 | 本地画像元数据：agent_mode='basic'，prompt_template_id 和 prompt_hash 必须为 null，prompt_variant='local_offline'，agent_config_id 为正整数 | N/packages/store/src/publication-map.ts:33（agent_mode='local_model'，prompt_variant=null，agent_config_id=null） | 不同 | LT/agentPublicationCurrent.test.js「a complete local profile publishes without fabricated Prompt metadata」 | 需确认业务库与投影器能否接受这些取值 |
| A-76 | L/localOfflineProfileExecutor.js:56-68 | runtime_model_id = `qy-channel-profile:{processor}:{bundle}:{prior}:{taxonomy}`，四段都必须存在，否则报错 | NP/profile_agent/adapter.py:125-127（只有三段，不含 taxonomy） | 不同 | LT/localOfflineProfileExecutor.test.js「local runtime identity is deterministic and includes every inference catalog」 | 发布出去的 agent_model 字符串格式与旧系统不同 |
| A-77 | L/localOfflineProfileExecutor.js:131-155 | 持久化 profile_processing_context：executor、runtime_model_id、snapshot_as_of、snapshot_hash、input_content_hash、processor/bundle/taxonomy/prior 的版本、model_bundle_hash、prior_catalog_hash、diagnostics | N/apps/execution-worker/src/activities.ts:288,303-304（AgentResult 只保留 model_version、taxonomy_version、observed_at；profile-agent 返回的 diagnostics 被丢弃） | 缺失 | 同上 | 失去模型包和先验目录的哈希、快照哈希以及诊断（如 MODEL_BUNDLE_NOT_PRODUCTION_ELIGIBLE、评论样本使用） |
| A-78 | L/incrementalAgentResultStore.js:116；agent_profiles.current_output_hash | output_hash = observationFactsHash(整个 metrics_json，含处理上下文) | N/packages/store/src/publication-map.ts:33（hash(facts)） | 不同 | LT/agentPublicationCurrent.test.js「Agent Current binds persisted input, output and version hashes」 | 哈希口径不同（新系统只哈希 facts），跨系统比对时不可互换 |
| A-79 | L/agentPublicationCurrent.js:445-640 | 发布就绪检查：fact 完整、agent_mode、status=success、input_url 可规范化、output/input/version 哈希一致、canonical ID 列表、legacy 输入一致、配置一致、来源观测摘要（output/input/version hash）一致；有问题则 ready=false，不发布 | N/packages/store/src/publication.ts:25-35；publication-map.ts（没有 Agent 就绪检查） | 缺失 | LT/agentPublicationCurrent.test.js「Agent Current requires exact config and source Observation summary provenance」「a complete Agent Current produces the full deterministic publication payload」 | 发布组应有同名条目；本组只记录 Agent 侧的缺口 |
| A-80 | L/agentConfig.js:120-175,322-388 | （仅 LLM）Prompt 模板版本化：draft → publish（旧 active 归档），prompt_hash=sha256(模板) | — | 不适用 | — | |
| A-81 | L/incrementalAgentResultStore.js:174-232,327-484 | 成功时在一个写事务内完成：upsert agent_profiles（attempts+1，清空 error），频道置为 done，刷新请求置为 done，Run 的 domains.agent=complete，waiting_agent → done，记录 agent 观测后 reconcilePublication | N/packages/store/src/index.ts:682-715（写入 crawl_data.channels.agent，agent_revision 单调保护；AGENT 置为 APPLIED；计划完成后 queuePublication） | 一致 | LT/incrementalAgentEventPayload.test.js「full Agent success persists Profile and Channel in one writer transaction」「successful Agent persistence reconciles after its Observation is durable」；LT/pipelineAgentWriterTransaction.test.js「Agent result writes never bypass the Publication writer transaction」 | |
| A-82 | L/incrementalAgentResultStore.js:357-379 | 增量 Agent 观测：幂等键 `agent:{batch}:{channel}:attempt:{n}`；command 含 output_hash、input_content_hash、agent_version_hash；结果摘要含 fulfilled_plan_count、category_level_1、evidence_count 等 | N/packages/store/src/index.ts:1108（计划结算时 agentObservation） | 不同 | — | 摘要字段不同，见 A-83 |
| A-83 | L/incrementalAgentResultStore.js:61-140 | 时钟事件载荷：output_hash(metrics)、一二级分类、tag_count、evidence_count（**只数 evidence 数组**）、active_subscriber_ratio、topic_tokens（小写并折叠空白、排序、不截断）、evidence_fingerprints（逐条哈希、排序、≤256）、agent_version_hash（配置身份哈希） | N/packages/store/src/feature-clocks.ts:81-96 | 不同 | LT/incrementalAgentEventPayload.test.js「Agent event emits bounded identity signals instead of raw evidence」「Agent version hash is deterministic and changes with prompt metadata」 | 新系统：evidence_count 与指纹**把 source_urls 也算进去**；指纹不排序；topic 不折叠空白、不排序、截断到 128；version hash = sha256(model_version\0taxonomy)。这些会改变时钟的语义漂移和证据替换分数（时钟组联动） |

## 七、重试、退避与失败落库

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| A-84 | L/agentRetryPolicy.js:5-38 | 失败分类：401/403 认证错误，不可重试；429 限流、408/409/425、5xx、stale_snapshot、网络或超时类可重试；413 或上下文超长可拆批、不可重试；JSON 不完整或截断可重试且可拆批；其他为 permanent | N/apps/execution-worker/src/profile-client.ts:16-23（网络错误可重试；422 不可重试；其他非 2xx 可重试；契约不符不可重试） | 不同 | LT/agentRetryPolicy.test.js「agent transport and rate-limit failures never split a batch」「agent response-shape and context failures may split a batch」「native JSON parse failures split only the unresolved agent batch」 | 本地服务没有认证；413（请求体超过 16MB）在新系统中会被当作可重试 |
| A-85 | L/agentRetryPolicy.js:40-44 | 退避：base 1s × 2^(attempt-1)，上限 30s，再乘 (0.5+random) 抖动 | N/apps/execution-worker/src/workflows.ts:24-27（Temporal：初始 5s，×2，最大 2 分钟，最多 max(maxAttempts,5) 次；UPDATE 计划 maxAttempts=3，截止 120 分钟） | 不同 | LT/agentRetryPolicy.test.js「agent retry delay uses exponential jitter with a bounded deterministic value」 | |
| A-86 | L/localOfflineProfileExecutor.js:327-338 | 快照过期（运行期间 latest_run_id 已变化）时丢弃结果，记为可重试的 stale_snapshot | N/apps/execution-worker/src/activities.ts:298-312；index.ts:685（INPUT_MISMATCH 时重新读取输入并重新推理，最多 3 次） | 一致 | LT/localOfflineProfileExecutor.test.js「local executor discards a result when latest Channel Run changed」 | 新系统测试：N/apps/execution-worker/test/agent.test.ts「collectAgent re-reads and re-profiles…」 |
| A-87 | L/localOfflineProfileExecutor.js:284-287,320 | 快照不存在（SnapshotNotFound）不可重试；其他 Python 运行异常**可重试** | NP/profile_agent/server.py:68-77（InputError/ContractError/SnapshotError 返回 422，不可重试；其余返回 500，可重试）；index.ts:1142（频道事实缺失时报 DOMAIN_INCOMPLETE） | 不同 | — | 旧系统把 ContractError（如某字段弃权）当作可重试，数据更新后可能恢复；新系统同一计划内直接失败 |
| A-88 | L/incrementalAgentResultStore.js:234-282；L/agentBatchDispatch.js:87,96 | 全量失败：频道置为 failed，`agent_next_retry_at = now + min(3600, 30·2^min(attempts,7))` 秒，**无次数上限**，控制器到期后重新派发 | N/apps/execution-worker/src/workflows.ts:44-48（活动重试耗尽后计划失败或 DOMAIN_INCOMPLETE；之后只能靠时钟 partial_retry agent_days 或人工） | 不同 | LT/incrementalAgentEventPayload.test.js「full Agent failure persists Profile and Channel in one writer transaction」 | 首采失败后的自动恢复节奏不同 |
| A-89 | L/incrementalAgentResultStore.js:26-40,512-702；L/pipelineV2.js:251 | 增量失败处置：不可重试，或 attempts ≥ `INCREMENTAL_AGENT_MAX_ATTEMPTS`（默认 8，1-50）时为终态（next_retry 设为 infinity，Run 置为 failed，记录 agent_refresh_failed 观测）；可重试时请求退避 min(3600, 30·2^min(attempts,7)) 秒，Run 的 domains.agent 置为 retrying，**不发终态观测** | Temporal 活动重试加时钟 | 不同 | LT/incrementalAgentEventPayload.test.js「Agent failures remain internal retries until permanent failure or max attempts」「retryable Agent failure does not emit a terminal Observation」「retryable local failure does not fabricate Prompt metadata」 | |
| A-90 | L/incrementalAgentResultStore.js:234-282 | 失败落库：agent_profiles 置为 status=failed，metrics='{}'（新建时），attempts+1，记 error_message；local 路径的 prompt 字段为 null，variant=local_offline | N/apps/execution-worker/src/activities.ts:86（只记 ERROR 事件，并在原始存档留证据）；旧画像保留在 crawl_data.channels.agent | 不同 | 同上 | 注意：旧系统失败后当前画像 status 变为 failed，发布就绪检查判为 agent_current_not_success（A-79）；新系统继续发布上一次的成功画像 |
| A-91 | L/pipelineV2.js:4417-4441 | 整个运行时调用抛异常时，本批所有增量请求逐一记失败，再重新抛出 | — | 不适用 | — | |
| A-92 | L/llmAgent.js:470-496,557-633 | （仅 LLM）HTTP 重试 max_retries+1 次（≤5）；invalid_response 校验重试（≤4）；遇认证或限流时轮换 API key；可拆分错误对半拆批；未解析的行递归重试 | — | 不适用 | LT/llmAgentTransport.test.js「incomplete Agent output retries within the same batch before failing the Clock request」 | |

## 八、外部 LLM 传输与配置（全部仅 LLM）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| A-93 | L/llmAgent.js:279-311,454-461,498-521 | 端点推导（Gemini generateContent、chat/completions、responses）；Gemini 用 x-goog-api-key 并带 google_search 工具；温度 0.4 或 0.2，stream=false | — | 不适用 | LT/llmAgentTransport.test.js「Gemini base URLs become native generateContent endpoints」「Gemini requests use x-goog-api-key and Google Search tools」「chat completions explicitly disable streaming…」 | |
| A-94 | L/llmAgent.js:313-452 | 解析响应：各网关的文本字段；SSE 组装与错误事件；剥离代码围栏；取第一个完整 JSON 数组或对象 | — | 不适用 | LT/llmAgentTransport.test.js「ordinary OpenAI-compatible JSON…」「agent parser accepts the first complete JSON array…」「SSE chat completion deltas…」「HTTP 200 SSE error events…」 | |
| A-95 | L/llmAgent.js:232-277；L/agentConfig.js:9-118；L/agentPromptTemplate.txt | Prompt 构造：占位符替换、国家覆盖段、身份证据段（禁止从外貌或声音推断性别年龄）、逐 URL 对应 | — | 不适用 | LT/llmAgentTransport.test.js「canonical prompt injects the current batch…」；LT/agentIdentityContext.test.js「canonical prompt forbids appearance-based gender and age guesses」 | |
| A-96 | L/agentConfig.js:183-440；L/pipelineV2.js:598-624 | 配置管理：默认 rules 配置；batch_size 1-50，timeout 5s-3600s，max_retries 0-10；API key 与 base_url 从 settings 读取，缓存 30s；local 配置按 is_default 优先 | — | 不适用 | — | 新系统没有 agent_config_id，溯源字段为 null（A-75） |

## 九、Finalize 与发布衔接

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| A-97 | L/finalizePolicy.js:202；L/pipelineV2.js:4786-4810 | 没有 Agent，或缺必填 Agent 字段时为 pending_agent，不发布 | N/packages/store/src/publication.ts:25-26（没有 agent 时 required_data_not_finalized；计划未 COMPLETED 时 plan_not_completed） | 一致 | — | |
| A-98 | L/pipelineV2.js:4483-4490 | Agent 成功后用 source_latest_run_id 触发 Finalize（agent-complete） | N/packages/store/src/index.ts:709-715（计划完成时 queuePublication） | 一致 | LT/pipelineAgentWriterTransaction.test.js | |

---

## 统计

| 状态 | 条数 |
|---|---|
| 一致 | 34 |
| 不同 | 34 |
| 缺失 | 11 |
| 不适用 | 19 |
| 合计 | 98 |

## 不同/缺失条目（按影响排序）

1. **A-37 / A-38 / A-34 / A-35（高）国家未规范化就进模型。** 旧系统先把 About 国名规范化成 ISO 码和英文规范名，识别不了就让采集失败；模型读到的是英文规范名。新系统把 pt-BR 本地化国名（如“Índia”）直接交给模型，而 canonical_name 恒为 None。结果有三：country 事实输出葡语国名；有 ISO 码时落入结构冲突分支，变成 low 置信；受众地区出现“França”+“France”重复，Python 校验按 casefold 去重拦不住。修复方向：在采集或 Store 层移植 `canonicalizeCrawlerCountry`，向 adapter 传 `country_canonical_name` 和 `country_code`，未知国名按 A-35 让采集失败。
2. **A-40 / A-36（高）爬取国家没有覆盖模型。** 旧系统在 About 已确定国家（country_source=youtube_about 且有码）时，以爬取事实为准（source=crawler，confidence high）。新系统没有“已确定国家”的判定，也没有覆盖逻辑。
3. **A-71 / A-72（高）input_content_ids 恒为空，input_content_hash 是 hash([])。** 发布的溯源与真实输入不符（属虚假溯源）。数据可从 `control.plans.pipeline_agent_snapshot` 或 AgentInput.videos 恢复，需要在 AgentResult 中保留输入 ID。
4. **A-73 / A-74 / A-77（中高）版本溯源缺失。** agent_version_hash 为 null；模型包和先验目录的哈希、snapshot_hash、diagnostics 全部丢失；运行时 taxonomy 也不与期望值比对。模型或先验升级后，下游与时钟无法据此判断画像是否过期。
5. **A-50 / A-79（中）TS 契约与发布端校验弱于旧发布就绪检查。** region 不要求 6 项且末项为 Other，标签不去重，分类不对照分类树，evidence 和 source_urls 允许为空，也没有 Agent 就绪检查；目前全靠 Python 端把关。
6. **A-83 / A-82（中）时钟用的 Agent 事件载荷口径不同。** evidence_count、指纹、topic_tokens、version hash 的算法都变了，影响时钟的语义漂移和证据替换判断（需与时钟组联动核对）。
7. **A-5（中）隐藏订阅数的频道照样跑 Agent。** 旧派发要求 subscriber_count 非空；新系统在人工准入或无资格判定时会对 subscriber_count=null 的频道推理，活跃率等字段只能靠先验。
8. **A-88 / A-89 / A-85 / A-87（中）失败与重试语义不同。** 旧系统全量失败后无限期指数退避重派；增量最多 8 次，可重试失败不发终态观测。新系统依赖 Temporal 活动重试（最多约 5 次，截止 120 分钟），之后计划失败，ContractError 一律不重试。
9. **A-21（中）评论改从对象存储回填。** 对象过期时 Agent 静默失去评论证据，同一频道两次推理的输入可能不一致。
10. **A-66 / A-67（中，运维）profile-agent 是单线程 HTTPServer，调用方没有并发闸门，超时 60s。** 并发时可能排队超时并重复推理。
11. **A-39（中）国家推主语言的回退在本地化国名下失效。** 稀疏频道的 creator_language 准确性下降（与第 1 条同源）。
12. **A-9（中，跨组）缺少 reject_if_no_recent_content 不跑 Agent 的规则。**
13. **A-6（中低）没有 dormant 状态。** 休眠频道仍会按时钟跑 Agent；旧系统休眠频道不跑 Agent，Finalize 直接 ready_partial。
14. **A-25（中低）非法评论页会让整个 Agent 不可重试地失败**（旧系统只丢该页）。
15. **A-90（中低）失败后的画像状态不同。** 旧系统失败后当前画像变为 failed、不可发布；新系统继续发布上次成功的画像。需确认哪一种才是期望行为。
16. **A-75 / A-76 / A-78 / A-42（低中）发布元数据格式不同。** agent_mode=local_model（旧为 basic）、prompt_variant=null（旧为 local_offline）、agent_config_id=null、agent_model 少 taxonomy 段、output_hash 口径不同；需确认业务库投影是否兼容。
17. **A-16（低）内容集合细节不同。** 首采只看本计划目标；排序无 position 次序；Agent-only 更新用文本排序。
18. **A-19 / A-18 / A-28（低）输入字段偏差。** summary 和 is_verified 为空；description_source 错映射；first_seen_at 为空；provenance 不全。
19. **A-54（低）reason 不再恒为 null**（有意的改进，需确认下游兼容）。
20. **A-10 / A-15 / A-24 / A-26 / A-31 / A-41 / A-84（低）** 均为有意或良性差异：每次重跑都推理、等视频完成后再跑、接受 NEWEST_FIRST、as_of 改为确定性、请求体与输出上限形态不同、country 总是必填、HTTP 状态分类简化。

附注：新系统 Store 的 `agentInput`/`agentSnapshot`（N/packages/store/src/index.ts:1133-1171）**没有任何测试覆盖**；Agent 侧测试只有 N/apps/execution-worker/test/agent.test.ts 和 NP/tests/test_profile_agent.py，均未覆盖国家规范化、input_content_ids 和评论回填。
