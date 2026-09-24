# 2026-09-24 开发验证资源事故

北京时间 09:25～09:27，执行 Agent 让 Temporal SDK 集成测试、根 TypeScript 类型检查和真实联调脚本启动重叠执行，没有事先限制宿主机测试进程组的内存。这是一次资源安排失误。实际完整联调没有完成，不能计为通过。

2026-09-24 10:39～10:42 重新读取 `/var/log/sysstat/sa24` 和上一启动的 journal，确认：

| 指标 | 事故前 | 故障期间 |
| --- | --- | --- |
| 可用内存（sar kbavail） | 09:10 为 2,218,372 KiB | 09:44 为 752,420 KiB |
| swap | 0 | 0 |
| CPU iowait | 09:10 为 0.30% | 09:44～10:16 为 85.20%～89.85% |
| 系统日志 | — | 持续 `Under memory pressure`、SSH `Timeout before authentication` |
| 内核 OOM 日志 | — | 上一启动未找到 `Out of memory` / `Killed process` / `oom-kill` |
| 重启 | — | sar 记录 10:22:15 LINUX RESTART |

时间线与测试并发高度吻合，测试叠加很可能触发了内存压力和大量回收/磁盘等待；没有逐进程历史 RSS，不能精确归因到某一个进程，也不声称发生了 OOM kill。内存百分比的不同工具口径不能直接比较。

用户指定查阅的 Claude 会话 `71743463-6aa8-43ec-9e76-5bcc15124704` 记录：用户只同意恢复原有 2 GiB swap，不同意全用户内存上限；earlyoom 方案已撤回。现场确认 `/swap.img` 已启用，`vm.swappiness=10`，`user-1000.slice` 的 MemoryHigh/MemoryMax 仍为 infinity。执行 Agent 不修改这些系统配置。swap 提供缓冲，不保证宿主机不会再次陷入内存压力。

后续执行侧验证改用 `scripts/check-safe.sh`：单个全流程检查通过锁串行；宿主机可用内存不足 2.5 GiB 时不启动，运行中低于 1.5 GiB 时结束本次检查；临时 systemd user scope 限制本次检查及所有子进程，MemoryHigh=768 MiB、MemoryMax=1 GiB、MemorySwapMax=256 MiB、CPUQuota=150%、TasksMax=256；Node 堆上限 384 MiB，类型检查为 512 MiB，整体检查最多 300 秒。无法建立资源边界时明确失败，不回退为无限制运行。

限额启用后，16 项模块测试通过。首次受限全仓库类型检查在 384 MiB 堆上限内退出；收敛到执行模块后 SDK 声明仍超过该堆容量，因此仅把类型检查的堆调整到 512 MiB，整组 1 GiB 硬上限保持不变。这些受限检查未出现宿主机内存压力，不计为类型检查通过，直到实际成功退出。

上述是执行侧检查自身的临时限制，不设置全用户/基础设施组上限。尚未在这些限制内完成的场景继续标记未通过，不通过调高至无界来取得测试结果。
