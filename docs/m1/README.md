# M1 三 Agent 协作与验收

日期：2026-09-23｜状态：G0 已发布，进入 G1 并行实现与验证；M1 全链路尚未验收。

M1 交付一条使用固定样本、具备持久回执与中断恢复、控制台可追踪的内部链路。之后的 M2 再接真实采集、本地代理及所需 API/Agent，交付频道基础信息、视频、评论和 Agent 分析结果。

## 1. 工作区和任务单

| 角色 | 工作目录 | 分支 | 任务说明 |
| --- | --- | --- | --- |
| 主 Agent：公共基础与集成 | `/home/ubuntu/workspace/crawlsystem-business` | `business/crawler-platform` | [主 Agent 任务](agent-main.md) |
| 执行 Agent：Temporal 与 Worker | `/home/ubuntu/workspace/crawlsystem-execution` | `business/m1-execution` | [执行 Agent 任务](agent-execution.md) |
| 控制台 Agent（Claude）：业务前端 | `/home/ubuntu/workspace/crawlsystem-console` | `business/m1-console` | [控制台 Agent 任务](agent-console.md)、[Claude 接手说明](claude-ui-handoff.md) |

共同资料：[开发计划](../业务平台开发计划_讨论稿_2026-09-23.md)、[旧系统字段参考](../业务数据范围_旧系统字段参考_2026-09-23.md)。旧仓库 `/home/ubuntu/workspace/oldsystem` 仅作为参考；本轮固定提交为 `e92d9227a5a3847430e5d062bea13227564ee419`。

用户已明确：旧代码和算法允许重新设计；先用独立数据验证新系统；第一版是采集管理平台，预留下游交付接口；质量目标为性能、并发、伸缩性、可靠性、安全、可观测性、易用性和可维护性。

共同文档基线来自 `4fb6c8f`。公共代码 G0 为 `ca3973f43d4ee3bc355cb0cc3ab1a373f5292a92`，已经同步至两个 worktree；工程、契约、迁移及当前接入说明见 [integration-baseline.md](integration-baseline.md)。各模块实际完成程度以报告和测试证据为准，G0 不代表 M1 已验收。

## 2. 目录所有权

以下为 M1 建议目录。主 Agent 在 G0 建立并锁定目录与工具版本；若需要调整路径，统一更新三份任务单后通知各分支。

| 目录或文件 | 唯一修改负责人 | 内容 |
| --- | --- | --- |
| 根 `package.json`、workspace 配置、锁文件、基础 TypeScript/检查配置、CI | 主 Agent | 工程工具链和跨模块依赖 |
| `packages/contracts/` | 主 Agent | 业务类型、运行时校验、API schema、错误与状态定义、共享测试样本 |
| `packages/store/`、`database/migrations/` | 主 Agent | 数据访问、事务、幂等、领域收口和数据库迁移 |
| `apps/control-api/`、`apps/ingest/`、`packages/http/` | 主 Agent | 控制/查询接口、共享 HTTP/鉴权、启动意图派发与结果接收 |
| `apps/execution-worker/`、`packages/execution-client/` | 执行 Agent | Temporal Workflow/Activity、Worker、启动适配器和执行侧 HTTP 客户端 |
| `apps/console/` | 控制台 Agent | 页面、前端请求适配、展示与页面测试 |
| `tests/integration/`、`scripts/dev/` | 主 Agent | 全链路测试、环境与启动编排；各 Agent 提供所需命令和参数 |
| `docs/m1/reports/main.md`、`docs/m1/integration-baseline.md` | 主 Agent | 契约发布、环境配置说明、集成结果 |
| `docs/m1/reports/execution.md` | 执行 Agent | 执行模块交付与验证结果 |
| `docs/m1/reports/console.md` | 控制台 Agent | 前端交付与验证结果 |

各 Agent 可以修改自己模块内的 `package.json` 和测试。共享依赖、根锁文件、Schema、状态枚举及跨模块接口由主 Agent 集中修改并同步；不得在自己的模块复制另一套类型定义。

## 3. 公共接口由谁提供

接口的具体名称、路径、枚举及错误码由 G0 契约确定；下表分配责任，不能据此由各 Agent 独立发明 API。

| 能力 | 提供者 | 使用者 | 关键约束 |
| --- | --- | --- | --- |
| 创建样本 Plan、查询频道/Plan、取消本轮 | 主 Agent 的 Control API | 控制台；集成测试 | 创建幂等、对象授权、取消的期望版本、明确样本身份 |
| 冻结输入与目标、执行权限、已有检查点 | 主 Agent 的受控执行 API | 执行 Agent | 输入版本可核对、范围有界、Worker 无 PG 凭据 |
| 提交 Submission、查询持久回执 | 主 Agent 的 Ingest/查询 API | 执行 Agent | 相同身份和内容可重放；不同内容冲突；授权独立校验 |
| 幂等启动 Temporal 的客户端接口 | 主 Agent 定义接口，执行 Agent 实现适配器 | 主 Agent 的持久启动意图派发器 | 网络调用在数据库事务外；重复启动识别同一 Workflow |
| Workflow/Activity 执行与恢复 | 执行 Agent | 主 Agent 集成 | 业务身份与重试身份分开；重启不生成另一轮 Plan |
| Worker 注册/心跳、执行阶段和错误上报 | 主 Agent 提供受控接口，执行 Agent 上报 | 控制台读取主 Agent 查询接口 | 心跳有时间与失联语义，不把心跳当完成事实 |
| 节点、Worker、回执、错误与关联对象查询 | 主 Agent | 控制台 Agent | 列表分页、结果有界、来源与状态时间可见 |

主 Agent 对外提供完整的控制台后端 API。控制台 Agent 不承担数据库查询服务；执行 Agent 不承担数据库迁移或直接 SQL 写入。

## 4. 启动与协作顺序

### G0：公共代码基线发布

主 Agent 先交付工程骨架、统一类型及运行时校验、最小迁移、样本格式、API 输入输出与错误样例、Workflow 启动接口、配置模板和可执行检查命令。

将接口版本、迁移版本、目录责任、环境隔离和启动命令记入 `integration-baseline.md`，通过实际类型/契约检查后提交，并在交付消息中给出完整 commit SHA。该 SHA 是两条分支同步的依据，不能仅用会移动的分支名作为实现基线。

G0 前，执行 Agent 可检查旧执行入口、Temporal 接入资料并准备恢复场景；控制台 Agent 可梳理页面操作与状态展示。依赖公共契约的代码在 G0 同步后实现，无需重新询问用户每个字段。发现契约缺口时，给主 Agent 提交具体输入、预期输出和场景；已有明确边界的工作继续推进。

### G1：并行实现

- 主 Agent：Ingest/Store、控制与查询 API、持久启动意图、鉴权和数据库测试。
- 执行 Agent：启动适配器、样本 Workflow/Activity、回执查询与执行恢复。
- 控制台 Agent：按统一契约实现页面、请求适配、加载/错误/等待状态和操作测试。

开发时可使用契约匹配的测试替身，但测试替身结果需明确标记；每个模块的最终交付包括真实依赖验证结果或明确未通过项。

### G2：主线集成

主 Agent 审查执行分支的具体提交并集成，贯通 API → Temporal → Worker → Ingest → PG，再集成控制台分支进行浏览器端验证。涉及共同状态或数据库的冲突由主 Agent统一解决，不能用删除校验或跳过测试解决。

分支同步统一使用 Git 合并具体提交；没有独立提交时可快进。遇到冲突先检查双方改动，不强制覆盖、不直接复制另一个 worktree 的未提交文件。子 Agent 只在自己的 worktree 提交，主 Agent 负责把成果合入业务集成分支。

### G3：M1 通过，转入 M2

验收确认固定样本链路能运行、能恢复、能从页面定位状态后，才标记 M1 完成。M2 的真实 YouTube、节点本地代理和真实 API/Agent 属于下一开发包；M1 的样本成功不代表真实采集通过。

## 5. 测试环境与证据

worktree 隔离代码，运行资源也要隔离。主 Agent 在 G0 分配测试数据库/Schema、Temporal 测试命名空间与 Task Queue、端口和数据身份；共享数据库上的破坏性测试必须改用明确隔离资源。独立的 Task Queue 不等于数据和权限已隔离。

连接地址、证书位置、账号与 Secret 引用来自既有部署资料和实际环境。配置模板只提供变量名与非敏感示例；凭据通过运行环境注入。已有基础设施复用验收记录，缺少的业务接入证据在联调中补齐；外部 S3 暂缓不阻塞有界固定样本链路。

| 验收场景 | 实现/验证负责人 | 必须观察到的结果 |
| --- | --- | --- |
| 同 Submission、同内容重复及并发提交 | 主 Agent；执行 Agent 集成 | 同一持久回执，一个业务效果 |
| 同 ID、不同内容 | 主 Agent | 冲突被拒绝，原事实与回执保持一致 |
| 旧执行代次、错误对象权限 | 主 Agent；执行 Agent 集成 | 新写入被拒绝；授权查询已成功提交的回执仍可正常核对 |
| 提交成功但响应丢失 | 主 Agent＋执行 Agent | 原身份恢复回执，不重新创建 Plan 或重复写入 |
| Plan 已入库但 Workflow 尚未启动时崩溃 | 主 Agent＋执行 Agent | 启动意图恢复，同一 Workflow 被可靠启动 |
| Worker 重启与有限重试 | 执行 Agent | 原计划恢复，预算与业务身份不因 Activity attempt 重置 |
| 取消后的迟到结果 | 主 Agent＋执行 Agent；控制台验证 | 取消行为符合契约，不发生越权新写入；页面不误报成功 |
| 必需领域缺失、最后两个领域并发完成 | 主 Agent | 缺失时不提前成功；并发收口不遗漏、不重复产生可靠义务 |
| 实际页面查看样本计划、回执、错误和失联状态 | 控制台 Agent＋主 Agent | 页面与持久事实一致，空值/未知/等待可区分，测试身份明确 |
| 队列/请求大小/数据库连接预算 | 各模块负责人 | 超预算时有明确拒绝或背压，不产生无界内存与并发 |

每项记录测试命令、环境、代码版本、结果与证据位置。基础设施测试、模块测试、固定样本全链路和真实采集验收分别标记。

## 6. 每个 Agent 的交付格式

1. 分支名、共同基线 SHA、本轮提交 SHA。
2. 完成的任务编号、改动目录和接口版本。
3. 实际运行的验证命令、结果、环境及证据路径。
4. 启动方式、配置变量与数据库迁移要求。
5. 未完成项、已知限制及对其他模块的具体依赖。
6. 是否具备主线集成条件；如不具备，指出缺失的具体契约或测试。

本轮任务单没有启动其他 Agent。用户可分别在两个 worktree 打开会话，将对应任务单交给执行 Agent 和控制台 Agent；主 Agent 按共同基线推进集成。
