/** DESIGN PREVIEW ONLY. Invented accounts that show the user management page at
 * team scale; rendered only behind the explicit "预览示例数据" switch under a
 * warning banner. Account names are placeholders, not people. The default view
 * lists the real accounts of the signed-in workspace. */
import type { ConsoleAccount } from '@crawlsystem/contracts';

export interface UsersSample {
  workspace: string;
  accounts: ConsoleAccount[];
  logins: { day: string; value: number }[];
  events: { time: string; type: string; user: string; detail: string; tone: 'green' | 'amber' | 'red' | 'blue' | 'slate'; status: string }[];
}
const at = (day: number, hm: string) => `2026-09-${String(day).padStart(2, '0')}T${hm}:00.000+08:00`;
const account = (username: string, role: ConsoleAccount['role'], created: string, sessions: number | null, latest: string | null, disabled = false): ConsoleAccount => ({
  username, subject: `user:${username}`, role, status: disabled ? 'DISABLED' : 'ACTIVE', created_at: created, updated_at: latest ?? created, active_sessions: sessions, latest_session_at: latest,
});

export const usersSample: UsersSample = {
  workspace: 'm1-main',
  accounts: [
    account('ops-lead', 'operator', at(1, '10:30'), 2, at(22, '20:14')),
    account('operator-a', 'operator', at(3, '09:12'), 1, at(22, '18:32')),
    account('operator-b', 'operator', at(3, '09:20'), 1, at(22, '17:20')),
    account('analyst-a', 'reader', at(5, '14:02'), 1, at(22, '16:05')),
    account('analyst-b', 'reader', at(5, '14:06'), 0, at(21, '11:40')),
    account('auditor-a', 'reader', at(8, '11:00'), 0, at(20, '14:12'), true),
    account('operator-c', 'operator', at(9, '16:45'), 1, at(22, '12:03')),
    account('reader-a', 'reader', at(12, '10:10'), 0, null),
    account('reader-b', 'reader', at(12, '10:12'), 1, at(22, '09:18')),
    account('operator-d', 'operator', at(15, '08:30'), 0, at(19, '15:11'), true),
  ],
  logins: [{ day: '09/16', value: 12 }, { day: '09/17', value: 13 }, { day: '09/18', value: 19 }, { day: '09/19', value: 15 }, { day: '09/20', value: 18 }, { day: '09/21', value: 23 }, { day: '09/22', value: 29 }],
  events: [
    { time: '09/22 11:28', type: '新建账号', user: 'reader-a', detail: '只读用户', tone: 'amber', status: '尚未登录' },
    { time: '09/21 16:03', type: '重置密码', user: 'analyst-b', detail: '原有会话已撤销', tone: 'green', status: '已完成' },
    { time: '09/20 10:21', type: '角色变更', user: 'operator-c', detail: '只读用户 → 操作员', tone: 'green', status: '已生效' },
    { time: '09/19 14:17', type: '停用账号', user: 'operator-d', detail: '会话立即失效', tone: 'red', status: '已停用' },
    { time: '09/18 09:33', type: '登录受限', user: 'auditor-a', detail: '1 分钟内失败超过 10 次', tone: 'slate', status: '已自动解除' },
  ],
};
