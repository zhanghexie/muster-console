/**
 * 溯源分类（memory-refactor §5）：origin 五类（user/scheduler/worker/untrusted/
 * system）的保守分类纯函数 + 写路径两道门（会话种类门 / 明示记住判定）。
 *
 * 分类立场（方案 §5）：
 * - 保守优先：定不了按 untrusted/system，**永不默认 user**；
 * - 回合内污点：本回合存在网络来源工具结果 → 其后 assistant 产生的候选内容按
 *   untrusted 分类（外部内容推导；下一条用户消息清污——清污由消息扫描方负责）；
 * - 会话种类门：heartbeat/auto/headless 会话不产生晋升候选（不进 staging，只允许
 *   任务产物路径），staging 写入侧按本模块 isPromotableSessionKind 拒收。
 *
 * 纯函数、零 IO/electron 依赖（test/*.mjs 即时转译导入）。
 */
import type { MemoryOrigin } from './db';
import type { MemorySessionKind } from './service';

// ---------------------------------------------------------------------------
// 明示记住判定（直写门 §6.1 的宿主侧规则）
// ---------------------------------------------------------------------------

/**
 * zh/en 明示记住关键词启发（B3 简报口径：记住/以后/remember/keep in mind 等）。
 * 设计取舍：
 * - 中文动词组（记住/牢记/谨记）带否定 lookbehind（「不要记住」= 明确不记，不算
 *   明示指令）；「记下」仍不进启发（「把日志记下来」是操作指令非记忆指令）；
 *   「记一下/记着」进启发（2026-09-22 用户真实措辞「记一下我喜欢…」被误拒——
 *   代价面：操作语境「把这个数记一下」可能误开，但直写仍需模型主动选 remember，
 *   且误写可经记忆中心面板删；误拒的体验成本已被实测证明更高）；
 * - 裸「以后」误伤面太大（「以后再说」= 以后再处理，非记忆指令），只认
 *   「以后 + 要/记得/记住/别/请/都/永远」的祈使形态；
 * - 拉丁词走 \b 词边界，避免 rememberMouse 之类的子串误命中；
 * - EN 否定/过去式/疑问防护（B3 评审 MINOR-1，照 zh lookbehind 先例）：
 *   "I don't / do not / can't … remember"（否定回顾）、"remembered"（过去式）、
 *   "do you remember"（疑问形）都不算明示记住——lookbehind 挡否定/疑问引导词，
 *   remember\b 挡屈折后缀（remembered/remembers）。
 */
const EXPLICIT_REMEMBER_RE_ZH =
  /(?<!不要|别|不用|无需)(?:请记住|请牢记|请谨记|记住|牢记|谨记|记一下|记着)|别忘了|不要忘记|以后(?:要|记得|记住|别|请|都|永远)/;
const EXPLICIT_REMEMBER_RE_EN =
  /\b(?<!\b(?:don'?t|doesn'?t|didn'?t|can'?t|cannot|won'?t|never)\s+)(?<!\b(?:do|does|did)\s+not\s+)(?<!\b(?:do|does|did)\s+(?:you|i|we|they|he|she|it)\s+)remember\b|\bkeep\s+(?:this\s+)?in\s+mind\b|don'?t\s+forget\b|\bmake\s+(?:a\s+)?(?:mental\s+)?note\b/i;

/**
 * 用户画像/偏好句式启发（remember 直写的画像路由，§10「画像素材=用户亲述」）：
 * 第一人称 + 偏好/习惯/风格动词 → 该条应进全局 USER.md 而非工作区策展核心。
 * 刻意窄：只认「我 + 喜欢/偏好/讨厌/习惯/倾向/总是/从不」与「我的 + 风格/习惯/
 * 偏好/口味」两组 zh 形态、EN 的 I like/prefer/hate/love/always/never 祈使形；
 * 非第一人称的任务事实（「记住这个接口的坑」）不路由。误路由方向可控：画像写满
 * 即拒（4000 上限）且面板可改。
 */
const PROFILE_DIRECTIVE_RE_ZH = /我(?:不?喜欢|不?偏爱|偏好|讨厌|倾向|习惯|总是|从不|通常|一般都)|我的(?:风格|习惯|偏好|口味|称呼)/;
const PROFILE_DIRECTIVE_RE_EN = /\bI\s+(?:really\s+)?(?:don'?t\s+)?(?:like|prefer|hate|love|always|never|usually|tend\s+to)\b/i;

/** remember 直写内容是否为用户画像/偏好（应路由 USER.md；纯函数，供工具层与测试） */
export function looksLikeUserProfileDirective(text: string | null | undefined): boolean {
  const s = (text ?? '').trim();
  if (!s) return false;
  return PROFILE_DIRECTIVE_RE_ZH.test(s) || PROFILE_DIRECTIVE_RE_EN.test(s);
}

/** 本回合用户消息是否含明示记住指令（直写门放行条件之一；缺证据=false） */
export function hasExplicitRememberInstruction(userTurnText: string | null | undefined): boolean {
  const s = (userTurnText ?? '').trim();
  if (!s) return false;
  return EXPLICIT_REMEMBER_RE_ZH.test(s) || EXPLICIT_REMEMBER_RE_EN.test(s);
}

// ---------------------------------------------------------------------------
// 会话种类门（§5：heartbeat/auto/headless 不产生晋升候选）
// ---------------------------------------------------------------------------

/** 非交互会话集合：其候选一律拒收进 staging（任务产物路径不走 staging） */
const NON_PROMOTABLE_KINDS: ReadonlySet<string> = new Set(['heartbeat', 'auto', 'headless']);

/** 该会话种类是否允许产生晋升候选（staging 写入门） */
export function isPromotableSessionKind(kind: string | null | undefined): boolean {
  if (!kind) return false; // 未知种类保守拒收（调用方应先以运行时会话上下文定种类）
  return !NON_PROMOTABLE_KINDS.has(kind);
}

// ---------------------------------------------------------------------------
// 网络来源工具（回合内污点标记面）
// ---------------------------------------------------------------------------

/**
 * 声明外部来源的工具名模式（§5「web fetch/终端输出」）：命中即给当前回合打污点，
 * 其后 assistant 内容按 untrusted 分类。
 *
 * 覆盖面（B3 落位，已知边界见 progress.md 偏差记录）：
 * - web.fetch：抓取的外部网页正文；
 * - browser.*：内置浏览器面（页面内容皆外部）；
 * - apps.run：持久应用可能含外部来信/订阅/消息，facade 名保守整体标记；
 * - desktop.list / desktop.look：窗口标题、应用标签和截图来自外部应用；
 * - terminal.capture / terminal.getStatus：终端输出（命令产物可能来自网络，方案 §5
 *   原文把「终端输出」列为外部来源，保守全污点）；terminal.open/focus/write/resize
 *   是控制面不是内容面，不打污点；
 * - mcp.call/search 中转及 mcp__ 前缀（外部 MCP 内容和工具描述不可控）。
 * 未覆盖：pi 引擎原生工具（web_search 等若接入，需在此登记）、扩展 ext.*（B8 收口）。
 */
const NETWORK_SOURCE_TOOL_PATTERNS: ReadonlyArray<{ prefix: string; exact?: string[] }> = [
  { prefix: 'web.', exact: ['web.fetch'] },
  { prefix: 'browser.' },
  { prefix: 'github.' },
  { prefix: 'desktop.', exact: ['desktop.list', 'desktop.look'] },
  // App queries may return persisted mail/RSS/chat content; the transcript stores
  // only the facade name, so classify conservatively like the browser domain.
  { prefix: 'apps.', exact: ['apps.run'] },
  { prefix: 'mcp.', exact: ['mcp.call', 'mcp.search'] },
  { prefix: 'mcp__' },
  { prefix: 'terminal.', exact: ['terminal.capture', 'terminal.getStatus'] }
];

/** 工具名是否声明外部（网络）来源——executor 在工具成功返回后据此打回合污点。
 *  两侧口径：原名（`mcp__` 前缀，外部 MCP 服务器工具）与下划线归一名（shell API
 *  侧 `browser_tabs` 这类点名转点号后的形态）。 */
export function isNetworkSourceTool(dotName: string | null | undefined): boolean {
  const name = (dotName ?? '').trim();
  if (!name) return false;
  if (name.startsWith('mcp__')) return true;
  // Persisted transcripts now carry host.* names; older histories and the
  // internal executor still use the original IDs. Both must remain tainted.
  const publicName = name.replace(/_/g, '.');
  const normalized = publicName.startsWith('host.') ? publicName.slice(5) : publicName;
  for (const p of NETWORK_SOURCE_TOOL_PATTERNS) {
    if (p.prefix === 'mcp__') continue; // 已按原名判定
    if (!normalized.startsWith(p.prefix)) continue;
    if (!p.exact) return true; // 前缀组整组污点（browser.*）
    if (p.exact.includes(normalized)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// origin 分类
// ---------------------------------------------------------------------------

/** 写入面：谁在写（工具链身份，宿主层判定后传入） */
export type MemoryWriterSurface = 'scheduler' | 'worker' | 'chat' | 'system';

export interface ClassifyOriginInput {
  /** 会话种类（运行时会话上下文判定，勿事后猜测） */
  sessionKind: MemorySessionKind;
  /** 本回合用户消息是否含明示记住指令（hasExplicitRememberInstruction 判定后传入） */
  latestUserTurnHasExplicitRemember: boolean;
  /** 本回合（或候选消息之前）是否存在网络来源工具结果（回合内污点） */
  toolResultsTainted: boolean;
  /** 写入面身份 */
  writerSurface: MemoryWriterSurface;
}

export interface ClassifyOriginResult {
  origin: MemoryOrigin;
  /** 判定依据（人可读，入 signals/日志；不是稳定 API） */
  reason: string;
}

/**
 * origin 五类保守分类（§5）。判定顺序（先命中先出）：
 * 1. 回合内污点 → untrusted（外部内容推导优先定性，即使同回合有明示记住——
 *    明示记住的直写走 memory.remember 门，其内容来源仍可能被污点污染，保守不定 user）；
 * 2. 明示记住 && 无污点 → user（用户明示指令的记写）；
 * 3. 非交互会话（heartbeat/auto/headless）→ system（且写入门会拒收进 staging）；
 * 4. 写入面/会话种类 → scheduler / worker；
 * 5. 其余定不了 → system（保守，永不默认 user）。
 */
export function classifyOrigin(input: ClassifyOriginInput): ClassifyOriginResult {
  const { sessionKind, latestUserTurnHasExplicitRemember, toolResultsTainted, writerSurface } = input;
  if (toolResultsTainted) {
    return { origin: 'untrusted', reason: '回合内存在网络来源工具结果，其后内容按外部推导定性（§5 回合内污点）' };
  }
  if (latestUserTurnHasExplicitRemember) {
    return { origin: 'user', reason: '本回合用户消息含明示记住指令（§6.1）' };
  }
  if (sessionKind === 'heartbeat' || sessionKind === 'auto' || sessionKind === 'headless') {
    return { origin: 'system', reason: `非交互会话（${sessionKind}）不产生晋升候选（§5 会话种类门）` };
  }
  if (writerSurface === 'scheduler' || sessionKind === 'scheduler') {
    return { origin: 'scheduler', reason: '调度会话推导' };
  }
  if (writerSurface === 'worker' || sessionKind === 'worker') {
    return { origin: 'worker', reason: 'Worker 会话推导' };
  }
  if (sessionKind === 'chat') {
    // chat 面兜底：无 agent 写入面证据（宿主注入/系统代理写）→ system（保守）。
    // 不按 writerSurface='chat' 映射 scheduler——该映射无调用方且属静默升级（B3 评审 MINOR-2 删）
    return { origin: 'system', reason: 'chat 面无写入面证据，保守按 system' };
  }
  return { origin: 'system', reason: '无法确定来源，保守按 system（§5：永不默认 user）' };
}
