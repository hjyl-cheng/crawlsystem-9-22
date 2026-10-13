# 规则清单 1：会话、身份、传输与失败策略

审计日期：2026-10-13（只读审计，未改动任何仓库）

路径缩写：
- 旧系统 `L/` = `oldsystem/services/qybullmq/src/`；`LT/` = `oldsystem/services/qybullmq/test/`；`L/py` = `oldsystem/services/qybullmq/scripts/fingerprint_gateway.py`；`R/` = `oldsystem/services/rota/core/internal/proxycontrol/`；`compose` = `oldsystem/deploy/compose.yml`；`catalog` = `R/identity_policy_catalog.generated.json`
- 新系统 `EW/` = `crawlsystem-business/apps/execution-worker/src/`；`YT/` = `EW/youtube/`；`PM/` = `apps/proxy-manager/src/`；`FG/` = `apps/fingerprint-gateway/fingerprint_gateway/gateway.py`；`EC/` = `packages/execution-client/src/`；`ST/` = `packages/store/src/`；`CT/` = `packages/contracts/src/`；`RP/` = `apps/raw-parser/src/parser.ts`

状态说明：一致 / 缺失 / 不同 / 不适用（附原因）。凡属其他组（评论、详情、上传列表、区域、Data API）主责的规则，在备注中注明“由 X 组复核”。

## A. 运行时与会话创建（youtubeJs.js 1–260、1041–1211）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| S-1 | L/youtubeJs.js:47 | YouTube.js 版本固定为 17.2.0 | YT/web-scrape.ts:137（extractor_version 写 18.1.0）；node_modules/youtubei.js 18.1.0 | 不同 | — | 架构说明已知的升级；解析节点形状变化集中在 web-scrape.ts / scrape.ts |
| S-2 | L/youtubeJs.js:48；compose:55；catalog（youtube_control_language=en） | Innertube 会话语言 `lang` = YOUTUBE_CONTROL_LANGUAGE（生产为 **en**），而不是 YOUTUBE_LANGUAGE(pt-BR) | YT/identity.ts:5；YT/web-scrape.ts:38；RP:35（均为 pt-BR） | 不同 | — | 旧系统 youtubei.js 请求 hl=en、gl=BR；新系统 hl=pt-BR。直接影响计数文本、日期文本、播放状态原因文本的语言，以及所有本地化解析正则（新系统已改写为 pt-BR 解析）。需确认这是有意的变更 |
| S-3 | L/youtubeJs.js:49；compose:56 | 会话 `location` 默认 BR | YT/identity.ts:5；YT/web-scrape.ts:36-38 | 一致 | — | 区域复查时 location 改为频道所在国家（区域组复核） |
| S-4 | L/youtubeJs.js:50；compose:67 | 单个请求超时 YOUTUBEJS_TIMEOUT_MS=30000，最小 1000 | YT/fingerprint.ts:47-52 | 一致 | LT/youtubeJsTimeout.test.js “YouTube.js internal timeout remains a recorded upstream failure” | 新系统还会把超时上限压到“租约剩余时间 −1s”，租约剩余 ≤0 时直接报 gateway 错误 |
| S-5 | L/youtubeJs.js:51；compose:68 | 频道 Tab 翻页上限 YOUTUBEJS_MAX_TAB_PAGES=20 | YT/web-scrape.ts:90 | 不同 | LT/youtubeJs.test.js “Full Crawl stops at its page budget without fetching an uninspected continuation” | 上限值一致（20），但旧系统到预算后停止并记录边界，新系统抛 `parse` 错误；由上传列表组复核 |
| S-6 | L/youtubeJs.js:53 | 视频详情客户端顺序 WEB → IOS | YT/web-scrape.ts:141 | 一致 | LT/youtubeJs.test.js “Video Detail surfaces a bot challenge from IOS without further clients” | |
| S-7 | L/youtubeJs.js:52,54 | 终态探测客户端为 IOS；显式终态原因码仅 private / uploader_removed | YT/web-scrape.ts:141-168 | 不同 | LT/incrementalYoutubeJsVideoProbe.test.js | 新系统无单独的 IOS 终态探测步骤；由详情组复核 |
| S-8 | L/youtubeJs.js:68 | youtubei.js 日志级别 ERROR | YT/scrape.ts:8（NONE） | 一致 | — | 不影响采集行为 |
| S-9 | L/youtubeJs.js:70-81；compose:66 | 提取模式 disabled/channel/full，非法值回退 full | EW/config.ts:20-21（YOUTUBE_COLLECTION_MODE=web/legacy） | 不适用 | — | 新系统没有部分提取模式，用 web/legacy 两种模式代替 |
| S-10 | L/youtubeJs.js:191-193 | 无租约时回退到环境变量固定代理 YOUTUBE_PROXY_URL | — | 不适用 | — | 新系统每个单元都从 Proxy Manager 取租约（YT/web-collector.ts:31） |
| S-11 | L/youtubeJs.js:1054-1056,1102-1120 | 运行时按 `proxyUrl\|profile_id` 复用；同一个键只创建一次（单飞）；键变化时关闭旧的再建新的 | YT/web-collector.ts:49 | 不同 | — | 新系统每次 `web()`（About、Targets、每个视频的每次尝试）都新建 Innertube 会话。由于 `generate_session_locally`，这不额外产生网络请求，影响低 |
| S-12 | L/youtubeJs.js:1058-1068 | 无指纹配置时，ProxyAgent 设 connections=2、pipelining=1、keepAlive 60s、最大 keepAlive 300s | EC/proxy-connect.ts:135-143（connections=4，connectTimeout 15s） | 不同 | — | 只影响新系统的 legacy（非 web）模式 |
| S-13 | L/youtubeJs.js:1073-1084 | Innertube.create 选项：retrieve_player=false、generate_session_locally=true、retrieve_innertube_config=false、enable_session_cache=false | YT/web-scrape.ts:38-40；RP:35 | 一致 | — | 但 YT/scrape.ts:24 的 legacy 模式会话没有设置 retrieve_innertube_config、enable_session_cache、UA 和 visitor_data |
| S-14 | L/youtubeJs.js:1076-1078 | 会话的 user_agent、visitor_data、timezone 取自身份档案 | YT/web-scrape.ts:38-39 | 一致 | — | |
| S-15 | L/youtubeJs.js:1096-1099 | 会话创建失败时关闭 dispatcher，并原样抛出错误 | YT/web-scrape.ts:41（classify） | 一致 | — | |
| S-16 | L/youtubeJs.js:1103 | Data API 续接交接期间禁止任何 YouTube 网络请求（assertVideoApiNetworkAllowed） | — | 不适用 | — | 新系统在同一个 Activity 内直接做 API 回退（YT/web-collector.ts:177-199），没有跨队列交接 |
| S-17 | L/youtubeJs.js:1122-1139 | 预热：要求指纹传输时推迟到拿到档案后（deferred_until_profile）；失败时返回 enabled=false 而不抛错 | EW/main.ts:39-40（网关就绪才报告 collectionReady） | 一致 | — | |
| S-18 | L/youtubeJs.js:1148-1153；compose:490 | 每个进程同一时间只允许一个频道租用运行时（重复租用抛错）；频道 Worker 并发为 1 | YT/fingerprint.ts:27-30（按 networkKey 串行）；EW/config.ts:32（WORKER_CAPACITY 默认 2） | 不同 | — | 新系统一个 Worker 可同时跑 2 个计划，并共享节点代理池 |
| S-19 | L/youtubeJs.js:1151-1153 | 要求指纹传输但没有 profile_id 时，拒绝租用 | YT/fingerprint.ts:33-34 | 一致 | — | 新系统总会加载或创建身份档案 |
| S-20 | L/youtubeJs.js:1181-1196 | 释放时，若代理变化则关闭运行时，并返回占用时长 | YT/fingerprint.ts:80-85（DELETE 网关档案并解锁） | 一致 | — | |
| S-21 | L/youtubeJs.js:1198-1211 | 运行状态与统计（requests/failures/challenges/statuses）对外可见 | YT/fingerprint.ts:88-95；FG:162-167 | 一致 | — | 新系统提供近 1 小时的请求数与 blocked 数 |
| S-22 | L/worker.js:1362-1376 | 失败决策 client_action=refresh_or_fallback 时关闭 YouTube.js 运行时（下次重建会话） | YT/web-collector.ts:49 | 一致 | — | 新系统每次尝试本来就重建会话，等价成立 |

## B. 评论区首屏请求（youtubeJs.js 86–189，由评论组复核）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| S-23 | L/youtubeJs.js:86-96,144-163 | 自己构造评论区 token：sortBy=0（Top）、type=2、target=comments-section，请求类型 CONTINUATION_REQUEST_TYPE_WATCH_NEXT | YT/scrape.ts:84（yt.getComments(id,'TOP_COMMENTS')） | 不同 | LT/youtubeCommentPage.test.js | 新系统改由 youtubei.js 内部构造请求，请求形状可能不同 |
| S-24 | L/youtubeJs.js:165-167 | 响应 success=false 时按 HTTP 失败抛错 | YT/scrape.ts:102-108 | 一致 | — | youtubei.js 对非 2xx 会抛错 |
| S-25 | L/youtubeJs.js:169-172 | 只有“未关闭评论、总数>0、Top 返回 0 条、存在 Newest 端点”时，才回退一次 NEWEST_FIRST | YT/scrape.ts:90-92 | 一致 | LT/youtubeCommentPage.test.js “optional comments fall back once to the server's newest endpoint when top has no rows” | 新系统另外在 “comments page did not have any content” 且 API 计数>0 时也回退到 NEWEST（YT/scrape.ts:84-88） |
| S-26 | L/youtubeJs.js:174-187 | Newest 回退失败时保留 Top 原页，并记录诊断（reason=positive_total_empty_top、fallback_status） | YT/scrape.ts:91 | 一致 | 同上 | 新系统不记录回退诊断字段；原始响应已归档 |
| S-27 | L/youtubeJs.js:115-129 | 首屏状态：关闭→总数 0 且状态 disabled；返回条数>0→collected，否则 unresolved；来源 youtubejs_comments | YT/web-scrape.ts:134,164；YT/map.ts（CommentsResult） | 不同 | LT/commentFirstPageBackfill.test.js “only a resolved getComments page or disabled comments is persisted” | 新系统用 page/unavailable/disabled/skipped 表示；评论请求失败会降级为 unavailable，视频仍然成功（见 S-100） |
| S-28 | L/youtubeJs.js:110,173,185 | 评论多次请求之间都要检查取消 | YT/fingerprint.ts:49（AbortSignal.any） | 一致 | LT/youtubeJsCancellation.test.js “fetchYoutubeJsVideoDetail does not turn comment cancellation into a partial result” | |

## C. 解析辅助（youtubeJs.js 195–260）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| S-29 | L/youtubeJs.js:195-204 | 渲染文本：先 trim，空串或 `[object Object]` 视为 null | YT/web-scrape.ts:12 | 不同 | — | 新系统还排除 'N/A'，但不 trim；影响低 |
| S-30 | L/youtubeJs.js:217-224 | URL 绝对化：`//` 补 https:，`/` 补 https://www.youtube.com | YT/web-scrape.ts:63 | 不同 | — | 新系统只给外链补 `https://`，缩略图不做绝对化；影响低 |
| S-31 | L/youtubeJs.js:226-248 | 最佳缩略图：递归深度 ≤4，遍历 thumbnails/thumbnail/image/sources/content_image，按面积取最大 | YT/web-scrape.ts:14 | 不同 | — | 新系统只在一层数组里按宽度取最大 |
| S-32 | L/youtubeJs.js:250-254 | 计数解析：数字取四舍五入，文本按 DEFAULT_LANGUAGE(en) 本地化解析 | YT/web-scrape.ts:13（pt-BR；数字须为非负安全整数） | 不同 | — | 跟 S-2 的语言差异连带 |

## D. 传输包装与挑战检测（youtubeJs.js 843–1039）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| S-33 | L/youtubeJs.js:843-848 | 挑战文本：先 NFD 去重音；显式模式包括 sorry/index、detected unusual traffic、automated quer、sign in to confirm…not a bot、confirm…not a bot、faca login…confirmar…nao e um robo/bot、verify you are human；裸 “captcha” 只在结构化节点内才算 | YT/fingerprint.ts:73-74；FG:205-208 | 不同 | LT/youtubeJs.test.js “bot challenge detection distinguishes IP blocks from ordinary sign-in restrictions” | 新系统传输层只认 not a bot、unusual traffic、带重音的 “não é/sou robô”、captcha。缺少 sorry/index、automated queries、verify you are human（HTML 中）；也不做 NFD，所以不带重音的 “nao e um robo” 漏检。YT/web-scrape.ts:97 的 playability 会做 NFD，覆盖面更全 |
| S-34 | L/youtubeJs.js:850-863 | 结构化 JSON 递归扫描：键名匹配 `(re)captcha*renderer\|challenge`，或键名含 error/alert/dialog/challenge/playability 且内容含挑战文本，都判为挑战 | YT/fingerprint.ts:73（只看 playabilityStatus.reason） | 不同 | — | browse/next 响应里 alert、dialog、captcha renderer 形式的挑战不会被识别 |
| S-35 | L/youtubeJs.js:865-877 | 先用宽松正则预筛，再解析 JSON；非 JSON 正文只认显式文本（不认裸 captcha） | YT/fingerprint.ts:74（HTML 只认 captcha-form 和 “Our systems have detected unusual traffic”） | 不同 | — | |
| S-36 | L/youtubeJs.js:957 | 所有非 2xx 响应和 200 响应都抽样检查挑战（取前 500 字符作为证据） | YT/fingerprint.ts:71-75 | 一致 | — | 新系统检查全部响应 |
| S-37 | L/youtubeJs.js:961-983 | 响应里检出挑战时，**当场让该请求失败**：抛 “bot challenge HTTP 200”，计入 challenges 统计，记录 client 和 target_url | YT/fingerprint.ts:75（只标记 failureKind=blocked，响应照常返回）；YT/web-collector.ts:51-52 | 不同 | — | **高影响**：如果 browse/next 被挑战但 youtubei.js 仍能解析，新系统会把该单元当成功并归档，只是向代理池报 blocked；旧系统会让这次尝试失败，并换身份重试 |
| S-38 | L/youtubeJs.js:1003-1011 | HTTP 403/429 在传输层直接抛错，并带上 status/body/client | YT/fingerprint.ts:75-77（照常返回）；youtubei.js HTTPClient 抛 “failed with status code N”；YT/scrape.ts:18 | 不同 | LT/youtubeFailurePolicy.test.js “plain 403 is a token or client problem until stronger evidence exists” | 429 最后会被识别为 blocked（一致）；403 被识别为 `parse`（见 S-98） |
| S-39 | L/youtubeJs.js:991 | 计算 requestOk 时把 403/429 当失败计入指标 | FG:219（按状态码段计数） | 不适用 | — | 只是指标口径 |
| S-40 | L/youtubeJs.js:901-904,936 | 从请求体 context.client.clientName 识别客户端，缺省为 WEB 并转大写 | EW/raw-archive.ts:120-127 | 一致 | — | 新系统用 `^[A-Z_]{1,40}$` 校验，没有缺省值 |
| S-41 | L/youtubeJs.js:906-919 | 按 videoId 保留权威的 WEB player 内容类型证据；之后 IOS 或无效响应不能覆盖 | YT/web-scrape.ts:154-155（取最后一个 /player 响应） | 不同 | LT/youtubeJs.test.js “IOS without a microformat cannot erase WEB Shorts evidence” | WEB 映射失败转 IOS 后，WEB 的 Shorts/直播信号会丢失；由内容类型或详情组复核 |
| S-42 | L/youtubeJs.js:985-989 | 每个 /browse 响应都提取 uploads_response_evidence，供空上传列表判定使用 | EW/raw-archive.ts:120-134（全部响应归档）；YT/web-collector.ts:143 | 不同 | LT/channelDormancy.test.js | 证据都有，判定逻辑不同；由上传列表组复核 |
| S-43 | L/youtubeJs.js:926-930,1014 | 合并调用方、操作、托管三个中止信号；外部取消时抛原始原因，不记为失败、不惩罚代理 | YT/fingerprint.ts:49,56；YT/web-collector.ts:51,63 | 一致 | LT/youtubeJsCancellation.test.js “YouTube.js transport does not record a response completed with external cancellation” | |
| S-44 | L/youtubeJs.js:954,959 | 响应返回后、读取正文后都再检查一次中止 | YT/fingerprint.ts:49,71 | 一致 | LT/youtubeJsCancellation.test.js “fetchYoutubeJsVideoDetail forwards its explicit cancellation to the real transport” | 读取正文时同一个 abort 信号仍然有效 |
| S-45 | L/youtubeJs.js:1015-1034 | 所有传输错误都附加证据（source=youtubejs_fetch、target_url、client），且只记录一次 | YT/web-collector.ts:107-110；EW/activities.ts:85 | 不同 | LT/youtubeFailurePolicy.test.js “nested transport evidence is retained” | 新系统用失败单元的原始响应归档代替；FingerprintError 本身不带 target 和 client |
| S-46 | L/youtubeJs.js:948-953 | 有网关时一律走 `youtubejs_chrome` 档案的指纹传输；没有网关时才用 undici 加 dispatcher | YT/fingerprint.ts:45-78 | 一致 | — | |
| S-47 | L/youtubeJs.js:925,955,1036 | 运行时统计 requests、failures、challenges、statuses、duration | FG:188-219 | 一致 | — | |

## E. 指纹传输（fingerprintFetch.js、fingerprintGateway.js、fingerprint_gateway.py）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| S-48 | L/fingerprintFetch.js:7-11；compose:494,510,529 | FINGERPRINT_TRANSPORT_REQUIRED 的真值为 1/true/yes/on，默认 false；channel 角色的 Worker 设为 true | EW/config.ts:22-27 | 一致 | — | 新系统 web 模式必须配置网关 |
| S-49 | L/fingerprintFetch.js:15-18 | 处于频道执行上下文、要求指纹却没有网关时，抛错而不是直连 | FG:178-179（没有代理就拒绝，FINGERPRINT_ALLOW_DIRECT=1 仅测试用） | 一致 | — | |
| S-50 | L/fingerprintFetch.js:21-25 | 没有档案时抛错；每个请求前后都断言代理身份没有变化 | YT/fingerprint.ts:25,33 | 不同 | LT/channelExecutionContext.test.js “channel execution context rejects proxy address drift even when proxy id is unchanged” | 新系统的代理 URL 在租约内固定，请求前后不再断言 |
| S-51 | L/fingerprintGateway.js:6-17,119-126 | 请求头过滤 hop-by-hop（connection、content-length、host、keep-alive、proxy-*、te、trailer、transfer-encoding、upgrade） | YT/fingerprint.ts:50（只删 cookie）；FG:183（只删 user-agent） | 不同 | — | 影响低 |
| S-52 | L/fingerprintGateway.js:240；L/py:196 | 强制把 User-Agent 设为档案 UA | FG:183-184 | 一致 | — | |
| S-53 | L/fingerprintGateway.js:249-251 | 网关超时头为 max(1000, timeoutMs 或 YOUTUBEJS_TIMEOUT_MS=30000) | YT/fingerprint.ts:52 | 一致 | — | 新系统取 max(1000, timeout−1000)，使网关先于 Worker 超时 |
| S-54 | L/fingerprintGateway.js:248；L/py:198 | 重定向：follow 或 manual | YT/fingerprint.ts:52；FG:186 | 一致 | — | |
| S-55 | L/fingerprintGateway.js:256-271 | 响应没有 x-fingerprint-response-status 时视为网关错误；payload 里 target_status_raw=0 时判为 proxy_transport | YT/fingerprint.ts:62-66 | 一致 | LT/fingerprintGateway.test.js “fingerprint gateway distinguishes local transport failures from target HTTP responses” | |
| S-56 | L/fingerprintGateway.js:273-298；L/py:228-240 | 目标状态码不在 200–599：0 判 proxy_transport，其余判 invalid_target_status；附响应头和正文前 2048 字节（base64）作证据 | FG:214-218；YT/fingerprint.ts:64,68-69 | 一致 | LT/fingerprintGateway.test.js “an invalid target HTTP status becomes structured evidence instead of a Response RangeError”、“a missing target HTTP status is a proxy transport failure that keeps status 0”、“invalid target status remains structured when target header metadata is malformed”；LT/fingerprint_gateway_status_test.py 两个用例 | 分类一致；新系统不带响应头和正文样本证据 |
| S-57 | L/fingerprintGateway.js:47-90 | 错误码映射为 FINGERPRINT_PROXY_TRANSPORT / UPSTREAM_TRANSIENT / INVALID_TARGET_STATUS / GATEWAY_ERROR，并带 curl_code、session_reset | YT/fingerprint.ts:5-8 | 一致 | LT/fingerprintGateway.test.js | invalid_target_status 在新系统归为 `gateway` |
| S-58 | L/fingerprintGateway.js:300 | 101/204/205/304 响应正文为 null | YT/fingerprint.ts:77 | 一致 | — | 新系统额外对 HEAD 置 null |
| S-59 | L/fingerprintGateway.js:169-208 | 网关是子进程：健康检查轮询 60×100ms（单次超时 500ms），失败则 SIGTERM | — | 不适用 | — | 新系统网关是同 Pod 的 sidecar |
| S-60 | L/fingerprintGateway.js:210-234 | prepare 时按 proxy、档案组、修订号缓存配置，配置超时 10s | YT/fingerprint.ts:19-23（每个档案 PUT，超时 5s）；FG:176-180（代理随请求传入） | 一致 | LT/fingerprintGateway.test.js “fingerprint gateway configures isolated profiles and reconstructs the target response” | 实现方式不同，语义等价 |
| S-61 | L/fingerprintGateway.js:307-315 | Cookie 快照超时 5s | YT/fingerprint.ts:39-44 | 一致 | — | 快照时机不同，见 S-75 |
| S-62 | L/py:168 | 每个档案的并发 = clamp(max_connections, 1, 4)，用信号量限流 | FG:137,147,190 | 一致 | — | 缺省值：旧为 1，新为 2；chrome 档案两边都显式设为 2 |
| S-63 | L/py:106-116 | 传输失败后换新连接池，但保留 Cookie jar（身份） | FG:98-108 | 一致 | LT/fingerprintGateway.integration.test.js “real curl_cffi gateway keeps profile cookies while using the configured proxy” | |
| S-64 | L/py:125-128 | ProxyError 或 SSLError 判 proxy_transport，其他 RequestException 判 upstream_transient | FG:111-112 | 一致 | LT/fingerprintGateway.test.js | |
| S-65 | L/py:189-190 | 只允许 http(s) 目标 | FG:174-175 | 一致 | — | |
| S-66 | L/py:20-32 | 响应头剔除 hop-by-hop 和 set-cookie | FG:34-37,122-123 | 一致 | — | |
| S-67 | L/py:154-184 | configure 整体替换档案集合，关闭过期档案 | FG:134-154；YT/fingerprint.ts:83 | 一致 | — | 新系统逐个 upsert，用完即删；网关重启丢失档案时会重新配置并重试一次（YT/fingerprint.ts:58-61） |

## F. 身份档案与身份策略

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| S-68 | L/browserProfileStore.js:83-95 | visitor_data = protobuf{1: 11 位随机字母表 ID，5: unix 秒 varint}，base64url 编码 | YT/identity.ts:10-16 | 一致 | LT/browserProfileStore.test.js “generated Chrome and Safari profiles carry stable client-family constraints” | |
| S-69 | L/browserProfileStore.js:97-112 | Chrome 档案：impersonate=chrome136（FINGERPRINT_CHROME_TARGET），Windows 的 Chrome/136 UA，max_connections=2 | YT/identity.ts:5,37；YT/fingerprint.ts:21 | 一致 | 同上 | |
| S-70 | L/browserProfileStore.js:114-130 | yt-dlp Safari 档案（safari184，max_connections=1） | — | 不适用 | 同上 | 新系统不使用 yt-dlp；由评论组确认 yt-dlp 路径没有遗漏的采集规则 |
| S-71 | L/browserProfileStore.js:13-27,37-70 | Cookie 状态用 AES-256-GCM 加密；密钥 = sha256("qy-browser-profile:"+secret)，secret 至少 12 个字符 | YT/identity.ts:19-23,42-53 | 一致 | LT/browserProfileStore.test.js “profile cookie state is authenticated and never stored as plaintext” | 新系统要求密钥至少 32 个字符，并把 worker:networkKey 作为 AAD 绑定，更严格 |
| S-72 | L/browserProfileStore.js:187-291 | v1：每个 proxy_id 只有一个活跃档案组；代理地址哈希变化时退役旧组、新建档案 | YT/identity.ts:24；YT/fingerprint.ts:25 | 一致 | LT/browserProfileStore.test.js “one proxy keeps one active profile group and rotates when its address changes” | 新系统按 proxy_id + protocol//host:port 建身份 |
| S-73 | L/browserProfileStore.js:293-389 | v2：按 (policy, version, network_identity_key, profile_epoch) 建档；epoch 不能回退；切到新 epoch 时退役其他 epoch | YT/identity.ts:24 | 缺失 | LT/browserProfileStore.test.js “Rota v2 profiles are keyed by Policy, anonymous network identity and Profile epoch” | 新系统没有 epoch，同一个网络身份的档案永远不会轮换（见 S-120） |
| S-74 | L/browserProfileStore.js:224-291（存 PG，全局共享） | 同一个网络身份的档案在所有 Worker 之间共享 | YT/identity.ts:24（文件键包含 workerId） | 不同 | — | 节点池中同一个代理被多个 Worker 使用时，同一出口 IP 会同时出现多套 visitor_data 和 Cookie。旧系统一个 slot 绑定一个代理，不会出现这种情况 |
| S-75 | L/channelExecutionRuntime.js:330-341；L/browserProfileStore.js:391-401 | Cookie 只在**成功、未取消、代理身份未变**的尝试结束后才写回；快照失败会把这次尝试变成失败 | YT/fingerprint.ts:39-44,76 | 不同 | — | 新系统每个请求完成后都快照并写回，包括 429 或挑战响应之后，可能把“被挑战的 Cookie”持久化 |
| S-76 | L/browserProfileStore.js:149-151；catalog | 档案组的语言、国家、时区来自策略（pt-BR / BR / America/Sao_Paulo） | YT/identity.ts:5 | 一致 | — | |
| S-77 | L/identityPolicyCatalog.js:80-90 | 环境变量 YOUTUBE_LANGUAGE、CONTROL_LANGUAGE、COUNTRY、TZ 不能和策略冲突，冲突就拒绝启动 | YT/identity.ts:5（硬编码） | 不适用 | — | 新系统没有可配置项，不会冲突 |
| S-78 | catalog（required_egress_country=BR，三个角色都设） | 出口国家必须是 BR | EW/config.ts:25,28；YT/web-collector.ts:31；PM/pool.ts:55-57 | 不同 | — | 只有设置 REQUIRED_EGRESS_COUNTRY=BR 才强制；默认不强制 |
| S-79 | catalog（geo_freshness_window_seconds=86400、attempt_safety_window_seconds=7200） | 出口国家地理信息的有效期 24h；尝试安全窗口 2h | YT/web-collector.ts:44-47（仅区域复查时做 sw.js 出口核验） | 不同 | — | 默认 BR 请求依赖分配时记录的 egress_country，没有新鲜度约束 |
| S-80 | catalog（allowed_proxy_tags role:*）；R/policy.go:255-272 | 代理按角色标签固定到 discover/channel/query_quality/detail slot；detail 没有 slot 时回落到 channel | — | 不适用 | — | 新系统是节点级单一代理池（记忆：新代理模型不照搬 Rota） |

## G. 失败分类（youtubeFailurePolicy.js）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| S-81 | L/youtubeFailurePolicy.js:35-40 | HTTP 状态：优先用显式 100–599 状态，否则从文本中提取第一个三位 HTTP 码 | YT/scrape.ts:17-18 | 不同 | LT/youtubeFailurePolicy.test.js “structured failure evidence does not borrow HTTP status from an AggregateError sibling” | 新系统只读 error.info.status 或 error.status（youtubei.js 的错误没有这两个字段），文本中只认 429 |
| S-82 | L/youtubeFailurePolicy.js:120-142 | 失败文本：沿 cause 和 AggregateError.errors 最多遍历 20 个节点，合并 message+code 并去重，截到 2000 字符 | — | 缺失 | LT/youtubeFailurePolicy.test.js “nested transport evidence is retained” | 新系统 classify 只看顶层 message |
| S-83 | L/youtubeFailurePolicy.js:173-185,187-203 | 失败证据字段：status、body（≤500）、source、target_url、client；显式覆盖优先于内嵌证据 | YT/web-collector.ts:107-110 | 不同 | LT/youtubeFailurePolicy.test.js “structured adapter evidence survives an outer generic error message” | 新系统用原始响应归档代替 |
| S-84 | L/youtubeFailurePolicy.js:222-228 | youtube_collection_failure（播放状态显示机器人挑战）判 youtube_challenge，换身份重试，冷却原因为挑战 | YT/web-scrape.ts:147,156；YT/web-collector.ts:63-64 | 一致 | LT/youtubeJs.test.js “Video Detail surfaces a bot challenge from IOS without further clients” | 身份轮换缺失，见 S-120 |
| S-85 | L/youtubeFailurePolicy.js:229-231 | ParserContractError / IncrementalPlanContractError 判 parser_contract，终态，不重试 | YT/scrape.ts:21；EW/activities.ts:36；YT/web-collector.ts:160-168 | 不同 | — | 新系统采集端的 `parse` 是可重试的 UNAVAILABLE：单视频重试 3 次，再加 Activity 重试，会浪费代理配额。独立解析器的契约失败另有 ParseFailure（RP:18） |
| S-86 | L/youtubeFailurePolicy.js:232-234 | PostgreSQL 契约错误码（22001、22P02、23502、23503、23505、23514、42804）判终态 | — | 不适用 | LT/youtubeFailurePolicy.test.js “content and PostgreSQL contract failures do not retry” | Worker 不连数据库 |
| S-87 | L/youtubeFailurePolicy.js:52-71,235-242 | 结构化 proxy_transport（failureKind 和 code 必须一致，否则忽略）：换身份并按网络原因冷却 | YT/fingerprint.ts:7,64-66；YT/web-collector.ts:63-64 | 一致 | LT/youtubeFailurePolicy.test.js “a nested structured Fingerprint proxy failure does not depend on error text” | |
| S-88 | L/youtubeFailurePolicy.js:243-249 | 结构化 upstream_transient：沿用同一身份，**不惩罚代理** | YT/fingerprint.ts:7（curl 码属于 {5,7,28,35,56,97} 时惩罚） | 不同 | LT/youtubeFailurePolicy.test.js “structured Fingerprint upstream failures keep the same identity” | 新系统对 curl 28（超时）、56、7 等 upstream_transient 也惩罚代理 |
| S-89 | L/youtubeFailurePolicy.js:73-86,250-261 | 只有来源可信（fingerprint_gateway）时，旧格式文本 “proxy_transport” 或 “SSLError…curl_code 35” 才判 proxy_transport | YT/fingerprint.ts:7（curl 35） | 一致 | LT/youtubeFailurePolicy.test.js “trusted Fingerprint legacy SSLError text rotates the proxy”、“trusted Fingerprint legacy proxy_transport text rotates the proxy”、“untrusted legacy Fingerprint-shaped text does not rotate the proxy” | |
| S-90 | L/youtubeFailurePolicy.js:97-107,262-276 | FINGERPRINT_INVALID_TARGET_STATUS 且 target_status_raw=0：判 proxy_transport，并保留原始状态 | FG:215；YT/fingerprint.ts:64 | 一致 | LT/youtubeFailurePolicy.test.js “fingerprint status_code=0 is a proxy transport failure that keeps the raw status”、“an aggregated scrape failure still rotates when one layer is fingerprint status 0” | |
| S-91 | L/youtubeFailurePolicy.js:262-276 | 非 0 的非法目标状态：不进入特殊分支，继续按文本规则分类 | YT/fingerprint.ts:64（gateway）；YT/web-collector.ts:166 | 不同 | — | 新系统直接让单元失败、交给 Activity 重试，不惩罚代理 |
| S-92 | L/youtubeFailurePolicy.js:109-118,277-288 | 可信来源（fingerprint_gateway、youtubejs_fetch、youtube_fetch_transport）的超时（TimeoutError 或超时文本）：判 proxy_transport，换身份并冷却 | 网关 curl 超时：YT/fingerprint.ts:7（curl 28，惩罚）；Worker 端超时：YT/fingerprint.ts:56 → gateway → YT/web-collector.ts:166 | 不同 | LT/youtubeFailurePolicy.test.js “a trusted YouTube.js request timeout rotates the proxy instead of keeping the same identity”；LT/youtubeJsTimeout.test.js | 网关先超时的常见情况等价；Worker 端超时不惩罚代理，单视频也不再在单元内重试 |
| S-93 | L/youtubeFailurePolicy.js:115-118,315-321 | 没有可信来源标记的超时文本：判 upstream_transient，沿用同一身份 | YT/scrape.ts:20（timed out 判 network，惩罚代理） | 不同 | LT/youtubeFailurePolicy.test.js “an unmarked timeout keeps the same identity” | 主要影响新系统的 legacy 模式 |
| S-94 | L/youtubeFailurePolicy.js:289-295 | content_terminal：HTTP 404；“(channel\|video\|playlist)…does not exist/not found”；private video、is private、has been removed、members-only、subscriber-only、“does not have a … tab”，均判终态、不重试 | YT/scrape.ts:19；EW/activities.ts:36（NOT_FOUND 不可重试）；YT/web-scrape.ts:95-106 | 不同 | LT/youtubeFailurePolicy.test.js “content and PostgreSQL contract failures do not retry” | youtubei.js 抛的 “failed with status code 404” 不会匹配新正则，会变成 parse 并重试；“does not have a X tab” 缺失；新系统多了 “this channel is not available” |
| S-95 | L/youtubeFailurePolicy.js:297-313 | 显式代理文本（proxyerror、proxy_unavailable、proxy connection、tunnel connection、socks connection、proxy authentication、407）：判 proxy_transport | YT/scrape.ts:20；EC/proxy-connect.ts:9-11,100 | 一致 | LT/youtubeFailurePolicy.test.js “proxy transport failures are separate from upstream timeouts” | |
| S-96 | L/youtubeFailurePolicy.js:299,314-316 | 模糊 TLS 文本（wrong version number、ssl routines）：没有可信来源判 upstream_transient，不惩罚；来源可信才判 proxy_transport | FG:111-112（SSLError 一律 proxy_transport） | 不同 | LT/youtubeFailurePolicy.test.js “an unmarked generic TLS error is not blamed on the proxy”、“plain SSL routines text without trusted transport evidence does not rotate the proxy”、“trusted source on a wrapper cannot borrow TLS text from its cause”、“trusted source metadata cannot be combined with TLS text from an AggregateError sibling” | 指纹路径上旧系统同样判 proxy_transport，实际差异小 |
| S-97 | L/youtubeFailurePolicy.js:317-323 | 429、too many requests、rate limit(ed)：判 youtube_rate_limited，换身份，按限流原因冷却 | YT/scrape.ts:18；YT/fingerprint.ts:75 | 一致 | LT/youtubeFailurePolicy.test.js “explicit rate limits and bot challenges require a new identity” | 新系统不认 “rate limit” 文本；冷却参数不同，见 S-122 |
| S-98 | L/youtubeFailurePolicy.js:324-330 | 挑战文本（sorry/index、detected unusual traffic、automated quer、not a bot、bot challenge、captcha、verify you are human）：判 youtube_challenge | YT/scrape.ts:18（异常文本只认 unusual traffic、confirm you're not a bot）；YT/web-scrape.ts:97 | 不同 | 同上 | 异常路径缺少 sorry/index、automated queries、captcha、verify you are human |
| S-99 | L/youtubeFailurePolicy.js:331-340 | 403 或 po_token、proof of origin、serviceintegritydimensions、login required、sign in、not available on this app、client unsupported：判 token_or_client，按 route_or_token 重试，刷新会话或回退客户端，不惩罚代理 | YT/scrape.ts:21（落为 parse）；YT/web-scrape.ts:149-151（换下一个客户端） | 不同 | LT/youtubeFailurePolicy.test.js “plain 403 is a token or client problem until stronger evidence exists” | 新系统没有这一类：结果上不惩罚代理、下次尝试新建会话，近似等价；PO Token 相关文本没有专门处理 |
| S-100 | L/youtubeFailurePolicy.js:341-346 | 5xx、408、425、timeout、abort、fetch failed、failed to extract any player response、no player response、network、socket、econn、eai_again、connection refused/reset、DNS、remote end closed：判 upstream_transient，沿用同一身份，**不惩罚代理** | YT/scrape.ts:20-21 | 不同 | LT/youtubeFailurePolicy.test.js “proxy transport failures are separate from upstream timeouts” | 新系统把 fetch failed、ECONN、socket、network 判为 `network` 并惩罚代理；5xx 落为 parse |
| S-101 | L/youtubeFailurePolicy.js:347-352 | YoutubeJsRequiredSurfaceError（comments、player 必需表面缺失）：判 parser_runtime，默认重试 | YT/web-scrape.ts:164（评论失败降级为 unavailable，视频照常成功） | 不同 | LT/youtubeFailurePolicy.test.js “a required YouTube.js surface shape failure is a parser runtime failure”、“a required YouTube.js surface wrapper does not hide a nested rate limit” | 新系统会静默丢失评论；被包装在里层的 429 也被吞掉。由评论组复核 |
| S-102 | L/youtubeFailurePolicy.js:353-355 | ytinitialdata not found、parse、invalid json、unexpected token：判 parser_runtime，默认重试 | YT/scrape.ts:21；EW/activities.ts:36 | 一致 | — | |
| S-103 | L/youtubeFailurePolicy.js:356-361 | 五位 SQLSTATE 或数据库文本且来源含 database：判 database_runtime，沿用同一身份 | — | 不适用 | — | Worker 不连数据库 |
| S-104 | L/youtubeFailurePolicy.js:362 | 未知错误：默认重试 | EW/activities.ts:37（INTERNAL_ERROR，不可重试）；YT/web-collector.ts:164；ST/index.ts:290-291 | 不同 | — | 新系统的未知错误在 Activity 层不重试，只靠计划级自动重试（最多 3 次） |
| S-105 | L/youtubeFailurePolicy.js:365-379 | 聚合优先级：parser_contract 1000 > database_contract 990 > 结构化 proxy_transport 950 > 结构化 upstream_transient 940 > content_terminal 900 > proxy_transport 850 > rate_limited 800 > challenge 790 > token_or_client 700 > upstream_transient 600 > parser_runtime 500 > database_runtime 400 > unknown 0 | YT/scrape.ts:13-21（顺序：Fingerprint → blocked → not_found → network → parse） | 不同 | LT/youtubeFailurePolicy.test.js “failure selection returns one complete cause node” | |
| S-106 | L/youtubeFailurePolicy.js:381-432 | 沿 cause/errors 链最多 20 个节点逐个判定，取优先级最高的节点；外层包装的来源和状态不能借给里层结构化证据 | — | 缺失 | LT/youtubeFailurePolicy.test.js “structured failure evidence never borrows source from a wrapper”、“nested Fingerprint evidence does not borrow an outer YouTube HTTP status” | |
| S-107 | L/youtubeFailurePolicy.js:398-403 | VIDEO_API_FALLBACK_UNRESOLVED 判 parser_runtime，终态，不重试 | YT/web-collector.ts:181-182；EW/activities.ts:35 | 不同 | — | 新系统按 DataApiError 的类型映射；由 Data API 回退组复核 |
| S-108 | L/youtubeFailurePolicy.js:438-440 | 只有 proxy_action ≠ none 时才上报代理失败 | YT/web-collector.ts:51-52,63-66 | 一致 | LT/youtubeFailurePolicy.test.js “plain 403 is a token or client problem until stronger evidence exists” | |

## H. 重试、路由切换、代理惩罚与冷却（queues / worker / managedWorkerExecution / Rota）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| S-109 | L/queues.js:67-71 | BullMQ 作业 attempts=3，指数退避 5s，jitter 0.5 | EW/workflows.ts:24-28（maximumAttempts=max(maxAttempts,5)，初始 5s、×2、上限 2min） | 不同 | — | |
| S-110 | L/queues.js:74-85；L/worker.js:1424-1426 | retry_mode=none 时丢弃作业不重试；new_identity 标记 requires_new_identity；重试次数耗尽即终态 | EW/activities.ts:87（nonRetryable = !retryable） | 一致 | LT/queues.test.js “terminal failure decisions discard BullMQ retries” | |
| S-111 | compose:62 | 视频详情最多尝试 3 次（YOUTUBE_DETAIL_MAX_ATTEMPTS） | YT/web-collector.ts:160 | 一致 | — | 仅指标模式只试 1 次 |
| S-112 | L/managedWorkerExecution.js:8-12,98-115 | 只有 proxy_transport、youtube_rate_limited、youtube_challenge 会切换路由；优先级 限流/挑战(3) > 传输(2)；缺省来源 youtube_managed_request；API 回退未决、恢复挂起、陈旧执行不切换 | YT/web-collector.ts:63-66,160-168 | 不同 | LT/managedWorkerExecution.test.js “only structured proxy transport, rate-limit, and challenge failures switch Route”、“a nested rate limit Observation does not borrow its wrapper source”、“a structured Route failure without a local source uses the managed default”、“stale detail ownership overrides earlier network diagnostics and never switches Route” | 新系统每次重试都重新取租约，但池子可能又给同一个代理（`failure` 要连续 3 次才冷却），所以不保证“换路由”；parse 和 upstream 也会触发新租约 |
| S-113 | L/managedWorkerExecution.js:171-189 | 可重试的网络失败必须先把检查点持久化，再切路由 | YT/web-collector.ts:98-100,155-156（单元归档复用） | 一致 | LT/managedWorkerExecution.test.js “a managed failure is returned only after its durable checkpoint” | 已完成的单元重试时直接复用 |
| S-114 | R/task.go:106-183；R/manager.go:128-133 | 每次作业执行最多切 2 次路由；每个业务运行最多 9 次网络尝试（API 续接不计入） | YT/web-collector.ts:160；EW/workflows.ts:26；ST/index.ts:290-291（计划自动重试 3 次，间隔 5/15/60 分钟） | 不同 | — | 新系统的总尝试上限是各层相乘，没有统一预算 |
| S-115 | R/policy.go:118-126；L/channelExecutionContext.js:143-151 | 一个任务不能换 IP 继续；尝试中途代理变化即中止（ProxyIdentityChangedError），本次不写回 Cookie | YT/web-collector.ts:31-42；YT/fingerprint.ts:25 | 不同 | LT/channelExecutionContext.test.js “channel execution context rejects proxy address drift even when proxy id is unchanged” | 新系统一个单元固定用一个租约，但同一计划的不同单元（About、Targets、各视频）可能走不同代理；中途分配变化不会中止 |
| S-116 | R/completion.go:146-157,186-191 | 没有可用备用代理：暂停（paused_no_reserve），1000ms 后重试；等待新路由：250ms 后重试 | PM/pool.ts:50-63；YT/transport.ts:16,19（默认等 10s）；YT/web-collector.ts:34-38（最多睡 30s） | 不同 | — | 只是数值不同 |
| S-117 | R/observation.go:405-414 | 观察到挑战 → rotate_profile；proxy_transport 或限流 → rotate_route；其他 → 不动 | PM/pool.ts:96-118（只有 blocked / failure） | 缺失 | — | 新系统没有“轮换身份档案”这个动作 |
| S-118 | R/observation.go:416-435 | 待处理动作合并：rotate_profile(2) > rotate_route(1) > none | YT/fingerprint.ts:65 | 一致 | — | blocked 不会被后来的 network 降级 |
| S-119 | R/observation.go:26-37 | 上报给代理控制的载荷禁止含 cookie、visitor_data、proxy_url、headers、html、raw_response、authorization、proxy_password 等键 | YT/transport.ts:21-23 | 一致 | — | release 只上报 lease_id、outcome、latency_ms、error_class |
| S-120 | R/completion.go:137,478-516 | 挑战后**退役该网络身份的档案 epoch**，新 epoch+1，即换新的 visitor_data 和 Cookie；同时换路由 | YT/identity.ts:25-41（每个 networkKey 一份身份，永久复用） | 缺失 | LT/browserProfileStore.test.js “Rota v2 profiles are keyed by Policy, anonymous network identity and Profile epoch” | **高影响**：被挑战的 visitor_data 和 Cookie 会在代理冷却结束后原样再用 |
| S-121 | R/completion.go:193-205；R/proxy_health_transition.go:106-132 | 被替换的代理进入隔离：rotate_profile → youtube_unusable；proxy_transport → hard_unreachable；其他观察 → youtube_unusable；没有观察 → soft_unreachable | PM/pool.ts:104-118 | 不同 | — | |
| S-122 | R/proxy_health_transition.go:14-28；R/manager.go:122-127；compose:275-276 | 冷却时长：YouTube 不可用（挑战/限流）30 分钟；网络不可达 5 分钟；**单次**观察即隔离 | CT/proxy-policy.ts:3-8；PM/pool.ts:108-118 | 不同 | — | 新系统：blocked 冷却 600s，之后需连续 2 次探测通过才重新上岗；网络失败要连续 3 次才冷却，时长 60s×2ⁿ，上限 1800s；连续 3 次冷却判 failed |
| S-123 | R/report.go:206-251 | 成功上报：YouTube 响应时间 EWMA 0.8/0.2，failure_score ×0.8；样本数截到 1..10000，时长截到 1..600000ms | PM/pool.ts:96-101 | 不同 | — | 新系统延迟 EWMA 为 0.7/0.3，成功时清零连续失败 |
| S-124 | R/report.go:258-300 | 失败上报：failure_score = min(1, s×0.8+0.2)，立即隔离，错误文本截到 500 字符 | PM/pool.ts:103-118 | 不同 | — | 新系统错误类截到 120 字符，无 failure_score |
| S-125 | R/policy.go:205-253 | 选代理的排序：国家偏好 > 标签 > 身份 > 有效性 > 住宅 > HTTP 协议 > failure_score > 有无 YT 计时 > 响应时间 > id | PM/pool.ts:64-66（连续失败×10 + 在用比例 + 随机×0.5） | 不同 | — | 新模型不照搬 Rota（记忆）；出口国家改为硬过滤 |
| S-126 | R/policy.go:289-301；compose:273-274 | 备用水位：工作数的 25%，最少 3 个 | — | 不适用 | — | 新代理模型没有 slot 备用池 |
| S-127 | R/manager.go:113-121；compose:270-272 | 代理租约 60s（持续续租），对账周期 5s，资源同步 10 分钟 | YT/transport.ts:13；YT/web-collector.ts:31（TTL ≤180s）；PM/pool.ts:50,68（默认 120s，受中央租约约束）；PM/main.ts:15 | 不同 | — | 新租约不续期，单元超过 TTL 会以 gateway 错误失败（YT/fingerprint.ts:47-48） |
| S-128 | R/completion.go:73-75 | 租约丢失（ErrLeaseGone）只拒绝本次完成，不算代理健康失败 | PM/pool.ts:120-123（过期记为 timeout，并计一次连续失败） | 不同 | — | |
| S-129 | R/completion.go:92-122 | 国家复查不算代理健康失败；只认严格国家匹配（偏好 0/1）；没有该国备用代理时返回 NO_COUNTRY_RESERVE 并保留原路由 | YT/web-collector.ts:19,31-38,58-61,89-96；PM/pool.ts:55-57 | 一致 | LT/managedWorkerExecution.test.js “country recheck persists a bounded intent without a network failure checkpoint” | 新系统还会用 YouTube sw.js 核验出口国家（最多 3 个代理，等待 120s）；由区域组复核 |
| S-130 | R/completion.go:606-608；L/proxyIdentity.js:72-80 | 完成任务前必须已静默：没有在途的托管请求 | YT/web-collector.ts:68（work 结束后在 finally 中 release） | 一致 | — | |
| S-131 | compose:494,510,529,541,552 | 每个角色有独立的身份策略（channel / discover / query_quality） | YT/identity.ts:5（只有 channel 策略） | 不同 | — | 搜索（query-runner）用的身份由搜索组复核 |

## I. 代理身份与分配（proxyIdentity.js、proxyAssignment.js）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| S-132 | L/proxyIdentity.js:46-66 | 用 AsyncLocalStorage 绑定作业的代理身份；缺省回落到 YOUTUBE_PROXY_ID/URL；proxy_user 从 URL 用户名推出 | — | 不适用 | LT/proxyIdentity.test.js “proxy report identity remains bound to the active job across async work”、“workers without a proxy slot use an empty execution identity” | 新系统显式传递租约 |
| S-133 | L/proxyIdentity.js:24-44 | route_generation 必须为正整数；profile_epoch 必须非负，0 也要保留 | PM/pool.ts:9,77（generation） | 不同 | LT/proxyIdentity.test.js “managed execution identity preserves the complete Route tuple”、“managed execution identity preserves Rota's initial profile epoch zero” | 新系统没有 epoch |
| S-134 | L/proxyAssignment.js:7-14 | 代理地址哈希 = sha256(id\|protocol(缺省 http)\|address)，trim 并小写 | YT/fingerprint.ts:25 | 一致 | LT/proxyAssignment.test.js “proxy address hash is stable for the same normalized Rota assignment” | 新系统直接用 `${proxy_id}:${protocol}//${host}` 作为网络键 |
| S-135 | L/proxyAssignment.js:16-48 | 分配身份：v2 元组（slot、lease、route_generation、policy、network key、epoch）缺一不可；否则用 proxyId:addressHash；不完整则视为“不同分配” | PM/pool.ts:72-81 | 不同 | LT/proxyAssignment.test.js “proxy assignment identity requires both proxy id and address hash”、“Rota v2 assignment identity is fenced by Lease, Route, Policy and Profile epoch” | 新系统只用 generation 做 release 的栅栏 |

## J. HTTP 客户端、详情并发、运行环境、中止信号

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| S-136 | L/httpClient.js:3-17 | 直连持久 Agent：connections 8、pipelining 1、keepAlive 60s、最大 keepAlive 300s、headers/body 超时 300s；非法值回落默认，最小 1000 | YT/data-api.ts:37（全局 fetch，15s 超时） | 不同 | LT/httpClient.test.js “persistent HTTP client accepts one-hour header and body timeouts”、“persistent HTTP client keeps bounded defaults for invalid settings” | |
| S-137 | L/detailConcurrency.js:3-7；compose:63 | 详情并发默认 2，限制在 1..4，非数值回落默认 | YT/web-collector.ts:153-176 | 不同 | LT/detailConcurrency.test.js “normalizeDetailConcurrency defaults to two and clamps to the supported range” | 新系统逐个视频串行，吞吐约为旧系统一半 |
| S-138 | L/detailConcurrency.js:9-61 | 有序预取：按窗口并发预取、按源顺序处理；stopAfter 时排空当前窗口并返回剩余项；处理出错先排空窗口再抛错 | YT/web-collector.ts:153-176 | 不同 | LT/detailConcurrency.test.js “processWithOrderedPrefetch prefetches concurrently but processes in source order”、“…stops opening windows after a retryable result”、“…returns all rows after an ordered cutoff”、“…drains the current prefetch window after processing throws”、“…handles a later sibling rejection before it is consumed” | 新系统没有预取，顺序处理 |
| S-139 | L/detailConcurrency.js:18,25,37,39,46,58,63 | 处理每一项前、开下一个窗口前、最终返回前都检查取消；排空时取消优先 | YT/web-collector.ts:154,163 | 一致 | LT/detailConcurrency.test.js 中 cancellation 相关的 6 个用例 | |
| S-140 | L/runtimeEnvironment.js:3-19 | NAME 和 NAME_FILE 二选一，不能同时设；必填项缺失就报错；值做 trim | EW/config.ts:8,23 | 不适用 | LT/runtimeEnvironment.test.js 三个用例 | 新系统只用 *_FILE 读密钥 |
| S-141 | L/abortSignal.js:1-6 | 合并中止信号：去重；只有一个时原样返回；没有时返回 null | YT/fingerprint.ts:49；EW/activities.ts:159（AbortSignal.any） | 一致 | LT/abortSignal.test.js 前 4 个用例 | |
| S-142 | L/abortSignal.js:8-10 | throwIfAborted 抛出原始 reason | signal.throwIfAborted() | 一致 | LT/abortSignal.test.js “throwIfAborted throws the original abort reason” | |

## K. “Please sign in” 排除策略（youtubeLoginRequired.js）

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| S-143 | L/youtubeLoginRequired.js:2-5 | 只有 status=LOGIN_REQUIRED 且 reason 精确等于 “please sign in[.!]?”（忽略大小写、trim）才命中 | YT/web-scrape.ts:96,104 | 一致 | LT/youtubeLoginRequired.test.js “only the exact login response qualifies; age, bot and ambiguous errors do not” | |
| S-144 | L/youtubeLoginRequired.js:12-22；L/youtubeJs.js（详情客户端循环） | WEB 和 IOS 都返回 Please sign in 才排除；既不算路由失败，也不走 API 回退 | YT/web-scrape.ts:161-167 | 一致 | LT/youtubeLoginRequired.test.js “repeated Please sign in is excluded without API or route failure (exception/response)” | |
| S-145 | L/youtubeLoginRequired.js:12-22 | 详情表示：access_status=unknown，collection_exclusion{reason_code: login_required, policy_version: 1}，source=youtubejs_player，并记录各客户端尝试 | YT/web-scrape.ts:170-173（VideoUnavailable，access_status=login_required） | 不同 | — | 表示形式不同，下游映射由详情组复核 |
| S-146 | L/youtubeLoginRequired.js:24-34 | 处置：terminal_excluded，next_attempt_at=infinity，不可重试 | ST/index.ts:404,447（不可用视频不参与抽样） | 不同 | LT/youtubeLoginRequired.test.js “permanent exclusions survive later discovery and low-frequency repair” | 新系统下一次全量计划会把上传列表里的同一个 ID 重新采集 |
| S-147 | L/youtubeLoginRequired.js:36-51 | 以最近一次已结算的决定为准；人工重新分类可以覆盖；新的全量抓取候选不能覆盖 | — | 缺失 | LT/youtubeLoginRequired.test.js “cached exclusion can be released by an explicit finite retry time” | |
| S-148 | L/youtubeLoginRequired.js:55-65 | 调度 SQL 把已排除的视频移出修复和富化 | ST/index.ts:404 | 一致 | LT/youtubeLoginRequired.test.js “stored detail stays untouched and enrichment stops without a dead letter” | 只是部分对应：新系统没有修复和富化队列 |

## L. compose 中的相关默认值

| 编号 | 旧位置 | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| S-149 | compose:54 | YOUTUBE_LANGUAGE=pt-BR（档案和 yt-dlp 的语言） | YT/identity.ts:5 | 一致 | — | |
| S-150 | compose:57,496 | 时区 America/Sao_Paulo（档案和容器 TZ） | YT/identity.ts:5；YT/web-scrape.ts:38 | 一致 | — | |
| S-151 | compose:59 | 每个频道的内容上限 30 | CT/index.ts:128 | 一致 | — | 由范围组复核 |
| S-152 | compose:60 | 内容最大年龄 90 天 | CT/index.ts:126-129 | 不同 | — | 新系统的 web 采集不按年龄截断；由范围组复核 |
| S-153 | compose:61 | 详情在频道作业内联采集 | EW/workflows.ts:33-38 | 一致 | — | |
| S-154 | compose:65,69 | 开启视频 API 批量回退；Data API 只作应急回退 | YT/web-collector.ts:177-199 | 一致 | — | 由 Data API 组复核 |
| S-155 | compose:570-571 | Data API 批量并发 1；每日请求上限 500 | CT/index.ts:502（api_daily_limit 默认 10000 单位） | 不同 | — | 单位和数值都不同；由 Data API 组复核 |
| S-156 | compose（YTDLP_COMMENT_FIRST_PAGE_MAX=20） | 评论首屏最多 20 条 | CT/index.ts:130 | 一致 | — | |
| S-157 | compose:78 | PROXY_SLOT_POLL_MS=5000 | PM/main.ts:15（同步周期 30s） | 不适用 | — | 代理模型不同 |

## 统计

| 状态 | 数量 |
|---|---|
| 一致 | 72 |
| 不同 | 65 |
| 缺失 | 6 |
| 不适用 | 14 |
| 合计 | 157 |

## 不同 / 缺失项按影响排序

1. **S-120、S-117、S-73（缺失）挑战后不轮换身份档案。** 旧系统遇到机器人挑战会退役该网络身份的 profile epoch，换新的 visitor_data 和 Cookie。新系统每个 networkKey 的身份永久复用，代理冷却结束后被挑战的身份原样再上。
2. **S-37、S-33、S-34、S-35、S-98（不同）挑战检测和处理变弱。** 传输层检出挑战后，新系统只给代理池报 blocked，不让请求失败，可能把被挑战的响应当成功归档；检测模式也缺少 sorry/index、automated queries、verify you are human、alert/dialog/captcha renderer 等结构化信号，并且不做 NFD。
3. **S-2、S-32（不同）youtubei.js 会话语言由 en 改为 pt-BR。** 这改变了所有本地化文本，以及计数和日期的解析口径，需要确认是有意为之并有回归覆盖。
4. **S-122、S-121、S-124（不同）冷却策略。** 旧系统单次观察即隔离，挑战或限流冷却 30 分钟、网络冷却 5 分钟。新系统 blocked 只冷却 10 分钟（另需重新试用），网络失败要连续 3 次才冷却。
5. **S-75（不同）Cookie 写回时机。** 新系统每个请求后都写回，包括 429 或挑战之后；旧系统只在尝试成功后写回。
6. **S-74（不同）身份按 Worker 隔离。** 同一个代理在节点内被多个 Worker 共用时，同一 IP 会出现多套身份。
7. **S-85、S-104、S-94（不同）终态和重试分类。** 采集端的解析或契约失败在新系统里会重试（浪费代理）；youtubei.js 的 HTTP 404 会落为 parse 并重试；未知错误在 Activity 层不重试；“does not have a … tab” 缺失。
8. **S-88、S-100、S-93、S-92（不同）代理惩罚边界。** 新系统会惩罚 upstream_transient 中 curl 28/56/7 等错误和通用网络错误，旧系统对这些沿用同一身份、不惩罚；Worker 端超时则反过来不惩罚代理。
9. **S-112、S-114、S-115、S-127、S-128（不同）路由切换和预算。** 重试不保证换代理；没有统一的尝试预算（旧系统为 2 次切换、9 次尝试）；租约不续期，长单元会因租约到期失败；租约过期会计入代理失败。
10. **S-101（不同）评论必需表面失败。** 新系统静默降级为 unavailable，不再重试，也可能吞掉里层的 429。
11. **S-41（不同）WEB player 内容类型证据。** 切到 IOS 后，WEB 的 Shorts/直播证据会被覆盖。
12. **S-78、S-79（不同）BR 出口。** 默认不强制，也没有地理信息新鲜度窗口。
13. **S-137、S-138、S-18（不同）并发模型。** 详情由并发 2 加有序预取改为串行；Worker 并发由 1 改为 2。
14. **S-146、S-147（不同/缺失）login_required 排除。** 新系统没有跨计划的永久排除，也没有人工释放机制。
15. **S-82、S-106、S-81、S-105（缺失/不同）错误链遍历与证据选择。** 主要影响诊断准确度，以及嵌套错误下的分类。
16. 其余低影响项：S-1、S-5、S-7、S-11、S-12、S-29~S-31、S-42、S-45、S-50、S-51、S-91、S-96、S-97、S-99、S-107、S-109、S-116、S-123、S-125、S-131、S-133、S-135、S-136、S-145、S-152、S-155、S-23、S-27。
