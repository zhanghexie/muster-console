/**
 * Pi 模式钩子扩展：把自定义模式的「每轮注入 / 上下文瘦身」配置接到引擎事件上。
 * - turnInject → before_agent_start：渲染模板（{{now}}/{{date}}/{{time}}/{{cwd}}）后
 *   追加到本轮链式系统提示。默认每轮重渲染（时间类占位符保持新鲜）；
 *   turnInjectStable=true 时用 stable snapshot——同一天内逐字节复用同一份渲染结果
 *   （翻日才重渲染），保 provider 的 prompt/KV 前缀缓存命中（借鉴 pi-memory）；
 * - memoryInject → before_agent_start：工作区记忆（MEMORY.md + 今日 journal 尾部）
 *   逐轮注入，按天+记忆版本号 stable 快照——记忆写入（mtime/size 变化）或翻日才
 *   重渲染，注入附快照时间 caveat（借鉴 pi-memory 的检查点刷新模型）；
 * - contextTrim → context：toolResult 消息的文本块超过 maxToolResultChars 即截断，
 *   全文按内容哈希落盘（trimDir，同内容只写一次），截断标记带落盘路径，
 *   模型可用 read 工具按路径取回——截断不丢数据（借鉴 pi-web-access 的「句柄化」）。
 * 输入变换（inputTransforms）不经引擎：在 driver.send 发送前由 applyInputTransforms 应用，
 * 保证 SDK prompt 路径确定性生效。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// 逐轮记忆快照的说明独立于首条 Worker 输入。
const MEMORY_WRITE_TEACHING_LINE =
  'Muster 记忆用法见 ~/.muster/skills/memory/SKILL.md。涉及旧约定或纠正时用宿主工具检索，只为值得回看的决策、发现或交接信息写日志。';

export interface PiModeHooks {
  turnInject?: string;
  turnInjectStable?: boolean;
  inputTransforms?: Array<{ pattern: string; replacement: string }>;
  contextTrim?: { maxToolResultChars?: number };
  /** 工作区记忆逐轮注入：root=主工作区根（隔离 worktree 时与 cwd 不同） */
  memoryInject?: { root: string };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const dayKeyOf = (now: Date): string =>
  `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
const timeKeyOf = (now: Date): string => `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

/** 渲染回合注入模板；未知占位符原样保留 */
export function renderTurnInject(
  template: string,
  vars: { now?: Date; cwd?: string }
): string {
  const now = vars.now ?? new Date();
  const date = dayKeyOf(now);
  return template
    .replace(/\{\{now\}\}/g, `${date} ${timeKeyOf(now)}`)
    .replace(/\{\{date\}\}/g, date)
    .replace(/\{\{time\}\}/g, timeKeyOf(now))
    .replace(/\{\{cwd\}\}/g, () => (vars.cwd === undefined ? '{{cwd}}' : vars.cwd));
}

/** 记忆注入快照：同天且记忆文件未变 → 逐字节复用（prompt cache 友好） */
export interface MemoryInjectCache {
  dayKey: string;
  version: string;
  text: string;
}

/** 记忆节渲染（纯 IO 组装；快照判定在工厂里按 cache 键跳过） */
function renderMemoryInject(memory: string, now: Date): string {
  if (!memory.trim()) return '';
  const takenAt = `${dayKeyOf(now)} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  return [
    '## 工作区记忆（逐轮快照）',
    memory,
    `(快照于 ${takenAt}；可能与最新状态有出入——最新知识通过 memory.search 查询并核对适用条件。${MEMORY_WRITE_TEACHING_LINE})`
  ].join('\n');
}

/** 记忆 IO 注入口：driver 侧用 memoryStore 实现；本文件保持零依赖（单文件转译测试） */
export interface MemoryInjectSource {
  read: (now: Date) => string;
  version: (now: Date) => string;
}

/** stable 记忆快照：翻日或记忆文件（版本 token）变化才重渲染，否则逐字节复用 */
function stableMemoryInject(
  cache: MemoryInjectCache | undefined,
  source: MemoryInjectSource,
  now: Date
): MemoryInjectCache {
  const dayKey = dayKeyOf(now);
  let version = 'err';
  try {
    version = source.version(now);
  } catch {
    /* 读不到按 err 处理，下一轮重试 */
  }
  if (cache && cache.dayKey === dayKey && cache.version === version) return cache;
  let text = '';
  try {
    text = renderMemoryInject(source.read(now), now);
  } catch {
    text = '';
  }
  return { dayKey, version, text };
}

export interface StableInjectCache {
  dayKey: string;
  text: string;
}

/**
 * stable snapshot 注入：同一天命中缓存逐字节复用（prompt cache 友好），翻日重渲染。
 * 纯函数便于测试；工厂持有缓存跨回合调用。
 */
export function stableTurnInject(
  cache: StableInjectCache | undefined,
  template: string,
  vars: { now?: Date; cwd?: string }
): StableInjectCache {
  const now = vars.now ?? new Date();
  const dayKey = dayKeyOf(now);
  if (cache && cache.dayKey === dayKey) return cache;
  return { dayKey, text: renderTurnInject(template, { ...vars, now }) };
}

/**
 * 输入变换的规模门槛（pi-modes F-02）：超过该字符数的输入跳过全部 transforms 并回调
 * onSkip 记警告。inputTransforms 是主进程发送路径上的同步 `new RegExp` 替换，落盘校验
 * 只查可编译、不防灾难性回溯——贪婪回溯 pattern（如手改模式文件的 `(a+)+$`）匹配超长
 * 文本可长时间阻塞发送路径。纯同步长度门：不引入线程/worker/超时机制，超限输入按
 * 原文发送（变换缺席只是少一次可选改写，远轻于主进程卡死）。
 */
export const INPUT_TRANSFORM_MAX_CHARS = 64 * 1024;

/** 输入变换：按序应用正则替换（Host 侧 send 前调用）；超规模门槛跳过并经 onSkip 告警 */
export function applyInputTransforms(
  text: string,
  rules: Array<{ pattern: string; replacement: string }> | undefined,
  onSkip?: (reason: string) => void
): string {
  if (!rules?.length) return text;
  if (text.length > INPUT_TRANSFORM_MAX_CHARS) {
    onSkip?.(
      `输入 ${text.length} 字符超过输入变换规模上限 ${INPUT_TRANSFORM_MAX_CHARS}，本回合跳过 transforms（防同步正则回溯阻塞）`
    );
    return text;
  }
  let out = text;
  for (const rule of rules) {
    try {
      out = out.replace(new RegExp(rule.pattern, 'g'), rule.replacement);
    } catch {
      /* 落盘前已校验可编译；手改文件写坏时跳过该条 */
    }
  }
  return out;
}

const TRUNCATE_MARKER = '\n[已截断，工具结果超长';

/**
 * 截断落盘器：全文按 sha1 命名写入 trimDir（tmp+rename 原子写），同内容只写一次。
 * 返回「全文路径」或 ''（写失败时静默降级为纯截断——瘦身不能因为落盘失败而失败）。
 */
export function makeTrimPersister(trimDir: string): (fullText: string) => string {
  return (fullText: string): string => {
    try {
      const key = createHash('sha1').update(fullText, 'utf8').digest('hex').slice(0, 20);
      const file = path.join(trimDir, `${key}.txt`);
      if (fs.existsSync(file)) return file;
      fs.mkdirSync(trimDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, fullText, 'utf8');
      fs.renameSync(tmp, file);
      return file;
    } catch {
      return '';
    }
  };
}

/** 上下文瘦身：截断 toolResult 消息里的超长文本块（原地修改传入的深拷贝）。
 *  persist 提供时全文落盘并在截断标记里带回路径（模型可用 read 取回）。 */
export function trimToolResults(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[],
  maxToolResultChars: number,
  persist?: (fullText: string) => string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] {
  for (const msg of messages) {
    if (msg?.role !== 'toolResult' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > maxToolResultChars) {
        const orig = block.text.length;
        const stored = persist?.(block.text) ?? '';
        const where = stored ? `，全文已存盘：${stored}（可用 read 工具读取完整内容）` : '';
        block.text = block.text.slice(0, maxToolResultChars) + `${TRUNCATE_MARKER}，原 ${orig} 字符${where}]`;
      }
    }
  }
  return messages;
}

/** 构造钩子扩展工厂（before_agent_start + context）；三项都没配时不装。
 *  vars.trimDir 提供时截断全文落盘该目录（按会话隔离）。
 *  vars.onInjectChange：逐轮注入文本变化时报给 driver（Harness 透明·逐轮注入追踪）——
 *  stable 快照（记忆/回合注入 stable）变化即报；非 stable 回合注入只报首轮基线
 *  （时间类占位符逐轮重渲染，逐轮上报会是每回合一条噪音）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createPiModeHooksExtension(
  hooks: PiModeHooks | undefined,
  vars: {
    cwd?: string;
    trimDir?: string;
    memory?: MemoryInjectSource;
    onInjectChange?: (source: string, text: string) => void;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any | null {
  const hasInject = !!hooks?.turnInject?.trim();
  const hasMemory = !!vars.memory;
  const maxChars = hooks?.contextTrim?.maxToolResultChars;
  if (!hasInject && !hasMemory && !maxChars) return null;
  const persist = maxChars && vars.trimDir ? makeTrimPersister(vars.trimDir) : undefined;
  const onInjectChange = vars.onInjectChange;
  const report = (source: string, text: string): void => {
    if (!onInjectChange || !text) return;
    try {
      onInjectChange(source, text);
    } catch {
      /* 透明旁路：上报故障不影响注入 */
    }
  };
  return (pi: {
    on: (event: string, handler: (event: any) => unknown) => void;
  }) => {
    if (hasInject) {
      const template = hooks!.turnInject!;
      if (hooks!.turnInjectStable) {
        let cache: StableInjectCache | undefined;
        let lastReported: string | null = null;
        pi.on('before_agent_start', (event: { systemPrompt?: string; messageType?: 'user' | 'custom' }) => {
          // pi>=1.2：idle 的 sendCustomMessage({triggerTurn:true}) 触发的 run（memory 回执/安全审查）
          // 也走本钩子；此类结构化 run 不注入回合模板，维持旧版注入面
          if (event.messageType === 'custom') return undefined;
          cache = stableTurnInject(cache, template, { now: new Date(), cwd: vars.cwd });
          if (cache.text !== lastReported) {
            lastReported = cache.text;
            report('回合注入', cache.text);
          }
          return { systemPrompt: `${event.systemPrompt ?? ''}\n\n${cache.text}` };
        });
      } else {
        // 非 stable：逐轮重渲染（时间占位符保新鲜），只报首轮基线，变化不追踪
        let reportedBaseline = false;
        pi.on('before_agent_start', (event: { systemPrompt?: string; messageType?: 'user' | 'custom' }) => {
          if (event.messageType === 'custom') return undefined;
          const text = renderTurnInject(template, { now: new Date(), cwd: vars.cwd });
          if (!reportedBaseline) {
            reportedBaseline = true;
            report('回合注入', text);
          }
          return { systemPrompt: `${event.systemPrompt ?? ''}\n\n${text}` };
        });
      }
    }
    if (hasMemory) {
      // 逐轮注入记忆：按天+记忆版本号 stable 快照（写入/翻日才刷新），空记忆静默缺席
      const source = vars.memory!;
      let memCache: MemoryInjectCache | undefined;
      let lastReported: string | null = null;
      pi.on('before_agent_start', (event: { systemPrompt?: string; messageType?: 'user' | 'custom' }) => {
        if (event.messageType === 'custom') return undefined;
        memCache = stableMemoryInject(memCache, source, new Date());
        if (!memCache.text) return undefined;
        if (memCache.text !== lastReported) {
          lastReported = memCache.text;
          report('记忆段', memCache.text);
        }
        return { systemPrompt: `${event.systemPrompt ?? ''}\n\n${memCache.text}` };
      });
    }
    if (maxChars) {
      pi.on('context', (event: { messages: unknown[] }) => ({
        messages: trimToolResults(event.messages as unknown[], maxChars, persist)
      }));
    }
  };
}
