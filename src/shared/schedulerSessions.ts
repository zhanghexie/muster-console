/**
 * 调度会话切换面门控（R-12 去历史会话）纯函数：
 * - listableSchedulerSessions：调度面板历史列表只保留**无头定时任务桶**会话
 *   （聊天桶的历史切换面拆除——跨会话上下文改由 .muster/scheduler/ 记忆承载）；
 * - isOpenableSchedulerSessionFile：openSession 只放行定时任务桶目录内的文件，
 *   与 piProvider rename/delete 的 allowedDirs 精确匹配同口径（不递归子目录，
 *   防路径穿越）。无 Node path 依赖（渲染层可共用）。
 */
import type { AgentSessionSummary } from './types';

/** 归一路径分隔符与尾斜杠（Windows 反斜杠 → /） */
function normalizeDirPath(p: string): string {
  return String(p ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
}

/** 手写 dirname（shared 无 node:path；归一后按最后一个 / 切） */
function parentDirOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(0, idx) : '';
}

/** 历史列表过滤：只留定时任务桶（isTask=true）会话 */
export function listableSchedulerSessions(all: readonly AgentSessionSummary[]): AgentSessionSummary[] {
  return all.filter((s) => s && s.isTask === true);
}

/** openSession 门控：会话文件必须位于定时任务桶目录内（精确目录匹配） */
export function isOpenableSchedulerSessionFile(sessionFile: string, taskSessionDir: string): boolean {
  const file = normalizeDirPath(sessionFile);
  const dir = normalizeDirPath(taskSessionDir);
  if (!file || !dir) return false;
  return parentDirOf(file) === dir;
}
