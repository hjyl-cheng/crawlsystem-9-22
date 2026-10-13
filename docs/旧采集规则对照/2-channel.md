# 规则清单 2：频道 About、频道身份与频道生命周期

范围：旧系统 `L = oldsystem/services/qybullmq/src/`（youtubeJs.js 636–842、1301–1424，aboutCurrent / aboutObservation / incrementalAbout / aboutMetrics / youtubeJoinedDate / youtubeBusinessEmailAvailability / verifiedCurrent / channelLifecycle / channelQualification / channelApiFallback / agentCountryPolicy / channelDormancy / fullCrawlYoutubeJsFactory（About 与准入部分），以及 YouTube.js 路径实际调用的 localizedCount.js、publicationLinks.js / publicationUrl.js、pipelineV2.js 频道快照段、youtube.js 中的 parseChannelHeader / Data API 频道函数、incrementalTerminalFailure.js）。
新系统 `N = crawlsystem-business/`。旧测试路径相对 `oldsystem/services/qybullmq/test/`。

语言前提：旧会话 `lang = YOUTUBE_CONTROL_LANGUAGE || "en"`、`location = BR`；新采集与解析器回放都是 `pt-BR / BR / America/Sao_Paulo`。“备注”列注明了该语言差异对每条规则是否有影响。

状态：一致 / 缺失 / 不同 / 不适用（附原因）。

## A. 会话与频道请求

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| C-1 | youtubeJs.js:47-48, 1058-1083 | Innertube 会话：`lang = YOUTUBE_CONTROL_LANGUAGE \|\| YOUTUBE_LANGUAGE \|\| "en"`，`location = YOUTUBE_COUNTRY \|\| "BR"`，并设置 retrieve_player=false、generate_session_locally=true、retrieve_innertube_config=false、enable_session_cache=false；使用画像的 UA、visitor_data、时区 | N apps/execution-worker/src/youtube/web-scrape.ts:36-42；apps/raw-parser/src/parser.ts:35 | 不同 | — | **语言有影响**：en 改为 pt-BR 后，About 的国家名、加入日期、计数文字、标签页名、认证徽章标签和终止提示都会变成葡语。下面每条本地化规则都要按 pt-BR 重新核对。其余会话参数一致 |
| C-2 | aboutMetrics.js:79；incrementalAbout.js:13；youtubeJs.js:777-799 | 计数解析使用的语言等于会话语言（DEFAULT_LANGUAGE） | N web-scrape.ts:13, 51（解析写死 'pt-BR'） | 一致 | — | 新系统会话和解析都用 pt-BR，彼此一致。若以后改会话语言，这两处必须同步改 |
| C-3 | youtubeJs.js:1301-1309 | channel_id 去掉首尾空白后不能为空；通过 `client.getChannel(id)` 获取频道根页面 | N web-scrape.ts:45 | 一致 | — | 新系统的 channel_id 由契约 YoutubeChannelIdSchema 校验 |
| C-4 | youtubeJs.js:1312-1327, 1334-1337；aboutMetrics.js:129-136；incrementalAbout.js:5-35 | `getAbout()` 失败也被容忍：保留 about_error，about_observed=false，仍用 header 生成身份字段。增量 About 会记成 Partial About（`get_about_failed_identity_current`，不产生指标快照） | N web-scrape.ts:45（getAbout 抛错时整个 channelFacts 失败） | 不同 | incrementalAbout.test.js「a failed getAbout becomes one Partial About with identity Current and no metric snapshot」；aboutMetrics.test.js「a failed getAbout ignores header fallback and does not qualify for a snapshot」 | 新系统没有“只有身份、没有指标”的部分 About，About 失败就整步重试或失败。语言无关 |
| C-5 | fullCrawlYoutubeJsFactory.js:50-66 | 全量准入必须满足：快照存在、about_requested=true、没有 about_error、about_observed=true。否则抛出 `YoutubeJsRequiredSurfaceError`（required_surface=channel/channel_about），可重试 | N web-collector.ts:111-131；activities.ts:31-37（ScrapeError → UNAVAILABLE，可重试） | 一致 | fullCrawlYoutubeJsFactory.test.js「Full Crawl lifecycle accepts the shared Collector seam」 | 新系统 About 必须成功才产出事实，失败可重试 |
| C-6 | fullCrawlYoutubeJsFactory.js:67-70 | 身份冲突校验：解析出的 metadata.channel_id 必须等于请求的 channel_id，否则报 `Channel identity conflicts`（防止重定向或串号） | N web-scrape.ts:56（channel_id 直接取请求值，不校验 `metadata.external_id`） | 缺失 | fullCrawlYoutubeJsFactory.test.js「optional handle does not weaken channel identity validation (${field})」 | 高。YouTube 重定向到别的频道时，新系统会把别人的资料记到本频道下 |
| C-7 | youtubeJs.js:808 | channel_id 的取值顺序：metadata.external_id → about.id → about.channel_id → header.channel_id → 请求 ID | N web-scrape.ts:56 | 不同 | 同上 | 与 C-6 是同一个问题 |
| C-8 | youtubeJs.js:809 | title 的取值顺序：metadata.title → header.author.name / header.title → header.page_title | N web-scrape.ts:55-56（只用 meta.title） | 不同 | — | 回退链变短了 |
| C-9 | fullCrawlYoutubeJsFactory.js:71-84 | title 和 channel_url 是必填项，缺失时抛 ParserContractError（`required_channel_${field}_not_observed`，按解析契约错误处理） | N web-scrape.ts:55（ScrapeError('parse')）→ activities.ts:36（UNAVAILABLE，可重试） | 不同 | fullCrawlYoutubeJsFactory.test.js「optional handle does not weaken channel identity validation (${field})」 | 错误分类不同：旧系统是契约错误，新系统按可重试处理 |
| C-10 | fullCrawlYoutubeJsFactory.js:71-72 | handle 可以没有（例如自动生成的 Topic 频道），不阻断准入 | N packages/contracts/src/index.ts:46（handle 可为 null） | 一致 | fullCrawlYoutubeJsFactory.test.js「optional channel handle survives admission and fetch (handle=${handle})」 | — |

## B. 身份字段提取

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| C-11 | youtubeJs.js:640-648, 810 | handle 的取值顺序：header.channel_handle（缺 @ 时补上）→ 依次用 `/\/@([^/?#]+)/` 匹配 metadata.vanity_channel_url、metadata.url、about.canonical_channel_url → header metadata part 中以 @ 开头的值 | N web-scrape.ts:57（vanity_channel_url 用 `/@[^/]+/` 匹配 → header 字符串用 `/^@[\w.\-]+$/` 匹配） | 不同 | — | 缺少 header.channel_handle 和 about.canonical_channel_url 两个来源；header 正则只认 ASCII，非拉丁字符的 handle 会丢；vanity 正则不会在 `?` 或 `#` 处截断。语言无关 |
| C-12 | youtubeJs.js:811 | channel_url = metadata.url → about.canonical_channel_url → `/channel/{id}`，并补全为绝对地址 | N web-scrape.ts:56（固定拼成 `https://www.youtube.com/channel/{id}`） | 一致 | — | metadata.url 本来就是 /channel/UC… 形式，结果相同 |
| C-13 | youtubeJs.js:812；aboutCurrent.js:91 | vanity_channel_url = metadata.vanity_channel_url → about.canonical_channel_url，再经 normalizePublicationUrl 规范化 | N packages/store/src/publication-map.ts:10（ChannelFacts 里没有这个字段，发布时用 handle 拼 `youtube.com/@handle`） | 不同 | — | 没有 handle 但有 /c/、/user/ 自定义地址时，新系统会发布 null |
| C-14 | youtubeJs.js:650-652, 813 | description 取 metadata.description、about.description、header.description 中最长的一个 | N web-scrape.ts:58（`text(about.description) ?? meta.description`） | 不同 | — | 不再挑最长的，也不用 header 描述。通常差异很小 |
| C-15 | aboutCurrent.js:82-83 | description 状态：有内容为 exact；About 已观察到但为空为 empty；否则 unresolved。About 明确为空时，不回退到旧的 header 文本 | N web-scrape.ts:58（About 描述为 '' 时 text() 返回 null，于是回退到 meta.description；没有状态字段） | 不同 | channelPublicationCurrent.test.js「an explicitly empty About description never falls back to stale Header text」 | 低 |
| C-16 | pipelineV2.js:1357-1375, 466-474 | YouTube.js 元数据不完整（缺 title、handle、订阅数或 description，或 description 以 `...` / `…` 结尾，即被截断）时，回退到旧 HTML header 和 yt-dlp 并合并结果；合并时保留更长的 description | N 无 | 不适用 | pipelineAboutOnlyRouting.test.js「exhausted scrape layers keep their own errors and do not force Channel Data API」、「channel crawl does not fall back to legacy metadata after YouTube.js cancellation」 | 旧 HTML 和 yt-dlp 采集器不迁移（采集以 Innertube 为主）。描述截断检测这条规则可以考虑保留 |
| C-17 | youtubeJs.js:226-248, 814；aboutCurrent.js:63 | avatar 依次看 metadata.avatar、header.author.thumbnails、about.avatar、header.content.image，最多递归 4 层，按面积取最大，补全为绝对 URL，再经 normalizePublicationImageUrl 规范化 | N web-scrape.ts:14, 58（只看 `meta.avatar ?? meta.thumbnail`，按宽度取最大，不补全也不规范化） | 不同 | — | 若出现 `//yt3…` 这类协议相对地址，ChannelFactsSchema 的 Url 校验会让整个 About 失败 |
| C-18 | youtubeJs.js:195-204 | renderedText 会去掉首尾空白，`[object Object]` 视为 null | N web-scrape.ts:12（不去空白；另把 'N/A' 也当成 null） | 不同 | — | 低 |
| C-19 | youtubeJs.js:831；aboutCurrent.js:20-44 | keywords：数组时直接用；字符串时先尝试解析 JSON 数组，否则按 "…" / '…' 引号和 `, ; 空白` 分词并处理转义；最后去重并排序 | N youtube/map.ts:41-44；web-scrape.ts:62（只认双引号和空白分词，不去重、不排序；另有 meta.tags 回退，并截到 100 个、每个 200 字） | 不同 | aboutCurrent.test.js「About Current identity splits YouTube's quoted keyword string」、「About Current identity normalization is stable across list order and duplicates」 | 关键词顺序或重复变化会让哈希抖动 |
| C-20 | aboutCurrent.js:97-98 | keywords 状态和 available_tabs 状态：observed / unresolved | N 无 | 缺失 | — | 低 |
| C-21 | youtubeJs.js:832-836；aboutCurrent.js:52 | available_tabs 是规范名 `videos` / `shorts` / `live`，由 root.has_videos、has_shorts、has_live_streams 推出，然后排序去重 | N web-scrape.ts:62（`channel.tabs`）；publication-map.ts:12（has_videos 用 `/video/i`、has_live_streams 用 `/live\|stream/i` 判断） | 不同 | fullCrawlYoutubeJsFactory.test.js「pending About video count still requests uploads when all content tabs are hidden」 | **高，且受语言影响**：youtubei.js 18 的 `TabbedFeed.tabs` 返回的是本地化标签页标题（pt-BR 下是 "Início"、"Vídeos"、"Shorts"、"Ao vivo"…）。`/video/i` 匹配不到 "Vídeos"（带重音），`/live\|stream/` 匹配不到 "Ao vivo"，所以发布出去的 has_videos / has_live_streams 会被错误地置为 false。应改为直接用 has_videos、has_shorts、has_live_streams |
| C-22 | youtubeJs.js:1347-1351, 1357-1358, 1373-1376；fullCrawlYoutubeJsFactory.js:139-144 | 三个内容标签页都没有、About 视频数也不大于 0 时，跳过上传列表请求，直接给出空列表结论；只要 About 视频数大于 0，即使标签页被隐藏也照常请求 | N web-collector.ts:132-148（一律扫描上传列表） | 不同 | youtubeJs.test.js「Uploads with a normal empty playlist and no country returns a dormant decision」；fullCrawlYoutubeJsFactory.test.js「pending About video count still requests uploads when all content tabs are hidden」 | 只多一次请求，结论等价。与上传列表组有交叉 |
| C-23 | youtubeJs.js:837；aboutCurrent.js:92 | is_family_safe 取 metadata.is_family_safe，只接受布尔值，否则为 null | N web-scrape.ts:65 | 一致 | — | — |
| C-24 | youtubeJs.js:830；aboutCurrent.js:90 | rss_url 取 metadata.rss_url，补全并规范化 | N publication-map.ts:11（固定拼成 `feeds/videos.xml?channel_id=`） | 一致 | — | 值相同 |
| C-25 | youtubeJs.js:840 | 来源标签 `youtubejs_channel_about` | N web-scrape.ts:66（`youtubei:channel_about`） | 不适用 | — | 只是来源标签命名不同 |
| C-26 | aboutCurrent.js:46-55；fullCrawlYoutubeJsFactory.js:113-125 | About Current 的身份字段：title、handle、avatar、keywords、tabs，summary 等于 description | N contracts index.ts:44-56（summary 固定为 null）；publication-map.ts:12（description 取 about_description，没有时取 summary） | 一致 | aboutCurrent.test.js「About observation normalization produces persistable Channel fields」 | — |

## C. 订阅数

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| C-27 | youtubeJs.js:654-659 | header 片段来源仅限 `header.content.metadata.metadata_rows[].metadata_parts[].text` | N web-scrape.ts:15-22, 48（递归收集 header 下的所有字符串，最多 9 层、每层 60 个值） | 不同 | — | 新系统范围更宽，更容易误匹配 |
| C-28 | youtubeJs.js:661, 769-771 | 用多语言视频数标签（videos、vídeos、影片、视频、동영상、видео…）识别 header 里的视频数，并把它排除在订阅数候选之外 | N web-scrape.ts:49（header 只认带 `/inscrit\|subscri/` 标签的文本，间接排除了视频数） | 一致 | youtubeJs.test.js「Video count text cannot become a Channel subscriber count」；localizedCount.test.js「a channel video count is never stored as its subscriber count」 | pt-BR 下等价 |
| C-29 | localizedCount.js:47-54, 270-285 | findSubscriberCountText：排除像 handle 的文本（以 @ 开头或含 youtube.com/@）→ 先找带订阅标签的（36 种语言）→ 否则只有恰好一个紧凑数字（倍数大于 1）时才采用 | N web-scrape.ts:49（只有 `/inscrit\|subscri/i`，不排除 handle，也没有“唯一紧凑数字”规则） | 不同 | localizedCount.test.js「a Handle containing subscriber-label text cannot mask the real subscriber count」；youtubeJs.test.js「Channel metadata ignores a Handle-shaped subscriber field and uses the labelled count」 | 像 `@inscritosbr` 这样的 handle 会被当成订阅数文本 |
| C-30 | youtubeJs.js:664-704 | 订阅数候选的优先级：about.subscriber_count → header 中带标签的 part → root.subscribe_button.subscribers → 含糊的 header.subscribers（不含字母、可以解析、不是视频数或播放量标签、不是 handle）；取第一个非 handle 的候选 | N web-scrape.ts:49（只有 about.subscriber_count → header 带标签文本两步） | 不同 | youtubeJs.test.js「Video-only Channel metadata treats a lone Handle as no subscriber observation」 | 缺少订阅按钮和含糊 header 两条回退 |
| C-31 | youtubeJs.js:815-817 | 记录 subscriber_count_source（youtube_about / youtube_channel_header / youtube_subscribe_button） | N web-scrape.ts:52（不管值从哪来，source 都是 `youtubei:channel_about`） | 不同 | — | header 回退来的值会被误标为 About 来源 |
| C-32 | aboutMetrics.js:51-53 | About 指标只有在来源是 youtube_about 时才算解析成功；来自 header 回退的订阅数在 About 观察中状态为 unavailable、值为 null | N web-scrape.ts:49-53（header 回退的值也记为 exact / estimated） | 不同 | aboutMetrics.test.js「a failed getAbout ignores header fallback and does not qualify for a snapshot」 | 中 |
| C-33 | youtubeJs.js:794-804；localizedCount.js:252-268 | 严格解析：请求了 About、订阅数文本存在却无法解析时，抛 ParserContractError（`unsupported_localized_count`），明确报错 | N web-scrape.ts:50-53（无法解析时值为 null、状态 unresolved，不报错） | 不同 | youtubeJs.test.js「About subscriber values remain strict when the About domain is requested」；localizedCount.test.js「a present but unsupported subscriber value fails loudly」、「a structured About subscriber value cannot silently become zero」 | **高**：后续订阅门槛会把这种情况当成 hidden_subscribers 直接拒绝（见 C-46）。pt-BR 下新增的写法或单位同样会悄悄变成 null |
| C-34 | youtubeJs.js:805 | 非严格模式（includeAbout=false，只抓视频的增量）：宽松解析，无法解析的观察结果直接丢弃 | N 无（ABOUT 步骤总是请求 About） | 不适用 | — | 新系统没有“不带 About 的频道请求” |
| C-35 | fullCrawlYoutubeJsFactory.js:85-95；pipelineV2.js:1507-1547；youtube.js:1497-1524 | About 已加载但没有订阅数行：全量准入抛 `required_subscriber_count_not_observed`；pipelineV2 遇到网络或 IP 封锁时重抛（重试），否则抛契约错误；旧 HTML 解析规定 About 已加载且没有订阅数行时记为 0（文本 "0 subscribers"，来源 `youtube_about_missing_subscriber_row`）；About 没加载则保持未知 | N web-scrape.ts:49-53（记为 null / unresolved） | 不同 | youtubeHeader.test.js「a loaded About surface without a subscriber row means zero subscribers」、「a channel header without a subscriber row remains unknown until About loads」、「an unavailable channel header does not turn a network failure into zero」；localizedCount.test.js「only a genuinely absent subscriber row becomes zero after About loads」 | **高**：订阅数行缺失时旧系统记为 0 并说明来源，新系统记为 null；不受门槛约束的频道会把 null 发布出去 |
| C-36 | localizedCount.js:21-45, 223-246；aboutMetrics.js:55-64 | 多语言计数解析：用 ICU 紧凑单位加内置单位表（k/m/b、mil、mi/bi、milhão、lakh、crore、万/億…），支持本地数字（NFKC），自动判断小数点；倍数大于 1 为 estimated，否则 exact | N map.ts:10-25（pt 分支只支持 mil、mi、bi、milhão、bilhão、K/M/B，并给出 exact 标志） | 不同 | localizedCount.test.js「localized count parsing follows ICU compact notation across scripts」、「…round-trips YouTube market locales」、「…distinguishes locale-specific compact symbols」、「unabbreviated localized counts treat separators as grouping」、「a localized subscriber row is parsed instead of being mistaken for absence」；youtubeJs.test.js「parseYoutubeJsCount handles exact and localized abbreviated counts」 | 只要会话固定为 pt-BR，两者基本等价；多语言能力没有迁移。en 分支里“文本含 'no' 记为 0”的逻辑新系统网页路径不使用 |
| C-37 | youtubeJs.js:816；aboutMetrics.js:114 | 保留 subscriber_count_text 原文 | N contracts index.ts:39-43（MetricSchema 没有原文字段） | 缺失 | — | 低：原文仍在 raw 归档里，解析器可以重新得到 |
| C-38 | aboutMetrics.js:66-69 | 没有文本只有数值时，用数值并记为 exact | N web-scrape.ts:13（count() 支持数值，但 About 用 observed(text)） | 不适用 | — | youtubei.js 返回的是文本 |

## D. 播放量与视频数

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| C-39 | youtubeJs.js:822-823 | 总播放量只取 about.view_count，来源 youtube_about | N web-scrape.ts:64 | 一致 | — | — |
| C-40 | aboutMetrics.js:43-50 | 产品规则：About 已观察到、但没有播放量文本也没有数值时，记为 0、exact、来源 `youtube_about_missing_view_count`；请求失败或值异常的情况仍保持 unresolved | N web-scrape.ts:64（记为 null / unresolved） | 缺失 | aboutMetrics.test.js「successful About without a view count defaults only that metric to zero with explicit provenance」、「a successful partial About defaults missing views without defaulting subscribers」 | **中高**：没有播放量的频道在新系统里 About 永远是 partial（feature-clocks.ts:39-40），发布的 total_view_count 也是 null |
| C-41 | youtubeJs.js:818-821 | 视频数取值顺序：about.video_count → header.videos_count → header 中带视频标签的 part，并记录来源 | N web-scrape.ts:64（只取 about.video_count） | 不同 | — | 低：旧 About 指标本来也把 header 来源记为 unavailable；这个值主要用于判断有没有内容（C-22） |
| C-42 | aboutMetrics.js:55-64 | 指标状态：紧凑写法为 estimated；能解析为 exact；文本无法解析时为 unresolved 并保留原文；真实的 0 与缺失要区分 | N web-scrape.ts:50-53 | 一致 | aboutMetrics.test.js「compact About values remain explicitly estimated」、「an observed but unparseable About value stays unresolved」、「a genuine About zero is distinct from a missing value」 | 原文不保留（C-37） |
| C-43 | aboutMetrics.js:85-98, 111 | About 结论：三个指标都解析成功为 complete，否则 partial，About 失败为 failed；只要有一个解析成功就可以出快照 | N packages/store/src/feature-clocks.ts:33-44 | 一致 | aboutMetrics.test.js「About normalization produces an exact complete three-metric fact」 | 新系统没有 failed（C-4） |
| C-44 | aboutMetrics.js:72-74, 125；aboutObservation.js:5-31 | facts_hash、幂等键、extractorVersions、errorClass / errorMessage | N（raw 归档和 ingest 账本） | 不适用 | aboutMetrics.test.js「About idempotency is stable within an execution attempt and distinct across retries」 | 属于存储机制 |

## E. 订阅门槛（准入）

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| C-45 | channelQualification.js:1-36；fullCrawlYoutubeJsFactory.js:106-110 | 只有 enforce_min_subscribers 时才执行门槛；门槛取 job.min_subscriber_count，否则取 settings.minSubscriberCount；数量低于门槛为 rejected（`subscriber_count_below_minimum`），等于门槛即通过；数量规范化为四舍五入后的非负数 | N packages/store/src/index.ts:840-866（qualifyAbout：只在 frozen.discovery_qualification 存在时执行；小于门槛为 below_threshold，大于等于通过；支持人工 override） | 一致 | channelQualification.test.js「channel qualification passes crawls that do not enforce a subscriber threshold」、「…accepts a count at the configured threshold」 | 拒绝理由的命名不同 |
| C-46 | channelQualification.js:17-25；pipelineV2.js:1498-1547；channelApiFallback.js:78-92 | 订阅数未知时不直接拒绝：网络或 IP 封锁 → 重试；否则 → ParserContractError。只有 Data API 确认 hiddenSubscriberCount 时，才给出业务结论 `subscriber_count_hidden` | N index.ts:845-846（值为 null 就直接 REJECTED，理由 `hidden_subscribers`，计划 CANCELLED） | 不同 | channelQualification.test.js「channel qualification rejects unknown and below-threshold counts」；channelApiFallback.test.js「an API-confirmed hidden subscriber count is a business outcome」 | **高**：解析失败（C-33）、订阅数行缺失（C-35）、header 改版都会被当成“隐藏订阅数”永久拒绝，原本应该重试或报错 |
| C-47 | pipelineV2.js:1498-1503 | 执行门槛时，只有带来源的订阅数才算观察到 | N index.ts:844 | 不同 | — | 新系统不看来源；与 C-31 有关 |
| C-48 | channelQualification.js:38-62；worker.js:568-583 | 搜索发现阶段的门槛：候选的订阅数已知且低于门槛，当场拒绝；未知则标为 needs_snapshot，留到快照时判断 | N packages/store/src/query-runs.ts:171-173（只有冻结的旧 Data API 搜索：隐藏或 null 记为 UNQUALIFIED hidden_subscribers；R4 网页搜索没有订阅数，统一在首次 About 判断，见 contracts 中的 discovery_qualification r4.about.v1） | 不同 | channelQualification.test.js「discovery sends a missing subscriber row to snapshot validation」 | 旧 Data API 搜索里订阅数为 null 被直接判为不合格，而旧系统是“等快照” |
| C-49 | fullCrawlYoutubeJsFactory.js:311-318, 126-136 | 门槛未通过：候选记为拒绝（带理由和 sourceJson），不建 run，记录 qualification 和 checked_at | N index.ts:847-865（写 plan_qualifications，候选改为 UNQUALIFIED，导入改为 rejected，计划 CANCELLED，并写事件） | 一致 | — | 具体机制不同（不适用部分），规则一致 |

## F. Data API 频道回退

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| C-50 | channelApiFallback.js:1-17 | 触发条件：缺 title，或执行门槛时订阅数没有带来源的观察 | N web-collector.ts:111-127（只有在 channelUnavailablePage 时才查 Data API） | 不同 | channelApiFallback.test.js「missing required subscriber count invokes the channel data API」、「complete channel metadata skips the channel data API」 | 新系统缺订阅数时不调用 API；这与 C-46 一起造成拒绝 |
| C-51 | channelApiFallback.js:36-38 | 只有 fallbackMode 为 'emergency' 时才调用 API，否则记为 disabled | N 无开关（配置了 key 就会调用，受每日配额许可约束，见 activities.ts:140-156） | 不同 | — | 与“Data API 只作少用的回退”这一原则一致，但缺少总开关 |
| C-52 | channelApiFallback.js:39-74 | 多个 key 去重后轮换；每个请求先预留每日配额，配额用尽就报错；传输错误换下一个 key，全部失败后抛最后一个错误（可重试） | N data-api.ts:20-55（单个 key；quota → BUDGET_EXHAUSTED 不重试；5xx 或网络错误可重试） | 不同 | channelApiFallback.test.js「channel data API transport failures remain retryable」 | 低：没有多 key 轮换 |
| C-53 | youtube.js:2319-2381 | channels.list 请求 part=statistics,snippet，每次最多 50 个 ID 并去重，12 秒超时，非 2xx 时抛错并带上 API message | N data-api.ts:52-55（part=snippet,statistics,contentDetails,brandingSettings，单个 ID，15 秒，错误按 reason 分类，不暴露 URL 和 key） | 一致 | — | — |
| C-54 | youtube.js:2324-2340 | API 详情映射：customUrl 缺 @ 时补上作为 handle；subscriberCount 按观察到的精确值记录，来源 youtube_data_api_channels_list；记录 hidden 标志；取最佳缩略图 | N map.ts:55-84（toChannelFacts / apiChannelFacts：handle 直接用 customUrl，不补 @；订阅数记为 estimated（三位有效数字）；hidden 时为 null / unavailable；播放量和视频数为 exact；country_code 取 snippet.country；joined_at 取 publishedAt；keywords 取 brandingSettings；links 为 []；business email 为 null） | 不同 | youtubeHeader.test.js「channel data API statistics carry an observed subscriber source」、「channel data API preserves an explicit hidden subscriber state」 | 新系统字段更多；handle 没有补 @ |
| C-55 | channelApiFallback.js:78-92 | API 结果对准入的影响：API 未找到频道 → failed `channel_unavailable`；隐藏 → `subscriber_count_hidden`；其他 → `subscriber_count_unavailable` | N web-collector.ts:117-126（API 未找到且页面明确不可用 → CHANNEL_REMOVED，否则重抛原错误；隐藏订阅数在门槛处记为 hidden_subscribers） | 不同 | channelApiFallback.test.js「an empty channels.list response is a terminal unavailable outcome」、「an API-confirmed hidden subscriber count is a business outcome」 | — |
| C-56 | pipelineV2.js:1459-1491, 466-474 | API 详情按字段覆盖合并到网页结果上（mergeDefined），网页结果保留；保存原始 JSON（带 missing_fields 和 key_index） | N web-collector.ts:117-126, 72-74；region.ts:32-35（网页可用就不用 API；网页不可用就整份改用 apiChannelFacts；区域重查的结果只从 API 补 country_code） | 不同 | — | 原始响应都会归档（一致） |
| C-57 | aboutCurrent.js:71-74, 88-89 | About 没观察到时，外链状态是 unresolved，不能当成空列表 | N map.ts:80-84（API 回退时 external_links 是 []，被当成已观察到的空列表发布） | 不同 | aboutCurrent.test.js「a failed About request cannot turn an unobserved Link surface into empty」 | 中：业务库会把已有外链清空 |

## G. About 外链

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| C-58 | youtubeJs.js:706-719；publicationLinks.js:61-87 | 外链取 about.links，没有时取 primary_links；对每条记录 title、display_url（链接文字）、target_url（依次从 command_runs、endpoint、navigation_endpoint 的 payload / metadata 中取 url，再取 target_url / url，补全为绝对地址）、favicon_url、position | N web-scrape.ts:63（url = 链接显示文字加 `https://` 前缀；没有 endpoint 目标、favicon、display_url 和 position） | 不同 | youtubeJs.test.js「About links retain the parsed Text endpoint as the real target」 | **高**：YouTube 的显示文字会缩短长 URL（只有域名，或截断加省略号），新系统会丢掉真实路径或得到无效地址。语言无关 |
| C-59 | publicationUrl.js:55-128 | URL 规范化：最多解开 3 层 youtube.com/redirect?q=；处理 mailto、tel 和裸邮箱；拒绝带用户名密码的地址；去掉 utm_ 和跟踪参数；host 转小写；去掉默认端口和 hash | N 无 | 缺失 | channelPublicationCurrent.test.js「Channel Current repairs a legacy mailto-wrapped URL and its stale email metadata」 | 与 C-58 一起处理 |
| C-60 | publicationLinks.js:89-181 | 按 target 去重；link_type 分类（instagram、facebook、x_twitter、tiktok、spotify、youtube、whatsapp、telegram、email、phone、website）；purpose 按启发式分为 contact 或 public_reference（如 pix、paypal、loja、contato、business…）；记录无效 issue；按 position 排序 | N publication-map.ts:15（link_type 固定为 'external'，没有 purpose，不去重） | 缺失 | channelPublicationCurrent.test.js「a complete normalized Channel Current has the full V2 contract and stable hash」 | 也可能由发布组统计 |
| C-61 | youtubeJs.js:721-727；aboutCurrent.js:71-74 | 外链观察状态：About 成功就是 observed（包括空列表）；失败就是 unresolved | N web-scrape.ts:63（只要成功总有数组）；map.ts:80-84（API 回退时也是 []） | 不同 | youtubeJs.test.js「a successful About surface distinguishes an empty Link collection from a failed request」；aboutCurrent.test.js「a successful About response confirms an empty initial Link collection」 | 网页路径一致，API 回退路径不同（C-57） |

## H. 认证徽章

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| C-62 | youtubeJs.js:740-763, 838-839 | is_verified 的判断顺序：header.author.is_verified 是布尔值就直接用 → 否则看徽章（header.badges、author.badges、metadata_rows[].badges）→ 否则看标题 runs 是否带 attachment → 都没有时为 null / unknown | N web-scrape.ts:65（is_verified 固定为 null）；scrape.ts:60 | 缺失 | youtubeJs.test.js「Channel verification uses an observed PageHeader attachment without guessing」；youtubeHeader.test.js「Verified is false only when the PageHeader verification surface was observed」 | **高**：发布出去的 is_verified_status 永远是 unknown |
| C-63 | youtubeJs.js:729-738；youtube.js:1485-1493 | 徽章判定：style 为 BADGE_STYLE_TYPE_VERIFIED 或 VERIFIED_ARTIST，或 label、tooltip、无障碍标签匹配 `/verified/`（旧 HTML 解析另外认 `verificado`） | N 无 | 缺失 | 同上 | **语言有影响**：迁移时标签正则必须加上 pt-BR 的 "Verificado"，或只依赖 style 和 attachment 这类与语言无关的信号 |
| C-64 | verifiedCurrent.js:1-19 | value 和 status 必须成对一致（verified=true / not_verified=false / unknown=null），否则记为 unknown | N publication-map.ts:11（status 由 value 推出） | 一致 | channelPublicationCurrent.test.js「Header fallback keeps the observed Verified value and status as one pair」 | — |

## I. 商务邮箱

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| C-65 | youtubeBusinessEmailAvailability.js:24-40；youtubeJs.js:788-790, 828-829 | About 没观察到或无法识别时为 null / unknown；能识别时，sign_in_for_business_email（或 signInForBusinessEmail）渲染出非空文本为 true / available，没有这个字段为 false / not_available | N web-scrape.ts:65（`about.sign_in_for_business_email != null`）；map.ts:83（API 回退时为 null） | 一致 | youtubeBusinessEmailAvailability.test.js「a non-empty YouTube business email marker is available」、「a recognized About response without the marker is not available」、「failed or unrecognized About responses remain unknown」 | 只看字段是否存在，语言无关。微小差别：字段为空字符串时新系统算 true |
| C-66 | youtubeBusinessEmailAvailability.js:42-51 | 存储的 (available, status) 必须成对合法，否则记为 unknown；About 没观察到时一律 unknown | N contracts index.ts:54（只有 boolean 或 null） | 一致 | youtubeBusinessEmailAvailability.test.js「stored availability pairs cannot turn malformed or failed evidence into false」 | — |
| C-67 | aboutCurrent.js:76-80 | 一次成功的 About 可以把之前的 true 改成 false（邮箱被移除） | N publication-map.ts:15, 46-47（值不变时沿用原来的 observed_at） | 一致 | aboutCurrent.test.js「a successful About observation can explicitly remove a previous business email entry」；channelPublicationCurrent.test.js「a confirmed removed business email entry is published as false」 | — |

## J. 加入日期

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| C-68 | youtubeJs.js:824 | joined_date_text = renderedText(about.joined_date) | N web-scrape.ts:60 | 一致 | — | pt-BR 下文本形如 "Inscreveu-se em 12 de jan. de 2015" |
| C-69 | youtubeJoinedDate.js:16-76 | 日期解析：先认 ISO 前缀；再认中日韩的数字年-月-日；再用 Intl 生成当前语言加 en 的长短月份名（去重音、去点号）匹配，年份取最后一个四位数，日取 1–31，并校验日期合法 | N web-scrape.ts:23-34（absoluteDate：ISO，或 pt-BR 正则 `d de mmm[.] de yyyy`） | 不同 | channelPublicationCurrent.test.js「Joined Date normalization parses the observed YouTube format deterministically」 | **语言有影响**：旧系统 en 下解析 "Joined Jan 12, 2015"；新系统只认 pt-BR 格式。在当前固定 pt-BR 下能用，但换语言或回放 en 证据就会失败 |
| C-70 | youtubeJoinedDate.js:78-95 | 已存的 joined_at 精度为 date_only / second / exact 时直接复用；状态：解析成功为 exact，有原文但解析不了为 unavailable，没有原文为 unresolved；精度为 date_only 或 unknown | N web-scrape.ts:60；publication-map.ts:14（joined_date_status 只有 exact / unavailable） | 不同 | channelPublicationCurrent.test.js「Header fallback fills old operational rows while optional unknown fields remain publishable」 | 低：缺少 unresolved 状态 |

## K. 国家

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| C-71 | youtubeJs.js:825；aboutCurrent.js:84 | country 原文取 about.country，只有 About 已观察到时才保存 | N web-scrape.ts:59（country_source 为 `youtubei:about`） | 一致 | — | 来源标签不同（旧为 youtube_about） |
| C-72 | agentCountryPolicy.js:4-140 | canonicalizeCrawlerCountry 把国家原文转成 ISO 代码：先认二字母代码，再认已废弃代码的别名，再按英文 Intl 名称和别名表匹配（含 Türkiye、Viet Nam、Republic of Korea…，去重音后也匹配），最后补充所有 YouTube 界面语言的本地化名称；只有唯一匹配才采用；同时记录英文规范名 | N web-scrape.ts:59（网页路径 country_code 固定为 null）；只有 Data API 的 snippet.country 会填代码（region.ts:32-35；map.ts:67-68） | 缺失 | agentCountryPolicy.test.js「YouTube locale country labels round-trip to one canonical country」、「deprecated region aliases do not make canonical country names ambiguous」 | **高，且受语言影响**：pt-BR 下 About 给出 "Brasil"、"Estados Unidos"，新系统不转代码，发布的 country_code 是 null，country_name 是葡语 |
| C-73 | agentCountryPolicy.js:147-157；fullCrawlYoutubeJsFactory.js:102-105 | 观察到但认不出的国家：抛 ParserContractError（`unsupported_localized_country`），不能悄悄跳过 Agent 的国家推断 | N 无（接受任何文本） | 缺失 | agentCountryPolicy.test.js「an observed but unknown About country fails instead of bypassing Agent」 | — |
| C-74 | fullCrawlYoutubeJsFactory.js:103-105；pipelineV2.js:1494-1497 | 保存 country（原文）、country_code、country_canonical_name（英文名） | N contracts index.ts:47（没有 canonical_name）；apps/profile-agent/profile_agent/adapter.py:52（固定为 None） | 缺失 | — | 与 C-72 一起处理 |
| C-75 | agentCountryPolicy.js:142-145 | 国家为空白时视为缺失（null） | N web-scrape.ts:12, 59 | 一致 | agentCountryPolicy.test.js「crawler country normalization treats blank text as missing」 | — |
| C-76 | agentCountryPolicy.js:159-170；pipelineV2.js:4400, 4513, 4792 | 只有 country_code 合法且 country_source 为 youtube_about 时，Agent 才跳过国家推断；否则 Agent 必须推断国家（提示词变体为 country_required，必填字段里加上 country） | N apps/profile-agent/qy_channel_profile/analyzers.py:137-146, 265-330（只要有国家原文或代码就当作观察值；别名表 114-120 只有少量葡语和西语名，"Alemanha" 之类会原样输出） | 不同 | agentCountryPolicy.test.js「only a nonblank YouTube About country bypasses Agent country lookup」 | 中，且受语言影响：Agent 输出的国家名可能是葡语原文 |
| C-77 | youtubeJs.js:1332-1333；fullCrawlYoutubeJsFactory.js:350-352 | 上传列表空结论和国家重查使用的国家：About 成功时取 About 国家的规范代码，否则取已存的 country_code（来源须为 youtube_about） | N web-collector.ts:76-87（channelRegion：先看本计划已归档 ABOUT 的 country_code，网页路径下它总是 null；否则额外调用一次 Data API 取 snippet.country） | 不同 | youtubeUploadsCountry.test.js「explicit unavailable uploads enter Full Crawl country recheck and incremental empty scan」、「empty Full Crawl uploads request a country handoff, not a network retry」 | 来源从 About 的国家变成频道自报国家，而且每次重查多消耗 1 个配额。与上传列表组有交叉 |
| C-78 | （语言规则）youtubeJs.js:47 + 825 | en 会话下 About 国家是英文名，业务库收到的 country_name 是英文 | N publication-map.ts:14（country_name 取 a.country，为葡语） | 不同 | — | **受语言影响**：下游按英文国家名做的匹配会失效 |

## L. 频道生命周期：删除与终止

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| C-79 | channelLifecycle.js:8-46 | 终止判定：证据为 error.message 加 cause.message（去重，最多 2000 字）。“community guidelines” 对应 community_guidelines；“copyright infringement” 对应 copyright_termination；"this channel does not exist" 对应 channel_not_found；"this account has been closed" 对应 owner_closed；"this account has been terminated" 对应 account_terminated。结果 failure_kind=channel_removed，source=youtube_alert | N youtube/channel-removal.ts:3-16（en、pt、zh 文本匹配 not available / does not exist / removed / deleted / terminated / conta encerrada\|suspensa，结论只有一种：`source_removed`） | 不同 | channelLifecycle.test.js「classifies explicit YouTube Community Guidelines removal」、「classifies an explicit nonexistent Channel separately from a ban」 | 删除原因的细分丢失；"this account has been closed" 及其葡语说法可能匹配不到；"this channel is not available" 新系统也算删除，旧系统不算。**受语言影响**：新系统已加入葡语文本，但覆盖面需要核对 |
| C-80 | channelLifecycle.js:48-68 | 只看 `alerts[].alertRenderer` 中 type 为 ERROR 的提示（支持 simpleText 和 runs） | N channel-removal.ts:5-14（看所有 alert，不检查 type；前提是页面没有 channelMetadataRenderer 和 title） | 不同 | channelLifecycle.test.js「reads terminal evidence from the structured YouTube ERROR alert」 | 低 |
| C-81 | channelLifecycle.js:16-46 | 临时或含糊的失败（网络、超时、一般 HTTP 错误）绝不判为删除 | N channel-removal.ts:1-22（只有明确的不可用页面才算） | 一致 | channelLifecycle.test.js「does not permanently remove a Channel for transient or ambiguous failures」 | — |
| C-82 | fullCrawlYoutubeJsFactory.js:298-304；pipelineV2.js:1387-1411 | 单一来源即可判定：YouTube 明确的提示就足以判定删除 | N channel-removal.ts:17-22；web-collector.ts:116-120（页面不可用，且 Data API channels 返回 items=[]，两个来源都成立才判定） | 不同 | — | 新系统更严格：页面不可用但 API 还有记录时，会先在频道所在国家重查，再用 API 资料 |
| C-83 | fullCrawlYoutubeJsFactory.js:298-304；pipelineV2.js:1387-1411；incrementalTerminalFailure.js:17-31, 72-75 | 在哪些环节判定：全量准入、快照（youtubejs、旧 HTML、主错误任意一个）、增量任意域（about、video 失败都会判定；另有正则 "removed\|terminated…community guidelines" 和 "channel unavailable / not found" 对应 channel_unavailable），终止错误不等重试次数用完 | N web-collector.ts:111-127（只在 ABOUT 步骤）；activities.ts:180-189 | 不同 | channelLifecycle.test.js「persists the terminal Channel lifecycle and cancels later work」 | 中：不含 ABOUT 的 UPDATE 计划（只有 VIDEO 或 AGENT）发现不了频道已被删除，只会重试直到失败 |
| C-84 | channelLifecycle.js:82-317 | markChannelRemoved：频道状态改为 removed，removed_reason、at、source、evidence 以第一次为准（COALESCE）；清除休眠状态；Agent 记为 skipped；候选记为 rejected（注册表晋升的候选除外）；取消排队中的 Agent 刷新；跳过其他进行中的 run；当前 run 记为 failed 或 skipped；以 reasonCode=removed_reason 撤回发布 | N packages/store/src/index.ts:789-805（已纳管的频道改为 management_state='removed'，计划 CANCELLED，排队撤回发布；未纳管的计划 FAILED NOT_FOUND）；publication-map.ts:44（撤回理由固定为 'policy_removed'） | 不同 | channelLifecycle.test.js「persists the terminal Channel lifecycle and cancels later work」 | 数据库加锁和防护机制属于不适用部分。**撤回理由不同**：旧系统是 community_guidelines 等具体原因，新系统固定为 policy_removed |
| C-85 | pipelineV2.js:1395-1410；fullCrawlYoutubeJsFactory.js:301-303 | 频道已删除时直接返回 skipped（skip_reason=removed_reason），不重试 | N activities.ts:180-189（r3 先确认再等待计划终态；r2 返回 NOT_FOUND，不重试） | 一致 | — | — |
| C-86 | channelLifecycle.js:166-180（COALESCE） | 删除事实以最早的观察为准 | N index.ts:791（如果删除观察早于当前 About，判为 STALE_EXECUTION） | 不适用 | — | 新系统的顺序防护机制不同 |

## M. 频道休眠（dormancy）

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| C-87 | channelDormancy.js:1-6 | 休眠理由 `no_published_content_within_90_days`；观察窗口 90 天；重查间隔 30–90 天 | N 无（feature-clock 的 about_priority_dormant 只是更新频率档位，不是生命周期） | 缺失 | channelDormancy.test.js 全部 | — |
| C-88 | channelDormancy.js:31-41 | 重查延迟 = 30 + sha256("dormant-video-probe-v1\0{id}\0{cycle}") 前 4 字节（uint32BE）对 61 取余，结果是确定的；cycle 必须为正 | N 无 | 缺失 | channelDormancy.test.js「dormant recheck delay is deterministic and remains inside 30-90 days」 | — |
| C-89 | channelDormancy.js:43-65 | buildDormantLifecycle：cycle 加 1；dormant_since 保留最早值；重查日 = 观察日（UTC）加延迟；记录 last_probe_at | N 无 | 缺失 | channelDormancy.test.js「a later dormant cycle preserves dormant_since and derives a new UTC recheck」 | — |
| C-90 | channelDormancy.js:95-109 | evaluateVideoActivity：近期发布数大于 0 → active；发现未完成或有不确定条目 → inconclusive；否则 → dormant | N 无 | 缺失 | channelDormancy.test.js「only a complete zero-content scan can enter dormancy」；videoActivityLifecycle.test.js「Incremental lifecycle marks complete exact old evidence dormant」、「…keeps relative publication evidence inconclusive」、「…keeps a truncated historical evidence scan inconclusive」 | — |
| C-91 | channelDormancy.js:67-93 | 活跃和休眠的发布字段：window_days、recent_published_content_count、lifecycle_status、dormant_*；发布时带 lifecycle_status | N publication-map.ts:15（lifecycle_status 固定为 'active'） | 缺失 | videoActivityLifecycle.test.js「Video activity evidence builder returns a detached frozen value」 | — |
| C-92 | fullCrawlYoutubeJsFactory.js:156-159, 359-367；youtubeJs.js:600-604, 1373-1376 | 迁移活跃度门槛：reject_if_no_recent_content，或上传列表正常为空时给出休眠结论 → 准入时直接判为休眠，不抓视频详情 | N 无 | 缺失 | youtubeUploadsCountry.test.js「normal empty uploads settle dormant: ${reason}」 | 与上传列表组有交叉 |
| C-93 | channelLifecycle.js:169-170；pipelineV2.js:1660-1662 | 删除或重新接受频道时清除休眠状态 | N 无 | 不适用 | — | 新系统没有休眠状态 |

## N. About 观察的记录与触发

| 编号 | 旧位置(file:line) | 规则 | 新系统位置 | 状态 | 旧测试 | 备注 |
|---|---|---|---|---|---|---|
| C-94 | incrementalAbout.js:16-18 | 增量 About 要求频道快照确实请求了 getAbout | N web-scrape.ts:45（总是请求 getAbout） | 一致 | incrementalAbout.test.js「About execution carries identity fields in the same Current command」 | — |
| C-95 | incrementalAbout.js:20-35；pipelineV2.js:1566-1572 | 触发原因 initial_full / clock_due / repair；记录计划 ID 与日期、执行尝试幂等键 | N（feature clocks 加计划事件） | 不适用 | aboutObservationStore.test.js | 属于存储机制 |
| C-96 | fullCrawlYoutubeJsFactory.js:253-285 | 只修 About 的发布缺口修复：必须重新抓 About，而且三项指标要 complete，否则报 `publication_gap_about_incomplete` | N 无 | 不适用 | fullCrawlYoutubeJsFactory.test.js「About-only repair fetches fresh About despite completed Full Crawl checkpoint (complete=${complete})」、「completed About-only publication repair is replayed without refetching or restaging」 | 新系统没有发布缺口修复流程。若以后补上，“三项指标齐全”这条规则需要保留 |
| C-97 | pipelineV2.js:1343-1352；youtubeJs.js:1338-1352 | 归档的是 youtubei.js 解析后的 JSON（引擎版本、请求次数、标签页布尔值、metadata），不是原始 HTTP 响应 | N web-collector.ts:98-110；raw-parser parser.ts:94-101（归档全部 HTTP 响应，由解析器回放） | 不适用 | — | 新架构的改进 |
| C-98 | youtubeJs.js:1340-1346 | 记录 get_channel 和 get_about 各自的请求次数 | N 无（可以从 raw 响应数出来） | 不适用 | — | — |
| C-99 | — | （新系统独有）About 区域重查：页面不可用但 API 有记录、且频道国家不是 BR 时，用该国代理和 location 再抓一次 About；解析时先用区域响应，失败再用默认响应，最后用 API 资料 | N web-collector.ts:122-126；parser.ts:96-100；region.ts | 不适用 | — | 旧系统 About 没有这条规则（区域重查只用于上传列表和视频） |

## 统计

- 一致：25
- 不同：45
- 缺失：17
- 不适用：12
- 合计：99

## 不同 / 缺失项按影响排序

1. **C-62 / C-63 认证徽章缺失**：is_verified 固定为 null，发布的 is_verified_status 永远是 unknown。迁移时要用与语言无关的 style 和 attachment 信号，标签正则加上 "Verificado"。
2. **C-72 / C-73 / C-74 / C-78 国家代码没有规范化**：pt-BR 下 About 国家是葡语名，新系统网页路径 country_code 恒为 null，country_name 是葡语，认不出的国家也不报错。下游国家筛选、Agent 国家判断（C-76）和上传列表区域重查（C-77）都受影响。
3. **C-21 available_tabs 用了本地化标题**：发布时 has_videos 和 has_live_streams 会被错误地置为 false（"Vídeos"、"Ao vivo" 匹配不到正则）。应改用 has_videos、has_shorts、has_live_streams。
4. **C-33 / C-35 / C-46 / C-50 订阅数未知被当成“隐藏”并永久拒绝**：解析失败、订阅数行缺失、header 改版都会悄悄变成 null，然后在门槛处被拒绝。旧系统的做法是：解析失败报契约错误，订阅数行缺失记为 0 并说明来源，网络问题重试，只有 API 确认 hidden 才给业务结论。
5. **C-58 / C-59 / C-60 / C-57 外链**：新系统用显示文字代替 endpoint 的真实地址，长 URL 会被截断；redirect 不解包、跟踪参数不清理、mailto 不规范化；link_type 固定为 external，没有 purpose；API 回退时还会把未观察到的外链当成空列表发布。
6. **C-6 / C-7 身份冲突校验缺失**：重定向或串号时，会把别的频道资料写到本频道下。
7. **C-40 缺失播放量的规则**：没有记为 0 并说明来源，About 永远 partial，发布 null。
8. **C-87 ~ C-92 休眠生命周期整体缺失**：没有 90 天无发布判为休眠、30–90 天确定性重查、cycle 和 dormant_since 的维护，发布的 lifecycle_status 固定为 active。
9. **C-79 / C-83 / C-84 删除判定**：删除原因不再细分；只在 ABOUT 步骤判定（只有 VIDEO 的 UPDATE 计划发现不了）；撤回理由固定为 policy_removed；"account closed" 及其葡语说法可能匹配不到。
10. **C-4 部分 About**：getAbout 失败时没有“只有身份、没有指标”的降级，整步重试或失败。
11. **C-29 / C-30 / C-31 / C-32 订阅数候选与来源**：没有排除 handle、没有订阅按钮和含糊 header 的回退、来源全部标为 About、header 回退值被当成 About 指标。
12. **C-76 Agent 国家判断**：葡语原文国家名被当作观察值，别名表很小，输出可能是葡语。
13. **C-11 / C-13 handle 与 vanity URL**：缺少 header.channel_handle 和 canonical 地址两个来源，非 ASCII handle 会丢；vanity URL 用 handle 拼出，没有 handle 的 /c/、/user/ 频道会发布 null。
14. **C-69 / C-70 加入日期**：只能解析 pt-BR 格式（受语言影响），缺少 unresolved 状态。
15. **C-55 / C-56 / C-54 / C-51 / C-52 Data API 回退**：触发条件、合并方式、handle 补 @、emergency 开关、多 key 轮换都不同。
16. **C-14 / C-15 / C-17 / C-19 / C-20 / C-37 / C-41 / C-47 / C-48 / C-8 / C-9 / C-18 / C-22 / C-27 / C-36 / C-61 / C-77 / C-80 / C-82 其余低影响项**：描述取最长与 empty 状态、头像来源与 URL 规范化、关键词去重排序与多分隔符、状态字段、订阅数原文、header 视频数回退、发现阶段门槛、title 回退与错误分类、去空白、空内容时跳过上传列表请求、header 文本范围、多语言计数、外链观察状态、上传列表区域重查的国家来源、ERROR 类型过滤、双来源删除确认等。
