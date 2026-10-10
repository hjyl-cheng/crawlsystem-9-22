# R2 采集与 UI 验收（2026-10-10）

确认规则见 [推进计划 §0.8](../推进计划_2026-10-08.md)。代码已部署到现有预览集群；公开入口仍为 https://controversy-roughly-kiss-genealogy.trycloudflare.com/ 。

Worker 通过 Chrome 136 指纹网关访问 YouTube，按代理保存固定 pt-BR / BR / America/Sao_Paulo 浏览器身份，加密 cookie 档案放持久卷。频道首页与 About、一次上传列表的全部分页、每个视频详情与首屏评论分别作为采集单元，原始响应先存 MinIO，再发布 Kafka 文件地址；步骤清单同样先存后发。R2 仍以兼容投影调用旧 Ingest，方便现有 UI 与 Agent 继续运行。

| 验收 | 结果 |
| --- | --- |
| 完整回归 | 149/149 通过；采集专项 11/11，网关 Python 3/3；类型检查与前端生产构建通过 |
| 浏览器身份 | Worker 替换前后 5 个 `.sealed` 文件的哈希一致；新 Worker 与网关均 ready |
| 真实全量 | Google Developers，计划 `74381dc1-efb1-4ba6-bc09-eb253c37bd7d`；ABOUT / VIDEO / AGENT 全部 APPLIED，4 笔持久回执 |
| 视频结果 | `IBVmenOroPs`、`fMgcm9aXZyY`，均识别为 Shorts，均为 YouTube.js 网页详情，发布时间精确到秒；未走 Data API 详情兜底 |
| 原始数据 | 4 个采集单元、3 份步骤清单实际存在，清单地址、字节数和 SHA-256 与文件一致；每个视频单元包含各次 WEB / IOS 尝试与评论响应 |
| Kafka 发布 | 真实计划完成意味着单元通知及步骤通知均被生产者确认（acks=-1），之后才有 Ingest 回执；本次没有部署消费者，独立消费与入库归 R3 |
| 存储重试 | 真实 MinIO 验证缺失对象、先存后发、通知失败后复用补发、条件写入拒绝覆盖、步骤清单；验收文件由既有生命周期过期，无清库 |
| 版本比较 | 将完全相同的保存响应分别交给 YouTube.js 17.2.0 / 18.1.0；频道标题 / handle / 数值 / 国家 / 加入日期、目标 ID、视频标题 / 发布时间及精度 / 播放量 / 类型 / 首屏条数一致 |
| 真实增量 | 手动 VIDEO 更新 `48760785-4910-4ba0-95a9-117702331c3b` 完成；扫描 1 页 / 1 条后命中 `IBVmenOroPs`，新增 0 个，视频实体未重复，清单哈希通过 |
| 页面 | Worker、代理、任务详情、创建计划均通过真实浏览器检查，运行错误 0；任务页显示身份与代理事件，创建页不再显示发布时间窗口 |

这次全量样本遇到一次人机拦截和一次代理传输失败，按规则换线后完成。两条 Shorts 的首屏返回 0 条正文，评论总数未观察到，保存为 `null / unresolved`，没有写成总数 0。增量样本本轮近期复采选择 0 个，因此真实验收覆盖锚点停止与空增量；非空追赶、轻量复采、API 兜底以及 TOP 空页改用 NEWEST 的分支由专项测试覆盖。本次是单频道验收，持续量产和代理稳定性仍需 R6 连续运行验证。

过程中保留了两个失败计划：`6f47c58e-d1a2-4951-83f2-a807de97f26f` 暴露频道关键词实际返回字符串，`2707d8af-53a0-4917-9442-58d31e797d62` 暴露上传节点已变为 `LockupView.content_id`。两处已修复并加回归。另修复 Store 拒绝无年龄限制网页清单的问题：仅 `youtubei:uploads` 使用 epoch 窗口起点，旧 Data API 清单仍校验冻结时间窗口。

部署版本：Control / Ingest / Dispatcher / Proxy Manager 为 `393530eeacfb`（含目标窗口校验修复），Worker 为 `6e27ed903c5f`（含当前上传节点兼容），网关镜像内容标识 `1ff2fbba98b3c83f`，Profile Agent 内容标识 `e22cc47314736e0c`。Worker 新镜像已导入全部 6 个节点，预览前端工作树已同步。验收资料见 [evidence.json](evidence.json)，不包含 cookie、visitor_data 或凭据。

复验命令（依次运行，不重置共享数据库）：

```bash
npm run check:safe -- collection-preview 74381dc1-efb1-4ba6-bc09-eb253c37bd7d
npm run check:safe -- collection-parity
npm run check:safe -- collection-update 48760785-4910-4ba0-95a9-117702331c3b
npm run check:safe -- collection-browser
```

版本比较需要 `.runtime/r2/youtube17/` 中的独立 17.2.0 包；原始数据遵循 14 天生命周期，过期后需重新生成样本。传计划 ID 的命令只复核既有计划；省略 ID 会创建新的有界真实计划。

自动搜索、自动准入、定时更新和 Worker Query Runner 继续关闭，强制巴西出口继续关闭。下一步 R3：独立解析程序、PG 入库程序与账本、步骤清单对账、评论从 PG 迁到 MinIO、Agent 改读 MinIO。R4 再处理网页搜索与搜索来源订阅门槛，R5 处理失败 / 统计 / 清理，R6 才恢复自动运行。
