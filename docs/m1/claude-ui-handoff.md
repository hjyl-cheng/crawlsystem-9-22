# Claude Agent：控制台接手说明

用户已指定 UI 由 Claude Agent 开发。你负责页面和交互，主 Agent 继续负责后端、公共契约、根锁文件及最终集成。

## 工作位置与当前代码

- 工作目录：`/home/ubuntu/workspace/crawlsystem-console`
- 分支：`business/m1-console`
- 交接时 UI 提交：`c8dbe94fa0d5c05107ff68af21b249c725e5f4ac`。本说明随后同步到该分支；接手时以实际 `git status` / `git log` 核对新增工作。
- 主线后端基线：`0438484c1a22c9cb777290b4941f5c752b4fd2c6`。

沿用已有 worktree 和分支。开始前阅读现有代码与工作区状态，保留用户及其他会话尚未提交的改动。你可以重做布局、组件、样式及交互，也可以复用现有实现；页面的业务语义和接口以公共契约为准。

## 先读这些文件

1. `docs/m1/README.md`：分工与 M1 验收边界。
2. `docs/m1/agent-console.md`：UI-01～UI-05 的职责与完成标准。
3. `docs/m1/reports/console.md`、`apps/console/README.md`：现有功能、测试、原型布局与后续追加需求。
4. `docs/m1/integration-baseline.md`、`packages/contracts/src/index.ts`：接口、状态、样本和共享类型。
5. `apps/control-api/README.md`、`apps/console/docs/preview.md`：本分支已经实现的账号密码登录和开发预览接入。

旧系统只作字段和业务参考，不要求复制旧逻辑。频道采集数据是基础信息、视频、评论与 Agent 分析结果，没有额外的视频质量评分需求。

## 已有成果与第一步

当前分支已有 React/TypeScript 控制台，包括总览链路图、频道、Plan、Worker、错误、回执、创建和取消操作；总览已经按用户提供的原型调整。现有桌面/手机截图在 `apps/console/docs/evidence/`。

先运行页面、阅读最新需求及查看已有截图，确认用户希望改变的界面，再实施具体 UI 改动。已有行为应持续可用：权限、分页、请求取消和有限轮询、创建幂等、取消版本冲突、错误与回执定位、手机导航。后续若用户明确调整产品范围，以新需求为准。

测试证据来自前任 Agent 的提交报告，本次交接没有重新执行所有测试。接手后针对自己的改动验证并更新报告，不把历史结果写成本轮新结果。

## 登录与后端的实际差异

旧 G0 文档描述手动 Bearer 登录；控制台分支后续已按用户要求新增账号密码登录、HttpOnly Cookie 会话及 CSRF 校验，提交为 `078d9d8`。当前 UI 应沿用这一登录体验。

这一提交也包含 `apps/control-api/`、`packages/http/`、`packages/contracts/` 的后端与契约变更，尚未合入主线。接手时保留这些既有成果，交付时提醒主 Agent 一并审查和集成，不能只提取页面文件。

按现有报告，原主线 Control/Ingest 使用 `18100/18101`，带密码登录的预览 Control 使用 `18104`，UI 开发端口为 `18102`，静态预览端口为 `18103`。实际进程与地址需要启动时核对。密码登录页面必须连接支持登录接口的后端；不要仅因旧示例默认 `18100` 就认定登录接口已经存在。

浏览器仅获取公开 API 配置和用户会话。运行凭据、账号配置与短期令牌通过忽略的运行文件使用，不写进源码、截图、构建或报告。免费预览地址及服务状态以 `apps/console/docs/preview.md` 和实际环境为准。

## 本轮修改边界

你主要修改 `apps/console/`，并更新 `docs/m1/reports/console.md`。使用 `@crawlsystem/contracts` 的业务类型和运行时 schema。需要新增 API、状态或共享依赖时，把具体使用场景、输入输出和依赖版本记录给主 Agent，由主线统一维护；现有范围内的 UI 工作可以继续推进。

不能由页面把局部结果判断为完整成功：必需 Agent 缺失仍是等待；固定样本标明测试身份；未接入的代理、资源统计、趋势及正式交付按真实能力展示。接口失败应呈现错误和过期状态，不回退到假数据或伪造数字。

## 验证与交付

命令在控制台 worktree 根目录执行：

```bash
npm run typecheck --workspace @crawlsystem/console
npm run test --workspace @crawlsystem/console
npm run test:browser --workspace @crawlsystem/console
npm run build --workspace @crawlsystem/console
```

按改动需要执行真实接口 `test:live` 或密码登录 `test:login-live`，环境准备参照应用 README；测试替身验证与真实接口验证分别记录。根锁文件目前仍待主 Agent 集成控制台依赖，安装说明以当前应用 README 为准，不通过覆盖共享锁文件掩盖依赖差异。

交付内容：具体提交 SHA、改动说明、运行命令、桌面和手机截图、测试结果，以及仍缺少的后端能力。只提交自己的工作。由主 Agent 审查并合入 `business/crawler-platform`，继续与执行器做完整链路验收；UI 验证通过不代表 Temporal 与 M1 整体已验收。
