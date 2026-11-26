import type { AgentSessionSummary, ChatMessage, WorkspaceInfo } from './types';
import { formatRelativeTimeShort } from './relativeTime';
import { isVerboseStatusArg } from './workbenchStatus';
import { t } from './i18n';

/** Text commands and response formatting for remote workbench input. */
export type WorkbenchCommand =
  | { type: 'help' }
  | { type: 'palette' }
  | { type: 'workspaces' }
  | { type: 'useWorkspace'; target: string }
  | { type: 'sessions' }
  | { type: 'useSession'; target: string }
  | { type: 'newSession' }
  | { type: 'workSessions' }
  | { type: 'status'; detail: 'brief' | 'verbose' }
  | { type: 'stop' }
  | { type: 'bind'; target?: string }
  | { type: 'unbind' }
  | { type: 'plain'; text: string };

const HELP_WORDS = new Set(['帮助', 'help', '/help', '命令帮助', '?']);
const PALETTE_WORDS = new Set(['/', '命令', '/cmd', '/commands']);
const WORKSPACE_WORDS = new Set(['工作区', '工作区列表', 'ws', '/ws']);
const SESSION_WORDS = new Set([
  '会话',
  '会话列表',
  '调度会话',
  '调度会话列表',
  's',
  'sessions',
  '/s'
]);
const NEW_WORDS = new Set(['新会话', '新调度会话', 'new', '/new']);
const WORK_SESSION_WORDS = new Set([
  '工作会话',
  '工作会话列表',
  '终端列表',
  'ts',
  '/ts',
  '/term'
]);
const STOP_WORDS = new Set(['停止', 'stop', '/stop']);
const UNBIND_WORDS = new Set(['解绑', '退出绑定', '/unbind', '/ub']);
const RE_BIND = /^(?:\/bind|\/bd|绑定会话|绑会话|绑定工作会话)(?:\s+(.+))?$/i;
const RE_STATUS = /^(?:\/st(?:atus)?|status|状态)(?:\s+(.+))?$/i;

const RE_USE_WORKSPACE = /^(?:\/ws|ws|切|切换|使用)(?:到)?(?:工作区|ws)?\s+(.+)$/i;
const RE_USE_WORKSPACE_CN = /^(?:切|切换|使用)(?:到)?工作区\s+(.+)$/;
const RE_USE_SESSION = /^(?:\/s|s|切|切换)(?:到)?(?:会话)?\s+(.+)$/i;
const RE_USE_SESSION_CN = /^(?:切|切换)(?:到)?会话\s+(.+)$/;

/** 解析远程工作台消息文本为命令；不匹配任何命令时回落 plain */
export function parseWorkbenchCommand(raw: string): WorkbenchCommand {
  const text = raw.trim();
  if (!text) return { type: 'plain', text: '' };
  const lower = text.toLowerCase();
  if (HELP_WORDS.has(lower)) return { type: 'help' };
  if (PALETTE_WORDS.has(text) || PALETTE_WORDS.has(lower)) return { type: 'palette' };
  if (WORKSPACE_WORDS.has(lower)) return { type: 'workspaces' };
  if (WORK_SESSION_WORDS.has(lower) || WORK_SESSION_WORDS.has(text)) return { type: 'workSessions' };
  if (SESSION_WORDS.has(lower)) return { type: 'sessions' };
  if (NEW_WORDS.has(lower)) return { type: 'newSession' };
  if (STOP_WORDS.has(lower)) return { type: 'stop' };
  if (UNBIND_WORDS.has(lower) || UNBIND_WORDS.has(text)) return { type: 'unbind' };
  const bindHit = RE_BIND.exec(text);
  if (bindHit) return { type: 'bind', target: bindHit[1]?.trim() || undefined };
  const statusHit = RE_STATUS.exec(text);
  if (statusHit) {
    return { type: 'status', detail: isVerboseStatusArg(statusHit[1]) ? 'verbose' : 'brief' };
  }

  const cn = RE_USE_WORKSPACE_CN.exec(text);
  if (cn) return { type: 'useWorkspace', target: cn[1].trim() };
  const cnS = RE_USE_SESSION_CN.exec(text);
  if (cnS) return { type: 'useSession', target: cnS[1].trim() };
  // 英文短格式要求显式空格（"ws 2" / "s 3"），避免误吞普通句式
  if (/^(?:\/ws|ws)\s+/i.test(text)) {
    const en = RE_USE_WORKSPACE.exec(text);
    if (en) return { type: 'useWorkspace', target: en[1].trim() };
  }
  if (/^(?:\/s|s)\s+/i.test(text)) {
    const en = RE_USE_SESSION.exec(text);
    if (en) return { type: 'useSession', target: en[1].trim() };
  }
  return { type: 'plain', text };
}

export function formatHelpText(): string {
  return [
    t('可用命令：'),
    t('/new · 新调度会话'),
    t('/status · 工作台状态'),
    t('/stop · 停止当前回合'),
    t('请在已授权的 Channel 对话中使用 /bind 或 /unbind 选择远程会话。')
  ].join('\n');
}

export function formatWorkspaceList(workspaces: WorkspaceInfo[], activeId: string): string {
  if (!workspaces.length) return t('没有已打开的工作区');
  const lines = workspaces.map((w, i) => {
    const mark = w.id === activeId ? t(' · 当前') : '';
    return `[${i + 1}] ${w.name}${mark}`;
  });
  return t('工作区（{{n}} 个）：\n{{list}}\n切换：切工作区 <序号或名称>', {
    n: workspaces.length,
    list: lines.join('\n')
  });
}

/** 历史会话列表（截取前 limit 条；序号与返回数组下标 +1 对应，供「切会话 <序号>」解析） */
export function formatSessionList(
  sessions: AgentSessionSummary[],
  limit = 20,
  now: number = Date.now()
): string {
  const shown = sessions.slice(0, limit);
  if (!shown.length) return t('当前工作区还没有调度会话，直接发消息即开始新调度会话');
  const lines = shown.map((s, i) => {
    const rel = formatRelativeTimeShort(s.modified, { now });
    const kind = s.isTask ? t('定时任务') : t('普通');
    return `[${i + 1}] ${s.title} · ${rel} · ${kind}`;
  });
  const more =
    sessions.length > shown.length
      ? t('\n…共 {{total}} 条，仅显示前 {{n}} 条', { total: sessions.length, n: limit })
      : '';
  return t('调度会话（按最近使用）：\n{{list}}{{more}}\n切换：切会话 <序号>', {
    list: lines.join('\n'),
    more
  });
}

/** 把调度回合的结果、计划和错误转换为远程回复文字 */
export function formatDoneText(message: Pick<ChatMessage, 'content' | 'error' | 'aborted' | 'plan'>): string {
  if (message.plan) {
    const statusLabel: Record<string, string> = {
      pending: '待批准',
      executing: '执行中',
      done: '已完成',
      abandoned: '已放弃'
    };
    const steps = message.plan.steps
      .map((s) => `${s.completed ? '[x]' : '[ ]'} ${s.step}. ${s.text}`)
      .join('\n');
    return t('📋 计划（{{status}}）：\n{{steps}}', {
      status: t(statusLabel[message.plan.status] ?? message.plan.status),
      steps
    });
  }
  if (message.error) return t('⚠️ 出错：{{error}}', { error: message.error });
  const prefix = message.aborted ? t('⏹ 已手动停止\n') : '';
  const body = message.content.trim() || t('（本轮没有文本输出）');
  return `${prefix}${body}`;
}

/** 按「序号（1 起）或名称片段」解析目标项；返回列表下标 */
export function resolveListTarget(
  target: string,
  items: readonly { name?: string; title?: string }[]
): number {
  const trimmed = target.trim();
  if (/^\d+$/.test(trimmed)) {
    const idx = parseInt(trimmed, 10) - 1;
    return idx >= 0 && idx < items.length ? idx : -1;
  }
  const lower = trimmed.toLowerCase();
  // 名称包含匹配，取首个命中
  for (let i = 0; i < items.length; i++) {
    const label = (items[i].name ?? items[i].title ?? '').toLowerCase();
    if (label && label.includes(lower)) return i;
  }
  return -1;
}
