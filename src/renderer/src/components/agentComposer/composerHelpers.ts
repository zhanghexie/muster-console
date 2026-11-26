import { t } from '../../../../shared/i18n';
import { parseWorkbenchCommand } from '../../../../shared/workbenchCommands';
import { parseCompactCommand } from '../../../../shared/compactCommand';
import { skillsToSlashItems } from '../../../../shared/composerSkills';
import { acpCommandsToSlashItems, filterAcpSlashItems } from '../../../../shared/acpSlash';
import { parseWorkflowCommand } from '../../../../shared/workflowCommand';
import type { GuiWorkerMode, AgentSkillInfo } from '../../../../shared/types';
import type { ChatEngineSlashCommand } from '../../../../shared/chatSurface';

/** 快捷短语的全局存储键（跨会话/工作区共用） */
export const PHRASES_STORE_KEY = 'muster.quick-phrases.v1';

/** queuedItems 缺省（保持引用稳定，避免面板 props 每渲染变化） */
export const NO_QUEUED_ITEMS: ReadonlyArray<{ id: string; text: string }> = [];

/** 输入框打字时的入队建议胶囊（统一排队面板快捷入口） */
export type DraftQueueCapsuleId = 'to-manual' | 'to-queue';

/**
 * 当前草稿可执行的入队动作推导（纯函数）：
 * - 有正文或有图才可执行（图-only 也可入队）；UI 占位时按有草稿查询，空草稿禁用按钮；
 * - 「手动确认」恒在（清单支持随文图片）；
 * - 「排队发送」仅在会话忙或已有排队时出（空闲无队列时=普通发送，不另设入口）。
 */
export function deriveDraftQueueCapsules(input: {
  hasText: boolean;
  hasImages: boolean;
  busy: boolean;
  queuedCount: number;
}): DraftQueueCapsuleId[] {
  if (!input.hasText && !input.hasImages) return [];
  const out: DraftQueueCapsuleId[] = ['to-manual'];
  if (input.busy || input.queuedCount > 0) out.push('to-queue');
  return out;
}

export type MenuKind = 'slash' | 'at' | null;
export const HARNESS_COMMAND = '/harness';
export const RECORD_REQUESTS_COMMAND = '/record-requests';

export interface SlashItem {
  id: string;
  label: string;
  description: string;
  /** 源文件路径供需要文本指路的 CLI 表面使用。 */
  skillFilePath?: string;
  /** 选中后执行，而非插入文本 */
  action?:
    | 'clear'
    | 'compact'
    | 'status'
    | 'statusVerbose'
    | 'stop'
    | 'help'
    | 'bind'
    | 'unbind'
    | 'model'
    | 'harness'
    | 'recordRequests'
    | 'quickInput';
  /** 插入到输入框的文本（含尾空格可选） */
  insert?: string;
}

/** i18n 取词函数的最小形状（组件传 useTranslation 的 t，纯函数测试传恒等） */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * 模式标签：常量保持中文原文作 key，label 用 getter 延迟到取值（渲染点）才查 i18n，
 * 语言切换后下次渲染即生效（对齐 boardPresentation 的数据驱动词条模式）。
 */
export const MODE_META: Record<GuiWorkerMode, { label: string }> = {
  standard: { get label() { return t('标准'); } },
  'auto-review': { get label() { return t('由引擎审批'); } },
  'accept-edits': { get label() { return t('自动接受编辑'); } },
  default: {
    get label() {
      return t('默认');
    }
  },
  ask: {
    get label() {
      return t('只读');
    }
  },
  plan: {
    get label() {
      return t('计划');
    }
  },
  auto: {
    get label() {
      return t('全自动');
    }
  }
};

export function isLocalClearCommand(text: string): boolean {
  const t = text.trim();
  return t === '/new' || t === '/clear';
}

export function isSkillCommand(text: string): boolean {
  return /^\/skill:[^\s]+/i.test(text.trim());
}

/** 以 / 开头但不是本地命令或 skill → 未支持（compactAvailable 时 /compact 也算本地命令；
 *  workflowCommands=调度表面：/workflow-new、/workflow 原文发给调度，由主进程展开） */
export function isUnsupportedSlash(text: string, compactAvailable = false, workflowCommands = false, extensionTask = false): boolean {
  const t = text.trim();
  if (!t.startsWith('/')) return false;
  if (isLocalClearCommand(t)) return false;
  if (isSkillCommand(t)) return false;
  // Extensions can start a natural-language brief with their own /skill-name.
  if (extensionTask && /^\/[\w-]+\s+\S/.test(t)) return false;
  if (workflowCommands && parseWorkflowCommand(t)) return false;
  if (compactAvailable && parseCompactCommand(t)) return false;
  const cmd = parseWorkbenchCommand(t);
  if (cmd.type !== 'plain') return false;
  return true;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m.toFixed(m >= 10 ? 0 : 1).replace(/\.0$/, '')}M`;
  }
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) {
    const k = n / 1000;
    return `${k.toFixed(k >= 10 ? 0 : 1).replace(/\.0$/, '')}k`;
  }
  return String(Math.round(n));
}

export function findTrigger(
  value: string,
  cursor: number
): { kind: MenuKind; start: number; query: string } | null {
  const before = value.slice(0, cursor);
  // 从光标往前找最近的未转义触发符（行内 token）
  const slash = before.lastIndexOf('/');
  const at = before.lastIndexOf('@');
  const pick = Math.max(slash, at);
  if (pick < 0) return null;

  const kind: MenuKind = pick === slash && (at < 0 || slash > at) ? 'slash' : 'at';
  const start = kind === 'slash' ? slash : at;
  // 触发符须在开头或前面是空白
  if (start > 0 && !/\s/.test(value[start - 1]!)) return null;
  const query = before.slice(start + 1);
  // 查询中不能有空白（token 结束）
  if (/\s/.test(query)) return null;
  return { kind, start, query };
}

/** 思考档标签（中文原词作比较键；展示走 t()） */
export function thinkingLevelLabel(level: string): string {
  switch (level) {
    case 'off':
      return t('关闭');
    case 'low':
      return t('低');
    case 'medium':
      return t('中');
    case 'high':
      return t('高');
    case 'max':
      return t('最高');
    default:
      return level;
  }
}

/** 选中模式是否创造模式（pi 内置 id=creator） */
export function isCreativePreset(preset: { id: string }): boolean {
  return preset.id === 'creator';
}

/**
 * 斜杠菜单条目装配（原 AgentComposer 内 useMemo 的纯函数化）：
 * 命令清单按表面显式分叉：GUI 会话不列调度专属命令（status/help/model/bind）；
 * /new、/stop 的描述按 GUI 会话语义改写（不再是「Pi 会话/调度回合」）。
 */
export function buildSlashItems(
  skills: AgentSkillInfo[],
  query: string,
  gui: boolean,
  engineSlashCommands: ReadonlyArray<ChatEngineSlashCommand> | undefined,
  compactAvailable: boolean,
  t: Translate,
  /** 调度表面：本工作区可运行的工作流，补全成 `/workflow 名字 ` */
  workflows: ReadonlyArray<{ name: string; description?: string }> = [],
  harnessAvailable = false,
  requestRecordingAvailable = false
): SlashItem[] {
  const local: SlashItem[] = [
    ...(gui
      ? []
      : [
          {
            id: 'cmd:status',
            label: '/status',
            description: t('工作台简要状态（工作区 / 调度 / 终端）'),
            action: 'status' as const
          },
          {
            id: 'cmd:status-v',
            label: '/status v',
            description: t('详细状态（cwd、lifecycle）'),
            action: 'statusVerbose' as const
          }
        ]),
    {
      id: 'cmd:new',
      label: '/new',
      description: gui
        ? t('清空聊天，下轮从新会话开始')
        : t('清空聊天并开始新 Pi 会话'),
      action: 'clear'
    },
    {
      id: 'cmd:clear',
      label: '/clear',
      description: t('同上（/new 别名）'),
      action: 'clear'
    },
    {
      id: 'cmd:stop',
      label: '/stop',
      description: gui ? t('中止当前回合') : t('中止当前调度回合'),
      action: 'stop'
    },
    ...(compactAvailable
      ? [
          {
            id: 'cmd:compact',
            label: '/compact',
            insert: '/compact ',
            description: t('手动压缩上下文（空闲时执行，可带摘要侧重）'),
            action: 'compact' as const
          }
        ]
      : []),
    ...(requestRecordingAvailable ? [{
      id: 'cmd:record-requests',
      label: RECORD_REQUESTS_COMMAND,
      description: t('录制请求并打开面板（加 view 只查看历史）'),
      action: 'recordRequests' as const
    }] : []),
    {
      id: 'cmd:quickInput',
      label: '/quickInput',
      description: t('快捷短语：常用片段即搜即插'),
      action: 'quickInput' as const
    },
    ...(harnessAvailable ? [{
      id: 'cmd:harness',
      label: HARNESS_COMMAND,
      description: t('为委派任务选择 Harness、模型和参数'),
      action: 'harness' as const
    }] : []),
    ...(gui
      ? []
      : [
          {
            id: 'cmd:help',
            label: '/help',
            description: t('命令说明'),
            action: 'help' as const
          },
          {
            id: 'cmd:model',
            label: '/model',
            description: t('切换或查看当前调度 Agent 使用的大模型'),
            action: 'model' as const
          },
        ])
  ];
  const q = query.toLowerCase();
  const filteredLocal = local.filter(
    (i) =>
      !q ||
      i.label.slice(1).toLowerCase().startsWith(q) ||
      i.label.toLowerCase().includes(q) ||
      i.description.toLowerCase().includes(q)
  );
  const skillItems: SlashItem[] = skillsToSlashItems(skills, query, t('Skill'));
  const engineItems: SlashItem[] = gui
    ? filterAcpSlashItems(acpCommandsToSlashItems(engineSlashCommands ?? []), query)
        .filter(item => !harnessAvailable || item.label.toLowerCase() !== HARNESS_COMMAND)
    : [];
  return [...filteredLocal, ...engineItems, ...skillItems];
}

/** 上下文用量展示值（原渲染内 IIFE 的纯函数化）：frac=null 表示无分母/用量未知的空环 */
export function deriveContextUsage(
  u: { tokens: number | null; contextWindow: number; ts?: number; stale?: boolean } | null | undefined,
  statusModel: string,
  t: Translate
): { frac: number | null; label: string } | null {
  // 无分母/用量未知（刚 compaction 等）：有模型名就给空环锚点
  if (!u || u.tokens == null) {
    return statusModel ? { frac: null, label: t('上下文 —') } : null;
  }
  const used = formatTokenCount(u.tokens);
  if (!u.contextWindow) {
    return { frac: null, label: t('已用 {{used}}', { used }) };
  }
  const pct = Math.round((u.tokens / Math.max(1, u.contextWindow)) * 100);
  const win = u.contextWindow != null ? formatTokenCount(u.contextWindow) : '?';
  return { frac: u.tokens / Math.max(1, u.contextWindow), label: `${pct}% · ${used}/${win}` };
}
