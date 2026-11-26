/**
 * 调度 Agent 长期记忆（R-12 + R-11）纯函数层：双文件格式、回合注入前缀、
 * 机械态势快照拼装。无 Node/渲染层依赖（shared 三方共用，测试离线直跑）。
 *
 * 双文件通道（.muster/scheduler/，每工作区一份）：
 * - MEMORY.md：调度策展核心（写入走 memory.note/remember——2026-10-26 F-01 起统一
 *   进类型化知识库候选，经后台记忆会话整理生效；整理/淘汰走记忆中心面板）。
 *   注入走 MemoryService.inject 调度面 bootstrap（兼容路径；现行核心注入真源为
 *   类型化 records 表——MemoryService.injectKnowledge）。
 * - SITUATION.md：机械态势快照——宿主写、模型只读；新对话首轮注入即冷启动
 *   态势摘要（R-11 随解），长会话期间由事件泵 30s 节流刷新（O12 等待期挤压可见）。
 *
 * 设计出处：docs/research/scheduler-memory-framework-research.md（Hermes 式小预算
 * 冻结快照 + Claude Code 式「会话清理豁免记忆」）与夜批决议（2026-09-21）。
 */

/** 调度记忆目录内文件名（目录本身由 main 侧 store 拼 `.muster/scheduler`） */
export const SCHEDULER_MEMORY_FILE = 'MEMORY.md';
export const SCHEDULER_SITUATION_FILE = 'SITUATION.md';

/** MEMORY.md 注入预算（研究建议 4–6K 字符：态势与偏要的是精度不是容量） */
export const SCHEDULER_MEMORY_INJECT_MAX_CHARS = 6_000;
/** SITUATION.md 注入预算（机械快照本身很小，防意外膨胀兜底） */
export const SCHEDULER_SITUATION_INJECT_MAX_CHARS = 4_000;
/** scheduler.memory.write 时代的单次输入上限（工具已退役；常量随 R-22 提醒口径保留） */
export const SCHEDULER_MEMORY_TEXT_MAX = 4_000;
/** needs_you 名单每区最多列名数（防超多 Worker 时快照膨胀） */
const NEEDS_YOU_NAME_LIMIT = 8;

function p2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 时间戳注释行的正文部分：YYYY-MM-DD HH:mm:ss */
export function formatSchedulerStamp(now: Date = new Date()): string {
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(
    now.getHours()
  )}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
}

/**
 * 序列化一条调度记忆（追加写盘的最小单元）：时间戳注释行 + 正文。
 * 正文自由 markdown；注释行与仓内 docs/memory 合同同形（`<!-- ts [sid] -->`），
 * 便于人直读与后续工具按块解析。
 */
export function serializeSchedulerMemoryEntry(text: string, now: Date = new Date()): string {
  return `<!-- ${formatSchedulerStamp(now)} [scheduler] -->\n${text.trim()}\n`;
}

/** 尾部截断（记忆追加为主，新条目在尾）：超限保留尾部并显式标注 */
export function clipTail(text: string, maxChars: number): string {
  const raw = (text ?? '').trim();
  if (raw.length <= maxChars) return raw;
  return `…[${raw.length - maxChars} earlier chars omitted]\n${raw.slice(raw.length - maxChars)}`;
}

/**
 * 写满即错·宽松版（R-22）：MEMORY.md 总长超注入预算时的返回值提醒文案。
 * 与注入截断 clipTail 同口径（先 trim 再比 SCHEDULER_MEMORY_INJECT_MAX_CHARS）：
 * 超了返回提醒（指路记忆中心面板合并整理），未超返回 undefined（不带字段）。
 * 宽松版语义：只提醒促消化，不阻断写入、不报错；宿主不自动淘汰，合并整理靠人工。
 * 文案为 LLM 协议中文（工具结果发给调度 Agent），走 shared 纯函数不 import i18n 的既有口径。
 */
export function schedulerMemoryWarning(content: string): string | undefined {
  const len = (content ?? '').trim().length;
  if (len <= SCHEDULER_MEMORY_INJECT_MAX_CHARS) return undefined;
  return `Memory exceeds the ${SCHEDULER_MEMORY_INJECT_MAX_CHARS}-character injection budget (now ${len}); earlier content will no longer be injected — review and merge old entries in the memory center panel`;
}

/** 注入段标记（决议：内容带明确分隔便于调度识别；单源——注入组装在 memory/injection.ts 与 orchestrator 消费） */
export const SCHEDULER_MEMORY_INJECT_MARKER = '[scheduler memory]';
export const SCHEDULER_SITUATION_INJECT_MARKER = '[situation snapshot]';

export interface SchedulerSituationWsRow {
  /** 工作区显示名 */
  name: string;
  /** 需要你会话名（看板「需要你」口径）；undefined=该源读取失败 */
  needsYouNames?: string[];
  /** 排队 delegate 数；undefined=读取失败 */
  delegateQueued?: number;
  /** 该工作区调度的普通未读来信（不含宿主事件/其他收件人）；undefined=读取失败 */
  outboxUnread?: number;
  /** 事件队列深度（pending 条数）；undefined=读取失败 */
  eventQueueDepth?: number;
}

export interface SchedulerSituationData {
  generatedAt: number;
  /** 各工作区概况（含本区；undefined=会话表读取失败（省略整节） */
  workspaces?: SchedulerSituationWsRow[];
}

/** 会话名/工作区名同样折叠空白（防模型可控的名字在快照块里伪造换行结构）+ 截断 */
const NAME_CLIP = 40;
function clipName(t: string): string {
  const s = (t ?? '').trim().replace(/\s+/g, ' ');
  return s.length > NAME_CLIP ? `${s.slice(0, NAME_CLIP)}…` : s;
}

/**
 * 拼装 SITUATION.md 正文（紧凑 markdown）。纯函数：只消费采集器给的数据，
 * 不做任何 IO；条数与字段缺失的省略规则在此收口，便于单测。
 */
export function buildSchedulerSituationMarkdown(data: SchedulerSituationData): string {
  const lines: string[] = [
    '# Situation snapshot (host-generated, read-only)',
    `Generated at ${formatSchedulerStamp(new Date(data.generatedAt))} (point-in-time snapshot)`
  ];

  if (data.workspaces) {
    lines.push('', '## Workspaces');
    if (data.workspaces.length === 0) {
      lines.push('(no workspaces configured)');
    } else {
      for (const w of data.workspaces) {
        const segs: string[] = [];
        if (w.needsYouNames) {
          const names = w.needsYouNames.slice(0, NEEDS_YOU_NAME_LIMIT);
          const more = w.needsYouNames.length - names.length;
          segs.push(
            `needs you: ${w.needsYouNames.length}${names.length ? ` (${names.map(clipName).join(', ')}${more > 0 ? ' …' : ''})` : ''}`
          );
        }
        if (w.delegateQueued !== undefined) segs.push(`queued delegations ${w.delegateQueued}`);
        if (w.outboxUnread !== undefined) segs.push(`scheduler unread mail ${w.outboxUnread}`);
        if (w.eventQueueDepth !== undefined) segs.push(`pending events ${w.eventQueueDepth}`);
        lines.push(`- ${clipName(w.name)}: ${segs.length ? segs.join(' · ') : 'idle'}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}
