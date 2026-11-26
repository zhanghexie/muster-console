/**
 * bootstrap 注入组装（memory-refactor §7 Lane1-① / §12，B5）：策展核心（按面选择
 * 工作区 MEMORY.md / 调度 MEMORY.md）+ 今日 journal 尾部 + USER.md 画像槽位（B7 填充，
 * 本批留接口）的纯文本组装。
 *
 * - 共享核心（worker/chat 面）：parseMemoryEntriesV2 逐条 + 共享 memoryFormat 的
 *   优先级装箱（decision/preference 优先 → 新→旧），与旧 readMemoryContext 同语义；
 * - 调度核心（scheduler 面）：自由 markdown（时间戳条目追加制），尾部截断（新内容
 *   在文件尾，clipTail 与 shared/schedulerMemory 同口径）；
 * - journal：今日文件尾部截断（journalChars 预算；scheduler 面预算 0=不注入，
 *   与 R-12 现行前缀行为一致）；
 * - 画像：USER.md active 指令（B7 接线；文件缺省 null → 整节省略）。
 *
 * 纯函数（文件读取由调用方注入），零 IO/electron 依赖——test/*.mjs 直测。
 */
import { type MemoryEntryV2, parseMemoryEntriesV2, USER_PROFILE_MAX_CHARS } from './entryFormat';
import { SCHEDULER_MEMORY_INJECT_MARKER } from '../../shared/schedulerMemory';
import { JOURNAL_DIR_REL } from './paths';
import type {
  MemoryBudgetProfile,
  MemoryInjectionSection,
  MemoryInjectionSectionKind,
  MemorySessionKind
} from './serviceTypes';

/** 尾部截断（与 shared/schedulerMemory.clipTail 同口径；旧 memoryStore.truncateTail 已退役） */
export function clipTail(text: string, maxChars: number): { text: string; truncated: boolean } {
  const raw = (text ?? '').trim();
  if (raw.length <= maxChars) return { text: raw, truncated: false };
  return { text: `…[${raw.length - maxChars} earlier chars omitted]\n${raw.slice(raw.length - maxChars)}`, truncated: true };
}

/**
 * 共享核心优先级装箱（决策/偏好优先 → 时间新→旧 → 文件序）。
 * 首条也受预算约束：超长硬切进剩余预算（clipTail），绝不无条件整条装箱打穿 core 预算。
 */
function selectCoreEntries(entries: MemoryEntryV2[], budgetChars: number): {
  selected: MemoryEntryV2[];
  dropped: MemoryEntryV2[];
} {
  const rank = (e: MemoryEntryV2): number => {
    const t = e.tags.join(' ');
    if (/decision|决策/.test(t)) return 0;
    if (/preference|偏好/.test(t)) return 1;
    return 2;
  };
  const ranked = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const r = rank(a.e) - rank(b.e);
      if (r !== 0) return r;
      return a.e.ts < b.e.ts ? 1 : a.e.ts > b.e.ts ? -1 : a.i - b.i;
    });
  const chosen = new Set<number>();
  const clippedRaw = new Map<number, string>();
  const dropped: MemoryEntryV2[] = [];
  let used = 0;
  for (const { e, i } of ranked) {
    const size = e.raw.length + 2; // 条目间空行（shared/memoryFormat 同口径）
    if (used + size <= budgetChars) {
      chosen.add(i);
      used += size;
      continue;
    }
    // 首条也受预算：超长硬切（不无条件装箱）；剩余过窄则跳过。
    // clipTail 省略标记本身占位，再留 32 字余量，防硬切后仍略超预算
    if (chosen.size === 0 && budgetChars > 0) {
      const remain = budgetChars - used - 2 - 32;
      if (remain > 0) {
        const clipped = clipTail(e.raw, remain);
        if (clipped.text) {
          chosen.add(i);
          clippedRaw.set(i, clipped.text);
          used += clipped.text.length + 2;
          continue;
        }
      }
    }
    dropped.push(e);
  }
  const selected = entries
    .map((e, i) => {
      if (!chosen.has(i)) return null;
      const raw = clippedRaw.get(i);
      return raw != null ? { ...e, raw } : e;
    })
    .filter((e): e is MemoryEntryV2 => e !== null);
  return { selected, dropped };
}

/** 节装饰（head/note）预算上界：计入 core 预算，防止条目体+装饰远超 budgetChars */
const SHARED_CORE_DECOR_RESERVE = 240;

/** 共享核心节文本（条目间空行拼接 + 超限挤出标注——与旧 readMemoryContext 同形）。
 *  装饰文本（head/note）计入预算：条目体只装 budgetChars − 装饰预留。 */
export function assembleSharedCore(md: string | null, budgetChars: number): {
  text: string;
  entryCount: number;
} {
  const body = (md ?? '').trim();
  if (!body || budgetChars <= 0) return { text: '', entryCount: 0 };
  const entries = parseMemoryEntriesV2(body);
  const entryBudget =
    budgetChars > SHARED_CORE_DECOR_RESERVE
      ? budgetChars - SHARED_CORE_DECOR_RESERVE
      : Math.max(1, Math.floor(budgetChars / 2));
  const sel = selectCoreEntries(entries, entryBudget);
  if (sel.selected.length === 0) return { text: '', entryCount: 0 };
  const head = `### Long-term memory (docs/memory/MEMORY.md, injecting ${sel.selected.length}/${entries.length} entries)`;
  const text = sel.selected.map((e) => e.raw).join('\n\n');
  const note =
    sel.dropped.length > 0
      ? `\n\n> Note: the ${budgetChars}-character injection budget is full; ${sel.dropped.length} entries were squeezed out by priority (decision/preference first, newer first) — merge and prune them in the "Memory curation" panel.`
      : '';
  return { text: `${head}\n${text}${note}`, entryCount: sel.selected.length };
}

/** 调度核心节文本（自由 markdown 尾部截断；标记单源 shared/schedulerMemory） */
export function assembleSchedulerCore(md: string | null, budgetChars: number): {
  text: string;
  entryCount: number;
} {
  const body = (md ?? '').trim();
  if (!body || budgetChars <= 0) return { text: '', entryCount: 0 };
  const clipped = clipTail(body, budgetChars);
  const head = `${SCHEDULER_MEMORY_INJECT_MARKER} (.muster/scheduler/MEMORY.md, your frozen cross-session private memory snapshot; writes made this turn take effect next session; revise in the memory center panel)`;
  return { text: `${head}\n${clipped.text}`, entryCount: 1 };
}

/** 今日 journal 节文本（尾部 ≤ 预算） */
export function assembleJournalSection(md: string | null, dayKey: string, budgetChars: number): {
  text: string;
  entryCount: number;
} {
  const body = (md ?? '').trim();
  if (!body || budgetChars <= 0) return { text: '', entryCount: 0 };
  const j = clipTail(body, budgetChars);
  return {
    text: `### Today's journal (tail of ${JOURNAL_DIR_REL.replace(/\\/g, '/')}/${dayKey}.md, ≤${budgetChars} chars)\n${j.text}`,
    entryCount: 1
  };
}

/** USER.md 画像节文本（B7 填充；文件在场即 active 指令逐条，硬上限 USER_PROFILE_MAX_CHARS） */
export function assembleProfileSection(md: string | null, budgetChars: number): {
  text: string;
  entryCount: number;
} {
  const body = (md ?? '').trim();
  if (!body || budgetChars <= 0) return { text: '', entryCount: 0 };
  const cap = Math.min(budgetChars, USER_PROFILE_MAX_CHARS);
  const clipped = clipTail(body, cap);
  return {
    text: `### User profile (USER.md)\n${clipped.text}`,
    entryCount: 1
  };
}

export interface AssembleInjectionInput {
  sessionKind: MemorySessionKind;
  budget: MemoryBudgetProfile;
  workspaceMemoryMd: string | null;
  schedulerMemoryMd: string | null;
  todayJournalMd: string | null;
  /** 今日 journal 文件 dayKey（YYYY-MM-DD；节头展示用） */
  journalDayKey: string;
  /** USER.md 全文（B7 接线；缺省 null=整节省略） */
  userProfileMd?: string | null;
}

export interface AssembleInjectionResult {
  text: string;
  sections: MemoryInjectionSection[];
}

function section(
  kind: MemoryInjectionSectionKind,
  budgetChars: number,
  assembled: { text: string; entryCount: number }
): MemoryInjectionSection {
  return {
    kind,
    budgetChars,
    chars: assembled.text.length,
    entryCount: assembled.entryCount
  };
}

/**
 * bootstrap 注入组装（纯函数）。预算内装箱；整节空=该节省略；两段都空 → 空串。
 * scheduler 面：调度核心（不含共享核心/journal——与 R-12 现行前缀行为一致）；
 * worker/chat 面：共享核心 + 今日 journal。
 */
export function assembleMemoryInjection(input: AssembleInjectionInput): AssembleInjectionResult {
  const sections: MemoryInjectionSection[] = [];
  const parts: string[] = [];
  const push = (
    kind: MemoryInjectionSectionKind,
    budgetChars: number,
    assembled: { text: string; entryCount: number }
  ): void => {
    if (!assembled.text) return;
    parts.push(assembled.text);
    sections.push(section(kind, budgetChars, assembled));
  };
  if (input.sessionKind === 'scheduler') {
    push('core', input.budget.coreChars, assembleSchedulerCore(input.schedulerMemoryMd, input.budget.coreChars));
  } else {
    push('core', input.budget.coreChars, assembleSharedCore(input.workspaceMemoryMd, input.budget.coreChars));
  }
  push('journal', input.budget.journalChars, assembleJournalSection(input.todayJournalMd, input.journalDayKey, input.budget.journalChars));
  push('profile', input.budget.profileChars, assembleProfileSection(input.userProfileMd ?? null, input.budget.profileChars));
  return { text: parts.join('\n\n'), sections };
}
