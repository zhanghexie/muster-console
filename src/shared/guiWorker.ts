/**
 * GUI（chat surface）Worker 会话的共享类型：消息视图、事件、IPC 载荷。
 * 主进程是唯一 writer（审批、消息状态都由 Host 落定）；渲染层只读 + 应答。
 * 依赖仅共享纯函数与类型（test/*.mjs 即时转译导入）。
 */
import type {GuiInjectionView,GuiInjectionSummary,GuiHistoryMetadataStatus,GuiHistoryMetadataCounts} from './guiHistoryMetadata';
import type { GuiWorkerMode, PlanCard, ChatImageAttachment } from './types';
import type { ChatTranscriptSource } from './chatMessageSource';
import { coerceSourceAgentIdentity, type SourceAgentIdentity } from './subagentCharacters';
import type { CheckpointReason, CheckpointState, TurnCheckpoint } from './turnCheckpoint';

/** 工具调用卡（结构化事件渲染；status 由主进程落定） */
export interface GuiToolCallView {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** cancelled：引擎/服务端未回报结果，由回合收口或恢复消毒兜底落定（不是执行失败） */
  status: 'running' | 'ok' | 'error' | 'cancelled';
  output?: string;
  /** 编辑类工具的 unified patch（Pi edit 结果自带；渲染层按 git-diff 展示） */
  patch?: string;
  /** 工具执行时长（driver 起止打点；旧会话/无打点引擎缺省） */
  durationMs?: number;
}

/** ── Harness 透明（pi-trajectory-plan extension §4.2）：计量/插话/注入快照的转写合同 ── */

/** 单次模型调用的 token 用量（Pi 的 pi-ai Usage 归一） */
export interface GuiHarnessUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** 本次调用 USD 成本（pi-ai 目录定价实算；无价模型缺省不落，不把未知价报成免费） */
  costUsd?: number;
}

/** 一次模型调用（SDK turn_start…turn_end）的计量明细（「harness 详情」抽屉数据源） */
export interface GuiHarnessCall {
  stopReason?: string;
  usage?: GuiHarnessUsage;
  /** 首 token 停留（text/thinking/toolcall 流首现打点；纯工具调用响应靠 toolcall 补盲） */
  ttftMs?: number;
  durationMs?: number;
  /** 重试次数（该次调用的 onResponse 响应数 - 1；0 次重试缺省不落） */
  retry?: number;
  model?: string;
}

/** 回合级 harness 摘要：driver 随 turn-complete 发出，Host 盖到 assistant 消息上 */
export interface GuiHarnessSummary {
  usage?: GuiHarnessUsage;
  model?: string;
  durationMs?: number;
  calls?: GuiHarnessCall[];
}

/** 注入快照的分段（材料化产物的一段；B1' 全文落盘，注入段合计 <10KB） */
export interface GuiInjectionSegment {
  /** 来源名（政策层（材料化）/ 记忆段 / 模式段） */
  source: string;
  chars: number;
  /** 内容指纹（FNV-1a；代际去重用，非安全用途） */
  hash: string;
  text: string;
}

/** 连接期捕获的引擎工具目录条目（getAllTools 归一；raw schema 不落盘，只留参数摘要） */
export interface GuiToolCatalogItem {
  name: string;
  label?: string;
  source?: string;
  description?: string;
  /** 参数摘要（「名: 类型」，required 带 *） */
  params?: string[];
}

/** 引擎系统提示词真身（session.systemPrompt；连接期捕获，等值判代用 hash） */
export interface GuiEnginePromptCapture {
  chars: number;
  hash: string;
  text: string;
}

/** 引擎真身捕获（连接期一次性；pi driver 提供，其他引擎缺省） */
export interface GuiEngineCapture {
  enginePrompt?: GuiEnginePromptCapture;
  tools?: GuiToolCatalogItem[];
}

/** 连接级注入快照（messages json 信封；重连换代追加，内容不变不重复记） */
export interface GuiInjectionSnapshot {
  at: number;
  segments: GuiInjectionSegment[];
  /** 引擎系统提示词真身（pi 连接期捕获；旧快照/其他引擎缺省） */
  enginePrompt?: GuiEnginePromptCapture;
  /** 引擎工具目录（pi 连接期捕获；旧快照/其他引擎缺省） */
  tools?: GuiToolCatalogItem[];
}

/** FNV-1a 32bit 内容指纹（注入分段 hash；只做等值比较） */
export function hashInjectionText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 由材料化分段构造注入快照（空段丢弃；全空且无引擎真身时返回 null） */
export function buildInjectionSnapshot(
  at: number,
  sources: ReadonlyArray<{ source: string; text: string }>,
  capture?: GuiEngineCapture
): GuiInjectionSnapshot | null {
  const segments = sources
    .filter((s) => typeof s.source === 'string' && typeof s.text === 'string' && s.text.length > 0)
    .map((s) => ({
      source: s.source,
      chars: s.text.length,
      hash: hashInjectionText(s.text),
      text: s.text
    }));
  if (!segments.length && !capture?.enginePrompt && !capture?.tools?.length) return null;
  return {
    at,
    segments,
    ...(capture?.enginePrompt ? { enginePrompt: capture.enginePrompt } : {}),
    ...(capture?.tools?.length ? { tools: capture.tools } : {})
  };
}

/** TypeBox object schema → 参数摘要（「名: 类型」，required 带 *）；无属性/异常回 undefined */
export function summarizeToolParams(schema: unknown): string[] | undefined {
  try {
    const s = schema as
      | { properties?: Record<string, { type?: string }>; required?: unknown }
      | null
      | undefined;
    if (!s || typeof s !== 'object' || !s.properties) return undefined;
    const required = new Set(Array.isArray(s.required) ? (s.required as unknown[]) : []);
    const out = Object.entries(s.properties).map(([k, v]) => {
      const type = typeof v?.type === 'string' ? v.type : '';
      return `${k}${type ? `: ${type}` : ''}${required.has(k) ? '*' : ''}`;
    });
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

/** 工具目录内容指纹（名字+描述+参数摘要；等值判代用，非安全用途） */
export function toolCatalogFingerprint(items: readonly GuiToolCatalogItem[] | undefined): string {
  if (!items?.length) return '';
  return hashInjectionText(
    items
      .map((t) => `${t.name}\u0000${t.description ?? ''}\u0000${(t.params ?? []).join('\u0001')}`)
      .join('\u0002')
  );
}

/** 两张快照是否同代（分段源/长度/指纹逐一相等 + 引擎真身一致——text 不参与比较） */
export function injectionSnapshotsEqual(
  a: GuiInjectionSnapshot | null,
  b: GuiInjectionSnapshot | null
): boolean {
  if (!a || !b) return !a && !b;
  if (a.segments.length !== b.segments.length) return false;
  for (let i = 0; i < a.segments.length; i++) {
    const x = a.segments[i]!;
    const y = b.segments[i]!;
    if (x.source !== y.source || x.chars !== y.chars || x.hash !== y.hash) return false;
  }
  if ((a.enginePrompt?.hash ?? '') !== (b.enginePrompt?.hash ?? '')) return false;
  if (toolCatalogFingerprint(a.tools) !== toolCatalogFingerprint(b.tools)) return false;
  return true;
}

/** 宽松解析信封 injections（旧会话/手改文件容错）：坏条目丢弃，非数组回空 */
export function parseInjectionSnapshots(raw: unknown): GuiInjectionSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const out: GuiInjectionSnapshot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const at = (item as { at?: unknown }).at;
    const segsRaw = (item as { segments?: unknown }).segments;
    if (typeof at !== 'number' || !Number.isFinite(at) || !Array.isArray(segsRaw)) continue;
    const segments: GuiInjectionSegment[] = [];
    for (const s of segsRaw) {
      if (!s || typeof s !== 'object') continue;
      const source = (s as { source?: unknown }).source;
      const text = (s as { text?: unknown }).text;
      if (typeof source !== 'string' || typeof text !== 'string' || !text) continue;
      const chars = (s as { chars?: unknown }).chars;
      const hash = (s as { hash?: unknown }).hash;
      segments.push({
        source,
        chars: typeof chars === 'number' ? chars : text.length,
        hash: typeof hash === 'string' ? hash : hashInjectionText(text),
        text
      });
    }
    // 引擎真身（optional）：坏形状丢弃该段，不整条丢弃快照
    const snap: GuiInjectionSnapshot = { at, segments };
    const epRaw = (item as { enginePrompt?: unknown }).enginePrompt;
    if (epRaw && typeof epRaw === 'object') {
      const text = (epRaw as { text?: unknown }).text;
      if (typeof text === 'string' && text) {
        const hash = (epRaw as { hash?: unknown }).hash;
        const chars = (epRaw as { chars?: unknown }).chars;
        snap.enginePrompt = {
          chars: typeof chars === 'number' ? chars : text.length,
          hash: typeof hash === 'string' ? hash : hashInjectionText(text),
          text
        };
      }
    }
    const toolsRaw = (item as { tools?: unknown }).tools;
    if (Array.isArray(toolsRaw)) {
      const tools: GuiToolCatalogItem[] = [];
      for (const t of toolsRaw) {
        if (!t || typeof t !== 'object') continue;
        const name = (t as { name?: unknown }).name;
        if (typeof name !== 'string' || !name) continue;
        const str = (k: string): string | undefined => {
          const v = (t as Record<string, unknown>)[k];
          return typeof v === 'string' && v ? v : undefined;
        };
        const params = (t as { params?: unknown }).params;
        tools.push({
          name,
          ...(str('label') ? { label: str('label') } : {}),
          ...(str('source') ? { source: str('source') } : {}),
          ...(str('description') ? { description: str('description') } : {}),
          ...(Array.isArray(params)
            ? { params: params.filter((p): p is string => typeof p === 'string' && !!p) }
            : {})
        });
      }
      if (tools.length) snap.tools = tools;
    }
    if (segments.length || snap.enginePrompt || snap.tools) out.push(snap);
  }
  return out;
}

/**
 * 审批卡（挂在所属 assistant 消息上；一次一张）。
 * anchorPartIndex：请求到达时的 parts 长度——渲染层把卡插在该下标前（提问/审批
 * 发生在两个工具之间时按真实顺序显示，而不是永远沉在消息底部）；旧数据缺省=消息末尾。
 */
export interface GuiApprovalView {
  approvalId: string;
  nativeChoices?: import('./nativeSessionConfig').NativeApprovalChoice[];
  nativeSource?: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  reason?: string;
  anchorPartIndex?: number;
}

/** 用户提问卡的单一问题（dsh user-questions 词表：选项/多选/自定义/意图） */
export interface GuiUserQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  /** 展示意图（如 plan-review：approve 命名的选项是「批准」动作） */
  intent?: { kind: string; approve?: string };
}

/** 用户提问卡（挂在所属 assistant 消息上；一次一张）——ask_user_question / 计划审阅 */
export interface GuiUserQuestionView {
  questionId: string;
  questions: GuiUserQuestionItem[];
  /** answered 后保留答案回显；aborted = 用户取消作答 */
  status: 'pending' | 'answered' | 'aborted';
  answers?: Array<{ id: string; selected: string[]; custom?: string }>;
  /** 同 GuiApprovalView.anchorPartIndex：卡按提问发生的位置插入 parts 流 */
  anchorPartIndex?: number;
}

/**
 * 消息内容片段：按到达顺序交错（思考 → 工具 → 文本 → 思考 → …）。
 * v2 模型：v1 的 text/thinking/tools 三个扁平字段在加载时迁移成 parts。
 */
export type GuiMessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; tool: GuiToolCallView };

export interface GuiChatMessage {
  turnChanges?: import('./turnChanges').TurnChanges;
  /** Host-owned display annotations; never forwarded as model input. */
  displayItems?: import('./displayItems').DisplayItem[];
  id: string;
  role: 'user' | 'assistant';
  /** 按时间顺序的内容片段；user 消息恒为单个 text part */
  parts: GuiMessagePart[];
  /**
   * 转写身份：scheduler = 历史调度来源消息（引擎仍按 user 投递）。
   * 省略 = 用户真输入。勿与宿主通栏 host 混用。
   */
  source?: ChatTranscriptSource;
  sourceAgent?: SourceAgentIdentity;
  /** Trusted host notification, never accepted from the renderer's send options. */
  host?: boolean;
  /** 用户消息附带的图片（多模态引擎使用；展示层回放） */
  images?: ChatImageAttachment[];
  /** Display-only reference to the text submitted to this session's Harness. */
  engineInputRef?: string;
  approval?: GuiApprovalView;
  userQuestion?: GuiUserQuestionView;
  /** plan 模式提取的计划卡（挂在提取到计划的 assistant 消息上；执行进度原地更新） */
  plan?: PlanCard;
  error?: string;
  aborted?: boolean;
  /** Host settlement time, after execution resources are released. Missing in legacy/interrupted history. */
  finishedAt?: number;
  /** Host automatic recovery attempts for this turn, retained after successful settlement. */
  retryAttempts?: number;
  /** 网络中断自动续作提示（内存态；恢复时剥离） */
  retryHint?: string;
  /** busy 期间发送的排队消息（渲染层立即展示） */
  queued?: boolean;
  /**
   * Harness 透明·插话标记（pi-trajectory-plan extension）：busy 期间经 steer 注入当前回合的文本。
   * 'send' = 用户「立即发送」插话——透明开关关闭时渲染为普通用户气泡（现状零变化）；
   * 'host' = 后台任务唤醒等宿主静默插话——开关关闭时不渲染（现状不可见）。
   * 开启态两者统一渲染为 §6.2 插话线。
   */
  steering?: 'send' | 'host';
  /** Engine consumed this stable native message ID; repeated callbacks must not split again. */
  nativeMessageStarted?: true;
  /** Harness 透明·回合计量（turn-complete 携带的 summary 盖章；旧会话无此字段） */
  harness?: GuiHarnessSummary;
  /**
   * 轮内增量 checkpoint 元信息（D4）：撤销粒度到工具边界，不是只在轮末。
   * checkpoints[] 是轮内落账序列；行级 checkpointState/Reason 是最近一次摘要。
   * rewind 入口收敛到编辑历史（不独立 /rewind）。
   */
  checkpoints?: TurnCheckpoint[];
  checkpointState?: CheckpointState;
  checkpointReason?: CheckpointReason;
  /**
   * assistant 回复携带 ≤3 条建议：空输入框内灰字预览，切换胶囊后按 Tab 接受，
   * 不自动发送。交互 GUI Worker 由 ui.suggestReplies 写入当前回合并持久化；
   * 调度提问卡选项不会写入建议。
   */
  suggestedReplies?: string[];
  ts: number;
}

/** 建议回复数量上限。 */
export const MAX_SUGGESTED_REPLIES = 3;

/**
 * 规整模型路建议回复：去空白项、去重、截上限；非法输入返回空。
 * 消息映射（toDisplayMessage）与测试共用，保证「上限 3」在链路上只算一次。
 */
export function sanitizeSuggestedReplies(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const text = v.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= MAX_SUGGESTED_REPLIES) break;
  }
  return out;
}

/** 构造一条进转写的用户消息（Host.send / 注入管线共用，保证 source 不丢） */
export function createGuiUserMessage(input: {
  id: string;
  text: string;
  ts: number;
  images?: ChatImageAttachment[];
  queued?: boolean;
  source?: ChatTranscriptSource;
  sourceAgent?: SourceAgentIdentity;
  host?: boolean;
}): GuiChatMessage {
  const sourceAgent = input.source === 'agent' ? coerceSourceAgentIdentity(input.sourceAgent) : undefined;
  return {
    id: input.id,
    role: 'user',
    parts: [{ kind: 'text', text: input.text }],
    ts: input.ts,
    ...(input.images?.length ? { images: input.images } : {}),
    ...(input.queued ? { queued: true } : {}),
    ...(input.source === 'scheduler' || input.source === 'agent' ? { source: input.source } : {}),
    ...(sourceAgent ? { sourceAgent } : {}),
    ...(input.host ? { host: true } : {})
  };
}

/** 消息纯文本（全部 text part 拼接；计划提取 / 重发 / 复制都用它） */
export function guiMessageText(m: GuiChatMessage): string {
  return m.parts
    .filter((p): p is Extract<GuiMessagePart, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('');
}

const EXTENSION_DOMAIN_NUDGE_PREFIX = '扩展领域状态已变化。来源：';

/** Identifies pre-v4 host nudges that were persisted before they became hidden. */
export function isExtensionDomainNudge(m: GuiChatMessage): boolean {
  return m.role === 'user' && guiMessageText(m).startsWith(EXTENSION_DOMAIN_NUDGE_PREFIX);
}

/**
 * 纯 JSON 数据的无分配深度相等：首差异早退，逐 key 比较，不产出临时串。
 * 工具入参来自 IPC 结构化克隆，是纯 JSON 数据（无循环引用、无 undefined 语义键——
 * 严格说 structured clone 保留 undefined 值键，stringify 会丢，深比较按变化处理）。
 * key 顺序不敏感：stringify 比较的顺序敏感对「渲染等价」是误报源（同内容不同序
 * 会被误判不等，引发无谓重映射）。
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], bb[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  if (aKeys.length !== Object.keys(bo).length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!jsonEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * 两条消息是否渲染等价（结构深比较；字符串走 === 内容比较）。
 * IPC sync 每次都结构化克隆出全新对象，渲染层映射缓存靠它识别「内容其实没变」，
 * 避免每个工具事件都重跑全列表映射（含 linkify 正则全文扫描）。
 */
export function guiChatMessageEqual(a: GuiChatMessage, b: GuiChatMessage): boolean {
  if (a === b) return true;
  if (a.id !== b.id || a.role !== b.role || a.ts !== b.ts) return false;
  if (a.source !== b.source || a.host !== b.host) return false;
  if (a.sourceAgent?.sessionId !== b.sourceAgent?.sessionId || a.sourceAgent?.name !== b.sourceAgent?.name
    || a.sourceAgent?.characterId !== b.sourceAgent?.characterId) return false;
  if (a.error !== b.error || a.aborted !== b.aborted || a.queued !== b.queued || a.finishedAt !== b.finishedAt || a.retryAttempts !== b.retryAttempts) return false;
  if (a.retryHint !== b.retryHint) return false;
  if (a.steering !== b.steering || a.engineInputRef !== b.engineInputRef) return false;
  if (JSON.stringify(a.suggestedReplies) !== JSON.stringify(b.suggestedReplies)) return false;
  if (JSON.stringify(a.displayItems) !== JSON.stringify(b.displayItems)) return false;
  if (JSON.stringify(a.harness) !== JSON.stringify(b.harness)) return false;
  if (JSON.stringify(a.turnChanges) !== JSON.stringify(b.turnChanges)) return false;
  const aImg = a.images ?? [];
  const bImg = b.images ?? [];
  if (aImg.length !== bImg.length) return false;
  for (let i = 0; i < aImg.length; i++) {
    if (aImg[i]!.id !== bImg[i]!.id) return false;
  }
  if (JSON.stringify(a.plan) !== JSON.stringify(b.plan)) return false;
  if (JSON.stringify(a.approval) !== JSON.stringify(b.approval)) return false;
  if (JSON.stringify(a.userQuestion) !== JSON.stringify(b.userQuestion)) return false;
  if (a.parts.length !== b.parts.length) return false;
  for (let i = 0; i < a.parts.length; i++) {
    const pa = a.parts[i]!;
    const pb = b.parts[i]!;
    if (pa.kind !== pb.kind) return false;
    if (pa.kind === 'tool' || pb.kind === 'tool') {
      if (pa.kind !== 'tool' || pb.kind !== 'tool') return false;
      if (
        pa.tool.id !== pb.tool.id ||
        pa.tool.name !== pb.tool.name ||
        pa.tool.status !== pb.tool.status ||
        pa.tool.output !== pb.tool.output ||
        pa.tool.patch !== pb.tool.patch ||
        pa.tool.durationMs !== pb.tool.durationMs
      ) {
        return false;
      }
      // B1-2：无分配深度相等（首差异早退）替掉 MB 级临时串的 stringify 比较
      if (!jsonEqual(pa.tool.input, pb.tool.input)) return false;
    } else if (pa.text !== pb.text) {
      return false;
    }
  }
  return true;
}

/**
 * 渲染层合并 text/thinking 流式 delta（与 Host handleEvent 的 partIndex 语义对齐）。
 * sync 后 assistant 常为 parts: []，首条 delta 必须新建片段，不能因找不到 part 而丢弃。
 */
export function applyGuiMessageDelta(
  msg: GuiChatMessage,
  partIndex: number,
  deltaKind: 'text' | 'thinking',
  delta: string
): GuiChatMessage {
  const parts = [...msg.parts];
  const target = parts[partIndex];
  if (target && target.kind === deltaKind) {
    parts[partIndex] = { ...target, text: target.text + delta };
  } else if (!target) {
    // 超前到达（sync 替换瞬间的竞态）：按新开一段落地（Host 的 appendDelta 语义同族），
    // 绝不静默丢弃——顺序误差由下一次全量 sync 校正
    parts.push({ kind: deltaKind, text: delta });
  } else {
    // 目标存在但 kind 不符（异常漂移）：尾部新开一段——既不覆盖已有 part（可能是
    // 工具卡），也不丢增量
    parts.push({ kind: deltaKind, text: delta });
  }
  return { ...msg, parts };
}

/**
 * 应用 part 级推送（工具卡新增/出结果）到消息列表，返回新列表；**不同步时返回 null**，
 * 调用方必须回退到全量拉取。
 *
 * 引用契约（行级 memo 依赖）：只有目标消息与目标 part 换新引用，其余消息与同消息内
 * 其他 part 保持原引用。
 *
 * 判定不同步的两种情形——消息不在本地（已被清空/fork 走了），或 partIndex 跳号
 * （错过了前序推送）。这两种必须让调用方重新拉权威快照：静默丢一个 part 就是工具卡
 * 永久缺块，或永远停在「进行中」。partIndex === parts.length 是正常的追加（tool-start）。
 */
export function applyGuiMessagePart(
  messages: GuiChatMessage[],
  messageId: string,
  partIndex: number,
  part: GuiMessagePart
): GuiChatMessage[] | null {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return null;
  const msg = messages[idx]!;
  if (partIndex < 0 || partIndex > msg.parts.length) return null;
  const parts = msg.parts.slice();
  parts[partIndex] = part;
  const next = messages.slice();
  next[idx] = { ...msg, parts };
  return next;
}

/**
 * 回合收口兜底：把消息里仍 running 的工具卡原地终态化为 cancelled，返回被收尾的
 * callId 列表（供调用方给轨迹账本补 tool-call-end，否则轨迹页的「运行中」行也永远转）。
 *
 * 为什么必须收口：Cursor 服务端对并行工具偶发不发完成事件（2026-09-14 真机原始流
 * 实锤：一批 4 条 tool_call running 只跟 3 条 completed，模型侧结果已消费所以回合
 * 正常结束）；中止/引擎异常/worker 崩溃路径同理。事件丢了就再也不会来，不终态化
 * 则进行中动画永远转，且随消息持久化复活。
 */
export function finalizeRunningToolParts(msg: GuiChatMessage, note?: string): string[] {
  const swept: string[] = [];
  for (const p of msg.parts) {
    if (p.kind === 'tool' && p.tool.status === 'running') {
      p.tool.status = 'cancelled';
      if (note !== undefined) p.tool.output = note;
      swept.push(p.tool.id);
    }
  }
  return swept;
}

/**
 * Cursor `task` 子代理曾把思考/正文摊进主对话：token 级 kind 交替会刷出大量
 * 「思考过程 · 持续了几秒」夹在几个字之间。恢复时把这种 flicker 段按到达顺序
 * 拼回一段正文（碎片本身就是被误分类的正文）。真·一两段长思考 + 长正文不动。
 */
const FLICKER_THINKING_MIN = 4;
const FLICKER_TEXT_MEDIAN_MAX = 80;

function medianLength(lens: number[]): number {
  if (lens.length === 0) return 0;
  const sorted = [...lens].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function coalesceFlickerStreamParts(parts: GuiMessagePart[]): GuiMessagePart[] {
  let i = 0;
  let changed = false;
  const out: GuiMessagePart[] = [];
  while (i < parts.length) {
    const p = parts[i]!;
    if (p.kind === 'tool') {
      out.push(p);
      i += 1;
      continue;
    }
    const runStart = i;
    let thinkingCount = 0;
    const textLens: number[] = [];
    while (i < parts.length && parts[i]!.kind !== 'tool') {
      const cur = parts[i]!;
      if (cur.kind === 'thinking') thinkingCount += 1;
      else if (cur.kind === 'text') textLens.push((cur.text ?? '').length);
      i += 1;
    }
    const run = parts.slice(runStart, i);
    if (thinkingCount >= FLICKER_THINKING_MIN && textLens.length >= 2 && medianLength(textLens) < FLICKER_TEXT_MEDIAN_MAX) {
      const text = run
        .map((part) => (part.kind === 'thinking' || part.kind === 'text' ? (part.text ?? '') : ''))
        .join('');
      if (text) out.push({ kind: 'text', text });
      changed = true;
    } else {
      out.push(...run);
    }
  }
  return changed ? out : parts;
}

/**
 * 重启/重载恢复时的消息消毒：落盘快照可能带着「上次运行遗留的进行时状态」——
 * 排队标记（队列已不存在）、挂起审批卡（approvalId 无人认领，点了没反应）、
 * 挂起提问卡（pending 永远等不到应答通道）、running 工具卡（完成事件在上次运行
 * 中已丢失，恢复后无人再补）。统一在加载时终态化/剥离，否则渲染层出现可点但无效
 * 的僵尸控件或永远转的进行中动画。数组无变化时原引用返回（省一次 sync）。
 */
export function sanitizeRestoredMessages(messages: GuiChatMessage[]): GuiChatMessage[] {
  return sanitizeRestoredMessageRows(messages,false);
}

/** A bounded range must preserve every persisted ordinal, including empty
 * assistant shells. Removing a row here would shift every following page slot. */
export function sanitizeRestoredMessagePage(messages:GuiChatMessage[]):GuiChatMessage[]{
  return sanitizeRestoredMessageRows(messages,true);
}

function sanitizeRestoredMessageRows(messages:GuiChatMessage[],preservePositions:boolean):GuiChatMessage[]{
  let changed = false;
  const out: GuiChatMessage[] = [];
  for (const m of messages) {
    let next = m;
    if (isExtensionDomainNudge(m) && m.steering !== 'host') {
      next = { ...next, host: true, steering: 'host' };
    }
    if (m.turnChanges?.state === 'collecting') {
      next = { ...next, turnChanges: { ...m.turnChanges, state: 'error', warnings: [...m.turnChanges.warnings, '上次改动采集中断，没有可用的回退快照'] } };
    }
    if (m.queued) {
      next = { ...next, queued: undefined };
      delete next.queued;
    }
    if (m.retryHint) {
      next = { ...next, retryHint: undefined };
      delete next.retryHint;
    }
    if (m.approval) {
      next = { ...next, approval: undefined };
      delete next.approval;
    }
    if (m.userQuestion?.status === 'pending') {
      next = { ...next, userQuestion: { ...m.userQuestion, status: 'aborted' } };
    }
    // running 工具卡：恢复时不存在活跃回合，一律按取消收尾（收口兜底上线前的
    // 存量卡死数据也靠这里修复）。part 级复制保持未变 part 的引用。
    if (next.role === 'assistant' && next.parts.some((p) => p.kind === 'tool' && p.tool.status === 'running')) {
      next = {
        ...next,
        parts: next.parts.map((p) =>
          p.kind === 'tool' && p.tool.status === 'running'
            ? { kind: 'tool', tool: { ...p.tool, status: 'cancelled' } }
            : p
        )
      };
    }
    if (next.role === 'assistant') {
      const coalesced = coalesceFlickerStreamParts(next.parts);
      if (coalesced !== next.parts) next = { ...next, parts: coalesced };
    }
    // 审批剥离后可能剩下「零内容空壳 assistant」（子代理审批冒泡卡），整条丢弃
    const isEmptyShell =
      next.role === 'assistant' &&
      next.parts.length === 0 &&
      !next.error &&
      !next.aborted &&
      !next.plan &&
      !next.turnChanges &&
      !next.userQuestion;
    if (isEmptyShell && !preservePositions) {
      changed = true;
      continue;
    }
    if (next !== m) changed = true;
    out.push(next);
  }
  return changed ? out : messages;
}

/** v1 扁平消息（迁移输入形状；只在 persist.load 里出现） */
interface LegacyGuiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text?: string;
  thinking?: string;
  tools?: GuiToolCallView[];
  [k: string]: unknown;
}

/** v1 扁平字段 → parts（保持 v1 渲染顺序：思考 → 工具 → 文本） */
export function migrateGuiChatMessage(m: LegacyGuiChatMessage): GuiChatMessage {
  const parts: GuiMessagePart[] = [];
  if (m.thinking) parts.push({ kind: 'thinking', text: m.thinking });
  for (const t of m.tools ?? []) parts.push({ kind: 'tool', tool: t });
  const text = m.text ?? '';
  if (text || parts.length === 0) parts.push({ kind: 'text', text });
  const out: GuiChatMessage = {
    id: m.id,
    role: m.role,
    parts,
    ts: typeof m.ts === 'number' ? m.ts : 0
  };
  for (const key of [
    'images',
    'approval',
    'userQuestion',
    'plan',
    'error',
    'aborted',
    'finishedAt',
    'retryAttempts',
    'queued',
    'retryHint',
    'source',
    'sourceAgent',
    'host'
  ] as const) {
    if (m[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = m[key];
  }
  return out;
}

/** 主进程 → 渲染层推送（channel: agentSession:event）。sync 只携带最近 120 条，历史通过 getHistoryRange 分页读取。 */
export type GuiWorkerPush = (
  | { kind: 'permission-mode'; sessionId: string; mode: GuiWorkerMode }
  | { kind: 'native-config'; sessionId: string; snapshot: import('./nativeSessionConfig').NativeConfigSnapshot }
  | { kind: 'execution'; sessionId: string; state?: import('./executionLifecycle').ExecutionLifecycle }
  | { kind: 'parameters'; sessionId: string; controls: import('./modelParameters').ModelParameterState[]; warning?: string; providerId?: string; modelId?: string }
  | {
      kind: 'sync';
      sessionId: string;
      messages: GuiChatMessage[];
      /** Range metadata for this bounded tail snapshot. */
      before?: number;
      total?: number;
      hasEarlier?: boolean;
    }
  | {
      kind: 'delta';
      sessionId: string;
      messageId: string;
      /** 追加目标片段在 parts 里的下标（text/thinking 流式增量） */
      partIndex: number;
      deltaKind: 'text' | 'thinking';
      delta: string;
    }
  /**
   * 单个 part 的落定（工具卡新增/出结果）。
   *
   * 为什么不复用 sync：一个回合的所有工具卡都挂在**同一条** assistant 消息的 parts
   * 上（真机 277 个工具卡 / 4 条消息 / 2.29MB 工具输出），所以按消息粒度的增量等于
   * 还是推那条 2.93MB 的大消息。part 粒度才真省：每次只走一个工具卡。
   *
   * partIndex 是权威下标；渲染层若发现消息不存在或下标越界（错过了前序推送），
   * 必须回退到全量拉取，不能静默丢——否则工具卡永远缺一块。
   */
  | {
      kind: 'part';
      sessionId: string;
      messageId: string;
      partIndex: number;
      part: GuiMessagePart;
    }
  | {
      kind: 'busy';
      sessionId: string;
      busy: boolean;
      queued: number;
      /** 收口原因：网络/传输中止用尽续作后上报调度，不走普通 turn_end */
      outcome?: 'network_error';
      error?: string;
      retryAttempts?: number;
    }
  | { kind: 'error'; sessionId: string; message: string }
  | {
      kind: 'context';
      sessionId: string;
      usage: {
        tokens: number | null;
        contextWindow: number;
        ts?: number;
        stale?: boolean;
      } | null;
    }
  /** Harness 透明·注入快照信封换代（连接建立/重连换代时推送；渲染层更新标注数据源） */
  | { kind: 'injections'; sessionId: string; injection: GuiInjectionSummary; metadataCounts?:GuiHistoryMetadataCounts }
  /**
   * 压缩分隔标记（pi-trajectory-plan extension B3'：账本退役后的独立事件源；
   * running/complete/error 生命周期，乐观 pending 由渲染层经 markerId 认领）
   */
  | {
      kind: 'compaction';
      sessionId: string;
      metadataCounts?:GuiHistoryMetadataCounts;
      /** 标记 id（Host 分配；渲染层 React key 与乐观 pending 认领共用） */
      markerId: string;
      status: 'running' | 'complete' | 'error';
      at: number;
      /** 压缩前后规模（手动/宿主自动压缩结果补写；引擎内部压缩未知缺省） */
      tokensBefore?: number | null;
      tokensAfter?: number | null;
    }
  /** ACP 能力发现：斜杠命令 / 引擎当前模式 */
  | {
      kind: 'engine-meta';
      sessionId: string;
      slashCommands?: Array<{ name: string; description?: string; inputHint?: string }>;
      engineMode?: { modeId: string; name?: string };
    }
) & {
  /** Message-only live generation/revision. Metadata events do not advance it. */
  messagesVersion?: string;
  /** Monotonic message delivery cursor, independent from durable checkpoint writes. */
  liveSeq?: number;
};

/** 会话信封里的压缩记录（已完成；渲染层重建 complete 分隔线用） */
export interface GuiCompactionRecord {
  at: number;
  tokensBefore?: number | null;
  tokensAfter?: number | null;
}

/** 宽松解析信封 compactions（旧会话/手改文件容错）：坏条目丢弃，非数组回空 */
export function parseCompactionRecords(raw: unknown): GuiCompactionRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: GuiCompactionRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const at = (item as { at?: unknown }).at;
    if (typeof at !== 'number' || !Number.isFinite(at)) continue;
    const tb = (item as { tokensBefore?: unknown }).tokensBefore;
    const ta = (item as { tokensAfter?: unknown }).tokensAfter;
    out.push({
      at,
      ...(typeof tb === 'number' ? { tokensBefore: tb } : {}),
      ...(typeof ta === 'number' ? { tokensAfter: ta } : {})
    });
  }
  return out;
}

export interface GuiWorkerHistory {
  execution?: import('./executionLifecycle').ExecutionLifecycle;
  messages: GuiChatMessage[];
  /** Opaque live-entry generation/revision; absent on the disk fallback. */
  messagesVersion?: string;
  /** Current message delivery cursor for bounded live recovery. */
  liveSeq?: number;
  messagesUnchanged?: false;
  mode?: GuiWorkerMode;
  busy: boolean;
  /** Pi 会话的自定义模式 id（内置 creator/用户自建；空串=标准无模式） */
  piModeId?: string;
  /** 会话级模型覆盖（不设=跟随全局；只影响本会话） */
  modelOverride?: { providerId: string; modelId: string };
  /** 会话级思考档（Pi；null=跟随默认） */
  thinkingLevel?: import('./types').GuiThinkingLevel | null;
  /** 生效服务商是否配置了思考档映射（渲染层据此决定思考 chip 是否显示） */
  thinkingConfigured?: boolean;
  /** 上下文窗口占用快照（连接未建时可为重启恢复的 lastUsage，带 stale） */
  usage?: {
    tokens: number | null;
    contextWindow: number;
    ts?: number;
    stale?: boolean;
  } | null;
  /** Harness 透明·连接级注入快照（信封；旧会话缺省为空数组） */
  injections?: GuiInjectionSnapshot[];
  /** Harness 透明·压缩记录信封（旧会话缺省为空数组） */
  compactions?: GuiCompactionRecord[];
  /** ACP AvailableCommands */
  slashCommands?: Array<{ name: string; description?: string; inputHint?: string }>;
  /** ACP CurrentMode */
  engineMode?: { modeId: string; name?: string };
}

/** Only a client holding the matching complete message snapshot can receive this small reply. */
export type GuiWorkerHistoryResponse = GuiWorkerHistory | (
  Omit<GuiWorkerHistory, 'messages' | 'messagesUnchanged'> & {
    messagesUnchanged: true;
    messagesVersion: string;
  }
);

/** Tail page returned by the GUI Worker history range protocol. */
export interface GuiWorkerHistoryPage extends Omit<GuiWorkerHistory, 'messages' | 'messagesUnchanged' | 'injections'> {
  injections?: GuiInjectionView[];
  metadataStatus?: GuiHistoryMetadataStatus;
  messages: GuiChatMessage[];
  /** Exclusive cursor for the next older page. */
  before: number;
  total: number;
  hasEarlier: boolean;
}

export function isGuiMessagesVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(0|[1-9][0-9]{0,15})$/i.test(value);
}

export interface GuiWorkerSendResult {
  ok: boolean;
  /** busy 且无 redirect：消息入队，等当前回合结束后再发 */
  queued?: boolean;
  /** busy 且 driver.redirect 成功：已注入当前回合（不是排队） */
  steered?: boolean;
  /** busy 时请求原生插话，但当前 Harness 没有可用的原生插话通道；消息尚未入队 */
  steerUnsupported?: boolean;
  queueDepth?: number;
  error?: string;
}

export interface GuiWorkerForkResult {
  ok: boolean;
  sessionId?: string;
  error?: string;
}
