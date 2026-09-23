# M1 数据登记与保留规则

范围：采集事实与共享登录预算位于独立 `crawlsystem_m1_*_test` 数据库（迁移 001、002）。控制台账号库另外使用 `database/console/001_console.sql`；现有预览的账号在 `crawler.console`，主线测试仅在隔离库建立同结构副本。以下记录实际限制；采集事实仍是 M1 测试数据。

## 数据集登记

| 数据集 | 用途和唯一身份 | 增长 / 大小边界 | 保留与删除资格 |
| --- | --- | --- | --- |
| migrations | 迁移版本与 SHA-256 校验 | 每个版本一行 | 与数据库同寿命；不得为了重跑迁移删除校验记录 |
| plans | 冻结 Plan/Run、创建幂等、执行代次 | 每个 `(workspace_id,request_id)` 一行；冻结 JSON ≤ 1 MiB | 保留活动计划及全部可重放证据；按下文整个测试 workspace 回收 |
| domains | 必需领域完成证明 | `(plan_id,domain)`；每 Plan 1～3 行 | 与所属 Plan 一起保留 |
| plan_items | 已覆盖的冻结目标/检查点 | `(plan_id,domain,item_id)`；当前样本 1 个频道、1 个视频，契约视频清单上限 100 | 与所属 Plan 一起保留；不能先于回执删除 |
| receipts | APPLIED 证明、同内容重放与冲突检测 | `(workspace_id,submission_id)`；另唯一 `(plan_id,domain,logical_batch_key)`；每 Plan 最多 300 行 | 最后一次允许重放前不删除；取消/失败仍保留原回执 |
| commands | 取消幂等及原返回结果 | `(workspace_id,command_id)`；当前每 Plan 最多一个成功取消命令 | 与原 Plan 的重放期限一致 |
| intents | START/CANCEL 恢复义务与租约 | `(plan_id,kind)`；最多 2 行/Plan；更新同一行，last_error ≤ 500 字符 | PENDING/LEASED 不可删除；DONE/SKIPPED 与 Plan 一起保留 |
| obligations | 样本收口证明，不是真实交付事件 | `(plan_id,FIXTURE_PLAN_SETTLED)`；最多 1 行/Plan | 与 Plan/回执一起保留，避免重新产生效果 |
| channels | 当前频道事实和最新计划指针 | `(workspace_id,channel_id)`；当前样本每 workspace 1 个频道 | 存在引用计划时不删除；测试 workspace 整体回收时删除 |
| videos | 当前视频及评论首屏 | `(workspace_id,channel_id,video_id)`；批次最多 100 个视频，每视频最多 100 条首屏评论；请求 ≤ 1 MiB | 新 source_revision 替换旧 Current；不保存无限 JSON 历史；整体回收时删除 |
| events | 有界阶段和错误诊断 | `(plan_id,event_id)`；Worker 事件最多 1000 行/Plan，截止失败可额外写 1 行；每行 JSON ≤ 4096 字节 | M1 与 Plan 一起保留；该表不是完整链路追踪系统 |
| workers | Worker 当前心跳和节点关系 | `(workspace_id,worker_id)`；更新同一行，不追加心跳历史；当前 Plan 列表最多 100 个 | stale 只表示超过 90 秒未见心跳，不能自动删除正在恢复的执行证据；整体回收时删除 |
| m1.console_sessions | 可跨 API 实例恢复和撤销的会话 | `(authority,session_hash)`；同账号配置最多 200 个活动会话；只存哈希，绝不存原 Cookie | 8 小时后无条件不可认证；登录创建会话前分批删除最多 1000 个过期会话；退出立即撤销 |
| m1.console_login_limits | 跨 API 实例的登录尝试预算 | `(authority,bucket)`；每配置全局 60 次/分钟，每用户名 10 次/分钟；用户名只存哈希 | 1 分钟预算窗口；每次登录分批删除最多 1000 个已过期桶 |

| console.accounts | 独立账号身份；username 主键、subject 唯一；只保存加盐 scrypt 摘要 | 仅管理命令增添，用户名 ≤ 64 字符，身份 ≤ 160；尚无账号总量硬配额 | 账号由管理者停用，撤销该账号会话；无自动删账号，console_app 无 DELETE 权限 |
| console.sessions | 可跨 API 恢复和撤销的会话；token_hash 主键、username 外键 | 整个账号库最多 200 活动会话；只存 Cookie 的 SHA-256 | 最长 8 小时；登录有界清理最多 100 条过期记录；退出立即删除；改密/停用与会话撤销同事务 |

账号文件模式的 `authority` 是规范化账号配置的摘要，包含账号角色、工作空间及密码摘要版本。改变配置后，新的 API 实例不会接受旧配置会话；所有副本应使用同一配置版本。账号库模式使用固定 `console.accounts.v1` 作为共享登录预算 authority，按账号表的当前角色/停用状态验证会话；不依赖账号文件快照。数据库故障时账号认证返回依赖不可用，不能回退到本地会话或误报密码错误。

## 增长与索引

M1 固定样本没有外部无限发现来源；每次创建产生一份冻结输入、1～3 个领域和一个 START 意图。重复创建/提交不追加相同业务身份的数据。数据库页、索引和 WAL 会带来额外空间开销，不能把 JSON 上限当作精确磁盘预算。

每 workspace 的 Plan 总数、Worker 注册身份总数目前没有硬配额；M1 因此仍限定内部隔离测试，不能宣称已经具备公开批量准入能力。M2 批量运行前需要依据压测和实际磁盘预算确定配额、准入背压及告警阈值。

迁移 001 覆盖主键、创建/提交幂等和计划关联；002 补充按工作空间/状态列 Plan、活动截止扫描、频道更新时间排序、错误事件排序、会话及限流过期查询索引。分页最多 100 行、偏移最大 100000；大型生产列表进一步改键集分页属于后续数据量验证，不能用当前小样本测试证明大规模查询性能。

## 测试业务数据的回收条件

当前没有自动业务数据 TTL，也没有开放单独删除 Plan/Receipt 的 API。只有明确退役的测试 workspace 才具备整体回收资格，须同时满足：

1. 停止该 workspace 的创建、派发及 Worker，撤销其操作/执行凭据；不可继续用同一 workspace 重建旧业务身份。
2. 所有 Plan 已终态，START/CANCEL 意图均为 DONE/SKIPPED，Temporal 执行及取消已核对。执行模块尚未实现时，不能仅凭 Plan.status 假设这一条件成立。
3. 导出所需回执、故障测试结果和审计记录，确认不再需要恢复或重放。
4. 若曾启动 Temporal Workflow，最后一个执行关闭后至少保留完整 7 天历史保留窗口，并确认无仍有效的重试请求。

回收以受控维护操作按外键依赖顺序清理整个测试 workspace，或在全部 workspace 都退役后回收整个独立测试库；不在本次开发中删除历史证据。会话/限流属于短期认证数据，可按其独立过期规则清理，不影响业务回执。

账号库的身份配置属于实际访问控制数据，不能跟随测试 workspace 回收。主线集成测试建立的是隔离测试库内的 `console` schema，不对 `crawler.console` 或其授权执行建表/删数；正式账号库的 Owner/console_app 权限验证由部署验收另行记录。

## 本轮追踪输出

HTTP OTel span 不新增业务数据库表，沿 stdout → Alloy → Loki 保存。每进程队列 256、批次 32、属性至多 16（每值至多 160 字符）、默认 10% 根采样；只记录模板路由/状态/请求和业务身份，无请求正文或凭据。实际 Loki 保留政策仍使用基础设施配置；该日志不是 APPLIED 或账务审计的权威证据。Prometheus 新 job 使用既有 7 天/3GB 本地保留预算，业务事实按副本重复导出，聚合不得重复计数。
