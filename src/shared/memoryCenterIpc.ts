/**
 * 记忆中心 hub IPC DTO（memory-refactor §11 P5 面板批；preload/renderer/main 三方共享）。
 * 类型真源只放传输层形状：条目格式复用 memoryFormat / entryFormat 的解析产物；
 * 实现在 main/memory/center.ts（纯逻辑）+ main/memory/ipc.ts（通道登记）。
 * 现有 memory:*（工作区 MEMORY.md 行卡读写）保持不变，本通道是 hub 六页签的补充面。
 */
import type { DuplicatePair } from './memoryFormat';
import type { MemoryInjectionInfo, MemoryRecoveryItem } from './memoryIpc';

/** 策展命名空间：worker=工作区共享 docs/memory/MEMORY.md；scheduler=.muster/scheduler/MEMORY.md */
export type MemoryCenterNamespace = 'worker' | 'scheduler';

/** 单条策展条目（两份 MEMORY.md 合并列表；格式扩展注解见 entryFormat §4.3） */
export interface MemoryCenterEntry {
  /** 现有解析合同 id（ts-sid-内容指纹；文件内唯一） */
  id: string;
  namespace: MemoryCenterNamespace;
  /** 时间戳注释 'YYYY-MM-DD HH:MM:SS'（未识别条目为空串） */
  ts: string;
  /** 注释行会话短 id（'memory'=巩固晋升 / 'manual'=手工 等） */
  sessionId: string;
  tags: string[];
  links: string[];
  /** 正文（已剥行尾注解；不含行首标记剥离——渲染层自行 stripLeadingMarkers） */
  text: string;
  raw: string;
  unparsed: boolean;
  /** 行尾注解 trigger 词组 */
  trigger: string[];
  /** 行尾注解 importance 1–10（缺省 null=中性） */
  importance: number | null;
  /** 行尾注解 project（repoKey 作用域；缺省 null） */
  repoKey: string | null;
  /**
   * 溯源 origin 五类（§5）。B7 回填：条目行尾注解 `<!-- origin: user|scheduler|worker -->`
   * 由宿主写入路径落盘（memory.remember 直写=user、巩固晋升带 staging 真实来源），
   * 旧条目/不可注解类（untrusted/system）为 null——渲染层对 null 不渲染 OriginDot
   * 徽标。注解仅展示/审计用，不作为信任判定源（模型文本的伪造注解在入库时被剥离）。
   */
  origin: 'user' | 'scheduler' | 'worker' | 'untrusted' | 'system' | null;
  /** 年龄（天；按 ts 距今取整；无 ts 为 null） */
  ageDays: number | null;
  /**
   * 召回热度（条目 4A，近 30 天窗口聚合）：injected30d=注入次数（bootstrap/
   * brief_injected/trigger_injected），hits30d=检索命中次数（search_hit/
   * escalation_hit），lastRecalledAt=窗口内最近一次召回时间。派生库不可用/无
   * chunk 映射时为 null（渲染层按「从未被召回」弱灰处理，不炸）。
   */
  recall: MemoryCenterEntryRecall | null;
  /**
   * 来历（条目 3，读取端从 consolidation_log 明细 + 条目注解派生；null=无可靠来历，
   * 渲染层不渲染来历行）。判定顺序：log applied[] 命中（approval/sweep）最优先——
   * 「记住」回合候选经巩固/审批晋升后同样带 origin:user，真来历是巩固轮；→ origin=user
   * 直写（log 未命中时）→ sessionId='manual' 手工添加 → 其余非 'memory' 会话短 id=
   * 会话沉淀 → 'memory'=巩固晋升（旧 log 无明细的兜底，无轮次引用）。
   */
  provenance: MemoryCenterProvenance | null;
  /**
   * 血缘（条目 3）：本条取代了哪条旧条目（读取端从 log payload.supersededPairs 按
   * newEntryId 反查，取最近一次；无=null）。渲染层据此挂「取代了谁」可展开行。
   */
  supersedes: MemoryCenterSupersedesInfo | null;
}

/** 来历五态（条目 3B：信任的第一要素——这条记忆是谁说的、经谁生效） */
export type MemoryCenterProvenance =
  | { kind: 'direct' }
  | { kind: 'manual' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'approval'; logId: number }
  | { kind: 'sweep'; logId: number | null };

/** 血缘信息（本条是被取代者的继任；旧条目在「已取代」档只读考古） */
export interface MemoryCenterSupersedesInfo {
  oldEntryId: string;
  oldText: string;
  /** 前镜像 id（回收站回滚键；无改写=null） */
  preimageId: number | null;
  /** 旧条目退役时间（巩固轮 finishedAt） */
  retiredAt: number;
}

/**
 * 已取代档条目（条目 3A：退役条目考古；数据源=consolidation_log payload 的
 * supersededPairs——v4 起落明细，旧格式行无 payload 的取代对不可考，如实缺失）。
 * 只读：不提供「恢复到策展文件」旁路，恢复只走回收站回滚既有通道。
 */
export interface MemoryCenterSupersededItem {
  oldEntryId: string;
  oldText: string;
  /** 继任条目 id（可能已再次被取代/删除而不在策展文件——渲染层定位失败友好提示） */
  newEntryId: string | null;
  newText: string;
  preimageId: number | null;
  /** 退役时间（巩固轮 finishedAt） */
  retiredAt: number;
}

export interface MemoryCenterSupersededResult {
  /** retiredAt 倒序；渲染层上限 100 条，超出引导用搜索 */
  items: MemoryCenterSupersededItem[];
  /** 日志明细中的全部取代对数（可能大于 items.length：上限截断） */
  total: number;
  truncated: boolean;
}

/** 条目召回热度聚合（30 天窗口；GROUP BY chunk_id,kind 后按条目↔chunk 映射归并） */
export interface MemoryCenterEntryRecall {
  /** 近 30 天注入次数（bootstrap/brief_injected/trigger_injected） */
  injected30d: number;
  /** 近 30 天检索命中次数（search_hit/escalation_hit） */
  hits30d: number;
  /** 窗口内最近一次召回（epoch ms；窗口内无记录=null） */
  lastRecalledAt: number | null;
}

export interface MemoryCenterFileState {
  exists: boolean;
  chars: number;
  maxChars: number;
  /** 全文 hash（stale 防护基准；文件不存在时空串） */
  hash: string;
  relPath: string;
}

export interface MemoryCenterEntriesResult {
  files: Record<MemoryCenterNamespace, MemoryCenterFileState>;
  entries: MemoryCenterEntry[];
  /** 重复/矛盾检测沿用现有能力：按文件分别跑再合并（id 归属各自命名空间） */
  duplicates: DuplicatePair[];
  conflicts: DuplicatePair[];
  /** 旧回收站（docs/memory/recovery，B8 收编前只读不动） */
  recovery: MemoryRecoveryItem[];
  /** 注入命中信息（共享策展 worker 文件的预算装箱；选择算法同 memoryFormat） */
  injection: MemoryInjectionInfo;
  /** USER.md 画像命名空间（B7：页签 1 查看+直改；路径未装配 available=false） */
  profile: MemoryCenterProfileResult;
}

/** 行内编辑注解输入（只改 trigger/importance/project 三个注解字段；正文/tags/links 走 memory:saveEntry） */
export interface MemoryCenterUpdateEntryInput {
  namespace: MemoryCenterNamespace;
  id: string;
  /** 目标文件全文 hash（stale 防护基准；取 entries 结果里对应命名空间的 hash） */
  hash: string;
  /** 传空数组 = 清除注解；undefined = 不改该字段 */
  trigger?: string[];
  /** null = 清除注解；1–10 整数合法；undefined = 不改该字段 */
  importance?: number | null;
  /** null = 清除注解；非空串 = 设置；undefined = 不改该字段 */
  repoKey?: string | null;
  /** 回退定位正文（可选）：id 未命中时在当前文件里按该正文**唯一**匹配（两段保存的第一段
   *  legacy memory:saveEntry 重写正文后 id 随内容指纹变化；非唯一命中不回退，保持「条目不存在」） */
  matchText?: string;
}

/** IPC 入参归一（main/memory/ipc.ts 用）：undefined = 不改该字段（no-op），
 *  三个注解字段与 matchText 语义一致；importance null=清除、其余值 Number 强转后由服务层校验。 */
export function normalizeMemoryCenterUpdateEntryInput(raw: unknown): MemoryCenterUpdateEntryInput {
  const inp = (raw ?? {}) as Partial<MemoryCenterUpdateEntryInput>;
  return {
    namespace: inp.namespace === 'scheduler' ? 'scheduler' : 'worker',
    id: typeof inp.id === 'string' ? inp.id : '',
    hash: typeof inp.hash === 'string' ? inp.hash : '',
    trigger: Array.isArray(inp.trigger) ? inp.trigger.filter((x): x is string => typeof x === 'string') : undefined,
    importance:
      inp.importance === undefined ? undefined : inp.importance === null ? null : Number(inp.importance),
    repoKey: inp.repoKey === undefined ? undefined : typeof inp.repoKey === 'string' ? inp.repoKey : null,
    matchText: typeof inp.matchText === 'string' ? inp.matchText : undefined
  };
}

export type MemoryCenterUpdateEntryResult =
  | { stale: false; hash: string; entries: MemoryCenterEntry[] }
  | { stale: true; hash: string; entries: MemoryCenterEntry[] };

// ---------------------------------------------------------------------------
// 审批队列（§6.3 置信分档；B4 approvals 表 + approval.ts 服务）
// ---------------------------------------------------------------------------

/** 审批执行回执（approve 后真实生效结果——B4 混批修复后的验证组装） */
export interface MemoryCenterApprovalExecution {
  applied: number;
  total: number;
  /** rewrite=改写生效 / append=追加回退 */
  mode: 'rewrite' | 'append';
  hashConflict: boolean;
  /** 未生效操作分类计数（2026-10-02 M2：部分应用时如实报拒绝原因） */
  rejectedCounts?: Record<string, number>;
}

/** 审批时真正将执行的操作全文；previewDiff 只用于列表摘要。 */
export interface MemoryCenterApprovalOperation {
  kind: 'add' | 'merge' | 'supersede' | 'delete';
  proposedText: string;
  oldText: string | null;
  stagingId: number;
}

export interface MemoryCenterApproval {
  id: number;
  action: 'promote' | 'supersede' | 'delete' | 'user_md_change';
  state: 'pending' | 'approved' | 'rejected' | 'expired';
  /** 目标命名空间（user_md_change → 'profile'：userData 全局 USER.md） */
  namespace: MemoryCenterNamespace | 'profile';
  targetFileRel: string;
  confidence: number | null;
  /** 操作笔数 */
  operations: number;
  operationDetails: MemoryCenterApprovalOperation[];
  /** 预览 diff（一行一操作，B4 buildPreviewDiff 产物） */
  previewDiff: string[];
  reason: string;
  createdAt: number;
  decidedAt: number | null;
  /** 执行回执（本会话内批准成功时在场；历史已裁决项为 null——回执不落库，见 receiptText） */
  execution: MemoryCenterApprovalExecution | null;
  /** 裁决/执行失败原因（approve 写冲突、payload 损坏等） */
  error: string | null;
  /** 已裁决项的回执文本（consolidation_log 里 `approval:<id>:(approved|rejected)` 行的 diff 摘要） */
  receiptText: string | null;
}

export interface MemoryCenterApprovalsResult {
  items: MemoryCenterApproval[];
}

export interface MemoryCenterApprovalDecisionResult {
  ok: boolean;
  approvalId: number;
  decision: 'approved' | 'rejected';
  /** approve 成功时的执行回执 */
  execution: MemoryCenterApprovalExecution | null;
  error: string | null;
  /** 失败分类（busy/read_failed/write_failed/conflict/zero_applied；2026-10-02 M1/M2） */
  code?: string;
}

// ---------------------------------------------------------------------------
// 晋升审阅时间线（consolidation_log）与回收站（preimages + 旧 recovery）
// ---------------------------------------------------------------------------

export interface MemoryCenterLogItem {
  id: number;
  triggerSource: string | null;
  addedCount: number;
  mergedCount: number;
  supersededCount: number;
  diffSummary: string | null;
  /** 拒绝分类计数（B4 countRejectCategories 产物；空对象=无拒绝） */
  rejectedCounts: Record<string, number>;
  /**
   * 条目 2A 明细 payload（写入端收口，v4 起落库）。旧格式行（v4 前）/兜底错误行为
   * null——读取端宽容形状：null 时渲染层只显示计数，不展开明细。
   */
  payload: MemoryCenterLogPayload | null;
  startedAt: number | null;
  finishedAt: number;
}

// ---------------------------------------------------------------------------
// 巩固日志明细 payload（条目 2A：log 行同事务补记的 JSON 形状；DB 存储与 DTO 同构）
// ---------------------------------------------------------------------------

/** 本轮真实入库/改写的条目（展开体「自动入池/合并」组数据源） */
export interface MemoryCenterLogAppliedItem {
  op: 'add' | 'merge' | 'supersede';
  stagingId: number;
  /** 落盘条目 id（ts-sid-指纹；条目总览定位跳转键；解析定位失败=null） */
  entryId: string | null;
  /** merge：被合并的旧条目 id（渲染「新 ⟵ 旧」） */
  mergedInto: string | null;
  /** merge：被合并旧条目正文（「新 ⟵ 旧」行展示真实旧文；v4 复审补——旧格式 payload 行缺省 undefined，渲染回退占位） */
  oldText?: string | null;
  /** 条目正文（add/merge/supersede 的新正文全文） */
  text: string;
  /** 模型置信（0–1；缺省 null） */
  confidence: number | null;
  source: {
    stagingId: number;
    /** 来源会话引用（evidencePath 去行号后的会话定位串；无证据=null） */
    sessionId: string | null;
    /** 生效途径：sweep=高置信自动 / approval=审批批准 */
    via: 'sweep' | 'approval';
  };
  /** 巩固信号摘要（信号门读数；审批路径无候选装载=null） */
  signals: { recallCount: number | null; relevance: number | null };
}

/** 取代对（展开体「取代」组数据源；前镜像可回滚标注） */
export interface MemoryCenterLogSupersededPair {
  newEntryId: string | null;
  newText: string;
  oldEntryId: string | null;
  oldText: string;
  /** 前镜像 id（回收站回滚键；无改写=null） */
  preimageId: number | null;
}

/** 没入库的候选（展开体「没入库的」组数据源；人话拒因 = t(reasonKey, reasonArgs)） */
export interface MemoryCenterLogRejectedItem {
  stagingId: number | null;
  /** 候选原文（unknown 候选等无法回溯正文时为空串） */
  text: string;
  /**
   * 拒因 key：taint / low_signal（信号门）、ambiguous / over_loss / over_budget /
   * missing_source / invalid_op / hash_conflict / model_failed（验证组装）、
   * user_rejected（审批驳回）。渲染层对未知 key 回退显示 key 本身。
   */
  reasonKey: string;
  /** 拒因参数（相似度/阈值/信号读数等；t(key, args)） */
  reasonArgs: Record<string, unknown> | null;
  /** 来源会话引用（evidencePath 去行号；无=null） */
  originSessionId: string | null;
}

/** log.payload 的解析形状（旧记录无 payload=null，读取端宽容） */
export interface MemoryCenterLogPayload {
  applied: MemoryCenterLogAppliedItem[];
  supersededPairs: MemoryCenterLogSupersededPair[];
  rejected: MemoryCenterLogRejectedItem[];
}

export interface MemoryCenterLogResult {
  items: MemoryCenterLogItem[];
}

export interface MemoryCenterPreimage {
  id: number;
  /** 目标文件（工作区相对 posix 路径；USER.md 等工作区外目标为绝对路径） */
  fileRel: string;
  namespace: MemoryCenterNamespace | 'profile' | null;
  contentChars: number;
  contentHash: string;
  cause: string | null;
  createdAt: number;
  /** 末行预览（列表识别用） */
  preview: string;
}

export interface MemoryCenterRecycleResult {
  /** 改写前镜像（可一键回滚） */
  preimages: MemoryCenterPreimage[];
  /** 旧 recovery（只读；B8 收编） */
  recovery: MemoryRecoveryItem[];
}

export interface MemoryCenterRollbackResult {
  ok: boolean;
  preimageId: number;
  /** 回滚目标文件（工作区相对 posix 路径） */
  fileRel: string | null;
  /** 回滚前现状已另存为的新前镜像 id（回滚可撤销） */
  safetyPreimageId: number | null;
  error: string | null;
}

/** 彻底删除（不可恢复）：前镜像 / 旧 recovery 备份 */
export interface MemoryCenterPurgeResult {
  ok: boolean;
  /** 被删除对象 id（preimage 数字 id 或 recovery uuid） */
  id: number | string;
  error: string | null;
}

// ---------------------------------------------------------------------------
// 索引状态（§8）与重建
// ---------------------------------------------------------------------------

export interface MemoryCenterSourceCount {
  sourceType: 'memory' | 'journal' | 'transcript' | 'user_md' | 'features' | 'staging';
  chunks: number;
}

export interface MemoryCenterIndexStatus {
  /** BM25 恒开：全库 chunk 计数 */
  totalChunks: number;
  sources: MemoryCenterSourceCount[];
  /** 转录收录量（transcript chunk 的去重会话数） */
  transcriptSessions: number;

}

export interface MemoryCenterReindexResult {
  changed: number;
  removed: number;
  totalChunks: number;
  durationMs: number;
}

/** 审批角标（侧栏「记忆整理」入口） */
export interface MemoryCenterBadgeResult {
  pending: number;
}

// ---------------------------------------------------------------------------
// USER.md 画像命名空间（§10，B7）：userData 全局文件，页签 1 查看+直改（终审免审）
// ---------------------------------------------------------------------------

/** 画像条目（entryFormat.parseProfileEntries 产物子集） */
export interface MemoryCenterProfileEntry {
  id: string;
  /** 观察日期 YYYY-MM-DD */
  observed: string;
  status: 'active' | 'superseded';
  directive: string;
  raw: string;
  unparsed: boolean;
}

export interface MemoryCenterProfileResult {
  /** USER.md 路径未装配（userData 未注入）= false，面板显示不可用 */
  available: boolean;
  exists: boolean;
  /** 全文 hash（stale 防护基准） */
  hash: string;
  chars: number;
  maxChars: number;
  entries: MemoryCenterProfileEntry[];
}

/** 面板直改操作（人=终审，免审原子写；edit 的 observed 刷新为当日） */
export interface MemoryCenterProfileOp {
  kind: 'edit' | 'add' | 'remove';
  /** edit/remove：目标条目 id（parseProfileEntries 的稳定 id） */
  id?: string;
  /** edit/add：指令文本 */
  directive?: string;
  /** edit：状态（缺省保持 active） */
  status?: 'active' | 'superseded';
}

export interface MemoryCenterUpdateProfileInput {
  /** 全文 hash（stale 防护；不符返回最新内容拒绝写入） */
  hash: string;
  ops: MemoryCenterProfileOp[];
}

export type MemoryCenterUpdateProfileResult =
  | { stale: false; hash: string; entries: MemoryCenterProfileEntry[]; chars: number }
  | { stale: true; hash: string; entries: MemoryCenterProfileEntry[]; chars: number }
  | { stale: false; error: string };

// ---------------------------------------------------------------------------
// 意图管理（页签 4，§9 standing intents，B7）
// ---------------------------------------------------------------------------

/** 意图事件谓词（事件面结构化匹配；确定性字段匹配，零模型调用）。
 *  kind 与事件源真实字段对应：
 *  - notify_flip：会话相位翻转（NotifyFlipEvent：trigger ∈ needs_you|done|error）
 *  - merge_blocked：合入受阻（git 缝：branch/repo）
 *  - pr_merged：PR 已合并（prMergedWatch：repo/branch/title/prNumber） */
export interface IntentEventPredicate {
  kind: 'notify_flip' | 'merge_blocked' | 'pr_merged';
  /** notify_flip：相位触发类 needs_you|done|error */
  trigger?: string;
  /** merge_blocked：分支包含（可选） */
  branchIncludes?: string;
  /** pr_merged/merge_blocked：仓库路径包含（可选） */
  repoIncludes?: string;
}

/** 归一谓词入参（intent 工具/共享校验；非法字段丢弃，kind 非法返回 null） */
export function normalizeIntentEventPredicate(raw: unknown): IntentEventPredicate | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = String(o.kind ?? '');
  if (kind !== 'notify_flip' && kind !== 'merge_blocked' && kind !== 'pr_merged') {
    return null;
  }
  const str = (v: unknown): string | undefined => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s || undefined;
  };
  const p: IntentEventPredicate = { kind };
  if (kind === 'notify_flip') {
    p.trigger = str(o.trigger);
    if (!p.trigger) return null;
  } else {
    p.branchIncludes = str(o.branchIncludes);
    p.repoIncludes = str(o.repoIncludes);
    if (!p.branchIncludes && !p.repoIncludes) return null; // 至少一个匹配面
  }
  return p;
}

/** 谓词 → 人话标签（渲染层用 t() 包原文后渲染；main 侧通知文案有自己的私有形态） */
export const INTENT_PREDICATE_KINDS = ['notify_flip', 'merge_blocked', 'pr_merged'] as const;

/** intents 状态域（与 db.ts CHECK 同域） */
export type MemoryCenterIntentState = 'pending' | 'armed' | 'fired' | 'done' | 'cancelled' | 'expired';

/** 单条意图（页签 4 生命周期表行） */
export interface MemoryCenterIntentRow {
  id: number;
  description: string;
  /** 消息面触发关键词（全词预筛） */
  keywords: string[];
  /** 事件面谓词（结构化；渲染层配 formatIntentPredicateLabel 出人话） */
  eventPredicates: IntentEventPredicate[];
  state: MemoryCenterIntentState;
  fireCount: number;
  fireBudget: number | null;
  /** 冷却剩余 ms（读取时刻计算；无在途冷却=null） */
  cooldownRemainMs: number | null;
  /** 到期 epoch ms（null=不过期） */
  expiry: number | null;
  lastFiredAt: number | null;
  createdAt: number;
  createdBy: string | null;
}

export interface MemoryCenterIntentsResult {
  items: MemoryCenterIntentRow[];
}

export interface MemoryCenterIntentMutateResult {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// 记忆事件流（条目 1A：memory_events 账本读面；M3 总览事件流/边流量消费）
// ---------------------------------------------------------------------------

/** 事件 kind 全域（与 db CHECK / events.ts 同域） */
export type MemoryCenterEventKind =
  | 'auto_admitted'
  | 'evidence_linked'
  | 'conflict_suspended'
  | 'user_deleted'
  | 'staged'
  | 'promoted'
  | 'superseded'
  | 'approval_queued'
  | 'approval_decided'
  | 'direct_write'
  | 'profile_write'
  | 'intent_fired'
  | 'intent_cancelled';

/** 单条记忆事件（summary=i18n key，渲染层 t(summary, summaryArgs) 出人话） */
export interface MemoryCenterEvent {
  id: number;
  kind: MemoryCenterEventKind;
  ts: number;
  /** worker / scheduler / profile / null */
  namespace: string | null;
  stagingId: number | null;
  approvalId: number | null;
  chunkId: number | null;
  /** 实体定位串（staging:<id> / approval:<id> / intent:<id> / 条目 id） */
  entryRef: string | null;
  summary: string;
  summaryArgs: Record<string, unknown> | null;
}

export interface MemoryCenterEventsOptions {
  /** 返回条数上限（缺省 50，事件流渲染上限；服务端封顶 200） */
  limit?: number;
  /** kind 过滤（缺省全量） */
  kinds?: MemoryCenterEventKind[];
}

export interface MemoryCenterEventsResult {
  items: MemoryCenterEvent[];
  /** 今日生效：本地日历日零点至当前时刻的不同记录数，包含恢复生效。 */
  todayActivations?: number;
  /** 近 24h 按 kind 计数（总览边流量「近 24h 通过 X · 被拒 Y」取数面） */
  kindCounts24h: Record<string, number>;
  /** 近 7 日按 kind 计数（条目 1B：边流量芯片 hover 展示近 7 日） */
  kindCounts7d: Record<string, number>;
}

/** 事件流读参归一（ipc 层用；非法值回落缺省） */
export function normalizeMemoryCenterEventsOptions(raw: unknown): MemoryCenterEventsOptions {
  const o = (raw ?? {}) as Partial<MemoryCenterEventsOptions>;
  const out: MemoryCenterEventsOptions = {};
  if (typeof o.limit === 'number' && Number.isFinite(o.limit) && o.limit > 0) {
    out.limit = Math.floor(o.limit);
  }
  if (Array.isArray(o.kinds)) {
    const kinds = o.kinds.filter((k): k is MemoryCenterEventKind =>
      typeof k === 'string' && MEMORY_EVENT_KIND_SET.has(k as MemoryCenterEventKind)
    );
    if (kinds.length) out.kinds = kinds;
  }
  return out;
}

const MEMORY_EVENT_KIND_SET = new Set<string>([
  'auto_admitted','evidence_linked','conflict_suspended','user_deleted',
  'staged',
  'promoted',
  'superseded',
  'approval_queued',
  'approval_decided',
  'direct_write',
  'profile_write',
  'intent_fired',
  'intent_cancelled'
]);

// ---------------------------------------------------------------------------
// 情景暂存池（条目 6A：staging 读面 + 面板丢弃/撤销；M2 暂存池区块消费）
// ---------------------------------------------------------------------------

/** 单条暂存候选（pending + user_discarded 灰显行；promoted 等终态不出现） */
export interface MemoryCenterStagingItem {
  stagingId: number;
  text: string;
  origin: string;
  /** 巩固命名空间投影（worker/scheduler/profile） */
  namespace: MemoryCenterNamespace | 'profile';
  state: 'pending' | 'user_discarded';
  /** 入池时刻（epoch ms） */
  createdAt: number;
  /** 过期时刻 = createdAt + ttlDays（epoch ms；ttl 由调用方传巩固配置） */
  expireAt: number;
  evidencePath: string | null;
  /** 镜像 chunk id（无镜像=老数据；信号恒 0） */
  chunkId: number | null;
  /** 信号摘要（注入/召回次数与相关分均值；不实时跑检索） */
  signals: { recallEvents: number; uniqueQueries: number; relevanceMean: number | null };
}

export interface MemoryCenterStagingResult {
  items: MemoryCenterStagingItem[];
  /** 积压数=未过期 pending 行数（脑图 n-staging 徽标与列表同源） */
  pendingCount: number;
}

export interface MemoryCenterStagingMutateResult {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// 检索试验台（条目 5：索引状态页签顶部；只读试玩，不落 recall_stats）
// ---------------------------------------------------------------------------

/** 检索试验台使用词法检索。 */
export type MemoryCenterSearchLabMode = 'lex';

/** 单条试验台命中（debug 分项与主进程 finalScore 同一次计算——防两套口径） */
export interface MemoryCenterSearchLabHit {
  chunkId: number;
  sourceType: string;
  text: string;
  rank: number;
  /** 综合分（= BM25 × recency × importance × affinity；非归一域，跨查询不可比） */
  final: number;
  debug: {
    /** BM25 池内归一分（词法分项；未走 BM25 命中为 null） */
    lexNorm: number | null;
    /** 新近度衰减 */
    recency: number;
    /** 重要度乘数 */
    importance: number;
    /** repo 亲和乘数 */
    affinity: number;
    /** 综合分镜像（== final，同源） */
    final: number;
    /** 查询与命中正文的分词交集（「为什么是这条」的字面命中词） */
    matchedTerms: string[];
  } | null;
}

export interface MemoryCenterSearchLabResult {
  query: string;
  mode: MemoryCenterSearchLabMode;
  hits: MemoryCenterSearchLabHit[];
}
