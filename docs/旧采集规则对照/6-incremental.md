# 6 增量更新编排与规则清单（旧系统 → 新系统）

审计范围：旧 `services/qybullmq/src` 的 incrementalYoutubeJsVideo.js（全文 3,815 行）、incrementalChannelRunner.js、incrementalPlan.js、incrementalTerminalFailure.js、incrementalVideoExecution.js、videoExecutionRecovery.js、incrementalAgent.js、incrementalAbout.js、channelDormancy.js，以及这些文件直接依赖、承载业务规则的模块（incrementalVideoPlanner.js、incrementalVideoBatchPlan.js、incrementalVideoSnapshot.js、videoActivityLifecycle.js、videoDisposition.js、collectedVideoOutcome.js、contentEnrichPolicy.js、youtubeUploadsCountry.js、youtubeLoginRequired.js、channelLifecycle.js、incrementalRunStore.js、incrementalAgentBacklog.js、incrementalAgentBatchPolicy.js、incrementalVideoCapRecovery.js、incrementalPartialRecovery.js、incrementalChallengeRecovery.js、aboutMetrics.js、videoContentStore.js 的 refreshVideoContent），以及 `services/feature-engine`（policy.py、scheduler.py、applier.py、state.py、plan_status.py、clock_window.py、bootstrap.py、reference_data.py）和 `services/feature-dispatch`（dynamicDispatcher.js、dispatchTransport.js）中的时钟逻辑。

审计方式：只读。逐个函数读旧代码，再到新系统 `crawlsystem-business` 找对应实现。新 feature-clock 号称与旧 feature-engine 对齐（docs/m3），这里逐条核对过 decide.ts / engine.ts 与 policy.py / applier.py，没有直接采信。

## 路径缩写

旧系统（前缀 `/home/ubuntu/workspace/oldsystem/services/`）

| 缩写 | 文件 |
| --- | --- |
| IYV | qybullmq/src/incrementalYoutubeJsVideo.js |
| ICR | qybullmq/src/incrementalChannelRunner.js |
| IPL | qybullmq/src/incrementalPlan.js |
| ITF | qybullmq/src/incrementalTerminalFailure.js |
| IVE | qybullmq/src/incrementalVideoExecution.js |
| VER | qybullmq/src/videoExecutionRecovery.js |
| IAG | qybullmq/src/incrementalAgent.js |
| IAB | qybullmq/src/incrementalAbout.js |
| CDM | qybullmq/src/channelDormancy.js |
| IVP | qybullmq/src/incrementalVideoPlanner.js |
| IBP | qybullmq/src/incrementalVideoBatchPlan.js |
| IVS | qybullmq/src/incrementalVideoSnapshot.js |
| VAL | qybullmq/src/videoActivityLifecycle.js |
| VDI | qybullmq/src/videoDisposition.js |
| CVO | qybullmq/src/collectedVideoOutcome.js |
| CEP | qybullmq/src/contentEnrichPolicy.js |
| YUC | qybullmq/src/youtubeUploadsCountry.js |
| YLR | qybullmq/src/youtubeLoginRequired.js |
| CLC | qybullmq/src/channelLifecycle.js |
| IRS | qybullmq/src/incrementalRunStore.js |
| IABk | qybullmq/src/incrementalAgentBacklog.js |
| IABP | qybullmq/src/incrementalAgentBatchPolicy.js |
| CAP | qybullmq/src/incrementalVideoCapRecovery.js（BUG-035） |
| IPR | qybullmq/src/incrementalPartialRecovery.js |
| ICH | qybullmq/src/incrementalChallengeRecovery.js |
| ABM | qybullmq/src/aboutMetrics.js |
| VCS | qybullmq/src/videoContentStore.js |
| FE/pol | feature-engine/src/feature_engine/policy.py |
| FE/sch | feature-engine/src/feature_engine/scheduler.py |
| FE/app | feature-engine/src/feature_engine/applier.py |
| FE/st | feature-engine/src/feature_engine/state.py |
| FE/ps | feature-engine/src/feature_engine/plan_status.py |
| FE/cw | feature-engine/src/feature_engine/clock_window.py |
| FE/bs | feature-engine/src/feature_engine/bootstrap.py |
| FE/ref | feature-engine/src/feature_engine/reference_data.py |
| FD/dyn | feature-dispatch/src/dynamicDispatcher.js |
| FD/tr | feature-dispatch/src/dispatchTransport.js |

新系统（前缀 `/home/ubuntu/workspace/crawlsystem-business/`）

| 缩写 | 文件 |
| --- | --- |
| S | packages/store/src/index.ts |
| FC | packages/store/src/feature-clocks.ts |
| RS | packages/store/src/recent-sampling.ts |
| IR | packages/store/src/import-retry.ts |
| UB | packages/store/src/update-budget.ts |
| WK | packages/store/src/workers.ts |
| DEC | packages/feature-clock/src/decide.ts |
| ENG | packages/feature-clock/src/engine.ts |
| FST | packages/feature-clock/src/state.ts |
| POL | packages/feature-clock/src/policy.ts（及 clock_policy_v16_rule_7.json） |
| ACT | apps/execution-worker/src/activities.ts |
| WF | apps/execution-worker/src/workflows.ts |
| WC | apps/execution-worker/src/youtube/web-collector.ts |
| WS | apps/execution-worker/src/youtube/web-scrape.ts |
| DA | apps/execution-worker/src/youtube/data-api.ts |
| CRM | apps/execution-worker/src/youtube/channel-removal.ts |
| C | packages/contracts/src/index.ts |
| CK | packages/contracts/src/clocks.ts |
| DM | apps/control-api/src/dispatch-main.ts |
| SINK | apps/pg-sink/src/sink.ts |
| PAR | apps/raw-parser/src/parser.ts |

测试缩写：旧测试在 `qybullmq/test/`（简写 `T/`）和 `feature-engine/tests/`（简写 `FT/`）、`feature-dispatch/test/`（简写 `DT/`）。

状态说明：一致 = 业务效果相同（机制可以不同）；不同 = 新系统有对应实现但规则或数值不一样；缺失 = 新系统没有这条规则；不适用 = 规则只是旧系统的机制（BullMQ、Redis、围栏、检查点表等），新架构用别的方式保证或不需要，括号里写明原因。

---

## A. 计划组成与一轮更新的执行顺序

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| I-1 | IPL:149-156 | 一个增量计划带 About/Video/Agent 三个布尔任务位，三个全为 false 的计划非法 | S:401-403（`domains` 为空不建计划，手动更新报错） | 一致 | T/incrementalPlan.test.js「incremental Plan accepts only the frozen three-domain contract」 | 新系统用 required_domains 数组表达 |
| I-2 | IPL:175-183 | 计划模式只有 standard 与 dormant_probe；dormant_probe 只能是“仅 Video” | 无 | 缺失 | T/incrementalPlan.test.js「schema v5 accepts only a Video-only dormant probe」 | 新系统没有休眠频道，也就没有休眠探测计划（见 L 节） |
| I-3 | IPL:157-161, FE/sch:66-101 | 计划冻结容量：factor∈[0,1]、player_cap（默认 20）、next_cap（默认 8）；Video 的近期复查上限 = floor(player_cap×factor) | RS:8-17（playerCap 固定 20，factor 视为 1）；S:500-511 | 不同 | T/incrementalVideoPlanner.test.js「Recent Sampling obeys frozen capacity factor and hard caps」；FT/test_scheduler.py「test_capacity_factor_is_bounded」 | 新系统没有容量系数，上限写死 20；next_cap 因 M3-D3 不再使用 |
| I-4 | IPL:171-174 | scheduled_at 必须落在 plan_day（UTC）当天 | S:419-421（update_due_at = 最早到期时钟，created_at = now） | 不适用（新系统不按“计划日”冻结计划，计划在有空闲槽时即时创建） | T/incrementalPlan.test.js「schema v5 scheduled_at must stay inside plan_day UTC」 | |
| I-5 | IPL:115-132, 210-222 | 计划内容冻结、哈希固定；执行元数据（国家复查、API 续跑）不进哈希；队列名/任务名/任务 ID 必须匹配 | S:410-416（FrozenInput + input_hash）、S:366-370（request_id 同哈希幂等） | 一致（机制不同） | T/incrementalPlan.test.js「country recheck metadata survives retries without changing the frozen Plan」「incremental Job cannot arrive on the full-crawl queue」 | 队列/任务名校验属于 BullMQ 机制，不适用 |
| I-6 | IRS:43-128 | 同一 plan_id 重复领取：已 done/waiting_agent 直接返回终态；同 plan_id 不同哈希报冲突；其他状态恢复为 running 续跑 | S:366-370（同 request_id 不同哈希报 CONFLICT）；WF:17-18（已终态直接返回） | 一致 | T/incrementalRunStore.test.js「successful retry clears a previous failed detail status」 | |
| I-7 | IRS:59-71 | 只有频道状态匹配时才能建 Run：standard 要求 active；dormant_probe 要求 dormant（或旧 rejected+90 天无内容） | S:386-389（必须 management_state='managed'，paused/removed 不建） | 不同 | T/incrementalChannelRunner.test.js「dormant probe with no country reserve finishes without even opening a channel session」 | 新系统只有纳管/暂停/移出，没有 active/dormant 之分 |
| I-8 | ICR:12, 162-180 | 执行顺序固定：先 About，再 Video，最后 Agent | WF:30-47 | 一致 | T/incrementalChannelRunner.test.js「About Plan performs one About execution in one Channel session」 | |
| I-9 | ICR:114-144 | About 与 Video 共用一次频道会话（快照只打开一次，includeAbout 按任务位）；只有 Agent 的计划不打开 YouTube 会话 | WF:30-47、ACT:166-226（About 与 Video 分别采集；Agent-only 时 About/Video 活动直接跳过） | 一致（机制不同） | T/incrementalChannelRunner.test.js「Agent-only Plan registers one Channel without opening a YouTube session」 | 会话复用属于旧实现细节 |
| I-10 | ICR:14-16, 163 | 重试/续跑时，已 complete/partial/queued 的领域不重做 | ACT:170、ACT:280（领域已 APPLIED 跳过）；WC:98-108（原始单元 archive.reuse） | 一致 | T/incrementalChannelRunner.test.js「a resumed Run restores dormant lifecycle from the completed Video Domain」 | |
| I-11 | ICR:171-173 | 某领域返回 failed 观测时整个 Run 失败，不得记为完成 | WF:65-75、S:1090-1124（未 APPLIED 的领域记 failed，计划 FAILED） | 一致 | T/incrementalChannelRunner.test.js「a failed domain Observation fails the incremental Run instead of marking it complete」 | |
| I-12 | ICR:174-179 | 领域结果只有 complete 与 partial 两种“成功”；partial 不让 Run 失败 | FC:34-73（About/Video 观测可为 partial）；S:820-829（领域 APPLIED 即成功） | 一致 | T/incrementalChannelRunner.test.js「an incomplete Video Partial without lifecycle still queues an Agent due in the same Plan」 | 新系统领域只有 APPLIED/未 APPLIED，partial 只体现在送给时钟的观测里 |
| I-13 | ICR:182-207 | Agent 在 About/Video 都完成（含 partial）之后才登记 | S:819（AGENT 要等其他领域都 APPLIED）、WF:42-47 | 一致 | T/incrementalChannelRunner.test.js「Video executor receives the Crawler query dependency」 | |
| I-14 | ICR:197-199 | 同一计划里 Video 判定频道转入休眠时，跳过本计划的 Agent（记 skipped/channel_dormant） | 无 | 缺失 | T/incrementalChannelRunner.test.js「a Video transition to dormant skips an Agent due in the same Plan」 | 依赖休眠规则 |
| I-15 | ICR:184-196 | 续跑时从已完成 Video 领域或其观测恢复生命周期状态，用来决定是否跳过 Agent；Video partial 且没有生命周期时照常登记 Agent | 无 | 缺失 | T/incrementalChannelRunner.test.js「a historical resumed Run restores dormant lifecycle from its Video Observation」「a resumed Video Partial without lifecycle continues its pending Agent」 | 同上 |
| I-16 | ICR:208-209, IRS:151-174 | Agent 登记后 Run 进入 waiting_agent，Agent 完成才 done；Agent 被跳过则直接 done | WF:42-47（Agent 在同一工作流里执行，完成后计划 COMPLETED） | 一致（机制不同） | T/incrementalChannelRunner.test.js「Agent-only Plan registers one Channel without opening a YouTube session」 | |
| I-17 | ICR:219-228 | 国家复查交接、执行被取代、API 交接、等待安全恢复这几类异常不标记领域失败，原样抛出等重试 | WF:65-75（取消不制造失败）、S:792（STALE_EXECUTION） | 一致（机制不同） | T/incrementalChannelRunner.test.js「waiting recovery and superseded video executions cannot mark the current Plan failed」「API handoff preserves frozen incremental Plan and never marks its video domain failed」 | |
| I-18 | ICR:236-275 附近（incrementalDomainResult:36-38） | Video 预留清理延迟只记警告，Run 仍算成功 | 无对应概念 | 不适用（新系统没有内容补全任务的预留/租约） | T/incrementalChannelRunner.test.js「a deferred Video reservation cleanup keeps the Run successful and records the warning」 | |

## B. 时钟到期与每日调度

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| I-19 | FE/sch:175-213 | active 频道：到期日 ≤ 计划日且当天尚未覆盖的领域进入任务位；多个到期领域合并成一个计划（逾期与当天到期合并） | S:343-349、S:398-401 | 一致 | FT/test_scheduler.py「test_overdue_and_today_domains_are_coalesced」「test_due_days_create_an_unassigned_plan」 | |
| I-20 | FE/sch:194-200, 434-458 | 同一天已经由计划覆盖过的领域不再安排（失败的计划也算覆盖，取消的不算）；同日其他领域可补一个计划（plan_sequence 递增） | S:345-346、S:400（last_scheduled_at / last_attempt_at 早于当天 UTC 0 点才可安排） | 一致 | FT/test_scheduler.py「test_same_day_supplement_excludes_domains_already_planned」 | 新系统按每个时钟记录当天是否已安排/已尝试 |
| I-21 | FE/sch:467-481 | 一个频道同时只能有一个进行中的计划（planned/dispatching/dispatched/running） | S:347、S:390-391 | 一致 | FT/test_scheduler.py「test_due_days_create_an_unassigned_plan」 | |
| I-22 | FE/sch:184-192 | channel_next_run_day 必须等于三个时钟到期日的最小值（不变量） | ENG:227-229（nextRunDay 现算） | 一致 | FT/test_scheduler.py「test_channel_next_run_day_is_authoritative_and_validated」 | |
| I-23 | FE/sch:157-158 | removed 频道不能生成计划 | S:345（只扫 management_state='managed'）、S:1097（removed 的时钟不再改） | 一致 | FT/test_scheduler.py「test_removed_channel_cannot_build_a_daily_plan」 | |
| I-24 | FE/sch:159-172, 463-464, 491-494 | dormant 频道只在 dormant_recheck_day 到期时生成“仅 Video”的 dormant_probe 计划，当天已探测过则不再生成 | 无 | 缺失 | FT/test_scheduler.py「test_scheduler_selects_by_due_day_and_canary_channel」 | 见 L 节 |
| I-25 | FE/sch:496-500 | 选取顺序：到期日（休眠用复查日）→ dispatch_slot → channel_id | S:348（min(due_at) → channel_id） | 不同 | FT/test_scheduler.py「test_scheduler_selects_by_due_day_and_canary_channel」 | 新系统算了 dispatch_slot（ENG:59-61）但调度时没用它打散同日顺序 |
| I-26 | FE/sch:238-242 | 计划 ID = uuid5(日期:频道[:序号])，同日同频道稳定 | S:409（randomUUID） | 不适用（新系统用 request_id 和一频道一活动计划保证幂等） | FT/test_scheduler.py「test_plan_identity_is_stable_for_day_and_channel」 | |
| I-27 | FE/sch:519-534 | 新计划生成时，取消该频道更早计划日中还没派发的 planned 计划（superseded_by_daily_plan） | 无 | 不适用（新系统只在有空闲槽时才建计划，不会积压未派发的旧计划） | — | |
| I-28 | FE/sch:400-420 | 特征重算未结束时禁止调度 | 无 | 不适用（新系统没有批量重算任务） | FT/test_scheduler.py「test_scheduler_blocks_on_unresolved_recalculation」 | |
| I-29 | FE/cw:8-17, FE/sch:227, FD/dyn:66-71 | 派发时间窗：计划 eligible_at = 计划日 00:30 UTC，只在每天 00:30–21:30 UTC 之间派发 | DEC:25-27、FC:162（due_at = 当天 00:00 UTC）、DM:78-85（每 30 秒全天扫描） | 缺失 | DT/dynamicDispatcher.test.js「UTC dispatch window is half-open」「Dynamic Dispatcher does no telemetry or database work outside the safe window」 | 新系统全天派发，没有 21:30–00:30 的静默窗 |
| I-30 | FD/dyn:103-155 | 派发预算：按 Worker 数×2（上限 100）留缓冲，全量抓取积压时增量至少保留 25%；Agent-only 计划预留 25% 份额，Agent 积压目标 = 30×Agent 容量 | S:339-341、WK:82（有首采等待时更新只占一半槽位）、UB:9-16（Data API 日配额） | 不同 | DT/dynamicDispatcher.test.js「capacity budget accounts for shared Channel work and reserves Agent headroom」「large Full Crawl backlog cannot starve due incremental work」「PostgreSQL staging reserves Agent-only work then fills regular capacity」 | 新系统没有 Agent 专属份额；更新与首采按 1:1 分槽 |
| I-31 | FD/dyn:73-86 | 已延迟到将来的重试不占派发预算，到期的重试仍占 | 无 | 不适用（Temporal 活动重试不占计划槽位，计划在 RUNNING 期间一直占一个槽） | DT/dynamicDispatcher.test.js「26 future retries do not consume the dispatch budget of 25 incremental workers」 | |
| I-32 | FD/dyn:88-101 | 队列暂停或无 Worker 时不派发 | WK:72-80（只统计在线、接单的 Worker 容量） | 一致 | DT/dynamicDispatcher.test.js「paused or zero-worker incremental queue releases nothing」 | |
| I-33 | FD/dyn:250-268 | 派发信封至少要有一个任务位，否则拒绝 | S:401-403 | 一致 | DT/dynamicDispatcher.test.js「an empty three-Clock Plan cannot create a dispatch」 | |
| I-34 | FD/tr:236-237 | 增量任务最多 5 次尝试，指数退避 5 秒起、抖动 0.5 | WF:24-28（最多 max(3,5)=5 次，5 秒起、×2、上限 2 分钟） | 一致 | DT/dispatchTransport.test.js | 新系统另有计划截止 120 分钟（S:409） |
| I-35 | — | 失败的领域时钟不动，第二天由调度器再安排（按天重试） | S:1104-1108、S:345-346 | 一致 | FT/test_policy_tiers.py「test_failed_sampling_caps_the_single_video_clock」（间接） | 见 D 节 I-53 |
| I-36 | — | 每日更新计划受 Data API 预算约束，预算不足时时钟保持到期 | UB:17-19、S:404-405 | 不适用（旧系统走 Innertube 代理，不按 API 配额排队；新系统新增的约束） | — | 记录在案，非旧规则 |
| I-37 | FE/ref:270-287 | 时钟优先级信号：user_query_demand（带过期时间）、manual_priority 参与 collection_priority | FC:135、ENG:124（固定 NO_SIGNALS） | 缺失 | — | 新系统用“人工指定间隔”（S:1035-1048）替代人工优先级，但用户需求信号没有接入 |
| I-38 | — | 人工指定某个时钟固定间隔，覆盖算法；下次 = 上次成功日（无则今天）+ 天数 | S:1035-1048、FC:152-170 | 不适用（新系统新增功能，旧系统无对应） | — | 记录在案 |

## C. 时钟决策公式（policy.py → decide.ts）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| I-39 | FE/pol:14-27 | About 档位 {1,2,3,5,7,14,30,60,90,180}；冷启动节奏档 1.5→1、2.5→2、3.5→3、5.5→5；长间隔稳定门槛 (21天,3次,14)…(365,15,180) | DEC:15-18 | 一致 | FT/test_policy_tiers.py「test_every_about_tier_and_hard_cap」 | |
| I-40 | FE/pol:616-625 | About 优先级 = 0.40×订阅增长分位 + 0.35×播放增长分位 + 0.20×min(1, 视频增量/3) + 0.05×采集优先级；缺分位时用 0.5 并记原因 | DEC:85-89 | 一致 | FT/test_state_and_policy.py「test_baseline_uses_seven_day_fallback」 | |
| I-41 | FE/pol:650-657 | About 首次观测（baseline）：有可靠节奏用节奏档，否则 7 天 | DEC:92-94 | 一致 | FT/test_policy_tiers.py「test_cadence_baseline_uses_the_full_early_about_ladder」 | |
| I-42 | FE/pol:338-398 | 节奏档条件：发布间隔历史 ≥3 个用期望间隔，否则用 30/近 30 天视频数；最近发布 ≤7 天且置信度 ≥0.75；一档上限 1.0 天 | DEC:50-64、POL json（tier_one 1.0、max_publish_age 7.0） | 一致 | FT/test_policy_tiers.py「test_first_about_tier_requires_at_least_one_video_per_day」「test_cadence_baseline_prefers_reliable_intervals_over_recent_count」 | |
| I-43 | FE/pol:664-666 | 订阅或播放增长分位 ≥0.90 → 1 天 | DEC:95-97 | 一致 | FT/test_state_and_policy.py「test_critical_growth_maps_to_one_day」 | |
| I-44 | FE/pol:428-442 | 非首次：按优先级阈值 0.75/0.65/0.55/0.45/0.35/0.25/0.15/0.10/0.05 映射到 1/2/3/5/7/14/30/60/90 天，否则 180 | DEC:66-74、DEC:98-101 | 一致 | FT/test_policy_tiers.py「test_mature_policy_can_select_every_about_tier」 | |
| I-45 | FE/pol:686-688 | 非首次时 About 间隔不超过节奏档 | DEC:103-106 | 一致 | FT/test_policy_tiers.py「test_daily_publish_cadence_keeps_mature_about_clock_in_one_day_tier」 | |
| I-46 | FE/pol:690-692 | 视频数增加且近 30 天有发布 → About 间隔 ≤3 天 | DEC:107-110 | 一致 | FT/test_state_and_policy.py | |
| I-47 | FE/pol:445-450, 695-699 | 长间隔需同时满足稳定天数与稳定次数，否则封顶 7 天 | DEC:76-80、DEC:111-112 | 一致 | FT/test_policy_tiers.py「test_long_about_tiers_require_both_stable_time_and_runs」 | |
| I-48 | FE/pol:703-705 | About partial → 间隔 ≤3 天 | DEC:113 | 一致 | FT/test_state_and_policy.py「test_partial_result_is_capped_at_three_days」 | |
| I-49 | FE/pol:564-594 | About 变慢每次最多升一档，变快立即生效（首次观测不受限） | DEC:117-129、ENG:153 | 一致 | FT/test_policy_tiers.py「test_about_slowdown_moves_one_tier_but_acceleration_is_immediate」 | |
| I-50 | FE/pol:253-335, 641-648 | 节奏关闭时的旧冷启动优先级下限（0.75/0.55） | POL:283-289（拒绝加载关闭节奏的策略） | 不适用（v16-rule-7 开启了节奏与动态基线，这条路径不执行） | FT/test_policy_tiers.py「test_dynamic_baseline_maps_current_pressure_to_different_tiers」 | 若将来换策略需重评 |
| I-51 | FE/pol:778-850 | 新视频发现风险：无期望间隔用 7 天；规律频道（规律度 ≥0.65）在预测发布前 lead=min(7,max(1,ceil(0.2×期望))) 天检查；否则按沉默衰减 exp(-0.6×超期)、目标概率 0.20/0.35/0.60 求天数，空跑次数退避 ×(1+min(2,0.25×n))，映射到 {1,3,7,14,30,60,90} | DEC:135-174 | 一致 | FT/test_policy_tiers.py「test_every_discovery_tier_and_cap」；FT/test_v16_domain_state_and_policy.py「test_discovery_builds_publish_intervals_and_predicts_next_check」「test_elapsed_regular_publish_window_uses_silence_backoff」 | |
| I-52 | FE/pol:837-839 | 发现 partial → ≤3 天 | DEC:172 | 一致（公式）；但见 I-71 | FT/test_v16_domain_state_and_policy.py「test_partial_discovery_is_capped_at_three_days」 | 新系统实际不会产生 partial 的发现 |
| I-53 | FE/pol:853-909 | 近期复查风险：优先级 = 0.25 活跃 + 0.20 发布频率 + 0.25 变化概率 + 0.20 陈旧比 + 0.10 采集优先级；首次 14 天；近 30 天池为空 60 天；≥0.8/0.6/0.4/0.2 → 3/7/14/30，否则 60；partial ≤7 天 | DEC:176-191 | 一致 | FT/test_policy_tiers.py「test_every_recent_sampling_tier_and_cap」；FT/test_v16_domain_state_and_policy.py「test_first_recent_sampling_uses_fourteen_day_baseline」「test_partial_recent_sampling_is_capped_at_seven_days」 | |
| I-54 | FE/pol:932-949 | 近期复查 skipped 或 failed → 用 partial 重试天数（7） | DEC:199-202 | 一致 | FT/test_policy_tiers.py「test_failed_sampling_caps_the_single_video_clock」 | |
| I-55 | FE/pol:957-975 | Video 时钟取发现与复查中较短者，但不短于自动最小间隔 3 天 | DEC:203-208 | 一致 | FT/test_policy_tiers.py「test_automatic_video_clock_never_uses_the_one_day_risk_tier」「test_single_video_clock_uses_the_shorter_risk_interval」 | |
| I-56 | FE/pol:999-1026, 556-561 | Agent：首次/版本变化/无可比语义 → 180 天；否则 60+305×(1−变化)^1.8（四舍六入五成双） | DEC:240-254 | 一致 | FT/test_policy_tiers.py「test_agent_clock_calculates_a_continuous_semantic_interval」「test_agent_version_change_restarts_a_long_spread_baseline」；FT/test_v16_domain_state_and_policy.py「test_long_term_stable_agent_maps_to_365_days」 | |
| I-57 | FE/pol:473-541 | Agent 向后摊开：按间隔在锚点 {14:0,30:2,60:6,90:14,180:20,365:29} 插值得最大天数，sha256(策略:频道:间隔:版本) 取偏移，只往后推 | DEC:213-233、DEC:256-258 | 一致 | FT/test_policy_tiers.py「test_incremental_agent_due_uses_only_forward_stable_spread」「test_agent_forward_spread_is_repeatable_and_distributed」 | |
| I-58 | FE/pol:453-470 | 到期日 = 观测时间所在 UTC 日 + 间隔天数 | DEC:25-27 | 一致 | FT/test_state_and_policy.py「test_due_day_uses_the_utc_calendar_day」「test_late_observation_still_uses_its_utc_calendar_day」 | |
| I-59 | FE/pol:185-236 | 由已存特征状态整体重算三个时钟（rebuild） | S:1066-1088（重新纳管时从库内资料/视频/画像重放观测） | 不同 | FT/test_state_and_policy.py | 新系统重放的是事实而不是旧状态，结果可能不同 |

## D. 时钟应用（applier.py / state.py → engine.ts / feature-clocks.ts）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| I-60 | FE/app:589-597 | failed 观测（非频道移除）不改特征状态和时钟，只推进该类型的序号 | ENG:121-123、S:1104-1108 | 一致 | FT/test_v16_domain_state_and_policy.py | |
| I-61 | FE/app:1045-1110（_bootstrap_clocks） | 首个成功观测建立三个时钟：自身按决策，其余按基线（About 7、Video 7、Agent 180） | ENG:159-182 | 一致 | FT/test_state_and_policy.py「test_first_event_only_establishes_a_baseline」 | |
| I-62 | FE/app:1084-1097, 1221-1235 | About 发现视频数增加且近期活跃 → 把 Video 时钟拉到 3 天后（只提前不推后） | ENG:167-173、ENG:207-213 | 一致 | FT/test_policy_tiers.py | |
| I-63 | FE/app:954-1043 | 跨领域冷启动重算：另一类型只观测过 1 次时，用新状态按 baseline 重算，只在更早时才提前 | ENG:184-200 | 一致 | FT/test_policy_tiers.py「test_cold_start_uses_about_metric_confidence_not_a_later_domain」 | |
| I-64 | FE/app:192-194 | dispatch_slot = sha256(频道:dispatch) 前 8 字节 mod 1024 | ENG:59-61 | 一致（但未用于调度排序，见 I-25） | — | |
| I-65 | FE/st:430-512 | 发现阶段：只把上次完整发现之后发布的首见视频算新发布（早于的是回填，忽略）；间隔历史保留最近 32 个；完整发现且没有新发布 → 空跑 +1，有则清零；gap_abandoned 记原因 | FST:263-305 | 一致 | FT/test_v16_domain_state_and_policy.py「test_old_first_seen_id_is_treated_as_backfill_not_a_new_publication」「test_discovery_does_not_claim_empty_run_backoff_after_finding_video」「test_latest_30_gap_abandonment_advances_bounded_discovery_state」 | |
| I-66 | FE/st:515-598 | 复查阶段：failed 或乱序（不晚于上次）不改状态；播放变化率/互动变化率/上新变化 EWMA(0.4)；无可比播放时不衰减播放 EWMA | FST:309-344 | 一致 | FT/test_v16_domain_state_and_policy.py「test_recent_sampling_updates_change_probability_and_clock」「test_no_comparable_views_does_not_decay_view_change_ewma」 | |
| I-67 | FE/st:138-162（about），FE/app:182-227 | 乱序：较旧的观测不回退当前状态；部分指标保留各自观测时间 | FST:172-216 | 一致 | FT/test_state_and_policy.py「test_older_source_time_never_regresses_current_state」「test_partial_metrics_keep_independent_observation_times」 | |
| I-68 | ABM:76-110 | About 观测：三项计数都解析到才算 complete；拿到部分算 partial；没取到 About 算 failed | FC:33-45 | 一致 | T/aboutMetrics.test.js | |
| I-69 | ABM:129-136, IAB:15-35 | getAbout 失败但拿到频道身份 → 记 partial（get_about_failed_identity_current），About 时钟 ≤3 天 | WC:111-130（网页失败改用 Data API 频道记录，计数齐全时为 complete） | 不同 | T/incrementalAbout.test.js「a failed getAbout becomes one Partial About with identity Current and no metric snapshot」 | 新系统用 API 兜底，结果通常是 complete；兜底也失败则整计划失败、次日重试 |
| I-70 | FE/app:893-952 | Video 观测带生命周期：dormant → 时钟进入休眠、取消该频道进行中的计划；active → 清除休眠字段 | 无 | 缺失 | T/videoActivityLifecycle.test.js | 见 L 节 |
| I-71 | IYV:3403-3412, 3266-3327 | Video 观测 outcome：发现 complete 且复查 complete 才 complete；扫描不完整 → 发现 partial、复查 skipped；有阻塞的待定视频 → 发现 partial | FC:58-73（发现永远记 complete；首次采集复查记 skipped） | 不同 | T/incrementalVideo.test.js「an incomplete Uploads scan does not advance the incremental cursor」 | 新系统扫描不完整或个别视频失败时整计划失败（时钟不动、次日重试），不会产生“发现 partial ≤3 天”的决策 |
| I-72 | FE/ps:26-48 | 日计划状态：任一领域 failed → failed；未全部到齐 → running；有 partial → partial；否则 succeeded | S:830-836（全部 APPLIED 才 COMPLETED） | 不同 | — | 新系统计划没有“partial”状态，partial 只进时钟 |
| I-73 | FE/ref, FC:183-221 | 每天按 UTC 日生成一次参照分布并刷新所有频道的共享特征，不改时钟 | FC:183-221、DM:59-66 | 一致 | — | |
| I-74 | FE/bs:216-237, 924-979 | 批量导入旧频道时，把逾期时钟按频道哈希在 [1, 原间隔] 天内摊开（Agent 无观测时 60–90 天），避免同一天全部到期 | S:1066-1088（重新纳管只重放观测，不摊开） | 缺失 | FT/test_bootstrap_bundle.py | 若要把旧系统存量频道迁入并纳管，会出现同日集中到期 |

## E. About 执行

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| I-75 | IAB:15-18 | 增量 About 要求快照带 About（includeAbout），否则视为错误 | ACT:166-193 | 一致 | T/incrementalAbout.test.js「About execution carries identity fields in the same Current command」 | |
| I-76 | IAB:19-34 | About 观测带计划 ID、计划日、trigger=clock_due、scheduled_at、执行尝试 ID | S:416-419（plan_kind UPDATE、update_trigger SCHEDULED/MANUAL、update_due_at） | 一致（机制不同） | T/incrementalAbout.test.js | |
| I-77 | — | 频道国家来自 About（youtube_about），用于上传列表国家复查；不能用界面语言推断 | WC:132-148、WC:89-97（channelRegion + inRegion） | 一致 | T/youtubeUploadsCountry.test.js「explicit unavailable uploads enter Full Crawl country recheck and incremental empty scan」 | |

## F. 新视频发现（上传列表扫描、锚点、追赶上限）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| I-78 | IYV:499-549, IVP:85-98 | 锚点：优先用游标里保存的锚点（且库内有发布时间），没有游标时取最近 20 个已知视频（按发布时间倒序） | S:503-505（最近 20 个、发布时间非空、来自已完成计划的已知视频） | 一致（机制不同） | T/incrementalVideoPlanner.test.js「Video Discovery preserves the database order and requires a publication day」 | 新系统每次现算，不存游标 |
| I-79 | IYV:208-215, 3431-3433 | 发现完整后更新锚点：新扫到的在前、旧锚点在后，去重保留 20 个；不完整或空列表不更新 | S:503-505（下次从“已完成计划”的视频现算） | 一致（机制不同） | T/incrementalVideo.test.js「Video execution keeps its backup Anchor pool when a later Anchor closes Discovery」 | 新系统只采纳已完成计划写入的视频作锚点，未完成的不会误当锚点 |
| I-80 | IVP:28-39 | 发现最多 20 页；首屏之外追赶预算单独 50 个 | WS:90（20 页报错）、WS:87（扫满 100 个）、DA:11、DA:94-112（首页 50+追赶 50） | 不同 | T/incrementalVideoPlanner.test.js「Video Discovery gives Catch-up a separate 50-ID budget」 | 新系统网页扫描按累计 100 个判断，旧系统按“首屏 + 50” |
| I-81 | IYV:217-266 | 追赶放弃：追赶用尽 50 个、仍没遇到锚点、没有解析缺口、条目唯一、≥30 个 → 只保留最新 30 个，记 gap_abandoned_latest_30，视为完整 | WS:87、DA:111、C:177 | 不同 | T/incrementalVideo.test.js「Catch-up exhaustion classifies the latest 30 Videos in one discovery run」「Catch-up cannot abandon a gap before the configured budget is exhausted」 | 新系统没有“有解析缺口不得放弃”的条件；解析失败直接抛错 |
| I-82 | IYV:217-224, T/incrementalVideo.test.js:4077 | 追赶用尽但有解析缺口 → 保持 partial，不写内容 | WS:81（身份缺失抛 parse 错，整步重试） | 不同 | T/incrementalVideo.test.js「Catch-up exhaustion with parse gaps remains Partial and has no Content side effects」 | 新系统失败而不是 partial |
| I-83 | IYV:3585-3605 | 翻页出错：解析/内容终态类错误 → 扫描标记不完整（partial）；网络/代理类错误 → 抛出重试 | WS:70-92（classify 后抛出，活动重试） | 不同 | T/incrementalVideo.test.js「Video discovery also falls back when YouTube.js reports a pagination error」 | 新系统一律重试，不产出 partial |
| I-84 | IYV:1328-1342, VDI:118-130 | 扫描不完整时：新视频记 deferred（discovery_scan_incomplete，1 小时后重扫），不算首见、不推进游标 | 无 | 不同 | T/videoDisposition.test.js「an incomplete Uploads discovery defers the observed ID for a scan retry」；T/incrementalVideo.test.js「an incomplete Uploads scan does not advance the incremental cursor」 | 新系统扫描不完整即失败，不写任何视频 |
| I-85 | IYV:1352-1382 | 扫描到的已知视频：更新 playlist_last_seen_at、位置；上传列表的发布时间证据更强时覆盖库内发布时间 | 无 | 缺失 | T/incrementalVideo.test.js「Video execution deduplicates Contents and samples current Uploads dates in the same cycle」 | 影响较小 |
| I-86 | YUC:108-121 | 上传列表空响应必须有“播放列表为空”的明确提示才算真空；未知渲染/续页为空不算 | WC:143（首采空列表做国家复查）；增量（有锚点）空列表直接 list_end | 不同 | T/youtubeUploadsCountry.test.js「HTTP 200 without video nodes needs an explicit empty-playlist message」「an invalid item or a failed continuation never becomes normal empty uploads」 | 新系统增量模式不校验空响应真伪 |
| I-87 | YUC:26-58, ICR:117-133 | 真空列表/缺上传列表时按 About 国家复查：本国出口一致 → 确认；无该国代理 → no_country_reserve；复查用尽 → country_recheck_exhausted；结论是频道 dormant（uploads_empty） | WC:132-148（只在首采做国家复查，结论只是“空列表”） | 不同 | T/youtubeUploadsCountry.test.js「normal empty uploads settle dormant」「dormant country probes request a route before scanning, or stay dormant without reserve」 | 新系统没有 uploads_empty 休眠 |
| I-88 | IYV:3609-3611, IYV:2812-2834 | 扫描结果必须是带 entries 数组的对象，否则报错 | C:177-185（VideoDiscoveryManifestSchema） | 一致 | — | |
| I-89 | C:187-189 | （新增）恢复目标优先、合并后不超过 100 | C:187-189、ACT:206 | 不适用（新系统新增，见 I-104） | — | |

## G. 新视频的处置台账与按视频复查间隔

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| I-90 | IBP:65-68（checkpointItems） | 首见视频中正在直播或待开播的不取详情（除非是到期复查） | WS:107-137（直播/待开播照常取详情并入库，content_type=live） | 不同 | T/incrementalVideo.test.js「Video discovery does not persist an upcoming live before it starts」「Video discovery does not persist a live broadcast while it is in progress」 | |
| I-91 | VDI:92-103 | 待开播/直播中 → terminal_excluded，1 天后重查（直播重读） | 无 | 缺失 | T/videoDisposition.test.js「an upcoming Live terminal state takes precedence over otherwise storable evidence」；T/incrementalVideo.test.js「Video discovery honors an upcoming state first revealed by Player detail」 | 新系统直播结束后的时长、发布时间不会自动重读（只有近期复查读计数） |
| I-92 | VDI:104-117 | 超出内容窗口 → terminal_excluded，30 天后重查 | 无 | 缺失 | — | |
| I-93 | VDI:144-156, 49-52 | 私有/不可用 → terminal_excluded（access_*），7 天后低频重查 | WS:170（终态视频入库为 unavailable，不再重查） | 缺失 | T/incrementalVideo.test.js「Video discovery closes a private detail and schedules a low-frequency recheck」 | |
| I-94 | YLR:24-33, VDI:89-91 | “请登录”（WEB+IOS 两个客户端都返回）→ 永久排除（next_attempt_at=infinity），之后发现与复查都跳过 | WS:139-168（两个客户端都要求登录才判 login_required）、S:504（unavailable 视频不进复查） | 一致 | T/youtubeLoginRequired.test.js「repeated Please sign in is excluded without API or route failure」「permanent exclusions survive later discovery and low-frequency repair」 | |
| I-95 | YLR:5-14（test:84） | 登录排除可由人工给定有限重试时间解除 | 无 | 缺失 | T/youtubeLoginRequired.test.js「cached exclusion can be released by an explicit finite retry time」 | 低影响 |
| I-96 | VDI:157-170 | 取详情失败 → deferred（detail_collection_failed，1 小时后重试） | WC:150-200（网页 3 次后 Data API 兜底；仍失败整步抛错，计划重试/失败）；S:484-498（失败视频下次计划优先重采） | 不同 | T/incrementalVideo.test.js「First-Seen Video keeps an incomplete public detail open for Enrich」 | 新系统没有“按视频 1 小时后重试”，而是下一轮计划重采 |
| I-97 | VDI:185-197 | 类型证据不权威 → deferred（authoritative_type_unresolved，6 小时后重查） | WS:132-133（无法判断时默认 video，来源记 default:shorts_unknown，直接入库） | 不同 | T/incrementalVideo.test.js「Video discovery defers a public detail without authoritative type evidence」「Video discovery does not invent a video type when Watch detail collection fails」 | |
| I-98 | VDI:198-208 | 其他访问状态不可存 → deferred（access_*，6 小时后重查） | 无 | 缺失 | — | |
| I-99 | VDI:54-75, 239-240, 157-160 | 低频复查结论不确定时保留之前的终态结论，不降级为 deferred | 无 | 缺失 | T/videoDisposition.test.js「an inconclusive low-frequency recheck retains its prior terminal conclusion」；T/incrementalVideo.test.js「a failed low-frequency terminal recheck preserves the non-blocking conclusion」 | |
| I-100 | CVO:20-55, VDI:132-143 | 已存视频再观测到 unlisted/members_only/private/unavailable → 只更新访问状态，不新建、不删除 | S:434-471（复查只改计数，不改访问状态） | 缺失 | T/videoDisposition.test.js「an existing Full Video remains stored when explicit access evidence changes」 | |
| I-101 | IBP:41-62, IYV:472-497 | 每轮扫描对未入库的待定 ID：已到期的做复查（扫描完整时），未到期的 deferred 记为“待定未结”，未到期的终态直接跳过；不在当前页的到期复查每轮最多 10 个 | 无 | 缺失 | T/incrementalVideo.test.js「Video discovery throttles a deferred recheck before it is due without advancing the cursor」「Video discovery rechecks a due terminal exclusion outside the current Uploads page」「Video discovery does not recheck a terminal ID from Uploads before it is due」 | |
| I-102 | IYV:1517-1525, 366-392, 1559-1563 | 只要还有未结的 deferred 视频（含本轮、历史、复查），发现就是 partial（阻塞） | 无 | 缺失 | T/incrementalVideo.test.js「an outstanding deferred ID blocks the cursor even when it leaves the Uploads page」 | |
| I-103 | IYV:1497-1516 | 处置台账不变量：每个新发现的 ID 必须恰好一条处置，否则整轮报错 | S:819-826（VIDEO 只有全部目标单元入库才 APPLIED） | 一致（机制不同） | T/incrementalVideo.test.js「Video discovery accounts for every new ID with exactly one disposition」 | |
| I-104 | IYV:1000-1009, 1177-1285, 1287-1307 | 首见入库但详情补全失败（retryable/dead_letter）：先记为 pending 台账，之后某轮完整发现把它作为首见报告并标记 consumed | S:484-498（REPLAY_INCOMPLETE 解析失败、或所在计划未完成的视频，下次优先作为恢复目标，最多 100 个） | 不同 | T/incrementalYoutubeJsVideo.test.js「an active Item claim defers execution and resumes without repeating a captured item」 | 意图相同（不丢首见），机制与时机不同 |
| I-105 | IYV:2102-2135 | 先完成首见阶段（含首见台账检查点）才开始近期复查阶段 | WF:34-38（视频批次全部完成后才复查） | 一致 | T/incrementalYoutubeJsVideoProbe.test.js「read-only probe follows Phase A then Phase B with Detail concurrency fixed at one」 | |
| I-106 | IBP:79-84 | 同一视频不能同时出现在首见和复查两个阶段 | S:508-509（复查池排除恢复目标；新视频规划时尚未入库） | 一致 | T/incrementalVideoPlanner.test.js「Recent Sampling excludes Videos initialized by this Discovery」 | |
| I-107 | IYV:292-323 | 首见取完整详情（要求内容类型）；复查只取计数，除非该视频有待修复的详情 | WC:150-160（首见 full，网页 3 次；复查 metricsOnly，1 次）、ACT:257-275 | 不同 | T/incrementalYoutubeJsVideo.test.js「incremental recent detail uses the metrics contract unless a repair is pending」 | 新系统没有“复查时顺带修复缺失详情”的路径 |
| I-108 | IYV:2411-2434 | 单个视频失败：内容终态/解析类失败落为 settled_error 继续下一个；网络、限流、挑战类失败释放条目并让整轮重试 | WC:160-172（not_found → 存为不可用继续；网关/上游错误抛出；其他重试后转 API） | 一致（机制不同） | T/incrementalYoutubeJsVideo.test.js「incremental detail fetch preserves terminal facts and checkpoints parser gaps as partial」 | |
| I-109 | WC:171, VDI | 地区受限视频按频道国家再读一次 | WC:171 | 一致 | — | |

## H. 近期复查（选取、上限、计数合并）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| I-110 | IYV:1662-1768, IVP:19-83 | 复查池：本频道 video/short/live、非登录排除、发布时间在 计划日−30 天 之后（发布时间缺失时用本轮上传列表的日期） | S:500-511（发布时间非空、非不可用、在 今天−30 天 之后） | 不同 | T/incrementalVideo.test.js「Video sampling recovers queued detail when published_at is unresolved」；T/incrementalVideoSnapshot.test.js | 新系统不用上传列表日期补缺失的发布时间 |
| I-111 | IVP:100-124 | 打分：陈旧度 = 距上次读计数 / 7 天（封顶 1，从未读过 =1）；新鲜度 = 1 − 发布天数/30；变化概率无学习值时 = 0.6×0.5 + 0.4×新鲜度；分 = 0.6×陈旧 + 0.4×变化；从未读过或分 ≥0.55 才是候选 | RS:40-48 | 一致 | T/incrementalVideoPlanner.test.js「Recent Sampling ranks equal-staleness Videos by learned change probability」「Recent Sampling can select zero fresh low-change Videos」 | |
| I-112 | IVP:139-161 | 配额 = min(候选数, 待修复数 + ceil(需求×0.75), 上限)；排序：待修复优先 → 分高 → content_key | RS:50-60 | 不同 | T/incrementalVideoPlanner.test.js「Recent Sampling prioritizes queued detail recovery」 | 新系统没有待修复优先（docs/m3 已说明）；同分时按 video_id 而不是 content_key 排序 |
| I-113 | IVP:162-172, IYV:2738 | 评论“next”配额 = min(复查数, next_cap, ceil(复查数×(0.10+0.25×0.5)))，按 next 分选取 | RS:1-7（固定为 0） | 不同 | T/incrementalVideoPlanner.test.js「Recent Sampling obeys frozen capacity factor and hard caps」 | M3-D3 决定旧视频不重采评论 |
| I-114 | IYV:1686-1742 | 复查池过滤：补全任务租约中、终态等待中、重试等待中的视频不复查；时钟拥有 player-refresh 时才接管其到期任务 | 无 | 不适用（新系统没有独立的内容补全任务队列） | T/incrementalVideo.test.js「Video Clock does not bypass a recent Enrich Task's retry schedule」「Clock rollback does not sample a recent Video while its Enrich Worker lease is still live」 | |
| I-115 | IYV:2618-2647, CEP:54-85 | 复查（计数模式）成功条件：公开视频必须拿到播放数，否则按 incomplete_detail 失败；members_only/private/unavailable 记终态并按 7 天低频复查 | ACT:265-269（网页结果中不可用的视频算 missing）、S:449-450 | 不同 | T/incrementalYoutubeJsVideo.test.js「incremental recent detail uses the metrics contract unless a repair is pending」 | 新系统复查发现视频变私有/删除时只记失败，不更新访问状态 |
| I-116 | IYV:2649-2769 | 复查结果：被跳过或锁不到所有权、失败、行缺失都算失败；全部成功 complete，有成功 partial，否则 failed | S:445-469、FC:67 | 一致 | T/incrementalYoutubeJsVideo.test.js「recent storage updates metrics while guarding populated static fields」 | |
| I-117 | IYV:2713-2731 | 复查遇到“请登录” → 写登录排除处置，计入排除数，不算失败 | 无 | 缺失 | T/youtubeLoginRequired.test.js「stored detail stays untouched and enrichment stops without a dead letter」 | |
| I-118 | IYV:1630-1640, 2759-2764 | 统计：可比播放数、播放变化数、播放增量合计、互动（点赞或评论）变化数 | S:451-461 | 一致 | FT/test_v16_domain_state_and_policy.py「test_recent_sampling_updates_change_probability_and_clock」 | |
| I-119 | IYV:331-353 | 单视频变化概率：播放 0.70、点赞 0.15、评论 0.15 加权，EWMA α=0.4；无可比信号时保留原值 | RS:65-76 | 一致 | T/incrementalYoutubeJsVideo.test.js「recent storage updates metrics while guarding populated static fields」 | |
| I-120 | VCS:599-615 | 合并规则：新值为空保留旧值（播放/点赞/评论），评论关闭时评论数记 0 且状态 disabled | S:462-465 | 一致 | T/incrementalYoutubeJsVideo.test.js「recent storage preserves policy-zero engagement statuses」 | |
| I-121 | VCS:616-623 | 计数刷新同时更新访问状态（unknown/login_required 不覆盖）、直播开始/结束时间 | S:463-465（只更新三项计数） | 缺失 | T/incrementalVideo.test.js「a Recent Sampling access-only update still contributes recent publication evidence」 | |
| I-122 | VCS:637-638 | 只在新观测时间不早于上次读计数时间时写入（防迟到覆盖） | S:466-469（refresh_state 有该保护；videos.data 的直接更新 S:466 没有） | 不同 | — | 非流水线路径缺少时间单调保护 |
| I-123 | IYV:2733-2741, VCS:546-549 | 复查默认只刷新计数并保护已有静态字段；只有待修复视频才允许补静态字段 | S:462-465（只改计数） | 一致（只刷新计数）；修复部分缺失 | T/incrementalYoutubeJsVideo.test.js「recent storage repairs missing static fields without replacing populated values」 | |
| I-124 | IYV:3254-3263, S:473-482 | 复查池大小（recent_count）、陈旧比送入时钟作为近 30 天视频数 | S:473-482 | 不同 | FT/test_policy_tiers.py「test_every_recent_sampling_tier_and_cap」 | 旧系统取规划时的池（不含本轮新视频，且排除补全租约中的）；新系统取结算时库内近 30 天视频数（含本轮新视频）。会影响 recent30_video_count 与 About 节奏档 |

## I. 一轮 Video 的完成定义与原因码

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| I-125 | IYV:3403-3412 | 原因码：video_cycle_complete / video_cycle_gap_abandoned_latest_30 / video_cycle_{发现}_{复查}；扫描不完整为 video_cycle_discovery_{stop_reason} | FC:58-73（只有 stop_reason 进入状态） | 不同 | — | 新系统没有这组原因码，失败治理用 ErrorCode |
| I-126 | IYV:3468-3474 | 发现完整时同轮做发布对账（channel、video） | S:832-833（queuePublication） | 一致（机制不同） | — | |
| I-127 | IYV:3463-3467 | 同一轮视频观测只记一次（重复即报错） | S:604-718（submission 幂等）、S:1090 起（同一事务结算） | 一致 | T/incrementalYoutubeJsVideo.test.js | |
| I-128 | ACT:209, 250 | （新增）没有新视频且无复查目标时，发现即最后一批 | ACT:209 | 一致 | — | 对应旧“items 为空直接 ready” IYV:2045 |

## J. 检查点、执行围栏与安全恢复

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| I-129 | IYV:111-132, 1845-1878 | 周期键：无受控恢复标记为 base；有标记时按标记键哈希生成新周期，从而整轮重做 Video | 无 | 不适用（新系统重做用新计划，见 I-143） | T/incrementalYoutubeJsVideo.test.js「cycle key is stable within a Run and changes only with committed recovery marker keys」「cycle key rejects malformed or conflicting recovery markers」 | |
| I-130 | IYV:1903-1935, 134-147 | 批次冻结目标（目标哈希与阶段、序号、ID、快照相关），ready/finalized 不得有未完成条目 | S:1126-1131（首个接受的清单冻结为目标）、SINK:62-64（目标哈希一致才接受） | 一致（机制不同） | T/incrementalYoutubeJsVideo.test.js「target hash is order-independent but includes phase, ordinal, id, and target snapshot」 | |
| I-131 | IYV:1770-1784, 2191-2251 | 条目租约 5 分钟（30 秒–30 分钟），心跳 = 租约/3（1–60 秒），租约丢失立即中止 | WF:25（心跳超时 30 秒） | 不适用（Temporal 心跳替代） | T/incrementalYoutubeJsVideoCheckpoint.postgres.integration.test.js | |
| I-132 | VER:52-61, IYV:2390-2398 | 有其他执行持有未过期的条目租约时，延迟 15 秒（1 秒–5 分钟）再试，不算失败 | 无 | 不适用（Temporal 保证同一工作流单执行） | T/incrementalYoutubeJsVideo.test.js「an active Item claim defers execution and resumes without repeating a captured item」 | |
| I-133 | IVE:18-65, VER:19-50 | 执行围栏：只有最新尝试可写；被取代的执行抛 FENCE_STALE；接管时把被领走但未完成的条目放回 pending，已完成条目不重置 | S:792（STALE_EXECUTION）、ACT:98-108（execution_epoch） | 一致（机制不同） | T/incrementalChannelRunner.test.js「waiting recovery and superseded video executions cannot mark the current Plan failed」 | |
| I-134 | IYV:3715-3755 | 中心快照：已知视频或待定候选超过 10 万条拒绝生成快照 | 无 | 不适用（远端节点快照派发是旧部署形态） | T/incrementalVideoSnapshot.test.js | |
| I-135 | IYV:2899-3169, 2868-2897 | 只读探测：首见/复查各最多 N（0–10）个，网络类失败请求换路由，其他失败停止不重试 | 无 | 不适用（诊断工具，非业务规则） | T/incrementalYoutubeJsVideoProbe.test.js「read-only probe leaves a 429 target pending and stops before Phase B」 | |

## K. 终态失败分类、重试与频道移除

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| I-136 | ITF:70-75 | 未到最大尝试次数、又不是永久错误或频道移除时，不记终态失败（等待重试） | WF:24-28、ACT:87（nonRetryable 由错误码决定） | 一致 | T/incrementalTerminalFailure.test.js「terminal incremental failure is not emitted while the domain can still retry」 | |
| I-137 | ITF:34-40, 82-148 | 终态失败只记在第一个未完成的领域（顺序 About→Video→Agent），每次尝试一条失败观测 | S:1100-1108（所有未 APPLIED 的领域都记 failed） | 不同 | T/incrementalTerminalFailure.test.js「terminal incremental failure emits one failed Observation for the active domain」 | 新系统把未执行到的领域也算失败；对时钟无影响（失败不动时钟），但失败计数/统计口径不同 |
| I-138 | ITF:17-32 | 失败分类：channel_removed / channel_unavailable / timeout / proxy_failure（代理、隧道、机器人挑战、验证码）/ parser_failure / crawler_failure；原因码 = 领域_分类 | ACT:31-36（UNAVAILABLE/NOT_FOUND/BUDGET_EXHAUSTED/FORBIDDEN/INVALID_REQUEST）、packages/store/src/failures.ts | 不同 | T/incrementalTerminalFailure.test.js「terminal About failure uses the generic failed-domain payload」 | 新系统没有 timeout/proxy/parser 的业务分类，靠失败治理的 stage/code |
| I-139 | ITF:42-49 | Agent 终态失败载荷只带 failed_plan_count=1 | 无 | 不适用（新系统 Agent 失败走同一失败治理） | T/incrementalTerminalFailure.test.js「terminal Agent failure uses the bounded failed batch payload」 | |
| I-140 | CLC:16-50 | 频道移除判定（单一证据源：错误文本/ERROR 提示）：社区准则移除、版权终止、频道不存在、账号已关闭、账号已终止；临时或含糊错误不判移除 | CRM:3-22、WC:111-121（必须网页“频道不可用”页 + Data API channels 返回空，两个来源一致才确认） | 不同 | T/channelLifecycle.test.js「classifies explicit YouTube Community Guidelines removal」「does not permanently remove a Channel for transient or ambiguous failures」 | 新系统更严格；但不区分移除原因（removed_reason） |
| I-141 | ITF:72-73, 104-112 | 频道移除在第一次失败时就永久生效（不等重试用尽） | ACT:180-189、S:789-806 | 一致 | T/incrementalTerminalFailure.test.js「explicit Channel removal is persisted on the first failed attempt」 | |
| I-142 | CLC:167-290, FE/app:627-664 | 移除后：频道状态 removed，记录原因/时间/来源/证据（首次为准）；取消待办 Agent 请求；进行中的 Run 置 skipped；时钟生命周期 removed；取消该频道其他进行中的计划 | S:789-806（management_state=removed、发布撤回、本计划 CANCELLED/FAILED）、S:1097（时钟不再改）、S:345（不再调度） | 不同 | T/channelLifecycle.test.js「persists the terminal Channel lifecycle and cancels later work」 | 新系统不保存 removed_reason/removed_source/证据文本；一频道一活动计划，所以“取消其他计划”自然满足 |
| I-143 | IPR:21-275, CAP:13-300, ICH | 运维受控重做：对终态 partial（BUG-035 首见+未结 >20、批量 partial、挑战被当 partial）的 Run 写恢复标记、重置 Video 领域并重投同一个任务 | S:953-971（失败治理页人工重试，按原领域新建 UPDATE 计划） | 不同 | T/incrementalVideoCapRecovery.test.js「a terminal BUG-035 Run is prepared before its completed BullMQ Job is retried」；T/incrementalPartialRecovery.test.js「a terminal Video Partial is prepared before its original Job is retried」；T/incrementalChallengeRecovery.test.js | 新系统只对失败计划重试，不对“已完成但 partial”重做；属于运维工具 |
| I-144 | IR:3-18, S:280-330 | （新增）首采失败自动重试 5/15/60 分钟，仅 UNAVAILABLE/INTERNAL_ERROR/BUDGET_EXHAUSTED | IR:3-18 | 不适用（新系统首采规则，不属于增量） | — | 记录在案 |

## L. 休眠（dormancy）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| I-145 | CDM:3-4, 95-109 | 进入休眠：最近 90 天内没有已发布内容，且发现完整、没有不确定的内容；有近期内容 → active；否则不确定（保持现状） | 无 | 缺失 | T/channelDormancy.test.js「only a complete zero-content scan can enter dormancy」 | 新系统频道永远按时钟更新，长期不更新的频道只能靠 About/Video 时钟拉长间隔（Video 最长 90 天、About 180 天） |
| I-146 | VAL:289-318 | 活动证据：未结束的直播算不确定；发布时间相对/估计/不可用/跨截止日算不确定；只统计 video/short/live | 无 | 缺失 | T/videoActivityLifecycle.test.js「Incremental lifecycle keeps relative publication evidence inconclusive」「Incremental lifecycle keeps a date-only cutoff overlap inconclusive」 | |
| I-147 | VAL:24-40, 320-449 | 历史证据扫描有上限：1000 行、每页 200、500 毫秒；截断或超时 → 证据不完整 → 不确定 | 无 | 缺失 | T/videoActivityLifecycle.test.js「Incremental lifecycle keeps a truncated historical evidence scan inconclusive」「Incremental lifecycle stops historical evidence pagination at its time budget」 | |
| I-148 | IYV:423-470 | 本轮证据：首见、复查、直播中的条目、live_in_progress 处置都计入，直播中按不确定处理 | 无 | 缺失 | T/videoActivityLifecycle.test.js「current-run recent evidence reactivates a channel when history is truncated」；T/incrementalVideo.test.js「a throttled live Candidate still blocks Incremental dormancy from current Uploads」 | |
| I-149 | VAL:489-505 | 真空上传列表（国家复查确认）直接判休眠，原因 uploads_empty，不看库内旧视频 | 无 | 缺失 | T/videoActivityLifecycle.test.js「normal empty uploads can sleep despite stored recent video evidence without changing contents」 | |
| I-150 | CDM:31-41, 43-65 | 休眠复查日 = 观测日 + 30~90 天（sha256(频道,周期) 决定，可重复）；再次休眠时周期 +1、保留 dormant_since | 无 | 缺失 | T/channelDormancy.test.js「dormant recheck delay is deterministic and remains inside 30-90 days」「a later dormant cycle preserves dormant_since and derives a new UTC recheck」 | |
| I-151 | VAL:534-555 | 不确定时：休眠频道只更新 dormant_last_probe_at，不改状态 | 无 | 缺失 | T/videoActivityLifecycle.test.js | |
| I-152 | VAL:557-579, FE/app:937-952 | 退出休眠：发现近期内容 → active，清空休眠字段、周期归零；时钟恢复 active（到期日已过的立即到期） | 无 | 缺失 | T/incrementalVideo.test.js「a Recent Sampling detail reactivates a dormant channel beyond the history limit」「a current-run ended live replay reactivates a dormant channel beyond the history limit」 | |
| I-153 | VAL:603-608, FE/app:925-935 | 进入休眠时取消该频道待办/排队/失败的 Agent 请求，并取消进行中的日计划 | 无 | 缺失 | T/incrementalChannelRunner.test.js「a Video transition to dormant skips an Agent due in the same Plan」 | |
| I-154 | YUC:44-50, ICR:128-133 | 休眠探测：先按保存的国家复查；没有该国代理时不发请求、保持休眠 | 无 | 缺失 | T/youtubeUploadsCountry.test.js「dormant country probes request a route before scanning, or stay dormant without reserve」 | |
| I-155 | VAL:477-483 | 发现完整时把空列表复查结论写入频道 source_json.uploads_recheck，供下次休眠探测使用 | 无 | 缺失 | — | |

## M. Agent 重跑触发

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| I-156 | IAG:1-21, IABk:33-68 | Agent 由时钟到期触发；只为 active 频道登记，非 active 返回 skipped（channel_inactive）；同 plan_id 绑定其他频道/Run 报冲突 | S:398-401（AGENT 时钟到期且在 auto_domains 内）、S:386-389（只为纳管频道） | 一致 | T/incrementalAgentBacklog.test.js | |
| I-157 | IABP:6-40, IABk:72-160 | Agent 攒批：满 30 个频道立即发；不足时等所有已到期的 Agent 计划都登记，或最后一条 15 分钟内无新增后发 | ACT:277-315（每个计划自己跑 Agent） | 不适用（新系统用本地模型逐频道画像，不需要攒批） | T/incrementalAgentBatchPolicy.test.js「Agent dispatches immediately only when 30 due Channels are accumulated」「Agent tail waits while active Agent Plans have not registered requests」 | |
| I-158 | IABk:162-186, 188-226 | 批次投递失败：请求放回 pending，30 秒后重试；孤儿请求排队超 300 秒、运行超 3900 秒回收为 failed | WF:24-28 | 不适用（Temporal 重试与超时替代） | T/incrementalAgentBacklog.test.js「Incremental Agent Batcher releases only its claimed batch when BullMQ rejects it」 | |
| I-159 | IABk:72-145 | 同一频道已有排队/运行中的 Agent 请求时不再领取 | S:347、S:390-391（一频道一活动计划） | 一致 | T/incrementalAgentBacklog.test.js | |
| I-160 | S:396-397 | 只更新 Agent 时，冻结库内最新的视频作为画像输入 | S:396-397 | 不适用（新系统新增，旧系统 Agent 读当时库内数据） | — | 记录在案 |

## N. 其他

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| I-161 | IYV:556-568, CEP:21-29, 87-151 | 内容补全重试：30 秒起指数退避，最长 6 小时，最多 8 次后进死信；不可重试的工程错误直接死信；内容终态按访问状态 7 天复查 | 无 | 不适用（新系统没有独立的内容补全任务；失败视频改由下轮计划恢复，见 I-104） | T/contentEnrichPolicy 相关测试 | 若将来恢复补全队列需重评 |
| I-162 | IYV:3533-3538 | 环境开关 YOUTUBEJS_VIDEO_API_BATCH_FALLBACK 打开时，取详情失败可转 Data API 批量兜底 | WC:178-200（默认网页失败后转 Data API） | 一致 | T/incrementalYoutubeJsVideo.postgres.integration.test.js「Incremental API waiting releases its Item claim and resumes the same frozen video batch exactly once」 | |
| I-163 | IVP:19-25 | 计划冻结的 planner_config_version 与执行端不一致时拒绝执行 | C（FrozenInputSchema 严格校验 schema_version） | 一致（机制不同） | T/incrementalVideoPlanner.test.js「Crawler rejects a frozen Planner version it does not support」 | |

---

## 统计

| 状态 | 条数 |
| --- | --- |
| 一致 | 78 |
| 不同 | 32 |
| 缺失 | 31 |
| 不适用 | 22 |
| 合计 | 163 |

（“一致（机制不同）”“一致（公式）”计入一致；I-123 主体计为一致，其中“修复部分缺失”在备注说明。）

## 不同 / 缺失 按影响排序

影响从高到低。“高”= 会改变哪些频道被更新、多久更新一次，或会漏数据；“中”= 改变单个视频或统计的准确性；“低”= 运维与可观测性。

### 高

1. **休眠整套缺失（I-2, I-14, I-15, I-24, I-70, I-145 ~ I-155）**：新系统没有 90 天无发布的休眠判定、30~90 天的低频探测、休眠时跳过 Agent、退出休眠后恢复。长期不更新的频道会继续按 About 最长 180 天、Video 最长 90 天、Agent 60~365 天的节奏消耗请求；旧系统里这类频道只在复查日跑一个“仅 Video”的探测，About 和 Agent 都停。存量频道一旦大批迁入，成本差异最大。
2. **发现不完整时的处理（I-71, I-82, I-83, I-84, I-102）**：旧系统扫描不完整、或还有未结的待定视频时，记 partial，Video 时钟封顶 3 天，同时保留已拿到的部分结果。新系统一律整计划失败，第二天重试，期间已拿到的新视频不入库。频繁失败的频道会比旧系统晚发现新视频，时钟也学不到 partial 的信号。
3. **按视频的复查台账缺失（I-91, I-92, I-93, I-96 ~ I-101）**：旧系统按处置为每个视频安排复查：直播/待开播 1 天、私有/不可用 7 天、超窗 30 天、类型不明 6 小时、取详情失败 1 小时，每轮最多补 10 个到期复查。新系统里视频一旦记为不可用就不再复查，直播结束后的时长/发布时间也不会重读（I-90, I-91）。会导致直播类内容数据长期不完整，私有转公开的视频漏采。
4. **派发时间窗缺失（I-29）**：旧系统只在 00:30–21:30 UTC 派发，新系统全天派发、到期时间是 00:00 UTC。会把负载集中到 UTC 零点之后，并且失去旧系统留给全量/维护的静默窗。
5. **存量迁入不摊开（I-74）**：旧 bootstrap 会把逾期时钟按频道哈希摊到 [1, 原间隔] 天内。新系统重新纳管只重放观测，逾期的时钟同一天全部到期，迁移存量频道时会出现集中到期，挤占 Data API 配额。
6. **复查发现视频变私有/删除不更新访问状态（I-100, I-115, I-121）**：新复查只改三项计数，视频变成私有、会员专享或删除时只记一次复查失败，库内访问状态仍是公开，下游业务库会继续把它当公开视频。

### 中

7. **复查池计数口径（I-124）**：旧 recent_count 是规划时的池，不含本轮新视频；新系统是结算时库内近 30 天视频数，含本轮新视频。这个值会进入 recent30_video_count，影响近期复查档位、About 节奏档和冷启动判断，同一频道两边算出的间隔可能不同。
8. **About 拿不到时的结果（I-69）**：旧系统记 partial，About 时钟 ≤3 天；新系统先用 Data API 兜底（通常 complete），兜底也失败则整计划失败、次日重试。
9. **追赶放弃条件（I-80, I-81）**：旧系统是首屏 + 追赶 50 个用尽，且无解析缺口、≥30 个、条目唯一才放弃；新系统网页扫描累计 100 个就放弃。追赶窗口大小不同，同一个积压频道两边保留的新视频集合会不一样。
10. **类型不明直接入库（I-97）**：旧系统类型证据不权威时延后 6 小时再查；新系统默认记成 video（来源 default:shorts_unknown）直接入库，Shorts 有可能被误标成普通视频。
11. **首见失败的恢复方式（I-96, I-104）**：旧系统按视频 1 小时后重试，并用 pending/consumed 台账保证之后的完整发现会把它报成首见；新系统靠下一轮计划的恢复目标重采。不会丢视频，但发现延迟和首见归属（算在哪一轮）不同，会影响发现阶段“新发布间隔”的特征。
12. **复查池补缺失发布时间（I-110）与复查顺带修复详情（I-107, I-123）**：新系统发布时间为空的视频永远进不了复查池，也没有“复查时补缺失静态字段”的路径。
13. **复查容量（I-3, I-112, I-113）**：新上限固定 20，没有容量系数；没有“待修复优先”；同分时按 video_id 排（旧系统按 content_key）；评论 next 配额为 0（M3-D3 有意决定）。
14. **频道移除不留原因（I-140, I-142）**：新系统确认更严格（网页 + API 两个来源），但不记录 removed_reason（社区准则、版权、不存在、关闭、终止）和证据文本，业务侧无法区分封禁和自行关闭。
15. **调度顺序没有用 dispatch_slot（I-25）**、**派发预算没有 Agent 专属份额（I-30）**：同日大量到期时，新系统按 channel_id 字母序处理，Agent-only 计划也没有保底份额。
16. **采集优先级信号缺失（I-37）**：user_query_demand、manual_priority 不进入 collection_priority，按需求加快更新的能力不存在（人工固定间隔只能部分替代）。
17. **扫描到的已知视频不更新位置和发布时间（I-85）**、**空列表真伪校验只在首采做（I-86, I-87）**。

### 低

18. **终态失败口径（I-137, I-138）**：新系统把没执行到的领域也记失败，失败分类没有 timeout/proxy/parser；对时钟没有影响，只影响统计与告警。
19. **计划状态没有 partial（I-72）**、**Video 原因码不存在（I-125）**：只影响可观测性。
20. **非流水线路径复查写入没有时间单调保护（I-122）**：迟到的复查结果可能覆盖较新的计数。
21. **受控重做只对失败计划（I-143）**：对“已完成但 partial”的计划没有重做工具。
22. **由旧状态重算 vs 由事实重放（I-59）**、**登录排除不能人工解除（I-95）**、**复查遇“请登录”不写排除（I-117）**、**是否接受 v16-rule-7 以外的策略（I-50，目前不适用）**。
