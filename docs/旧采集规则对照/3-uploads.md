# 第 3 组：上传列表与目标选择（全量 + 增量发现）规则对照

- 旧系统（L）：`/home/ubuntu/workspace/oldsystem/services/qybullmq/src/`，测试在 `.../qybullmq/test/`
- 新系统（N）：`/home/ubuntu/workspace/crawlsystem-business`（HEAD `919eecc`）
- 范围：L/youtubeJs.js 317–637、1213–1300、1354–1418；youtubeUploadsCountry.js；fullCrawlYoutubeJsFactory.js；fullCrawlYoutubeJsModel.js；fullCrawlFetchContract.js；fullCrawlScanEvidence.js；contentWindow.js；incrementalVideoPlanner.js；collectedVideoOutcome.js；videoDisposition.js；videoActivityLifecycle.js；videoActivityEvidence.js；initialFullObservations.js；channelDormancy.js；incrementalYoutubeJsVideo.js 的发现/锚点/空列表/休眠/采样部分。为说清规则，补读了直接依赖：incrementalVideoBatchPlan.js、migrationActivityPolicy.js、publicationTimeEvidence.js、detailPolicy.js、youtubeContentType.js、youtubeLoginRequired.js、fullCrawlYoutubeJsStore.js、incrementalChannelRunner.js。
- 状态：一致 / 缺失 / 不同 / 不适用（说明原因）。“机制不同”但采集结果相同的记为一致。
- 已有问题编号见 `docs/推进计划_2026-10-08.md` §7.2（D4、D8、D9、D18、R6、R8 等），备注里引用。
- 测试名写法：`文件「测试名」`，文件都在 L/test/ 下。

## 规则表

### A. 上传列表条目归一（youtubeJs.js 317–403）

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| U-1 | youtubeJs.js:323-334 | 条目视频 ID 按以下顺序取：`video_id` → `id` → `content_id` → `endpoint.payload.videoId` → `on_tap_endpoint.payload.videoId` → `on_tap_endpoint.payload.reelWatchEndpoint.videoId` → `entity_id`（去掉 `shorts-shelf-item-` 前缀） | apps/execution-worker/src/youtube/web-scrape.ts:79-81 | 一致 | youtubeJs.test.js「feed items retain their Video ID while only explicit Upload signals set a type」「Uploads recognizes a reel endpoint as a Shorts URL fallback」 | 顺序与字段相同 |
| U-2 | youtubeJs.js:324-333 | ID 只要求 trim 后非空，不校验格式 | web-scrape.ts:82 | 不同 | 同上 | 新系统要求 `/^[\w-]{11}$/`，不匹配直接抛 parse，整个 TARGETS 步失败（旧系统只把真正缺 ID 的条目记为 parse gap） |
| U-3 | youtubeJs.js:419-427 | 没有 ID 的条目记 `parse_gap_count+1`，跳过并继续遍历；有 parse gap 时扫描判为不完整 | web-scrape.ts:82 | 不同 | youtubeJs.test.js「Uploads parse gaps disable the migration activity short-circuit」「incremental Upload scan treats a parse gap as Partial coverage」；youtubeUploadsCountry.test.js「an invalid item or a failed continuation never becomes normal empty uploads」 | 新系统遇到一个坏条目就让整步失败并重试（D8）。旧系统：全量照用其余条目，只把活跃度证据标为不完整；增量则判为部分完成（partial） |
| U-4 | youtubeJs.js:428-429 | 同一次遍历中重复的 ID 跳过：不触发 visit，不占限额，不占位置（`inspectedCount` 仍计数） | web-scrape.ts:83-85 | 不同 | youtubeJs.test.js「Full Crawl retains its frozen duplicate-page stop while Incremental inspects the terminal page」「shared traversal preserves selected positions versus raw positions and anchor stopping」 | 新系统的 ids 去重，但 `scanned` 把重复也计入，而增量 100 条的放弃阈值正是用它判断 |
| U-5 | youtubeJs.js:346-367,377-379 | 列表上的 Shorts 提示：导航 URL 为 `/shorts/{同一 id}`，或 `content_type==="SHORT"`，或节点类型是 `ReelItem`/`ShortsLockupView`；有 `reelWatchEndpoint` 时合成 shorts URL。type_source=`youtube_uploads_url:shorts` | 无（web-scrape.ts:70-94 只返回 ID；类型只看播放器 web-scrape.ts:125,129） | 缺失 | youtubeJs.test.js「Uploads preserves only explicit type evidence without requesting content tabs」「Uploads recognizes a reel endpoint as a Shorts URL fallback」「feed items retain their Video ID while only explicit Upload signals set a type」 | 旧系统中列表提示属于非权威证据（youtubeContentType.js:174-183，authoritative=false），作为候选的 discovery_classification 留证，并在直播被终止时提供 type_source。新系统在播放器没有信号时默认 `video`（`default:shorts_unknown`）。原件已归档，可以离线补回 |
| U-6 | youtubeJs.js:375-376,380-385 | 列表上的直播/预告提示：`is_live` 或 `is_upcoming` 时 content_type=`live`（优先于 short），type_source=`youtube_uploads_live_flag`；`upcoming` 为 Date 时记 upcoming_at | 无 | 缺失 | youtubeJs.test.js「incremental Upload scan never advances when Catch-up cannot find any backup Anchor」（含 is_live 条目）；fullCrawlYoutubeJsModel.test.js「known old and upcoming targets are terminal before a player request」 | 这是 U-45、U-86、U-87 的前提（D4） |
| U-7 | youtubeJs.js:386-402,609-625 | 目标条目带列表元数据：title、url（无导航 URL 时为 watch URL）、缩略图、duration（>0 才取）、view_count、published_text、live_status、live_scheduled_at、type_membership | 无（manifest 只存 video_ids） | 不同 | youtubeJs.test.js「feed items retain their Video ID while only explicit Upload signals set a type」 | 新系统的详情页会提供这些字段；但旧系统对预排除的直播/预告目标不请求播放器，正是用这些列表字段生成候选记录（fullCrawlYoutubeJsModel.js:133-155） |
| U-8 | youtubeJs.js:450-458 | 列表相对时间（如 “3 days ago”）按会话语言换算为 UTC 日，记 status=`relative`、precision=`date_only`、source=`youtube_uploads_relative_time`；解析不出时为 unresolved | 无 | 缺失 | publicationTimeEvidence.test.js「normalizes the three Uploads publication evidence variants」 | 用途：增量时更新已知视频的发布证据（只在证据更强时覆盖）、给库里没有日期的内容提供近期采样日期、作为活跃度证据（relative 一律算不确定）。会话语言见 D2 |

### B. 遍历与全量取列表（youtubeJs.js 405–637、1213–1300）

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| U-9 | youtubeJs.js:405-448 | 逐页读取 `page.videos` 或 `page.items`；每页读完后决定是否 `getContinuation()` | web-scrape.ts:73-92 | 一致 | youtubeJs.test.js「shared traversal preserves selected positions versus raw positions and anchor stopping」 | |
| U-10 | youtubeJs.js:51,466-468,471-477 | 全量页数上限 `YOUTUBEJS_MAX_TAB_PAGES`（默认 20）。到上限就停，terminal_reason=`max_pages`，truncated=true；已取到的条目仍作为目标 | web-scrape.ts:90 | 不同 | youtubeJs.test.js「Full Crawl stops at its page budget without fetching an uninspected continuation」 | 新系统到 20 页时抛 parse “insufficient progress”，整步失败 |
| U-11 | youtubeJs.js:469 | 全量“重复页停止”：续页加载后，如果上一页没有新增 ID 且新页没有续页，就停，不再读这一页 | 无 | 不同 | youtubeJs.test.js「Full Crawl retains its frozen duplicate-page stop while Incremental inspects the terminal page」 | 影响小 |
| U-12 | youtubeJs.js:437-446 | 全量翻页失败直接抛错，交给上层重试 | web-scrape.ts:93 | 一致 | youtubeJs.test.js「shared traversal propagates Full Crawl pagination errors but returns Incremental partial evidence」 | 增量的情况见 U-69 |
| U-13 | youtubeJs.js:415,440,442 | 每页开始、每次续页前后检查取消；取消不能变成停止原因 | web-collector.ts:28（AbortSignal、Temporal 取消） | 不适用 | youtubeJsCancellation.test.js「scanYoutubeJsFeed does not turn pagination cancellation into a stop reason」 | 取消改由 Temporal 和 AbortSignal 处理，不形成扫描结论 |
| U-14 | youtubeJs.js:589,1234；fullCrawlYoutubeJsStore.js:291 | 全量条数上限：默认 30，限定在 1–100（`YOUTUBE_CHANNEL_CONTENT_LIMIT`） | packages/contracts/src/index.ts:128；web-collector.ts:134 | 一致 | youtubeJs.test.js「Uploads records an explicit item-cap boundary when continuation remains」 | video_limit 默认 30，范围 1–100 |
| U-15 | youtubeJs.js:463-466 | 全量按上传列表顺序取最新 N 条，满 N 条即停 | web-scrape.ts:86 | 一致 | 同上 | |
| U-16 | youtubeJs.js:471-483 | 全量停止原因：list_end / max_items / max_pages；有 parse gap 时 stop_reason=`parse_gap`，complete=false；同时记 truncated 和 terminal_reason | web-scrape.ts:86,89 | 不同 | youtubeJs.test.js「Uploads records an explicit item-cap boundary when continuation remains」 | 新系统满额时也返回 `list_end`，另用 `exhausted` 表示读完。`exhausted` 的计算式 `scanned === page.videos.length` 只在第一页就结束时为真：列表在第 2 页以后才结束时会被误报为“未读完”（影响提示文案和 manifest 的 exhausted 字段） |
| U-17 | youtubeJs.js:590 | uploads 播放列表 ID：以 UC 开头的频道 ID 换成 UU，否则原样使用 | web-scrape.ts:73 | 一致 | — | 新系统契约只接受 UC 频道 ID |
| U-18 | youtubeJs.js:591-597,1354-1356；fullCrawlYoutubeJsFactory.js:139-144 | hasContent 门槛：频道没有视频/Shorts/直播页签，且视频数为 0 时（全量另看待提交 About 的 total_video_count、频道 total_video_count、available_tabs 是否非空），不请求上传列表，直接记为空（absent，uploads_missing=true），进入空列表决定 | 无（总是请求） | 不同 | fullCrawlYoutubeJsFactory.test.js「pending About video count still requests uploads when all content tabs are hidden」 | 新系统多发一次请求；如果 YouTube 对无内容频道返回“列表不存在”，新系统会判失败（见 U-22） |
| U-19 | youtubeJs.js:598-600 | 本应有内容但取回 0 条且扫描不完整（parse gap 或到 max_pages）时，抛错重试，不能当作空列表 | web-scrape.ts:82,90（这两种情况都会抛错） | 一致 | youtubeUploadsCountry.test.js「an invalid item or a failed continuation never becomes normal empty uploads」 | 机制不同，结果一致 |
| U-20 | youtubeJs.js:601-604,1404-1407；youtubeUploadsCountry.js:108-121 | 正常空列表须经校验：第一页无条目且无续页时，browse 响应必须 0 个 videoId，且带 “no videos in this playlist” 或 “this playlist is empty” 提示（或满足 U-22 的缺失证据），否则抛 `UPLOADS_EMPTY_RESPONSE_UNVERIFIED` 重试。空页但有续页时照常翻页 | web-scrape.ts:89；web-collector.ts:143 | 缺失 | youtubeUploadsCountry.test.js「HTTP 200 without video nodes needs an explicit empty-playlist message」「an invalid item or a failed continuation never becomes normal empty uploads」 | 新系统把任何“0 条且无续页”都当作已确认的空列表（D8）。未知渲染器会被静默当成空 |
| U-21 | youtubeUploadsCountry.js:74-95；youtubeJs.js:985-989,1214 | 每次 browse 响应提取上传证据：videoId 个数、messageRenderer 文本、alertRenderer ERROR 文本（各最多 5 条、每条 300 字）；每次取列表前先清空 | 无（原始响应已归档，raw-archive） | 缺失 | youtubeUploadsCountry.test.js「HTTP 200 without video nodes needs an explicit empty-playlist message」 | U-20 和 U-22 都依赖这些证据，可以从已归档原件离线提取 |
| U-22 | youtubeUploadsCountry.js:97-106；youtubeJs.js:1213-1226 | 缺失上传列表须有结构化证据：错误消息恰为 “The playlist does not exist.”，info.type=Alert，alert_type=ERROR，且响应证据为 0 个 videoId、只有这一条错误。满足时按空列表处理（进入国家重查或休眠）；其它错误（含网络错误）照常抛出 | web-collector.ts:138-142；scrape.ts:18（404 或文本含 not found / does not exist 即判 not_found） | 不同 | youtubeUploadsCountry.test.js「missing uploads require structured YouTube evidence, never a transport error or lost video」「explicit unavailable uploads enter Full Crawl country recheck and incremental empty scan」 | 新系统识别更宽松（只看文本），而处理更严：重查失败后直接抛错，计划失败（D8）。旧系统的结果是“休眠、正常结束” |
| U-23 | youtubeJs.js:619 | 目标位置 = 选中顺序 + 1 | activities.ts:206-208,218-219（manifest 的 video_ids 顺序） | 一致 | fullCrawlYoutubeJsModel.test.js「target normalization rejects duplicate identity and position」 | |
| U-24 | youtubeJs.js:626-637,1252-1290 | 统计类型计数（video/short/live/unresolved）、untyped_ids、raw 统计（请求数、耗时、页数） | 无 | 不适用 | — | 只用于诊断；新系统用原件和执行事件代替 |
| U-25 | youtubeJs.js:636,1261 | activity_evidence_complete = (parse_gap_count==0)，供全量活跃度闸门使用 | 无 | 缺失 | youtubeJs.test.js「Uploads parse gaps disable the migration activity short-circuit」 | 随休眠（D18）一起做 |

### C. 空列表、缺失列表与国家重查（youtubeUploadsCountry.js）

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| U-26 | youtubeUploadsCountry.js:6-9 | 国家码规范化：trim 后转大写，须是两个字母 | apps/execution-worker/src/youtube/region.ts:188-191 | 一致 | — | |
| U-27 | youtubeUploadsCountry.js:24-31 | 空列表决定使用 About 上的国家（或已持久化的重查国家），不用界面语言；没有国家时 reason=`no_country`，直接判 dormant | web-collector.ts:76-87 | 不同 | youtubeUploadsCountry.test.js「normal empty uploads settle dormant: ${reason}」 | 新系统先取本计划已归档 About 的 country_code，没有就查一次 Data API channels（耗配额）。没有国家时保留空结果，不判休眠（D5：country_code 几乎全空，所以实际几乎都走 Data API） |
| U-28 | youtubeUploadsCountry.js:33 | 当前出口国与频道国家相同时 reason=`country_checked`，不再重查 | web-collector.ts:90 | 一致 | 同上 | 新系统在国家等于 BR（默认）时不重查；结果都是“空列表成立”，但新系统没有 dormant 结论（见 L 节） |
| U-29 | youtubeUploadsCountry.js:34-37；fullCrawlYoutubeJsFactory.js:345-357 | 全量：出口国与频道国家不同且还没重查过时，抛 `UploadsCountryRecheck`，换该国路由重新取列表 | web-collector.ts:135,141,143；region.ts | 一致 | youtubeUploadsCountry.test.js「empty Full Crawl uploads request a country handoff, not a network retry」 | 新系统用该国代理加 YouTube location 重做一次（并核对出口），结果相同 |
| U-30 | youtubeJs.js:1404-1407；youtubeUploadsCountry.js:26-40 | 增量：完整扫描结果为空时同样走国家重查，之后判 dormant | web-collector.ts:143 | 不同 | youtubeUploadsCountry.test.js「explicit unavailable uploads enter Full Crawl country recheck and incremental empty scan」 | 新系统只在 `!anchors` 时重查。UPDATE 计划总会传 anchors（至少是 `[]`），所以增量空列表从不重查 |
| U-31 | youtubeUploadsCountry.js:34-35 | 已重查过：同一国家且状态为 unavailable 时 reason=`no_country_reserve`，否则 `country_recheck_exhausted`，结果都是 dormant | web-collector.ts:35,60,94（RegionUnavailable：没有该国代理、等待超过 120s、或 3 次出口不符） | 一致 | youtubeUploadsCountry.test.js「a no-country-reserve receipt finishes Full Crawl without another request on the old IP」「normal empty uploads settle dormant: ${reason}」 | “没有该国储备就保留默认结果”这一点一致；新系统没有 dormant 结论 |
| U-32 | youtubeUploadsCountry.js:42-50；incrementalChannelRunner.js:128-133 | 休眠探测：已保存国家而当前出口不同时，先要求该国路由；没有储备就不发任何请求，保持休眠 | 无 | 缺失 | youtubeUploadsCountry.test.js「dormant country probes request a route before scanning, or stay dormant without reserve」；incrementalChannelRunner.test.js「dormant probe with no country reserve finishes without even opening a channel session」 | 随 D18 |
| U-33 | youtubeUploadsCountry.js:52-58；youtubeJs.js:591-597；incrementalChannelRunner.js:120-127 | 已在国家重查上下文中、出口国仍不符时，不再抓取，直接得到空列表决定（全量 entries=[] 且完整；增量用 dormantUploadsScan） | web-collector.ts:89-97（重查失败后保留默认结果，不重复抓默认列表） | 一致 | youtubeUploadsCountry.test.js「a no-country-reserve receipt finishes Full Crawl without another request on the old IP」 | 机制不同：新系统在同一单元内先抓默认、再试该国 |
| U-34 | youtubeUploadsCountry.js:60-72 | dormantUploadsScan 的结构：complete=true、list_end、保留 active_anchor、request_count=0 | 无 | 不适用 | — | 内部数据形状；它的含义（不推进锚点）见 U-79 |
| U-35 | fullCrawlYoutubeJsStore.js:672-676；videoActivityLifecycle.js:477-483 | 把空列表决定（或 null）作为 `uploads_recheck` 持久化到频道，供以后的休眠探测取国家 | 无 | 缺失 | — | 随 D18 |
| U-36 | youtubeJs.js:598-604 | 只有空结果才触发国家决定；在他国重查时取到非空列表，就照常使用并保留截断 | web-collector.ts:141-143 | 一致 | youtubeUploadsCountry.test.js「nonempty uploads preserve Full Crawl truncation even on another country」 | |

### D. 全量编排、窗口与冻结（fullCrawl*、contentWindow）

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| U-37 | fullCrawlFetchContract.js:4-183 | 全量抓取合约：legacy_full_v2、youtubejs_full_v1/v2/v3，manifest 带 hash，默认 v3，修复类任务走 legacy，版本不得中途切换 | 无 | 不适用 | fullCrawlFetchContract.test.js 全部 7 项 | 由新系统的冻结输入（FrozenInput）、input_hash 和原件替代 |
| U-38 | fullCrawlYoutubeJsFactory.js:146-154 | 冻结设置：content_limit 来自 run，content_max_age_days 来自 run.result_json，观测时间用 run.started_at | contracts/src/index.ts:127-131,161；store index.ts:409（reference_time） | 一致 | fullCrawlYoutubeJsFactory.test.js「Uploads checkpoint recovery does not fetch Channel again」 | |
| U-39 | fullCrawlYoutubeJsFactory.js:350-352 | 全量国家来源：country_observation.code；没有时用 country_source=youtube_about 的 country_code | web-collector.ts:80-82 | 不同 | — | 新系统多了 Data API 兜底，见 U-27 |
| U-40 | fullCrawlYoutubeJsFactory.js:358-367；migrationActivityPolicy.js:24-91 | 全量活跃度闸门。触发条件：迁移标志，或空列表决定为 dormant。用列表条目评估：预告不计入，直播中算不确定；发布证据按 90 天窗口判断（只有 exact 证据能下结论）。证据不完整→pending；有近期内容→continue；有不确定→inconclusive；否则 dormant，此时 targets=[] | 无 | 缺失 | migrationActivityPolicy.test.js 全部 11 项；youtubeJs.test.js「Uploads with a normal empty playlist and no country returns a dormant decision」 | 用户 10-09 决定迁移部分不做；但“空列表→dormant”不是迁移专用，属于 D18 要移植的内容 |
| U-41 | fullCrawlYoutubeJsFactory.js:177-203,490-492；fullCrawlYoutubeJsStore.js:974-980 | 全量判为休眠时：结果 skipped=true，交接原因 `migration-activity-dormant`，频道不进入 Agent（只有 not_required 时 Agent 才可执行） | 无（Agent 照常运行） | 缺失 | initialFullObservations.test.js「dormant initial Full observations consume About and reuse the Activity Gate Video」；migrationActivityGate.test.js「migration activity gate admits the Channel as dormant and preserves About for Finalize」 | 随 D18 |
| U-42 | fullCrawlYoutubeJsStore.js:607-660 | 冻结目标：记录 uploads_hash 和 target_hash；重放必须一致；Uploads 检查点之前不能已有候选 | store index.ts:640-653（第一份 manifest 冻结，之后再提交即 CONFLICT） | 一致 | fullCrawlYoutubeJsModel.test.js「Uploads and target hashes are stable across object key order」；fullCrawlYoutubeJsStore.test.js「restore rejects a document whose entries differ from its frozen Candidate set」 | 机制不同 |
| U-43 | fullCrawlYoutubeJsModel.js:79-96 | 目标中重复的 video_id 或 position 一律拒绝 | contracts/src/index.ts:174 | 一致 | fullCrawlYoutubeJsModel.test.js「target normalization rejects duplicate identity and position」 | |
| U-44 | fullCrawlYoutubeJsModel.js:45-77 | 目标字段归一：缺省 published_at_status=unresolved、precision=unknown，type_membership 去重排序 | 无（目标只有 ID） | 不适用 | — | |
| U-45 | fullCrawlYoutubeJsModel.js:157-167；fullCrawlYoutubeJsFactory.js:415-436 | 详情前预分类：列表标为预告→`upcoming_live`；直播中（is_live 且不是回放）→`live_in_progress`。这两类都不请求播放器，用列表字段生成候选，记 content_type=live | 无（照常请求详情，并以 live 入库） | 不同 | fullCrawlYoutubeJsModel.test.js「known old and upcoming targets are terminal before a player request」 | D4：新系统把预告/直播当作定稿入库，之后不再补全 |
| U-46 | fullCrawlYoutubeJsModel.js:168-171；contentWindow.js:31-37 | 详情前窗口检查只认 exact 发布证据。列表相对时间是 relative，会被判 unresolved，所以列表日期永远不会导致预排除 | 无 | 一致 | contentWindow.test.js「isOutsideContentWindow uses exact instants and keeps ambiguous evidence」 | 两边对列表目标都不做预排除，效果相同 |
| U-47 | fullCrawlYoutubeJsFactory.js:161-171,452-458；contentWindow.js:31-41；publicationTimeEvidence.js:226-268；fullCrawlYoutubeJsStore.js:292 | 详情后：预告→upcoming_live；直播中→live_in_progress；contentMaxAgeDays>0（默认 90，0 表示关闭）且窗口为 outside 时，记 `outside_content_window` 终止排除，不写入 contents。outside 的判定：秒精度为 ≤截止时刻；日期精度为发布日早于截止日。截止日当天算 cutoff_overlap，不排除 | contracts/src/index.ts:125-129（注释“web collection has no age cutoff”）；store index.ts:645-647（window_start=epoch）；交付时才按 90 天/30 条过滤：packages/store/src/publication-map.ts:36-42 | 不同 | contentWindow.test.js「detailAgeDays uses UTC calendar days at the 90-day boundary」「isOutsideContentWindow excludes only known out-of-window content」；publicationTimeEvidence.test.js「classifies the real ITDP and Boxe timestamps at the exact 90-day cutoff」「exact date-only evidence on the cutoff day overlaps the cutoff instant」 | 新系统把最新 N 条全部入库，包括 90 天以前的；交付时再按窗口过滤，所以交付结果相同，但库存、锚点来源和 Agent 输入都不同。有意差异需要记录在案 |
| U-48 | fullCrawlYoutubeJsFactory.js:422-424；fullCrawlYoutubeJsStore.js:796-806；youtubeLoginRequired.js:36-48 | 已知 login_required：该视频最新已结算处置是 login_required（next_attempt=infinity）时，全量不再请求详情，直接按终止处理 | 无（每个计划都会重新跑 WEB+IOS，web-scrape.ts:141-167） | 缺失 | youtubeLoginRequired.test.js「permanent exclusions survive later discovery and low-frequency repair」；incrementalYoutubeJsVideo.postgres.integration.test.js「Full Crawl stores durable login exclusions for subsequent work」 | D9 |
| U-49 | fullCrawlYoutubeJsStore.js:756-806 | 详情按 position、candidate_id 顺序逐个处理 | activities.ts:229-236（按顺序每 10 个一批） | 一致 | fullCrawlYoutubeJsFactory.test.js「Detail checkpoint recovery fetches only unfinished Candidates」 | |
| U-50 | fullCrawlYoutubeJsStore.js:663-668 | 非空列表时，把该频道全部 contents.is_recent 置为 false | 无 | 不适用 | — | 旧存储标志 |
| U-51 | fullCrawlYoutubeJsStore.js:677-701 | 类型未解析的候选也照常进入详情：type_status=unresolved，列表分类作为 discovery_classification 留证 | activities.ts:229-252 | 一致 | fullCrawlYoutubeJsFactory.test.js「untyped API evidence is committed unresolved and subsequent video details still run」 | 两边都由详情决定类型 |
| U-52 | fullCrawlScanEvidence.js:12-46 | 扫描证明一致性：两个 hash、计数、候选处置（只允许 stored/terminal_excluded/deferred）、详情状态都要对得上 | store index.ts:693-695（plan_items 必须覆盖全部冻结目标） | 不适用 | fullCrawlScanEvidence.test.js「checkpoint repair must close the frozen Full Crawl receipt before finalization」 | 改用回执和 plan_items 校验 |
| U-53 | fullCrawlScanEvidence.js:50-66 | 修复任务关闭冻结证明后才能定稿 | — | 不适用 | 同上 | 旧修复流程专用 |

### E. 首次全量观测基线（initialFullObservations.js）

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| U-54 | initialFullObservations.js:166-212 | 全量扫描证明的终止条件：合格内容≥30→`qualified_item_limit`；请求上限 30、窗口 90 天、选中 30、检查≥30、无详情失败、停止原因 max_items→`candidate_limit_processed`；越过年龄边界→`age_boundary_crossed`；读到列表末尾→`list_end`；有 parse gap 或详情未完成→没有终止条件（partial） | publication-map.ts:42（window_proof 固定写成 complete / durable_finalized_window） | 不同 | initialFullObservations.test.js「Publication Repair marks a capped deep scan Complete only after 30 qualified items」「Publication Repair keeps an exhausted or parse-gapped scan Partial」「a shorter collection window cannot prove the 90-day Publication list end」 | 交付证明属于发布组，这里只记它对采集完整性的依赖 |
| U-55 | initialFullObservations.js:510-517 | 年龄边界判定：候选 scope.reason 为 older_than_max_age、after_chronological_age_cutoff 或 outside_content_window。详情失败判定：unavailable、deferred，或有 missing_fields | 无 | 不同 | initialFullObservations.test.js「Publication Repair preserves age-boundary proof after old Candidates leave Contents」 | 同 U-54 |
| U-56 | initialFullObservations.js:278-281 | 首轮增量的锚点：本次全量入库内容中有发布时间的前 20 个（按 published_at DESC） | store index.ts:503-505 | 一致 | initialFullObservations.test.js「initial Full Video baseline is derived only from retained Contents」 | 新系统取已完成计划写入、非不可用、有发布时间的视频，按发布时间降序取前 20。因为新系统不排除 90 天外的旧视频，锚点集合可能不同（见 U-47） |
| U-57 | initialFullObservations.js:57-79 | 同一视频有多条记录时，按证据强弱去重：有时间 > 精度 > 类型（live>short>video）> 观测时间 | 无 | 不适用 | initialFullObservations.test.js「initial Full Video baseline deduplicates Contents by YouTube Video ID」 | 新表主键是 (workspace, channel, video)，天然唯一 |
| U-58 | initialFullObservations.js:236,259-270 | 近期池：UTC 30 天内发布；stale 指播放器观测已满 7 天 | packages/store/src/recent-sampling.ts:8-10；store index.ts:506-507 | 一致 | initialFullObservations.test.js「initial Full Video baseline counts the UTC 30-day pool instead of the 90-day retention flag」 | |
| U-59 | baselineBundle.js:128-145 | discovery 基线：first_seen 最多 30 条，并带扫描证明 | 无 | 不适用 | — | 观测载荷格式 |

### F. 增量扫描（scanYoutubeJsFeed，youtubeJs.js 489–580、1364–1418）

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| U-60 | incrementalVideoPlanner.js:211-222；youtubeJs.js:489-517；incrementalYoutubeJsVideo.js:3570-3574 | 增量扫描参数：maxPages 默认 20（可配 1–100），catchUpMaxItems 默认 50（可配 1–500），两者冻结进批次 | web-scrape.ts:87,90（固定：总共 100 条、20 页） | 不同 | incrementalVideoPlanner.test.js「Video Discovery gives Catch-up a separate 50-ID budget」 | |
| U-61 | youtubeJs.js:525-534,551-555 | 第一页全部检查，且不占追赶预算；从续页开始的条目才计入追赶预算（50）。首页之外累计 50 条仍没碰到锚点，就以 `catchup_limit` 停止 | web-scrape.ts:87（scanned 含第一页、含重复，到 100 即放弃） | 不同 | youtubeJs.test.js「incremental Upload scan enters Catch-up after checking the complete first page」「incremental Upload Catch-up stops before an Anchor beyond its 50-ID budget」「incremental Upload Catch-up accepts an Anchor at its 50th ID」「incremental Upload scan checks the complete first page before applying its Catch-up cap」 | uploads 第一页通常就有约 100 条：旧系统约看到 150 条才放弃，新系统看完第一页就放弃。锚点在第 101–150 条之间时，旧系统能收齐全部新视频，新系统只留最新 30 条 |
| U-62 | youtubeJs.js:496-506 | 锚点按 ID 去重、保持顺序，published_day 规范为 YYYY-MM-DD | contracts/src/index.ts:156；store index.ts:503-505 | 一致 | incrementalVideoPlanner.test.js「Video Discovery preserves the database order and requires a publication day」 | |
| U-63 | youtubeJs.js:539-549 | 碰到任一锚点就停（`anchor_matched`）。按 ID 精确匹配，不会因为发布日期已越过锚点而提前停 | web-scrape.ts:84 | 一致 | youtubeJs.test.js「incremental Upload scan continues until a database Anchor is found」「incremental Upload scan can match every one of its 20 backup Anchors」「incremental Upload scan keeps looking for an exact ID after publication dates cross Anchors」「incremental Upload scan matches a fallback Anchor when feed dates are absent」 | |
| U-64 | youtubeJs.js:541-544,574 | 碰到较后的锚点时，记录越过的前序锚点（crossed_anchor_ids）和 active_anchor_id | web-scrape.ts:84（只记 matched_anchor_id） | 不同 | youtubeJs.test.js「incremental Upload scan abandons V30 only after crossing its publication day」「incremental Upload scan reuses a same-day V29 only after V30 is crossed」 | 只用于诊断和游标，影响小 |
| U-65 | youtubeJs.js:536-538 | 命中的锚点条目也进入 entries，随后作为已知视频被过滤掉 | web-scrape.ts:84（命中前就返回，结果不含锚点） | 一致 | youtubeJs.test.js「incremental Upload scan continues until a database Anchor is found」 | 效果相同 |
| U-66 | youtubeJs.js:550-553,562 | 没有续页→`list_end`（完整）；页数到 maxPages→`max_pages`（不完整，判 partial，不推进游标） | web-scrape.ts:89-90 | 不同 | youtubeJs.test.js「Full Crawl stops at its page budget without fetching an uninspected continuation」 | list_end 一致；新系统到页数上限时抛错 |
| U-67 | youtubeJs.js:557-560；incrementalYoutubeJsVideo.js:3585-3601,2814-2826 | 增量翻页失败：失败类型为 parser_runtime 或 content_terminal 时，扫描标为不完整（已扫到的新 ID 以 discovery_scan_incomplete 记账）；代理、限流、挑战类失败则抛错，换路由重试 | web-scrape.ts:93（一律抛错） | 不同 | youtubeJs.test.js「shared traversal propagates Full Crawl pagination errors but returns Incremental partial evidence」 | |
| U-68 | youtubeJs.js:563-577 | complete =（anchor_matched 或 list_end）且 parse_gap=0；有 parse gap 时 stop_reason=`parse_gap` | — | 不同 | youtubeJs.test.js「incremental Upload scan treats a parse gap as Partial coverage」 | 新系统的 parse gap 会抛错（见 U-3） |
| U-69 | youtubeJs.js:1364-1394 | 增量：hasContent=false，或休眠探测已得出决定时，不发请求，返回完整的空扫描并附 empty_uploads | 无 | 缺失 | youtubeUploadsCountry.test.js「dormant country probes request a route before scanning, or stay dormant without reserve」 | 随 D18 |
| U-70 | youtubeJs.js:1404-1407 | 增量扫描完整但为空时：校验是正常空响应，再做空列表决定（国家重查或休眠） | 无 | 缺失 | youtubeUploadsCountry.test.js「explicit unavailable uploads enter Full Crawl country recheck and incremental empty scan」 | 新系统增量空列表时不校验、不重查（另见 U-20、U-30） |

### G. 追赶放弃（gap_abandoned_latest_30）

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| U-71 | incrementalYoutubeJsVideo.js:217-241 | 放弃的前提（全部满足）：停止原因为 catchup_limit、没碰到锚点、parse_gap=0、条目≥30、首页数+追赶数=条目数、追赶数=配置上限、ID 无空值无重复。任一不满足就保持 catchup_limit 不完整（partial，不推进游标） | web-scrape.ts:87（只看 scanned≥100） | 不同 | incrementalVideo.test.js「Catch-up cannot abandon a gap before the configured budget is exhausted」「Catch-up exhaustion with parse gaps remains Partial and has no Content side effects」 | |
| U-72 | incrementalYoutubeJsVideo.js:62-64,242-266 | 放弃时只保留最新 30 条，complete=true，stop/terminal_reason=`gap_abandoned_latest_30`，策略 `latest-30-on-catchup-limit-v1`，并记录 abandoned_anchor_ids | web-scrape.ts:87；contracts/src/index.ts:177-182 | 一致 | incrementalVideo.test.js「Catch-up exhaustion classifies the latest 30 Videos in one discovery run」 | 保留条数和停止原因相同；触发阈值的差异见 U-61、U-71 |
| U-73 | incrementalYoutubeJsVideo.js:3408-3411 | 观测 outcome 码 `video_cycle_gap_abandoned_latest_30` | activities.ts:210（进度文案） | 不适用 | — | 观测记录格式 |

### H. 锚点与游标

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| U-74 | incrementalYoutubeJsVideo.js:499-549 | 锚点来源：视频游标里的 anchor_video_ids，按游标顺序，只保留在 contents 中有发布时间的；没有游标时，回退为 contents 中 video/short/live 且有发布时间的视频，按 published_at DESC 取前 20 | store index.ts:501-505 | 不同 | incrementalVideoPlanner.test.js「Video Discovery preserves the database order and requires a publication day」；incrementalVideo.test.js「Video execution keeps its backup Anchor pool when a later Anchor closes Discovery」 | 新系统每次从库里重新计算：只取已完成计划的、非不可用的，按发布时间排序。旧系统的锚点顺序是上传列表顺序（见 U-76）。只要碰到任一锚点就停，所以实际影响小 |
| U-75 | incrementalVideoPlanner.js:268-281 | orderedDiscoveryAnchors：去重、跳过无效日期、最多 20 个 | store index.ts:503-505（SQL：published_at IS NOT NULL，LIMIT 20） | 一致 | 同上 | |
| U-76 | incrementalYoutubeJsVideo.js:208-215,3431-3433 | 游标推进：只在发现完整且不是空列表时推进。本轮扫到的、不在旧锚点里的 ID 排前，旧锚点排后，截取 20 个 | 无游标；锚点由“已完成计划”推出 | 不同 | incrementalVideo.test.js「an incomplete Uploads scan does not advance the incremental cursor」 | 新系统没有独立游标；计划失败时锚点自然不变，这一点与旧系统等价 |
| U-77 | incrementalYoutubeJsVideo.js:3266-3326 | 扫描不完整时：发现记 partial，近期采样跳过（skipped / discovery_incomplete），不推进游标，不判活跃度 | 无（扫描不完整会直接抛错） | 不同 | incrementalVideo.test.js「an incomplete Uploads scan does not advance the incremental cursor」 | |

### I. 增量目标选择

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| U-78 | incrementalVideoBatchPlan.js:92-96；incrementalYoutubeJsVideo.js:355-364,1420-1425 | 过滤已知视频：扫描条目中已在 contents 里的 ID 不再作为首见目标，只更新它们的列表观测（见 U-79） | activities.ts:204-206；store index.ts:654-661（锚点以上的 ID 全部作为目标） | 缺失 | incrementalVideo.test.js「Video discovery accounts for every new ID with exactly one disposition」 | D9。触发 gap 放弃时，最新 30 条里的已知视频会被重新完整采集；失败计划留下的视频也会再采一次 |
| U-79 | incrementalYoutubeJsVideo.js:1340-1381 | 已知视频的列表观测：更新 playlist_last_seen_at、last_seen_at 和 position；列表相对发布时间只在证据更强时覆盖，冲突留痕 | 无 | 缺失 | publicationTimeEvidence.test.js「selects publication evidence by status and precision as one quartet」「equal-quality conflicts retain current evidence and expose the conflict」 | D16（首见/末见时间） |
| U-80 | incrementalVideoBatchPlan.js:41-62 | 处置账本复查。对扫描中的未知 ID，看它最近一次处置：deferred 或 terminal_excluded 时，next_attempt=infinity 则永不复查；未到期则跳过（deferred 的记为 pending 并阻塞游标）；已到期则作为 disposition_recheck 重新采集。扫描不完整时不做到期复查 | 无 | 缺失 | incrementalVideo.test.js「Video discovery throttles a deferred recheck before it is due without advancing the cursor」「Video discovery does not recheck a terminal ID from Uploads before it is due」「an incomplete Uploads scan does not consume or downgrade a due terminal recheck」 | D9 |
| U-81 | incrementalYoutubeJsVideo.js:472-497；incrementalVideoBatchPlan.js:123-150,103-105 | 列表外的到期复查：每轮最多 10 个（按 next_attempt_at、candidate_id 排序），取最新处置已到期、仍未入库的视频，追加为目标，位置排在扫描最大位置之后。只在扫描完整且非空列表时做 | store index.ts:484-497（recoveryVideoIds） | 不同 | incrementalVideo.test.js「Video discovery rechecks a due terminal exclusion outside the current Uploads page」；incrementalVideo.postgres.integration.test.js「incremental Video rechecks terminal exclusions only when their schedule is due」 | 新系统的恢复目标只包括解析 REPLAY_INCOMPLETE 失败的视频和未完成计划的视频，最多 100 个，没有到期时间概念，每次计划都带上 |
| U-82 | incrementalYoutubeJsVideo.js:1225-1307；incrementalVideoBatchPlan.js:104 | 恢复上一轮已采但未提交的首见结果（检查点） | web-collector.ts:99-100,155-156（同一计划内复用原件）；跨计划靠 recovery | 不适用 | incrementalVideo.postgres.integration.test.js「a new Clock Run recovers a pending First-Seen checkpoint after the old Run ends partial」 | 由原件复用机制承担 |
| U-83 | incrementalVideoBatchPlan.js:64-88 | 首见详情资格：列表标为 is_upcoming 或 is_live 的首见目标不请求详情（复查条目除外）；同一视频不能同时出现在首见和近期采样两个阶段 | 无 | 不同 | incrementalVideo.test.js「Video discovery does not persist an upcoming live before it starts」「Video discovery does not persist a live broadcast while it is in progress」 | 新系统对直播/预告照常请求详情。另外由于没有过滤已知视频，一个近期已知视频可能既是发现目标又在 recent_sampling 里 |
| U-84 | incrementalYoutubeJsVideo.js:969-998；detailPolicy.js:47-70 | 首见终止原因：列表或详情任一处为预告→upcoming_live；直播中且不是回放→live_in_progress。结果为 terminal_excluded，24h 后复查，不入库 | 无 | 缺失 | incrementalVideo.test.js「Video discovery honors an upcoming state first revealed by Player detail」 | D4 |
| U-85 | incrementalYoutubeJsVideo.js:1309-1336,1450-1462 | 扫描不完整时，新 ID 以 discovery_scan_incomplete 记为 deferred（1h 后复查；之前若是终止排除则保留原结论），不请求详情 | 无 | 缺失 | videoDisposition.test.js「an incomplete Uploads discovery defers the observed ID for a scan retry」 | |
| U-86 | incrementalYoutubeJsVideo.js:1497-1516 | 账本不变式：每个发现的 ID 恰好有一个处置，否则整轮失败，不允许静默丢失 | store index.ts:693-695（domain_complete 要求每个冻结目标都有结果） | 一致 | incrementalVideo.test.js「Video discovery accounts for every new ID with exactly one disposition」 | 机制不同 |
| U-87 | incrementalYoutubeJsVideo.js:366-392,1517-1525,1567-1570 | 发现完整的条件：扫描完整，且没有阻塞的 deferred。阻塞的 deferred 包括：库中最新处置为 deferred 且未入库的、本轮未解决的、复查后仍为 deferred 的。否则记 partial，游标不推进 | 计划为 COMPLETED 的视频才会成为锚点；未完成的进 recovery | 不同 | incrementalVideo.test.js「an outstanding deferred ID blocks the cursor even when it leaves the Uploads page」 | |
| U-88 | incrementalYoutubeJsVideo.js:3541-3549 | 首见数量不受存储刷新上限 player_cap 限制 | activities.ts:204-206（发现目标最多 100，含恢复目标的合并截断） | 一致 | incrementalVideo.test.js「Video execution classifies every First-Seen Video independently of the stored Video refresh cap」 | |
| U-89 | incrementalVideoBatchPlan.js:103-112 | 空列表（empty_uploads）时，不做列表外复查，也不做近期采样 | store index.ts:406,506-510（recent_sampling 在建计划时已冻结） | 不同 | youtubeUploadsCountry.test.js「explicit unavailable uploads enter Full Crawl country recheck and incremental empty scan」 | 新系统即使列表为空也照常重读近期视频 |

### J. 处置状态与复查间隔（videoDisposition.js、collectedVideoOutcome.js、youtubeLoginRequired.js）

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| U-90 | videoDisposition.js:89-91；youtubeLoginRequired.js:24-34 | login_required→terminal_excluded，next_attempt=infinity（永久；只有人工给出有限时间才能解除），retry_class=null | web-scrape.ts:167（每次都产出一条不可用记录，没有账本） | 缺失 | youtubeLoginRequired.test.js「repeated Please sign in is excluded without API or route failure」「cached exclusion can be released by an explicit finite retry time」「stored detail stays untouched and enrichment stops without a dead letter」 | D9 |
| U-91 | videoDisposition.js:92-103 | upcoming_live 或 live_in_progress→terminal_excluded，24h 后复查（low_frequency_access_recheck），优先级高于其它可入库证据 | 无 | 缺失 | videoDisposition.test.js「an upcoming Live terminal state takes precedence over otherwise storable evidence」 | D4、D9 |
| U-92 | videoDisposition.js:104-115 | outside_content_window→terminal_excluded，30 天后复查（low_frequency_policy_recheck） | 无 | 缺失 | — | 依赖 U-47 |
| U-93 | videoDisposition.js:118-130 | discovery_scan_incomplete→deferred，1h 后复查（uploads_scan_retry）；之前若为终止排除则保留原结论 | 无 | 缺失 | videoDisposition.test.js「an incomplete Uploads discovery defers the observed ID for a scan retry」 | |
| U-94 | videoDisposition.js:132-142；collectedVideoOutcome.js:28-38 | 已入库内容这次只拿到访问状态（unlisted、members_only、private、unavailable）时，只更新访问状态，保留原内容，记 stored / content_access_updated | apps/pg-sink/src/sink.ts:71-78 | 不同 | videoDisposition.test.js「an existing Full Video remains stored when explicit access evidence changes」 | 新系统用不可用记录整体覆盖 data（ELSE EXCLUDED.data），原有元数据丢失 |
| U-95 | videoDisposition.js:49-52,144-155 | private 或 unavailable→terminal_excluded（access_{状态}），7 天后复查 | 无 | 缺失 | incrementalVideo.test.js「Video discovery closes a private detail and schedules a low-frequency recheck」 | D9 |
| U-96 | videoDisposition.js:157-169 | 采集出错→deferred detail_collection_failed，1h 后复查（player_retry）；之前若为终止排除则保留原结论 | web-collector.ts:160-198（WEB 试 3 次，再用 Data API 批量兜底；仍失败则计划失败，下次靠 recovery） | 不同 | incrementalVideo.test.js「a failed low-frequency terminal recheck preserves the non-blocking conclusion」 | |
| U-97 | videoDisposition.js:171-181；collectedVideoOutcome.js:40-50 | 权威类型且访问状态为 public、unlisted 或 members_only→stored / content_stored | web-scrape.ts:129-137（详情映射成功即入库） | 一致 | videoDisposition.test.js「an existing Full Video remains stored when explicit access evidence changes」 | 类型权威性见 U-98 |
| U-98 | videoDisposition.js:185-196 | 类型不权威→deferred authoritative_type_unresolved，6h 后复查（有详情时 retry_class=alternate_player，否则 detail_retry） | web-scrape.ts:129（没有信号时默认 video，来源记 default:shorts_unknown，并入库） | 不同 | youtubeJs.test.js「full detail stops after WEB and IOS when type evidence is still absent」 | |
| U-99 | videoDisposition.js:198-207；collectedVideoOutcome.js:52-60 | 类型权威但访问状态未知或其它→deferred access_{状态}，6h 后复查（access_recheck）；“权威类型但访问状态不可入库”（classified_only）不入库 | web-scrape.ts:135（access=unknown 也入库） | 不同 | — | D1：新系统 88% 的视频访问状态为 unknown |
| U-100 | videoDisposition.js:54-75 | 保留先前的终止结论：本次结果不确定时，沿用原终止原因，复查间隔按原因：login 永久、outside 30 天、直播 24h、其它 7 天 | 无 | 缺失 | videoDisposition.test.js「an inconclusive low-frequency recheck retains its prior terminal conclusion」 | |
| U-101 | videoDisposition.js:20-41 | 立即修复资格：deferred 和 terminal_excluded 只有在 next_attempt_at≤now 时才能修复 | 无 | 缺失 | incrementalVideo.postgres.integration.test.js「Incremental Video consumes scheduled terminal rechecks only in Clock mode and only when due」 | D9 |

### K. 活跃度与休眠（channelDormancy.js、videoActivityEvidence.js、videoActivityLifecycle.js、incrementalChannelRunner.js）

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| U-102 | channelDormancy.js:3-6 | 常量：休眠原因 `no_published_content_within_90_days`，窗口 90 天，复查间隔 30–90 天 | 无（packages/feature-clock 只有 About 优先级标签 `about_priority_dormant`，与此无关） | 缺失 | channelDormancy.test.js 全部 3 项 | D18 |
| U-103 | channelDormancy.js:31-41 | 复查延迟：sha256("dormant-video-probe-v1\0"+频道ID+"\0"+cycle) 取前 4 字节，mod 61 再加 30，结果是确定的 30–90 天 | 无 | 缺失 | channelDormancy.test.js「dormant recheck delay is deterministic and remains inside 30-90 days」 | |
| U-104 | channelDormancy.js:43-65 | 进入休眠：cycle 加 1；已在休眠时沿用 dormant_since，否则取本次时间；recheck_day = 观测 UTC 日 + 延迟天数 | 无 | 缺失 | channelDormancy.test.js「a later dormant cycle preserves dormant_since and derives a new UTC recheck」 | |
| U-105 | channelDormancy.js:95-109 | 判定：有近期内容→active；发现不完整或有不确定证据→inconclusive；否则→dormant | 无 | 缺失 | channelDormancy.test.js「only a complete zero-content scan can enter dormancy」 | |
| U-106 | videoActivityEvidence.js:3-28；publicationTimeEvidence.js:226-268 | 证据分类：只有 exact 证据能判 inside 或 outside。秒精度：晚于观测时刻为 after_as_of，≤截止时刻为 outside。日期精度：发布日早于截止日为 outside，等于截止日为 cutoff_overlap（不确定），晚于观测日为 after_as_of。relative、estimated、unresolved 一律算不确定 | 无（只有交付窗口 publication-map.ts:40，且它接受 exact、relative、estimated） | 缺失 | publicationTimeEvidence.test.js「only exact evidence can produce a resolved window relation」「classifies exact publication evidence after the observation instant」；videoActivityLifecycle.test.js「Incremental lifecycle keeps relative publication evidence inconclusive」「Incremental lifecycle keeps a date-only cutoff overlap inconclusive」 | |
| U-107 | videoActivityLifecycle.js:289-318 | 存量证据：contents 中 video/short/live 按视频去重；未结束的直播（live、没有 live_ended_at、没有时长）算不确定 | 无 | 缺失 | incrementalVideo.test.js「a throttled live Candidate still blocks Incremental dormancy from current Uploads」 | |
| U-108 | videoActivityLifecycle.js:24-40,320-449 | 存量扫描上限：1000 行，每页 200 行，限时 500ms；被截断或超时→证据不完整→inconclusive | 无 | 缺失 | videoActivityLifecycle.test.js「Incremental lifecycle keeps a truncated historical evidence scan inconclusive」「Incremental lifecycle stops historical evidence pagination at its time budget」；videoActivityLifecycle.postgres.integration.test.js 2 项 | 具体上限可按新存储重新设计，但“证据不完整不能判休眠”必须保留 |
| U-109 | incrementalYoutubeJsVideo.js:410-470 | 本轮证据：首见和采样结果的发布证据一起计入；扫描中直播中的条目和 live_in_progress 处置都算不确定，阻止判休眠 | 无 | 缺失 | incrementalVideo.test.js「a current-run ended live replay reactivates a dormant channel beyond the history limit」「a Recent Sampling detail reactivates a dormant channel beyond the history limit」「a page-out deferred detail uses recent publication evidence without storing content」 | |
| U-110 | videoActivityLifecycle.js:489-511,581-587 | 空列表直接休眠：发现完整且空列表决定为 dormant 时，不看存量证据，原因记 `uploads_empty`，contents 不变 | 无 | 缺失 | videoActivityLifecycle.test.js「normal empty uploads can sleep despite stored recent video evidence without changing contents」 | D8、D18 |
| U-111 | videoActivityLifecycle.js:534-555 | 已休眠频道本轮结论为 inconclusive 时，只更新 dormant_last_probe_at，状态不变 | 无 | 缺失 | — | |
| U-112 | videoActivityLifecycle.js:557-579 | 判为 active：清空全部休眠字段，dormant_cycle 归零（removed 状态不改） | 无 | 缺失 | videoActivityLifecycle.test.js「Incremental lifecycle keeps exact recent evidence active」 | |
| U-113 | videoActivityLifecycle.js:588-608 | 判为 dormant：写入休眠字段，并取消该频道 pending、queued、failed 的 Agent 刷新请求（原因 channel_dormant） | 无 | 缺失 | videoActivityLifecycle.test.js「Incremental lifecycle marks complete exact old evidence dormant」「Incremental lifecycle can prove dormancy after a complete paginated scan」 | |
| U-114 | videoActivityLifecycle.js:477-486 | 只有状态为 active 或 dormant 的频道才应用活跃度（rejected 且原因为 90 天无内容的，视为 dormant） | — | 不适用 | — | 新系统的状态机不同；移植休眠时需要定义对应状态 |
| U-115 | incrementalChannelRunner.js:178-199 | Video 判为休眠后，同一计划里的 Agent 跳过（skipped / channel_dormant）；Video 为 partial 且没有生命周期结论时，Agent 照常执行；恢复执行时从已完成的 Video 结果还原休眠状态 | apps/execution-worker/src/workflows.ts:41-44（Agent 总是执行） | 缺失 | incrementalChannelRunner.test.js「a Video transition to dormant skips an Agent due in the same Plan」「an incomplete Video Partial without lifecycle still queues an Agent due in the same Plan」「a resumed Run restores dormant lifecycle from the completed Video Domain」 | D18 |
| U-116 | incrementalChannelRunner.js:128-140 | plan_mode=dormant_probe：休眠频道按 dormant_recheck_day 低频探测上传列表，取代常规 Video 时钟 | 无（feature-clock 照常排期） | 缺失 | incrementalChannelRunner.test.js「dormant probe with no country reserve finishes without even opening a channel session」 | D18 |
| U-117 | videoActivityLifecycle.js:118-257 | activity_evidence 字段齐全性和计数一致性校验 | — | 不适用 | videoActivityLifecycle.test.js「Video activity evidence validator accepts the complete producer shape」等 4 项 | 观测契约；移植休眠时可以参考 |

### L. 近期采样中与发现耦合的部分（incrementalVideoPlanner.js、incrementalYoutubeJsVideo.js）

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| U-118 | incrementalVideoPlanner.js:202-266 | 采样参数：recentWindowDays 30，staleAfterDays 7，三个默认值（collection priority、change probability、interaction need）均为 0.5，minimumRefreshScore 0.55，EWMA alpha 0.4；可用环境变量调整，计划版本须为 video-plan-1 | packages/store/src/recent-sampling.ts:8-17 | 一致 | incrementalVideoPlanner.test.js「Crawler rejects a frozen Planner version it does not support」 | 新系统写成常量；版本校验不适用 |
| U-119 | incrementalVideoPlanner.js:283-308 | 打分：staleness、freshness（30 天）、change；player_score = 0.6×staleness + 0.4×change。候选条件：enrich_pending，或从未观测，或分数≥0.55 | recent-sampling.ts:40-47 | 一致 | incrementalVideoPlanner.test.js「Recent Sampling can select zero fresh low-change Videos」「Recent Sampling ranks equal-staleness Videos by learned change probability」 | 新系统没有 enrich_pending（不适用） |
| U-120 | incrementalVideoPlanner.js:310-344 | 配额 = min(候选数, pending + ceil(demand×(0.5+0.5×priority)), floor(player_cap×factor))；排序依次为 enrich_pending、分数降序、content_key | recent-sampling.ts:50-59 | 不同 | incrementalVideoPlanner.test.js「Recent Sampling obeys frozen capacity factor and hard caps」「Recent Sampling prioritizes queued detail recovery」 | 新系统上限固定为 20，平分时按 video_id 排序 |
| U-121 | incrementalVideoPlanner.js:316-320；incrementalVideoBatchPlan.js:107-110 | 采样排除本轮发现和复查的目标 | store index.ts:506-507（只排除 recovery ID） | 不同 | incrementalVideoPlanner.test.js「Recent Sampling excludes Videos initialized by this Discovery」 | 新系统在扫描前就定好采样；又因为没有过滤已知视频，同一视频可能被重复采集（另见 U-83） |
| U-122 | incrementalYoutubeJsVideo.js:1662-1764 | 采样池：contents 中 video/short/live，排除 login_required；发布时间取库内值，没有时取本轮列表的相对日期，须≥plan_day−30 天；enrich 任务处于租约中或等待中的排除 | store index.ts:501,506-507 | 不同 | incrementalVideoSnapshot.test.js「snapshot sampling preserves stored publication, repairs undated feed evidence, and retains due older repairs」 | 新系统要求 published_at，并排除不可用视频；没有列表日期回填，也没有 login 排除 |
| U-123 | incrementalVideoPlanner.js:345-355 | 评论（next）配额 | — | 不适用 | — | M3-D3：已知视频不重读评论 |
| U-124 | incrementalYoutubeJsVideo.js:325-353 | 变化概率：EWMA，权重 views 0.70、likes 0.15、comments 0.15 | recent-sampling.ts:65-76 | 一致 | incrementalYoutubeJsVideo.test.js「recent storage updates metrics while guarding populated static fields」 | |
| U-125 | incrementalYoutubeJsVideo.js:292-323 | 首见用 full 详情；近期采样用 metrics 模式（enrich_pending 时改用 full） | activities.ts:257-264；web-collector.ts:150-160（SAMPLING 时 metricsOnly=true） | 一致 | incrementalYoutubeJsVideo.test.js「incremental recent detail uses the metrics contract unless a repair is pending」 | getBasicInfo 缺互动数的问题见 D4、D13 |

### M. 新系统新增或非主路径

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| U-126 | （对应 U-81） | 恢复目标合并：recovery 排前、去重，合并后截取 100 个；全量和增量都合并 | contracts/src/index.ts:187-189；web-collector.ts:144；activities.ts:206,218；parser.ts:105-107 | 不适用 | — | 新增机制。R8：截断可能丢掉新上传。R6：恢复目标与锚点重合时，store index.ts:659-661 会拒绝发现清单，导致计划失败 |
| U-127 | fullCrawlFetchContract.js:64-68 | 旧 YouTubeJS 合约中，Data API 只做视频详情兜底，频道和上传列表始终走 YouTubeJS | apps/execution-worker/src/youtube/data-api.ts:11,71-112（uploadsUntilAnchor / recentUploads，只在没有网页采集器时使用） | 不适用 | fullCrawlFetchContract.test.js「v3 enables shared video batch fallback and keeps channel/uploads on YouTubeJS」 | 不是主路径；但它的规则与网页路径不一致：跳过没有发布时间（私密）的条目、按 max_age_days 截断、scanned 只计入保留的条目 |
| U-128 | （对应 U-42、U-63） | 发现清单校验：matched_anchor 必须在冻结的锚点里，目标不得包含锚点；stop_reason 与 matched_anchor 必须一致 | store index.ts:654-661；contracts/src/index.ts:184 | 一致 | — | 对应旧系统的冻结目标校验 |
| U-129 | — | 解析程序离线重放 TARGETS：有区域原件时先用区域原件，失败再用默认原件，调用同一个 uploads() | apps/raw-parser/src/parser.ts:102-108 | 不适用 | — | 新架构；任何列表规则改动都要同时在采集和重放生效 |

## 状态统计

| 状态 | 条数 |
| --- | --- |
| 一致 | 35 |
| 缺失 | 39 |
| 不同 | 37 |
| 不适用 | 18 |
| 合计 | 129 |

## 不同 / 缺失 按影响排序

1. **频道休眠整体缺失（D18）**：U-102～U-116、U-40、U-41、U-25、U-32、U-35、U-69、U-110。新系统没有“90 天无新视频”或“空列表”的休眠判定，没有 30–90 天的确定性低频探测，判休眠后也不跳过 Agent。结果是不活跃频道照常全频更新、照常跑 Agent，占用代理和配额，不符合“采集按旧系统”。移植时要连同“只有 exact 证据能判 outside、relative 一律算不确定、扫描被截断就是 inconclusive”这些防误判规则一起带上（U-106～U-109）。
2. **没有过滤已知视频，也没有逐视频复查账本（D9）**：U-78、U-80、U-81、U-83～U-85、U-87、U-90～U-101、U-48。已知视频、login_required、私密/不可用、直播/预告会在每次计划里重新完整采集（WEB+IOS，必要时再走 Data API）。旧系统的间隔是：失败 1h、类型未定 6h、访问状态未知 6h、私密/不可用 7d、直播 24h、窗口外 30d、login 永久。U-94 的问题更直接：新系统用不可用记录整体覆盖已入库视频的元数据（pg-sink sink.ts:71-78），数据会丢失。
3. **空列表和缺失列表没有校验（D8）**：U-20、U-21、U-22、U-30、U-70、U-18、U-89。任何“0 条且无续页”都被当作已确认的空列表（未知渲染器会被静默当成空）；而有结构化证据的“列表不存在”反而在重查失败后让整个计划失败；增量的空列表也从不按频道国家重查。
4. **采集阶段没有 90 天窗口，直播/预告也没有终止处理（D4）**：U-47、U-45、U-84、U-83、U-6、U-92。新系统把最新 N 条全部入库，包括 90 天外的旧视频和尚未开播或正在直播的；交付时虽然按 90 天/30 条过滤（publication-map.ts:36-42），但入库数据、锚点、Agent 输入都和旧系统不同；直播入库后也不会再补全。若保留“不设年龄限制”，需要记为有意差异。
5. **解析缺口和页数上限会让整步失败（D8）**：U-3、U-2、U-68、U-10、U-66、U-67。一个缺 ID 或 ID 不是 11 位的条目、一个 parser_runtime 类的翻页失败、或翻满 20 页，都会让 TARGETS 失败并无限重试。旧系统的处理是：全量照用其余条目，增量记 partial 和 discovery_scan_incomplete（1h 后复查）。
6. **增量扫描深度和放弃条件不同**：U-61、U-60、U-71、U-4。新系统在总共 scanned≥100（含第一页、含重复）时就放弃，只留最新 30 条；旧系统是第一页全部检查，再加 50 条追赶预算，并有严格前提（无 parse gap、条目≥30、ID 不重复）。锚点在第 101–150 条之间时，新系统会漏采第 31 条以后的新视频。
7. **列表类型提示缺失**：U-5、U-98、U-99。播放器没有类型信号时，新系统默认 `video` 并立即入库；旧系统会 deferred 6h 再取一次（列表上的 Shorts 提示只作为非权威留证）。可能把 Shorts 误记成普通视频；访问状态未知的视频也直接入库（D1）。
8. **锚点和游标语义**：U-74、U-76、U-77、U-87、U-64。新系统用“已完成计划”代替游标，锚点按发布时间排序，不记越过的锚点；扫描不完整时直接失败，不记 partial。总体等价，但要先修 R6（恢复目标与锚点重合时计划失败）、R8（恢复目标截断会挤掉新上传，U-126）。
9. **近期采样与发现的耦合**：U-89、U-121、U-122、U-120。空列表时仍然重读近期视频；采样不排除本轮发现的目标（同一视频可能被采两次）；没有用列表日期回填无日期内容；上限固定 20，平分时按 video_id 排序。
10. **影响较小**：U-7（列表元数据）、U-8、U-79（列表相对日期和首见/末见时间，D16）、U-11（重复页停止）、U-16（`exhausted` 在第 2 页以后结束时误报为未读完）、U-27、U-39（国家来源多走一次 Data API，D5）、U-54、U-55（交付证明固定写成 complete，属发布组）。
