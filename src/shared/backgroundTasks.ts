/**
 * 后台任务（子代理 / 后台终端 / 定时器）共享合同。
 * GUI 会话内 pi 经 bgtasks.* 工具派发；主进程 BackgroundTaskManager 是唯一 writer，
 * 渲染层只读展示 + 动作回传（kill / markRead / 删除已完成）。零运行时依赖
 * （test/*.mjs 即时转译导入）。
 */
import type { GuiChatMessage } from './guiWorker';
import type { GuiHarnessUsage } from './guiWorker';
import type { SessionMeta } from './types';

export type BgTaskKind = 'subagent' | 'shell' | 'timer';
export type BgTaskStatus = 'running' | 'done' | 'error' | 'cancelled';
/** P17：完成时何时唤醒。缺省 success（失败静默）；需跟进失败时显式 fail / always */
export type BgWakeOn = 'success' | 'fail' | 'always';

/** 子代理预算硬顶（opt-in，派发时声明；breach 即停并写明原因，借鉴 pi-subagents invocation-config） */
export interface BgTaskBudget {
  /** 最多 LLM 调用轮次（turn-complete 计数） */
  maxTurns?: number;
  /** 累计 token 上限（input+output 计入，cache 读不计） */
  tokenCap?: number;
}

/** 子代理累计用量（随运行回传，bgtasks.list 展示） */
export interface BgTaskUsageStats {
  turns: number;
  tokens: number;
}

/** 谁发起的停止（task-stop initiator） */
export type BgKillInitiator = 'model' | 'user';

/** shell 超时转后台判别联合（foreground=超时前跑完 / backgrounded=超时自动转后台） */
export type BgShellRunResult =
  | { kind: 'foreground'; exitCode: number; summary: string; outputPath?: string }
  | { kind: 'backgrounded'; taskId: string; reason: string };

export interface BgTaskRecord {
  id: string;
  parentSessionId: string;
  /** Dispatch-time source identity. Older completed records may lack it. */
  workspaceId?: string;
  sourceRoot?: SessionMeta['sourceRoot'];
  /** Actual single cwd, including an inherited isolated worktree. */
  cwd?: string;
  cwdPhysicalPath?: string;
  kind: BgTaskKind;
  /** 短名称（胶囊 / 面板列表展示；缺省用 detail 截断） */
  label: string;
  /** shell=命令文本；subagent=任务提示词；timer=到点带给 pi 的理由 */
  detail: string;
  /** timer 专用：到点时间（epoch ms） */
  wakeAt?: number;
  status: BgTaskStatus;
  createdAt: number;
  endedAt?: number;
  /** shell 退出码（cancelled 不带） */
  exitCode?: number;
  /** 完成摘要（子代理末条回复 / shell 输出尾部；error 时为错误信息） */
  summary?: string;
  /** 面板徽标：用户尚未打开面板看过 */
  unread: boolean;
  /** 结果尚未注入父会话引擎上下文（takeDigest 消费；wake 类不走摘要通道） */
  pendingDigest: boolean;
  /** Parent admission is separate from task completion and confirmed digest consumption. */
  parentNotification?: 'pending' | 'accepted' | 'unknown' | 'digest' | 'disabled' | 'digested';
  notificationError?: string;
  /** 完成时是否自动唤醒父会话（subagent/timer 恒 true；shell 由工具入参决定） */
  wake: boolean;
  /** P17：wake 为真时按终态过滤；缺省 success */
  wakeOn?: BgWakeOn;
  /** 子代理预算硬顶（仅 subagent；派发时声明） */
  budget?: BgTaskBudget;
  /** 子代理累计用量（仅 subagent；运行中回传） */
  usage?: BgTaskUsageStats;
  /** 完成通知 claim：true=已发过完成通知（防重复唤醒/摘要注入） */
  notified?: boolean;
  /** 完整输出文件路径（大输出落盘，摘要只保尾；模型可 Read 全文） */
  outputPath?: string;
  /** 谁终止的（kill 时记录；自然结束不带） */
  initiator?: BgKillInitiator;
}

/** push `agentSession:bgTask`：任务快照（状态/列表变化；按父会话全量） */
export interface BgTaskSnapshotPush {
  kind: 'snapshot';
  sessionId: string;
  tasks: BgTaskRecord[];
}

/** push `agentSession:bgTask`：子代理消息流（Host 侧装配好的整包，节流推送） */
export interface BgTaskMessagesPush {
  kind: 'task-messages';
  taskId: string;
  sessionId: string;
  status: BgTaskStatus;
  messages: GuiChatMessage[];
}

export type BgTaskPush = BgTaskSnapshotPush | BgTaskMessagesPush;

/** bgTasks:list 返回（面板首帧：快照 + 各子代理消息整包） */
export interface BgTaskListResult {
  tasks: BgTaskRecord[];
  messages: Record<string, GuiChatMessage[]>;
}

/** 每会话并发后台任务上限（timer 含内） */
export const BG_TASKS_MAX_PER_SESSION = 4;
/** 摘要/命令文本截断 */
export const BG_TASK_SUMMARY_MAX = 600;
/** timer 上限 24h */
export const BG_TIMER_MAX_MS = 24 * 60 * 60 * 1000;

export function truncateBgText(s: string, max = BG_TASK_SUMMARY_MAX): string {
  const clean = s.replace(/\s+$/g, '');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 校验预算入参（工具层调用）；返回 null 表示未提供，字符串为错误文案 */
export function sanitizeBgBudget(input: unknown): BgTaskBudget | string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) return 'budget 须为对象（{maxTurns?, tokenCap?}）';
  const raw = input as { maxTurns?: unknown; tokenCap?: unknown };
  const out: BgTaskBudget = {};
  if (raw.maxTurns !== undefined) {
    if (typeof raw.maxTurns !== 'number' || !Number.isInteger(raw.maxTurns) || raw.maxTurns < 1 || raw.maxTurns > 200) {
      return 'budget.maxTurns 须为 1-200 的整数';
    }
    out.maxTurns = raw.maxTurns;
  }
  if (raw.tokenCap !== undefined) {
    if (
      typeof raw.tokenCap !== 'number' ||
      !Number.isInteger(raw.tokenCap) ||
      raw.tokenCap < 1000 ||
      raw.tokenCap > 100_000_000
    ) {
      return 'budget.tokenCap 须为 1,000-100,000,000 的整数';
    }
    out.tokenCap = raw.tokenCap;
  }
  if (out.maxTurns === undefined && out.tokenCap === undefined) {
    return 'budget 至少给 maxTurns 或 tokenCap 之一';
  }
  return out;
}

/** 累计一次模型请求用量（input+output 计入；cache 读/写与 reasoning 不计入 tokenCap 口径） */
export function addHarnessUsage(acc: BgTaskUsageStats | undefined, usage: GuiHarnessUsage): BgTaskUsageStats {
  const base = acc ?? { turns: 0, tokens: 0 };
  return {
    turns: base.turns,
    tokens: base.tokens + (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
  };
}

/** 预算是否已突破；返回原因文案（null=未突破或未设预算） */
export function budgetBreachReason(
  budget: BgTaskBudget | undefined,
  usage: BgTaskUsageStats | undefined
): string | null {
  if (!budget || !usage) return null;
  if (budget.maxTurns !== undefined && usage.turns > budget.maxTurns) {
    return `预算超限：轮次 ${usage.turns} 超过上限 ${budget.maxTurns}`;
  }
  if (budget.tokenCap !== undefined && usage.tokens > budget.tokenCap) {
    return `预算超限：累计 token ${usage.tokens} 超过上限 ${budget.tokenCap}`;
  }
  return null;
}

/** 「HH:mm」或 ISO 时间 / delaySec → 距今毫秒（非法返回 null；HH:mm 已过则顺延明天） */
export function parseTimerDelayMs(
  at: string | undefined,
  delaySec: number | undefined
): number | null {
  if (typeof delaySec === 'number' && Number.isFinite(delaySec) && delaySec > 0) {
    return Math.round(delaySec * 1000);
  }
  const s = (at ?? '').trim();
  if (!s) return null;
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(':').map(Number);
    const target = new Date();
    target.setHours(h, m, 0, 0);
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
    return target.getTime() - Date.now();
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const delta = t - Date.now();
  return delta > 0 ? delta : null;
}

/**
 * 待注入结果 → 引擎前缀（forkTranscript 同款：只进引擎、不进 UI）。
 * 返回 null 表示没有待注入项；不修改传入对象（消费标记由 manager 落）。
 */
export function buildBgTaskDigest(tasks: readonly BgTaskRecord[]): string | null {
  const pending = tasks.filter((t) => t.pendingDigest && t.status !== 'running');
  if (pending.length === 0) return null;
  const lines = pending.map((t) => {
    const head = `- ${t.label}（${t.id}）`;
    if (t.status === 'error') return `${head} 失败：${t.summary ?? '未知错误'}`;
    if (t.status === 'cancelled') return `${head} 已取消`;
    return `${head} 完成${typeof t.exitCode === 'number' && t.exitCode !== 0 ? `（exit ${t.exitCode}）` : ''}${t.summary ? `：${t.summary}` : ''}`;
  });
  return `[后台任务结果通知（详情可用 bgtasks.list / bgtasks_kill 查询）]\n${lines.join('\n')}`;
}

export function parseBgWakeOn(raw: unknown): BgWakeOn | undefined {
  if (raw === 'success' || raw === 'fail' || raw === 'always') return raw;
  return undefined;
}

/** shell：wake=true 且未写 wakeOn → success（失败默认静默） */
export function resolveShellWakePolicy(wake: boolean, wakeOn?: BgWakeOn): { wake: boolean; wakeOn: BgWakeOn } {
  if (!wake) return { wake: false, wakeOn: 'success' };
  return { wake: true, wakeOn: wakeOn ?? 'success' };
}

export function bgCommandFamily(kind: BgTaskKind, detail: string): string {
  if (kind !== 'shell') return `${kind}:${detail.trim().slice(0, 80).toLowerCase()}`;
  const tokens = detail.trim().split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const tok of tokens) {
    if (tok.startsWith('-')) continue;
    const base = tok.replace(/\\/g, '/').split('/').pop() ?? tok;
    kept.push(base.toLowerCase());
    if (kept.length >= 3) break;
  }
  return kept.join(' ') || 'shell';
}

export interface BgWakeDecisionInput {
  task: Pick<BgTaskRecord, 'id' | 'createdAt' | 'status' | 'kind' | 'detail' | 'wake' | 'wakeOn'>;
  sessionPhase?: string;
  siblings: ReadonlyArray<
    Pick<BgTaskRecord, 'id' | 'createdAt' | 'status' | 'kind' | 'detail' | 'wake' | 'wakeOn'>
  >;
}

/** 该终态兄弟任务按自身唤醒策略是否真的会注入父会话（静默失败的兄弟不应抑制别人） */
function siblingWouldWake(
  s: Pick<BgTaskRecord, 'status' | 'kind' | 'wake' | 'wakeOn'>
): boolean {
  if (!s.wake) return false;
  const on = s.wakeOn ?? (s.kind === 'shell' ? 'success' : 'always');
  if (s.status === 'done') return on !== 'fail';
  if (s.status === 'error') return on === 'fail' || on === 'always';
  return false;
}

/**
 * P17：是否把完成事件注入父会话。
 * - 失败默认不唤醒（wakeOn=success）
 * - 同命令族只留创建时刻最新一条（且该后继自己确实会唤醒——否则不掩盖更早的唤醒）
 * - 会话已 needs_you/idle 且已有更新成功任务时丢弃更早失败
 */
export function shouldInjectBgWake(input: BgWakeDecisionInput): boolean {
  const { task, sessionPhase, siblings } = input;
  if (!task.wake) return false;
  if (task.status === 'cancelled' || task.status === 'running') return false;
  const wakeOn = task.wakeOn ?? (task.kind === 'shell' ? 'success' : 'always');
  if (task.status === 'error' && wakeOn === 'success') return false;
  if (task.status === 'done' && wakeOn === 'fail') return false;

  const family = bgCommandFamily(task.kind, task.detail);
  const newerSameFamily = siblings.some(
    (s) =>
      s.id !== task.id &&
      s.createdAt > task.createdAt &&
      bgCommandFamily(s.kind, s.detail) === family &&
      siblingWouldWake(s)
  );
  if (newerSameFamily) return false;

  const settled = sessionPhase === 'needs_you' || sessionPhase === 'idle';
  if (settled && task.status === 'error') {
    const newerSuccess = siblings.some(
      (s) => s.id !== task.id && s.createdAt > task.createdAt && s.status === 'done' && s.wake
    );
    if (newerSuccess) return false;
  }
  return true;
}

// ---- C1: 超时转后台 / 输出指针 / 通知 claim ----

/** 大输出落盘阈值（超过则写全文文件，摘要只保尾） */
export const BG_OUTPUT_FILE_THRESHOLD = 2000;

/** bgtasks.shell 等待窗口上限（模型可传 timeoutMs 的钳制上限；超过按此值等待） */
export const BG_SHELL_TIMEOUT_MS_CAP = 10 * 60 * 1000;

/**
 * 判断是否纯 sleep 命令（超时即预期行为，不转后台）。
 * 仅匹配独占 sleep：`sleep 30`、`Start-Sleep -Seconds 5`、`timeout /t 10`；
 * `sleep 5 && npm test` 等组合命令不算纯 sleep。
 */
export function isSleepCommand(command: string): boolean {
  const s = command.trim().toLowerCase();
  if (!s) return false;
  // 去掉常见包装前缀
  const stripped = s.replace(/^(?:exec\s+|command\s+time\s+)/, '');
  // 分隔符含换行：`sleep 5\necho pwned` 不是纯 sleep（漏判会把多行命令当 sleep 超时杀掉）
  if (/^sleep\s+\d/.test(stripped) && !/[;&|\r\n]/.test(stripped)) return true;
  if (/^start-sleep\b/.test(stripped) && !/[;&|\r\n]/.test(stripped)) return true;
  if (/^timeout\s+\/t\s+\d/.test(stripped) && !/[;&|\r\n]/.test(stripped)) return true;
  return false;
}

/** shell 超时处置：纯 sleep 判失败（预期超时），其余自动转后台 */
export function resolveShellTimeoutAction(command: string): 'fail' | 'background' {
  return isSleepCommand(command) ? 'fail' : 'background';
}

/**
 * 截断保尾：大输出只留末尾 max 字符（近期内容对排错更有价值），
 * 前部以 `…` 省略。与 truncateBgText（保头）互补。
 */
export function truncateBgTextTail(s: string, max = BG_TASK_SUMMARY_MAX): string {
  const clean = s.replace(/\s+$/g, '');
  return clean.length > max ? `…${clean.slice(-max)}` : clean;
}

/** 大输出落盘后的指针文案（模型可按路径 Read 全文，不回灌上下文） */
export function buildOutputPointer(outputPath: string): string {
  return `完整输出已落盘：${outputPath}（可用 Read 查看全文）`;
}

/**
 * 完成通知 claim（防重复）：首次调用占用并返回 true，后续返回 false。
 * 单线程 check-and-set 原子；重复 complete / restore 重放均不再发通知。
 */
export function claimNotification(task: Pick<BgTaskRecord, 'notified'>): boolean {
  if (task.notified) return false;
  task.notified = true;
  return true;
}

/** 超时转后台结果文案（工具层拼装返回值用） */
export function formatShellRunResult(r: BgShellRunResult): string {
  if (r.kind === 'foreground') {
    const parts = [`foreground: 退出码 ${r.exitCode}`, r.summary];
    if (r.outputPath) parts.push(buildOutputPointer(r.outputPath));
    return parts.join('\n');
  }
  return `backgrounded: ${r.taskId}（${r.reason}）`;
}

