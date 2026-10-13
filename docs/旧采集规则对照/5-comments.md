# 规则清单 5：评论（首页、计数、禁用/零/不可用、排序、作者与时间字段、重试）

审计方式：只读。旧系统 L = `oldsystem/services/qybullmq/src/`（另含 `scripts/ytdlp_comments.py`、`services/local-agent/src/qy_channel_profile/`）；新系统 N = `crawlsystem-business`。
简写：YCP = `L/youtubeCommentPage.js`；YJ = `L/youtubeJs.js`；P2 = `L/pipelineV2.js`；scrape = `N/apps/execution-worker/src/youtube/scrape.ts`；ws = `N/.../youtube/web-scrape.ts`；map = `N/.../youtube/map.ts`；wc = `N/.../youtube/web-collector.ts`；loc = `N/.../youtube/localized.ts`；parser = `N/apps/raw-parser/src/parser.ts`；ct = `N/packages/contracts/src/index.ts`；sink = `N/apps/pg-sink/src/sink.ts`；adapter = `N/packages/legacy-publication/src/businessPublicationProjectionAdapter.js`。
旧测试简写：YCPt = `test/youtubeCommentPage.test.js`；CFBt = `test/commentFirstPageBackfill.test.js`；YTDt = `test/ytdlpCommentPage.test.js`；DAt = `test/youtubeDataApiComments.test.js`；DCSt = `test/disabledCommentCountSchema.test.js`；DCRt = `test/disabledCommentCountRepair.test.js`；DCRi = `test/disabledCommentCountRepair.postgres.integration.test.js`；BDPi = `test/businessDisabledCommentProjection.postgres.integration.test.js`。
状态只用四种：一致 / 缺失 / 不同 / 不适用（不适用会说明原因）。

背景（任务给出的已知现象）：28.7% 的新视频 comment_count 为 unresolved；web 路径上 comments_disabled 从未为 true；评论发布时间全部为 null。下表把这三个现象分别追到了对应规则（见 M-21…M-29、M-30、M-34、M-38…M-44、M-54）。

## A. 请求、排序与页大小

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| M-1 | YJ:86-96, 136-164 | 首页请求：用 youtubei.js 的 `GetCommentsSectionParams` 自己编码 continuation（ctx.videoId、unkParam 6、opts{videoId, sortBy 0, type 2, commentId ""}、target "comments-section"），以 `CONTINUATION_REQUEST_TYPE_WATCH_NEXT` 调 `next` | scrape:84 `yt.getComments(id,'TOP_COMMENTS')`；youtubei.js 18.1.0 `Innertube.getComments`（node_modules/youtubei.js/dist/src/Innertube.js:218-240）内部编码完全相同 | 一致 | YCPt「comment collection bypasses youtubei.js parsing for avatar-less comment entities」 | 请求本身完全相同 |
| M-2 | YJ:164,168；YCPt:133-161 | 拿原始 JSON（`response.data`），**不用 youtubei.js 的 Comments 解析器**：评论实体缺头像时 youtubei.js 会抛 `TypeError: Cannot read properties of undefined (reading 'endpoint')`，旧系统因此改走原始 JSON 解析（YCP:443-486） | scrape:84-100 用 youtubei.js `Comments`/`CommentView` 解析结果 | 不同 | YCPt「comment collection bypasses youtubei.js parsing…」 | 新测试 `youtube-map.test.ts:58` 显示 "Cannot read properties of undefined" 会以 parse 错误抛出，然后 ws:164 的 `.catch` 把它变成 `unavailable`，**整页评论丢失**。18.1.0 是否还会触发这个崩溃，离线无法确认，需要用归档的原始响应回放验证 |
| M-3 | YJ:165-167, 178 | `success===false` 时抛出 "YouTube comments request failed HTTP n" | youtubei.js 抛错 → scrape:103 `classify` | 一致 | — | 抛错之后的处理不同，见 M-38…M-41 |
| M-4 | YCP:244, 344, 436, 478 | 页面 sort 默认 `TOP_COMMENTS`；只有走了 NEWEST 回退时才写 `NEWEST_FIRST` | scrape:83, 87, 91；map:105 `sort ?? 'TOP_COMMENTS'`；ct:67 枚举 | 一致 | YCPt「normalizeYoutubeCommentPage reads the header count…」 | — |
| M-5 | YJ:169-172, 2057；fullCrawlFetchContract.js:57-58 | NEWEST 回退的条件：只在 `fallbackToNewest = optionalComments` 时开启（全量采集、checkpoint 路径，契约写明 `comments_fallback: "empty_top_to_newest_once"`），而且要同时满足：未禁用、total_count>0、TOP 返回 0 条、存在服务端下发的 NEWEST endpoint；只回退一次。增量（strict）路径不回退 | scrape:85-92：(a) TOP 抛 EMPTY_COMMENTS 且 apiCount>0 → 改用 NEWEST；(b) TOP 成功、total>0 但 contents 为空 → 改用 NEWEST；所有路径都会这样做（首采、API 回退、解析器回放） | 不同 | YCPt「optional comments fall back once to the server's newest endpoint when top has no rows」 | 新系统触发范围更大（包括 EMPTY 抛错的情形，也包括增量路径），也没有「存在 endpoint」这个前提 |
| M-6 | YCP:488-496 | NEWEST endpoint 来自 commentsHeader 里 `sortFilterSubMenuRenderer.subMenuItems[1].serviceEndpoint`（也就是 YouTube.js applySort 用的那一项），而且必须 `request === CONTINUATION_REQUEST_TYPE_WATCH_NEXT`、token 是字符串，否则不回退 | youtubei.js `getComments(id,'NEWEST_FIRST')` 在客户端编码 `sortBy: 1`（Innertube.js:220-232） | 不同 | 同上 | 旧系统用服务端下发的 token，新系统用客户端参数。YouTube 是否认 `sortBy=1` 要用回放核对 |
| M-7 | YJ:174, 182, 186-187；YCP:484 | 回退时把诊断写进首页 JSON：`fetch_diagnostics {reason:"positive_total_empty_top", top_returned_count:0, fallback_status: collected/empty/failed, fallback_error}` | 无；ct:66 `CommentPageSchema` 是 strictObject，不允许这个字段 | 缺失 | YCPt「optional comments fall back once…」（断言 `fetch_diagnostics.fallback_status`） | 新系统无法区分「NEWEST 也是空的」和「NEWEST 失败」 |
| M-8 | YJ:180, 183；YCP:471 | NEWEST 页的 total_count 优先用 NEWEST 页 header，没有就用 TOP 页的 total（`youtubejs_comment_total`） | scrape:89, 101 `total_text = NEWEST header ?? String(total)`，其中 total 取自 TOP 页 header 或 apiCount | 一致 | 同上（total_count 3） | — |
| M-9 | YJ:184-187 | NEWEST 请求失败时保留 TOP 页（sort 仍是 TOP），不让评论整体失败 | scrape:91 catch 后保留 TOP 页 | 一致 | 同上（scenario failed） | 新系统不记失败原因（见 M-7） |
| M-10 | YCP:443-486；YJ 全文 | 只取第一页，不翻页 | scrape 不调用 getContinuation | 一致 | — | — |
| M-11 | YCP:455-464, 419-428；ytdlp_comments.py:9-33 | 页大小：youtubei 路径收下首个 continuation 返回的全部顶层线程（通常约 20 条），不截断；yt-dlp 路径 `YTDLP_COMMENT_FIRST_PAGE_MAX` 默认 20、最多 50，参数 `max_comments [n,n,0,0,1]`（不取回复） | map:107 `slice(0, commentLimit)`；ct:130 `comments_per_video` 默认 20，范围 0–100；ct:68-69 每页最多 100 | 一致 | YTDt「yt-dlp comment options cap extraction to top-level Top Comments」 | YouTube 一次返回超过 limit 时新系统会截断，旧 youtubei 路径不截 |
| M-12 | — | （新增）`comments_per_video = 0` 时跳过评论 | ws:164；parser:169 | 不适用 | — | 新增的配置，旧系统总是取评论 |
| M-13 | YCP:6-34（不截断） | 评论正文不截断 | map:109 `text.slice(0, 20_000)`；ct:34 Text 最大 20000 | 不同 | — | 影响很小 |
| M-14 | YCP:4；YJ:48 | 评论计数和相对时间按会话语言解析（旧为 en，可由 `YOUTUBE_CONTROL_LANGUAGE`/`YOUTUBE_LANGUAGE` 覆盖） | ws:164、wc:190、parser:170 传 `'pt-BR'`；activities.ts:244（非 web 路径）用默认 `'en'`，且会话也是 en | 一致 | — | 解析语言和会话语言一致；但 pt-BR 的具体解析能力不够，见 M-17、M-54 |

## B. 总数（total / comment_count）的来源和解析

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| M-15 | YCP:465-470, 429-431 | total 的读取顺序：`commentsHeaderRenderer`/`commentsHeaderViewModel` 的 countText → commentsCount → count → commentsCount.content；getComments 结果则是 header.countText/count → commentsCount/comments_count | scrape:89 只读 `header.comments_count`（来自 commentsCount），不看 countText | 不同 | YCPt「normalizeYoutubeCommentPage reads the header count…」「…reads commentViewModel threads without commentThreadRenderer」 | header 只有 countText（例如 "1.234 comentários"）时，新系统会落到入口计数 |
| M-16 | YCP:471-472；YJ:1478-1485, 1491, 1496, 2046-2053, 2066 | header 里没有计数时，total 回退到 watch next 页 `comments_entry_point_header.comment_count`（hint） | web 路径：ws:163 取入口计数 → scrape:89 apiCommentCount；API 回退路径：wc:190、parser:170 用 Data API `statistics.commentCount`；map:106 | 一致 | YCPt「an observed comment total is independent of optional first-page rows」 | API 回退用的是 videos.list 的计数，不是评论正文，符合「评论只走 web」的决定 |
| M-17 | YJ:256-271 | hint 的解析：数字直接 round；文本用 `parseRequiredLocalizedCount`，没有数字就抛 `ParserContractError`（让详情失败，暴露为 parser gap） | ws:13, 163 `count()` → `parseCount(...,'pt-BR')`，解析不了就静默返回 null | 不同 | — | 新系统把格式变化静默吞成 unresolved |
| M-18 | L/localizedCount.js:223-250（YCP:83-87 调用） | 计数解析：NFKC、各种本地数字系统、按 Intl 生成的紧凑单位（mil/mi/K/M/lakh/万…）、前后缀单位 | map:10-25 `parseCount` 是简化版（pt：mil/mi/bi/milhão/K/M/B；en：K/M/B，"no" 记为 0）；loc:139 已移植 `parseLocalizedCountDetails`，但评论路径没接上 | 不同 | —（localizedCount 自身的测试不在本组） | pt-BR 常见写法能解析；接上 loc 就能完全对齐 |
| M-19 | YCP:536-544 | 有首页且 returned>0 时：`comment_count = total ?? returned_count`，status exact，source youtubejs_comments（没有 total 就用已返回条数作下界） | ws:128, 134：total_text 解析不出来就是 null/unresolved，不用 returned_count 兜底 | 不同 | YCPt「classifyYoutubeCommentPage keeps closed, zero and positive totals…」 | 旧系统把下界标成 exact（有偏差）；新系统更保守，但会增加 unresolved |
| M-20 | YCP:545-552 | total>0 但 returned=0 时，comment_count=total，status exact（计数和正文是否采到无关） | ws:128, 134：page 类型，用 total_text → exact | 一致 | YCPt「an observed comment total is independent…」「classify…」（total 12 → exact） | — |
| M-21 | YJ:261-270（缩写 hint 也算 exact） | 旧系统的评论数没有 "estimated" 状态；缩写的 hint（如 "1.2K"）解析后仍是 exact | ws:134：page 类型且 total_text 是缩写时 → `estimated`；入口计数路径（unavailable/skipped）仍是 exact | 不同 | — | **业务影响**：adapter:390-401 `countValue` 只把 comment_count 的 exact/zero_*/disabled 映射成 exact，`estimated` 会变成 unavailable 且值为 null，所以新系统的缩写评论数在业务库里会丢失 |

## C. 状态分类：禁用 / 零 / 不可用 / 未解析

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| M-22 | YCP:520-527；YJ:2060-2062, 1507-1512, 1638-1640 | 判定禁用时：comments_disabled=true、comment_count=0、status `disabled`、source `youtubejs_comments`；首页写成 `emptyYoutubeCommentPage(total 0)`，不做 normalize | map:104, 123-124 认得 `kind:'disabled'`，形状一致；但 scrape **从来不返回 'disabled'** | 缺失 | YCPt「classifyYoutubeCommentPage keeps closed, zero…」；DCSt 两条 | 这就是「comments_disabled 从未为 true」的直接原因 |
| M-23 | YCP:95-100 | 禁用文案的正则（递归扫描响应里的所有字符串）：英文 `comments? (are /have been )?(turned off/disabled)`；葡语 `coment[aá]rios? (foram /est[aã]o )?(desativad/desabilitad)`；法语 `commentaires? (sont /ont été )?désactiv` | 无 | 缺失 | YCPt「youtubeCommentsDisabled recognizes an explicit disabled surface」（含葡语 "Os comentários estão desativados."） | 新会话是 pt-BR，葡语这条正则可以直接照搬 |
| M-24 | YCP:105-107 | 扫描时跳过 `commentSimpleboxRenderer` 子树：评论输入框里的 disabledText 不算禁用证据；只看 key 里含 comment 的上下文 | 无 | 缺失 | YCPt「an inactive comment composer disabledText is not a disabled comment surface」 | 补禁用检测时必须同时补这条 |
| M-25 | YCP:111-116, 512-514 | 只有在没有任何已返回评论证据时才认定禁用：首页 returned>0、getComments contents 非空、存在 commentThreadRenderer/commentViewModel/commentEntityPayload，任一成立都不算禁用 | 无 | 缺失 | 同上；YCPt「youtubeCommentsDisabled…」（有评论的 fixture 判为 false） | — |
| M-26 | YJ:1500-1504 | 也看 watch next 页（`info.page[1]`）里 Message 节点的文本来判定禁用 | ws:143 已经拿到 getInfo 的 next 响应，但没检查 | 缺失 | — | 不需要额外请求 |
| M-27 | YCP:118-124, 126-137 | 「bare continuation」（只有 responseContext 和 trackingParams，没有 onResponseReceived*）不算禁用证据；surface 为 `absent`；classify 结果为 unresolved | youtubei.js 对这种响应抛 "comments page did not have any content"（scrape:73）。apiCount 为 undefined → unavailable；为 '0' → 空页；>0 → 改用 NEWEST，再失败则 unavailable | 不同 | YCPt「a successful bare continuation response needs video access context」 | 大体等价，差异在 '0' 的分支（M-30） |
| M-28 | YCP:553-560 | `zero_from_surface`：total===0，或者首页结构合法、returned=0 且 surface≠absent，此时 count=0、comments_disabled=false | 新系统 total 为 0 时记 exact 0（ct:41 MetricSchema 没有 zero_* 状态）；评论区存在但 header 没有计数时 → unresolved | 不同 | YCPt「normalizeYoutubeCommentPage keeps a zero first page…」「classify…」「an inactive comment composer…」（0 Comments → zero_from_surface） | 业务层：adapter 把 zero_* 也映射成 exact，所以业务库结果相同；差异在采集层：状态语义丢失，并且「评论区存在、没有计数」会变成 unresolved |
| M-29 | YCP:561-566 | 其余情况：comments_disabled=null、count=null、unresolved、source=null | map:124：只要是 page 类型，comments_disabled 一律为 **false**，即使既没有计数也没有正文 | 不同 | YCPt「a successful bare continuation…」（classify → unresolved） | **取值错误，不只是缺值**：评论被关闭的视频大概率走到这里（空页、没有 header）。这是从代码推断的，需要用回放确认 |
| M-30 | YJ:1507-1509；YCP:553 | 入口 hint = 0 且评论响应为空 → comment_count 0（classify 结果为 zero_from_surface，或用 hint） | scrape:106 EMPTY 且 apiCount==='0' → page 不带 total_text → ws:128 commentCount=null → **unresolved** | 不同 | — | 代码注释写的是 "'0' → no comments yet"，但计数被丢掉了；这是一个 bug |
| M-31 | YCP:528-535；YJ:1507-1518 | 评论请求出错：comments_disabled=null，comment_count 取页面 total（如果有），否则回退到 hint，此时 status exact、source youtubejs_next | `unavailable` → ws:128 `count(入口计数)`，status exact、source `youtubei:video` | 一致 | — | — |
| M-32 | YJ:1524-1527 | comments_disabled 为 null 但已有计数时，comments_disabled 写成 false、source youtubejs_next | `unavailable`/`skipped` 时 map:124 让 comments_disabled 保持 null | 不同 | — | 影响很小 |
| M-33 | YJ:1425-1440, 1519-1523 | 年龄限制下的空响应：评论为空（错误文案 "comments page did not have any content"，或 absent + 0 条 + total=null）并且 playability 为 LOGIN_REQUIRED、`is_family_safe===false`、reason 匹配 confirm your age / age-restricted / verify your age → comments_disabled=true、0、disabled，source `youtubejs_comments_age_gate_empty` | ws:101, 148, 157：年龄限制直接返回终止态 `VideoUnavailable(age_restricted)`，没有评论事实 | 不同 | — | 跨组问题（可访问性/playability 组）。旧系统会保留年龄限制视频的指标，并把评论记为禁用 |
| M-34 | YJ:1568-1576 | 直播/首映：没有计数、没有错误、surface absent、access 为 public/unlisted，且 is_upcoming 或 is_live → count 0；upcoming 记 `zero_from_upcoming`（source youtubejs_upcoming_comments_not_public），live 记 `zero_from_empty`（source youtubejs_live_comments_not_public）。直播聊天不算评论 | 无，结果为 unresolved 或 unavailable | 缺失 | — | 28.7% unresolved 的来源之一 |
| M-35 | P2:698-702 | 合并后再归一：upcoming 且 public 且没有计数 → 0、`zero_from_upcoming`、comments_disabled=false、source `youtube_upcoming_state` | 无 | 缺失 | — | 同上 |
| M-36 | P2:687-697, 703-705 | 归一：disabled ⇒ 0/disabled；有计数 ⇒ exact（保留 zero_from_surface/zero_from_upcoming，但 **zero_from_empty 会被改写成 exact**，这是旧系统的怪癖）；comments_disabled=false 且有 status source ⇒ 0、zero_from_surface；否则 unresolved（API 之后为 unavailable） | map:123 API 路径缺计数时为 `unavailable`；web 路径为 `unresolved` | 一致 | — | unresolved 与 unavailable 的区分一致；zero 相关部分见 M-28、M-34 |
| M-37 | L/youtube.js:2114-2143 | Data API videos.list：privacyStatus=public 且 statistics 里没有 commentCount → comments_disabled=true、comment_count=0、disabled，source `youtube_data_api_statistics`；非 public → unresolved/null | map:123-124 `count(stats.commentCount,'unavailable')`，comments_disabled 只看评论页 | 不同 | DAt「videos.list classifies a public video without comment statistics as disabled zero」 | 新系统在 API 回退路径上也不会置 disabled。这里只用 videos.list 的计数，不涉及评论正文 |

## D. 重试，以及评论失败何时让详情失败

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| M-38 | YJ:2054-2081 | 评论请求最多 2 次；只有 `selectYoutubeFailure` 判为 `proxy_transport` 或 `upstream_transient` 才重试，且不重新取播放器；其他错误立即停 | scrape 不重试；ws:164 的 `.catch` 吞掉所有错误 | 缺失 | — | — |
| M-39 | YJ:2094-2107；youtubeJsVideoDetailContract.js:64-72；incrementalYoutubeJsVideo.js:307；fullCrawlYoutubeJsFactory.js:439；checkpointYoutubeJsDetail.js:11 | 三条生产路径都 `strictRequiredSurfaces:true`。评论失败（且访问状态不是 members_only/private/unavailable、不是 upcoming、不是禁用）时抛 `YoutubeJsRequiredSurfaceError(required_surface:"comments", partial_detail)`，让详情失败 → 详情重试（videoDetailApiFallback.js:96-100，解析类失败最多 3 次）→ 路由/预算恢复 → API 回退（`requireComments`，116-119） | 评论失败从不让详情失败；wc:160 的 3 次重试只覆盖详情本身抛错的情况 | 不同 | — | API 回退里用 Data API commentThreads 补评论这一步按用户决定不移植；但「失败要重试，不能静默丢」这条原则应该移植 |
| M-40 | YJ:2073-2079 | 被封（blocked）或网络失败时按失败类型处理：重试，并把失败上报给代理路由 | ws:164 `.catch(() => unavailable)` 连 blocked/network 一起吞（scrape:104 本来会把它们重新抛出） | 不同 | — | 评论阶段的封禁不会惩罚代理、不会换代理，评论首页就这样丢了 |
| M-41 | — | （新系统的设计意图）scrape:107 的注释和测试要求「其他 parse 失败仍然失败」，避免 YouTube 改版被静默吸收 | ws:164、wc:190、parser:170 的调用方 `.catch` 又把它吞成 unavailable | 不同 | — | 新系统内部前后矛盾：`youtube-map.test.ts:58` 断言会抛，生产调用方却吞掉 |
| M-42 | YJ:2034, 2092, 1687 | 详情里记录 `youtubejs_comments_error`，raw summary 里记录 `comments_query_used` | `unavailable` 不带原因 | 缺失 | — | 只影响诊断 |
| M-43 | L/videoDetailEvidence.js:24-47, 65-69 | 字段状态矩阵：评论失败时 comment_count/comments_disabled/comments_first_page 记为 `parser_gap`；禁用时记为 `disabled` | 无 | 缺失 | — | 影响低 |
| M-44 | YJ:2054（metrics 模式也无条件请求评论区）；incrementalYoutubeJsVideo.js:302-310 | 增量 recent 采样（detailMode metrics）照样请求评论区，用 header 刷新 comment_count | ws:143 metricsOnly 时用 `getBasicInfo`（只有 player，没有 next，也就没有入口计数）；ws:164 评论记为 skipped；activities.ts:264 commentLimit 0 → comment_count 恒为 null；sink:93-95 保留原值 | 不同 | — | **采样永远不刷新评论数**，`recent-sampling.ts:69` 里评论权重 0.15 的变化信号也就失效了 |

## E. 单条评论的字段

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| M-45 | YCP:202-204, 373-374 | comment_id 必须有，没有就丢弃；原始 JSON 路径只保留 `replyLevel==0` | scrape:93 过滤 `typeof comment_id === 'string'`；youtubei.js 的 CommentThread 本身只含顶层评论 | 一致 | YCPt normalize 各条 | — |
| M-46 | YCP:194-201, 205-207, 174-191 | 原始 JSON 路径：commentThreadRenderer/commentViewModel 通过 commentKey/commentId 关联 commentEntityPayload；没有实体也没有内容的线程丢弃 | youtubei.js 内部做 mutation 关联 | 不适用 | YCPt「…reads commentViewModel threads without commentThreadRenderer」 | 新系统不解析原始 JSON；见 M-2 |
| M-47 | YCP:424-427, 460-463 | 按 comment_id 去重，去重后 position 重新编号 1..n | map:107-109 不去重，position=i+1；ct:70 的 refine 要求 id 唯一，有重复时 parse 抛错，整条视频事实失败 | 不同 | — | 置顶评论在列表里重复出现时会触发 |
| M-48 | YCP:6-34, 218, 389 | text：去首尾空白，'N/A' 视为 null，runs 拼接；getComments 路径缺失时为 "" | scrape:95 `text(c.content) ?? ''`（不 trim） | 一致 | YCPt「youtubeCommentPageFromGetComments keeps the stored first-page JSONB shape」 | — |
| M-49 | YCP:219, 384 | author_name：`text()`，'N/A' 变成 null | scrape:95 `author.name ?? null`；youtubei.js Author 缺名字时值是 'N/A'（Author.js），新系统会存 'N/A' | 不同 | — | 影响低 |
| M-50 | YCP:220, 383 | author_channel_id：任意非空文本 | scrape:95 只接受 `^UC[\w-]{22}$`，否则 null（ct IdSchema 也限制字符） | 一致 | 同 M-48 | 新系统更严 |
| M-51 | YCP:167-172, 392-394 | author_url：url 以 `/N/A` 结尾时改用 `https://www.youtube.com/channel/{id}`；原始 JSON 路径把 channelCommand url 补成绝对地址，没有就用 channelId 拼 | scrape:96 `author.url ?? null`：不过滤 /N/A，也不由 id 拼地址 | 不同 | 同 M-48（author_url） | `…/channel/N/A` 能通过 Url 校验，会被存下来 |
| M-52 | YCP:44-64, 222-223, 395-397 | author_avatar_url：best_thumbnail → thumbnails 中面积最大的 → creator_thumbnail_url，都补成绝对地址（`//` 补 https:、相对路径补域名）；原始 JSON 路径用 avatarThumbnailUrl → avatar.image；没有头像就是 null | scrape:96 `best_thumbnail.url ?? creator_thumbnail_url`，不补绝对地址 | 一致 | YCPt「…avatar-less…」（null）；同 M-48 | 两个系统都会退回到 `creator_thumbnail_url`（实际上是频道主点心时的头像），这个怪癖一致。没有绝对地址归一，一旦出现非绝对 URL 会导致 Url 校验失败 |
| M-53 | YCP:208, 375 | published_text_raw = 原文 | scrape:97；map:110 | 一致 | — | — |
| M-54 | YCP:209-214, 376-381；L/localizedTime.js:237-268 | published_at_utc = `localizedEstimatedUtcTimestamp`：用 Intl.RelativeTimeFormat 生成该语言的长/短/narrow 各种模式，外加不带数字的短语（如 yesterday）；单位换算：秒、分、时、日、周=7 天、月=30 天、年=365 天 | map:34-39 `estimateRelative` 只认英文 "N unit(s) ago"，pt-BR 的 "há 2 dias" 匹配不上，于是**全部为 null**；loc:289 已经移植了 `localizedEstimatedUtcTimestamp`，但没接上 | 不同 | YCPt「…keeps the stored first-page JSONB shape」（published "2 days ago"）；新测试 `localized.test.ts:92` 已经覆盖 pt-BR | 这就是「评论时间全为 null」的根因，修法是在 map:108 改用 loc |
| M-55 | YCP:226, 400 | published_at_status：解析成功为 `estimated_relative`，否则 `unresolved` | map:110；ct:62 | 一致 | — | — |
| M-56 | YCP:210-213, 421 | 相对时间以 collected_at 为基准 | map:108 `comments.collected_at`（web 用 observedAt；回放用 `raw.captured_at`，parser:170） | 一致 | — | 回放结果可复现 |
| M-57 | YCP:227, 401 | is_edited：getComments 路径用发布时间文本匹配 `/\(\s*edited\s*\)/i`；原始 JSON 路径还接受 `properties.isEdited===true`；没有文本时为 false | map:111 `/edited\|editado/i`；没有文本时为 null | 一致 | — | 已适配葡语；null 与 false 的差别很小 |
| M-58 | YCP:228, 402 | like_count：`nonnegativeCount`，缺失记 0 | map:111 `parseCount(like_text)`，失败为 null；youtubei.js 18 的 CommentView 在缺失时本来就给 '0' | 一致 | 同 M-48（like 3） | — |
| M-59 | YCP:229, 403 | reply_count：同上，缺失记 0 | map:111；CommentView 缺失时给 '0' | 一致 | 同上（reply 0） | — |
| M-60 | YCP:230, 404 | is_pinned：getComments 路径 `===true`；原始 JSON 路径看 pinnedText 或 renderingPriority 含 PINNED | scrape:98；CommentView `is_pinned = !!pinnedText` | 一致 | — | — |
| M-61 | YCP:231, 405 | is_channel_owner：`author_is_channel_owner===true` 或 author.isCreator | scrape:98 | 一致 | — | — |
| M-62 | YCP:232, 406 | is_verified：`author.is_verified===true` 或 isVerified，否则 false | scrape:99 是布尔就原样，否则 null（Author 在没有 isVerified 时为 undefined） | 不同 | — | null 与 false 的差别；profile-agent 会把 null 当 False |
| M-63 | YCP:233, 407 | is_hearted：getComments 路径 `is_hearted===true`；原始 JSON 路径 `Boolean(toolbar.heartActiveTooltip)` | scrape:99 是布尔就原样，否则 null（CommentView 只在有 toolbar_state 时才设置） | 不同 | — | 来源字段不同，缺失时为 null |
| M-64 | YCP:306-354；L/youtube.js:2215-2314 | Data API commentThreads（order=relevance、maxResults=20、textFormat=plainText）字段映射、commentsDisabled → disabled、空结果 → confirmed_no_visible_threads | 无 | 不适用 | YCPt「official CommentThreads rows normalize to the first-page contract」；DAt「commentThreads.list returns disabled comments with an authoritative zero」 | 用户决定：评论正文不走 Data API |
| M-65 | ytdlp_comments.py:92-147 | yt-dlp 映射：只收 parent 为 root 的；timestamp→UTC；reply_count=null；author_is_uploader、is_favorited→hearted；没有任何行且 total≠0 时 page=null；total=max(total, 行数)；保留截断前的原始总数（install_original_comment_count_capture） | 无 | 不适用 | YTDt「bounded extraction preserves the original total comment count」「yt-dlp comments normalize into the first-page contract without requiring an avatar」 | 新系统没有 yt-dlp |
| M-66 | L/youtube.js:162-207, 1685-1693 | yt-dlp 的 watch 初始数据规则：有 commentsEntryPointHeader/commentsHeader/commentThread/评论面板但没有计数 → zero_from_surface；`commentsDisabled` 键，或 messageRenderer 文本同时含 comment/coment 和 turned off/disabled/desativad/deshabilitad/desactivad → disabled；`engagementPanelTitleHeaderRenderer.contextualInfo` 当作计数 | 无 | 不适用 | — | yt-dlp 路径不移植；但新系统 getInfo 拿到的 next 响应里也有这些节点，可以作为 M-26、M-28 的实现参考 |

## F. 页结构、存储、回填和发布

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| M-67 | YCP:149-153, 237-249, 475-481 | 页 JSON：version 1、collected_at 为 ISO（非法时抛错）、sort、total_count（非负安全整数或 null）、returned_count、comments | ct:66-70，另有 refine：returned_count===comments.length，comment_id 唯一 | 一致 | YCPt「…keeps the stored first-page JSONB shape」 | — |
| M-68 | YCP:482-484 | 页面里还带 `comments_disabled`、`surface`（available/disabled/absent）和 `fetch_diagnostics` | ct:66 是 strictObject，没有这些字段；ct:75-76 的 summary 也没有 | 缺失 | YCPt「a successful bare continuation…」（page.comments_disabled） | — |
| M-69 | YCP:498-510 | `commentPageHasFirstPage`（version 1、sort 合法、returned==长度）和 `commentPageTotalCount` | ct:70 的 refine | 一致 | YCPt 多条 | — |
| M-70 | YCP:251-284 | resolution：状态集为 collected/zero_comments/disabled/confirmed_no_visible_threads/unresolved；`confirmedNoVisibleThreadsPage` 记录 observed_comment_count、checked_at、next_retry_at（默认 +7 天）和去重后的 sources | 无 | 缺失 | YCPt「two-source empty evidence remains unresolved until the official API confirms it」 | 旧系统的「确认」靠 Data API 作为第三个来源；新系统要用 web 证据另行设计 |
| M-71 | YCP:286-304 | `commentFirstPageNeedsResolution`：已禁用、zero_* 状态、已有 >0 条首页、resolution 为 zero_comments/disabled 时不需要；confirmed 状态下计数变化或到了 next_retry_at（时间非法也算到期）要重解；否则 count>0 或 total>0 就需要 | 无 | 缺失 | 同上 | — |
| M-72 | L/commentFirstPageBackfill.js:24-56, 58-183, 185-293 | 首页回填任务：按 batch 或 plan_day（当天增量首次见到的视频）挑出首页缺失或为空、未禁用、非 zero 状态、confirmed 未到期的视频，支持分片，limit 1–10000；只有在库里现有页 returned=0 并且（新页有评论，或库里计数为 0）时才写入；新的空页与库里正计数冲突时拒绝写；采集出错时只记录、不中断；取消信号要向上传播 | 无 | 缺失 | CFBt 全部 10 条：「empty or missing first pages need backfill」「only a resolved getComments page or disabled comments is persisted」「loadCommentBackfillTargets keeps only empty first pages from the requested batch」「…selects incremental first-seen videos by plan day」「…partitions a plan day into deterministic shards」「persistCommentFirstPage updates only comment fields」「backfillOneCommentFirstPage keeps going when getInfo throws」「…propagates channel cancellation instead of returning an error row」「…rejects an empty page that conflicts with a stored positive count」「…does not write an unresolved getComments result」 | 没有回填，M-38…M-41 丢掉的首页就永远补不回来 |
| M-73 | L/videoContentMutationPolicy.js:2-8；commentFirstPageBackfill.js:211-215 | 保留首页：库里已有非空页（returned>0）就保留；否则用新的非空页；否则 COALESCE(当前, 新) | sink:71-79 VIDEO upsert 用 `EXCLUDED.data` 整体替换（只有旧 stats 更新时保留三个计数），comments_ref/summary 会被新事实覆盖，可能变成 null | 不同 | CFBt「persistCommentFirstPage updates only comment fields」 | 重采（recovery 等）会把好的首页冲掉 |
| M-74 | P2:326-428, 519-524 | 多来源合并：可见评论（rank 3）> 禁用（2）> 有观察（1）；计数和首页分别按证据等级取；只要有可见评论，comments_disabled 就改成 false，disabled 状态改成 exact/unresolved | 无 | 不适用 | — | 新系统只有一个 web 提取器。将来补禁用检测时，「正数证据压过禁用」这条原则要保留 |
| M-75 | P2:447-464, 2462-2484 | 非 youtubeJsOnly 模式下，YouTube.js 判出的禁用先清空，再用 yt-dlp 复核（`comments_disabled_verification`）；youtubeJsOnly（checkpoint）模式直接采信 | 无 | 不适用 | — | 新系统没有 yt-dlp。原则是「禁用需要第二个证据」 |
| M-76 | P2:2540-2554；YJ:104-134 | YouTube.js 详情关闭时，单独用 `fetchYoutubeJsCommentFirstPage` 补首页；`inspectYoutubeJsCommentsSection`（YJ:98-102）供 probe 脚本使用 | 无 | 不适用 | — | 新系统没有这种模式，也没有 probe 运维脚本 |
| M-77 | schema `contents_comment_state_shape`；L/disabledCommentCountRepair.js | 约束是双向的：comments_disabled=true ⇔（comment_count=0 且 status='disabled'）；有修复工具（plan/apply、证据哈希、确认串、advisory lock） | ct:92 只有单向：comments_disabled=true ⇒ 0/disabled/无评论；status 为 disabled 而 comments_disabled 不是 true 时不报错。map 只在 disabled 时同时设置两者 | 不同 | DCSt「Crawler schemas require disabled comments to carry an authoritative zero」；DCRt 三条；DCRi「disabled Comment repair converts legacy null to zero and refreshes Publication hash」 | 新系统目前产不出 disabled，实际没有风险；补禁用检测时建议同时补反向约束 |
| M-78 | L/videoPublicationCurrent.js:176-182, 219-226 | 发布校验：comment_count 的已解析状态是 exact/zero_*/disabled，未解析是 unavailable/unresolved，必须有 observed_at；disabled 与 comments_disabled 不一致时报 `video_item_comment_state_invalid` | packages/store/src/publication-map.ts:8, 24-25：`resolved()` 接受 exact/estimated/disabled；不做一致性校验，由 adapter:433-438 在投影时拒绝 | 不同 | — | 结果大体等价，只是失败出现得更晚 |
| M-79 | L/businessPublicationProjectionAdapter.js:365-401, 415-431 | 业务投影：disabled → exact 0；zero_* → exact；其他非 exact → unavailable、值为 null；disabled 三元组不一致时拒绝 | adapter:368-401, 422-438 原样移植 | 一致 | BDPi「Business accepts legacy disabled/null snapshots but requires v4 disabled/zero」；DCSt「Business schemas keep legacy snapshots readable…」 | 新系统的 estimated 会被丢弃（M-21） |
| M-80 | 同文件 :729-798, 833-864 | engagement_rate_by_views = 100×Σ(likes+comments)/Σviews，只算三项都有的视频，全部 exact 才标 exact；comments_subscribers_ratio 用 average_comments | adapter:740-805, 840-870 原样移植 | 一致 | — | — |
| M-81 | YCP 页存在 PG `crawler.contents.comments_first_page` 里 | 首页 JSON 存在 Postgres | parser:117-125 正文写 MinIO（crawl-parsed，key 带 plan/epoch/unit/sha256），PG 只存 `comments_summary` 和 `comments_ref`；packages/contracts/src/pipeline.ts:24 禁止在 PG 存正文；store/src/index.ts:889-896 读取时返回 AVAILABLE/EXPIRED/NONE | 不适用 | — | 架构已经商定 |
| M-82 | incrementalYoutubeJsVideo.js:341-344, 1635-1639 | 变化概率 EWMA：评论数变化权重 0.15（views 0.70，likes 0.15，alpha 0.4）；engagementChanged 包括评论数变化 | packages/store/src/recent-sampling.ts:64-69；store/src/index.ts:449-460 | 一致 | — | 但 web 采样拿不到评论数（M-44），这个信号实际上没有 |
| M-83 | sink:95；store/src/index.ts:452 | 已禁用的视频，采样时保留库里的 comment_count（0） | 同 | 一致 | — | 旧系统禁用记录也保持 0/disabled |
| M-84 | P2:723-730 | members_only 且没有播放量时，用 likes/0.028 + comments/0.0028 估算播放量（status estimated，source likes_comments_estimate） | 没有找到 | 缺失 | — | 属于播放量组，列在这里防止遗漏 |
| M-85 | L/detailPolicy.js:92-101, 125-133 | comment_count 缺失本身不触发 yt-dlp 回退；comment_count 已知时可以证明「点赞缺失记为 0」 | 无 | 不适用 | — | yt-dlp 回退不移植；点赞那条属于点赞组 |
| M-86 | activities.ts:244 | （新系统非 web 的旧 Data API 模式备用路径）调 topComments 时没有 `.catch`，评论失败会让整批失败，由 Temporal 重试 | 同 | 不适用 | — | 不在生产 web 路径上；它的行为反而更接近旧系统的 strict 模式 |

## G. Agent 读取的评论

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| M-87 | L/agentIdentityContext.js:1-80；P2:4233-4247, 4401；L/llmAgent.js:251, 271-272 | LLM 身份上下文：每个频道按 published_at 倒序取最新 8 个内容（video/short/live）的首页，只要 `is_channel_owner===true` 的评论，最多 4 条，空白折叠后截到 120 字符（超出加 …），附带 is_pinned；提示词规定 creator_gender/age 以这一块为主要证据 | 新系统没有 LLM Agent，也没有 first-party identity context（只有本地 profile-agent） | 缺失 | — | 如果 LLM Agent 由其他组负责，请对照那边 |
| M-88 | local-agent snapshot_repository.py:240-280；runtime.py:18-45；contracts.py:158-190 | 本地 Agent 取每个频道 content_limit 个最新内容的首页。页校验：version 1、**只接受 TOP_COMMENTS**、returned==长度、id 唯一、collected_at ≤ as_of；不合格的页单独剔除，记到 `provenance.invalid_comment_pages`，快照其余部分照常 | store/src/index.ts:1133-1151 从 MinIO 回填 comments_first_page（目标视频或最新 video_limit 个）；profile-agent/qy_channel_profile/contracts.py:166-167 接受 TOP 和 NEWEST；profile_agent/adapter.py:101-103 标记 mixed_first_page；contracts.py:388 collected_at > as_of 时**整个快照**报错 | 不同 | — | NEWEST 页旧系统会剔除，新系统会使用；单页不合格时新系统让整个快照失败 |
| M-89 | local-agent comment_features.py、creator_evidence.py:353-357 | 评论特征（owner ratio、非空页比例等）和频道主评论证据 | apps/profile-agent/qy_channel_profile/comment_features.py 与旧文件逐字节相同 | 一致 | — | 输入质量不同：published_at 全为 null（M-54），is_verified/hearted 的 null 被当成 False（M-62、M-63），禁用状态缺失（M-22），这些都会改变特征值 |

## 统计

总计 89 条：一致 31、不同 30、缺失 17、不适用 11。

- 一致：M-1, 3, 4, 8, 9, 10, 11, 14, 16, 20, 31, 36, 45, 48, 50, 52, 53, 55, 56, 57, 58, 59, 60, 61, 67, 69, 79, 80, 82, 83, 89
- 不同：M-2, 5, 6, 13, 15, 17, 18, 19, 21, 27, 28, 29, 30, 32, 33, 37, 39, 40, 41, 44, 47, 49, 51, 54, 62, 63, 73, 77, 78, 88
- 缺失：M-7, 22, 23, 24, 25, 26, 34, 35, 38, 42, 43, 68, 70, 71, 72, 84, 87
- 不适用：M-12, 46, 64, 65, 66, 74, 75, 76, 81, 85, 86

## 不同 / 缺失：按影响排序

1. **禁用检测整体缺失，而且会写错值**（M-22、M-23、M-24、M-25、M-26、M-29、M-37）：scrape 从不返回 `disabled`；没有计数也没有正文的页一律写 `comments_disabled=false`，评论被关闭的视频很可能被记成「未禁用 + unresolved」。API 回退路径也不按 statistics 里缺 commentCount 判禁用。可以直接照搬的部分：葡语/英语正则、跳过 commentSimplebox、「有评论证据就不算禁用」的前提，以及 watch next 页 Message 节点（M-26，不需要额外请求）。
2. **采样永远不刷新评论数**（M-44）：web 的 SAMPLING 走 getBasicInfo、跳过评论，comment_count 恒为 null，pg-sink 保留旧值。旧系统 metrics 模式每次都请求评论区。评论数会越来越旧，变化概率里评论那 0.15 的信号也失效。
3. **评论发布时间全为 null**（M-54）：`estimateRelative` 只认英文；`localized.ts` 里的 `localizedEstimatedUtcTimestamp` 已经移植并有 pt-BR 测试，只是没接上。改一行就能修。
4. **评论失败被静默吞掉：不重试、不失败详情、不惩罚代理**（M-38、M-39、M-40、M-41、M-2）：任何错误（包括封禁、网络错误、youtubei.js 解析崩溃）都变成 `unavailable`，整页丢失、计数只能靠入口 hint。旧系统对传输类错误重试 1 次，然后让详情失败进入重试/恢复。M-2 的 youtubei.js 解析崩溃风险需要用回放验证。
5. **零评论、直播/首映、空响应的计数变成 unresolved**（M-30、M-34、M-35、M-28、M-19）：EMPTY 加 '0' 的分支把计数丢了（bug）；直播/首映没有 zero 策略；「评论区存在但没有 header 计数」不再给 zero_from_surface；也不用 returned_count 兜底。这些和 M-38…M-41（失败被吞）、M-44（采样不刷新）一起，是 28.7% unresolved 的主要候选来源，需要按视频抽样确认各自的占比。
6. **缩写评论数在业务库里变成 null**（M-21）：新系统新增的 `estimated` 状态被移植过来的业务投影 `countValue` 映射成 unavailable。
7. **重采会冲掉已有的首页；重复 comment_id 会让整条视频事实失败**（M-73、M-47）。
8. **没有首页回填和 resolution 机制**（M-70、M-71、M-72）：丢掉的首页永远补不回来；需要用只走 web 的证据重新设计「确认没有可见线程」。
9. **NEWEST 回退的机制、范围和诊断不同**（M-5、M-6、M-7、M-68）：客户端 sortBy=1 代替服务端 token；所有路径都回退；没有 fetch_diagnostics、surface 字段。
10. **Agent 输入差异**（M-87、M-88）：LLM 身份上下文（频道主评论 4 条 × 120 字）缺失；本地 Agent 会接受 NEWEST 页，单页不合格时整个快照失败。
11. **年龄限制**（M-33）：新系统直接判为终止态 unavailable，旧系统保留指标并把评论记为禁用。跨组问题，交给可访问性组。
12. **影响较低的项**：M-15（不读 countText）、M-17（hint 解析不严格）、M-18（计数解析器简化）、M-13（文本截断）、M-32、M-49、M-51、M-62、M-63（null、'N/A'、/N/A 的取值差异）、M-42、M-43（诊断和字段状态）、M-77（反向约束）、M-78（校验时机）、M-84（members_only 播放量估算，属播放量组）。
