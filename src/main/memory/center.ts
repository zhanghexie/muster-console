/**
 * 记忆中心 hub 服务面（memory-refactor §11 P5 面板批的纯逻辑层）：
 * 策展条目列表（双 MEMORY.md + §4.3 注解）/ 行内注解编辑（stale 防护）/ 审批队列
 * 读写（走 B4 approval.ts 执行链）/ 晋升审阅时间线 / 前镜像回收站与一键回滚 /
 * 索引状态读数。此模块保留供旧格式查看器与历史测试；正式提醒 IPC
 * 直接依赖 centerState.ts，不经本模块加载审批/巩固代码。
 *
 * 零 electron 依赖（.mjs 可转译直测）；i18n 只用于面向面板的错误文案（词条在
 * fragments/memory.ts 收口）。面板正文编辑/删除/恢复走 memory/panelStore（原
 * metaAgent/memoryStore 面板 IO 的 B8 迁入落位）——canonical 路径单源在
 * memory/paths.ts；本模块保留同值**正斜杠 rel 形态**镜像（relPath 展示与
 * namespaceOfRel 比对依赖 `/` 分隔，paths.ts 的 path.join 形态不直接可用）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { t } from '../../shared/i18n';
import {
  findConflictPairs,
  findDuplicatePairs,
  isRecoveryRecord,
  selectEntriesForInjection,
  stripLeadingMarkers,
  type DuplicatePair
} from '../../shared/memoryFormat';
import type { MemoryInjectionInfo, MemoryRecoveryItem } from '../../shared/memoryIpc';
import type {
  MemoryCenterApproval,
  MemoryCenterApprovalDecisionResult,
  MemoryCenterApprovalsResult,
  MemoryCenterEntriesResult,
  MemoryCenterEntry,
  MemoryCenterEntryRecall,
  MemoryCenterEvent,
  MemoryCenterEventsOptions,
  MemoryCenterEventsResult,
  MemoryCenterIndexStatus,
  MemoryCenterLogItem,
  MemoryCenterLogPayload,
  MemoryCenterLogResult,
  MemoryCenterNamespace,
  MemoryCenterPreimage,
  MemoryCenterProfileEntry,
  MemoryCenterProfileResult,
  MemoryCenterPurgeResult,
  MemoryCenterRecycleResult,
  MemoryCenterRollbackResult,
  MemoryCenterSearchLabMode,
  MemoryCenterSearchLabResult,
  MemoryCenterStagingItem,
  MemoryCenterStagingMutateResult,
  MemoryCenterStagingResult,
  MemoryCenterProvenance,
  MemoryCenterSupersedesInfo,
  MemoryCenterSupersededItem,
  MemoryCenterSupersededResult,
  MemoryCenterUpdateEntryInput,
  MemoryCenterUpdateEntryResult,
  MemoryCenterUpdateProfileInput,
  MemoryCenterUpdateProfileResult,
  MemoryCenterBadgeResult
} from '../../shared/memoryCenterIpc';
import { parseMemoryEntriesV2, serializeMemoryEntryV2, type MemoryEntryV2 } from './entryFormat';
import {
  aggregateRecallStats,
  countChunks,
  getApproval,
  insertPreimage,
  listApprovals,
  listConsolidationLog,
  type MemoryDb
} from './db';
import {
  decideUserProfileApproval,
  parseProfileApprovalPayload
} from './consolidation/profile';
import {
  readUserProfile,
  writeUserProfile,
  getUserProfileFilePath
} from './userProfile';
import {
  parseProfileEntries,
  serializeProfileEntry,
  USER_PROFILE_MAX_CHARS
} from './entryFormat';
import { decideConsolidationApproval, type ApprovalPayload } from './consolidation/approval';
import { countRejectCategories } from './consolidation/apply';
import { listStagingCandidates, namespaceOfOrigin, type StagingCandidate } from './consolidation/gates';
import { getMemoryService } from './serviceRef';
export {
  memoryCenterIntents,
  memoryCenterCancelIntent,
  memoryCenterRearmIntent
} from './centerState';
import { writeTextAtomicSync } from '../atomicJson';
import {
  countEventsByKind,
  listMemoryEvents,
  type MemoryEventRow
} from './events';
import {
  discardStaging,
  undiscardStaging,
  STAGING_CONSTANTS
} from './staging';
import { SCHEDULER_MEMORY_INJECT_MAX_CHARS } from '../../shared/schedulerMemory';

// ---------------------------------------------------------------------------
// canonical 路径（与 memory/paths.ts 同值；单源在 paths.ts，此处保留正斜杠 rel
// 字符串形态供 relPath 展示与 namespaceOfRel/absToRel 比对——B8 评审收尾注明现状）
// ---------------------------------------------------------------------------

export const WORKER_MEMORY_REL = 'docs/memory/MEMORY.md';
export const SCHEDULER_MEMORY_REL = '.muster/scheduler/MEMORY.md';

export function memoryRelOf(namespace: MemoryCenterNamespace): string {
  return namespace === 'scheduler' ? SCHEDULER_MEMORY_REL : WORKER_MEMORY_REL;
}

export function memoryAbsOf(root: string, namespace: MemoryCenterNamespace): string {
  return path.join(root, ...memoryRelOf(namespace).split('/'));
}

export const MEMORY_RECOVERY_DIR_REL = path.join('docs', 'memory', 'recovery');

/** 巩固命名空间 → 策展核心预算（调度=注入预算单源 shared/schedulerMemory；共享=panelStore 同口径镜像。
 *  原 DIRECT_WRITE_CONSTANTS 已随 MEMORY.md 直写通道退役（2026-10-26 F-01）收口于此。 */
function budgetCharsOf(namespace: MemoryCenterNamespace): number {
  return namespace === 'scheduler' ? SCHEDULER_MEMORY_INJECT_MAX_CHARS : WORKER_INJECTION_BUDGET_CHARS;
}

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** 回滚前现状读取（M3）：读失败≠文件不存在——无安全镜像的覆盖不可逆，必须中止 */
function readCurrentForRollback(p: string): { content: string | null } | { error: string } {
  try {
    return { content: fs.readFileSync(p, 'utf8') };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'ENOENT') return { content: null };
    return { error: t('读取 {{file}} 失败（{{code}}）——已中止回滚（现状无法备份为安全镜像）', { file: p, code: e?.code ?? 'EUNKNOWN' }) };
  }
}

/** 面板 hash 基准：与 memory/paths.contentHash 同算法（sha1 前 16 位） */
export function contentHash16(text: string): string {
  return createHash('sha1').update(text ?? '', 'utf8').digest('hex').slice(0, 16);
}

const sha116 = contentHash16;

// ---------------------------------------------------------------------------
// 条目总览（页签 1）
// ---------------------------------------------------------------------------

function ageDaysOf(ts: string, now: Date): number | null {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const ms = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((now.getTime() - ms) / 86_400_000));
}

function toCenterEntry(
  e: MemoryEntryV2,
  namespace: MemoryCenterNamespace,
  now: Date,
  recall: MemoryCenterEntryRecall | null = null
): MemoryCenterEntry {
  return {
    id: e.id,
    namespace,
    ts: e.ts,
    sessionId: e.sessionId,
    tags: e.tags,
    links: e.links,
    text: e.text,
    raw: e.raw,
    unparsed: e.unparsed,
    trigger: e.annotations.trigger ?? [],
    importance: e.annotations.importance ?? null,
    repoKey: e.annotations.project ?? null,
    // B7 origin 回填：注解由宿主写入路径落（remember=user / 晋升带 staging 真实来源），
    // 旧条目无注解 → null（面板不渲染 OriginDot，不伪造）
    origin: e.annotations.origin ?? null,
    ageDays: ageDaysOf(e.ts, now),
    // 条目 4A 召回热度（近 30 天聚合；派生库不可用=null，渲染层弱灰处理）
    recall,
    // 条目 3 来历/血缘：memoryCenterEntries 统一派生回填（此处占位 null）
    provenance: null,
    supersedes: null
  };
}

// ---------------------------------------------------------------------------
// 召回热度聚合（条目 4A：30 天窗口 GROUP BY chunk_id,kind → 条目归并）
// ---------------------------------------------------------------------------

const RECALL_WINDOW_MS = 30 * 86_400_000;
const INJECTED_KINDS = ['bootstrap', 'brief_injected', 'trigger_injected'] as const;
const HIT_KINDS = ['search_hit', 'escalation_hit'] as const;

/**
 * 条目召回热度映射：memory 条目的 chunk（source_type='memory'）按 source_path +
 * 正文定位（chunkMemorySource 与 parseMemoryEntriesV2 同源解析，text 逐字节同形）。
 * 正文编辑后 chunk 行更换——账目沿继 indexer 整源替换的 recall_stats 迁移机制
 * （db.replaceChunksForSource 同事务 UPDATE chunk_id），此处不做二次迁移。
 * 派生库不可用/查询失败 → null（读取端宽容，条目列表不因召回面炸）。
 */
function recallByEntryOf(
  root: string,
  entries: ReadonlyArray<MemoryCenterEntry>,
  now: Date
): Map<string, MemoryCenterEntryRecall> {
  const out = new Map<string, MemoryCenterEntryRecall>();
  if (!entries.length) return out;
  try {
    const db = openDb(root);
    const chunkRows = db.handle
      .prepare(
        "SELECT id, source_path, text FROM chunks WHERE source_type = 'memory'"
      )
      .all() as Array<{ id: number; source_path: string; text: string }>;
    const aggRows = aggregateRecallStats(db, now.getTime() - RECALL_WINDOW_MS);
    const aggByChunk = new Map<number, { injected: number; hits: number; lastTs: number }>();
    for (const r of aggRows) {
      const injected = INJECTED_KINDS.includes(r.kind as (typeof INJECTED_KINDS)[number]);
      const hit = HIT_KINDS.includes(r.kind as (typeof HIT_KINDS)[number]);
      if (!injected && !hit) continue;
      const cur = aggByChunk.get(r.chunkId) ?? { injected: 0, hits: 0, lastTs: 0 };
      if (injected) cur.injected += r.count;
      else cur.hits += r.count;
      cur.lastTs = Math.max(cur.lastTs, r.lastTs);
      aggByChunk.set(r.chunkId, cur);
    }
    // 正文相同的重复条目（git 并发追加形态）共享同一 chunk 的账目——按 id 归并各自入账
    for (const e of entries) {
      const rel = memoryRelOf(e.namespace);
      const acc = { injected: 0, hits: 0, lastTs: 0 };
      let matched = false;
      for (const c of chunkRows) {
        if (c.source_path !== rel || c.text !== e.text) continue;
        const agg = aggByChunk.get(Number(c.id));
        if (!agg) continue;
        matched = true;
        acc.injected += agg.injected;
        acc.hits += agg.hits;
        acc.lastTs = Math.max(acc.lastTs, agg.lastTs);
      }
      out.set(
        e.id,
        matched
          ? { injected30d: acc.injected, hits30d: acc.hits, lastRecalledAt: acc.lastTs || null }
          : { injected30d: 0, hits30d: 0, lastRecalledAt: null }
      );
    }
  } catch {
    /* 服务未装配/库不可读：recall 恒 null（面板不炸） */
  }
  return out;
}

function listRecoveryItems(root: string): MemoryRecoveryItem[] {
  const out: MemoryRecoveryItem[] = [];
  const dir = path.join(root, MEMORY_RECOVERY_DIR_REL);
  try {
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed: unknown = JSON.parse(readIfExists(path.join(dir, name)) ?? '');
        if (!isRecoveryRecord(parsed)) continue;
        const last = (parsed.removedContent[0] ?? '').split('\n').filter((l) => l.trim()).slice(-1)[0] ?? '';
        out.push({
          id: parsed.id,
          createdAt: parsed.createdAt,
          preview: last.length > 80 ? `${last.slice(0, 80)}…` : last
        });
      } catch {
        /* 单个坏文件不拖垮列表 */
      }
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 共享策展注入预算（与 panelStore.MEMORY_CONTEXT_MAX_CHARS 同口径镜像） */
const WORKER_INJECTION_BUDGET_CHARS = 16_000;

function injectionInfoOf(entries: MemoryEntryV2[]): MemoryInjectionInfo {
  // 注入装箱按现行合同跑在 MemoryEntry（正文含行首标记）上：V2 text 已剥行尾注解，
  // 装箱排序只看 tags/ts，注解剥离不改变选择结果
  const legacy = entries.map((e) => ({
    id: e.id,
    ts: e.ts,
    sessionId: e.sessionId,
    tags: e.tags,
    links: e.links,
    text: stripLeadingMarkers(e.text),
    raw: e.raw,
    unparsed: e.unparsed
  }));
  const sel = selectEntriesForInjection(legacy, WORKER_INJECTION_BUDGET_CHARS);
  return {
    budgetChars: WORKER_INJECTION_BUDGET_CHARS,
    includedIds: sel.selected.map((e) => e.id),
    droppedIds: sel.dropped.map((e) => e.id)
  };
}

/** 策展条目列表（两份 MEMORY.md 合并；重复/矛盾按文件分别检测再合并） */
export function memoryCenterEntries(root: string, now: Date = new Date()): MemoryCenterEntriesResult {
  const entries: MemoryCenterEntry[] = [];
  const duplicates: DuplicatePair[] = [];
  const conflicts: DuplicatePair[] = [];
  const files = {} as MemoryCenterEntriesResult['files'];
  let workerParsed: MemoryEntryV2[] = [];
  for (const namespace of ['worker', 'scheduler'] as const) {
    const abs = memoryAbsOf(root, namespace);
    const content = readIfExists(abs);
    const parsed = content ? parseMemoryEntriesV2(content) : [];
    if (namespace === 'worker') workerParsed = parsed;
    files[namespace] = {
      exists: content != null,
      chars: content?.length ?? 0,
      maxChars: budgetCharsOf(namespace),
      hash: content ? sha116(content) : '',
      relPath: memoryRelOf(namespace)
    };
    entries.push(...parsed.map((e) => toCenterEntry(e, namespace, now)));
    if (parsed.length) {
      duplicates.push(...findDuplicatePairs(parsed));
      conflicts.push(...findConflictPairs(parsed));
    }
  }
  // 条目 4A：召回热度（近 30 天）挂条目卡——一次聚合查询 + 文本映射，不逐条目回表
  const recallMap = recallByEntryOf(root, entries, now);
  for (const e of entries) e.recall = recallMap.get(e.id) ?? null;
  // 条目 3：来历/血缘——一次 log 明细扫描派生（派生库不可用全 null，列表不炸）
  const lineage = buildLineageIndex(root);
  for (const e of entries) {
    e.provenance = provenanceOf(e, lineage);
    e.supersedes = lineage.supersedesByNew.get(e.id) ?? null;
  }
  return {
    files,
    entries,
    duplicates,
    conflicts,
    recovery: listRecoveryItems(root),
    injection: injectionInfoOf(workerParsed),
    profile: memoryCenterProfile()
  };
}

// ---------------------------------------------------------------------------
// 行内注解编辑（stale 防护：内容变化拒绝并返回新内容）
// ---------------------------------------------------------------------------

function normalizeAnnotations(input: MemoryCenterUpdateEntryInput): { trigger?: string[]; importance?: number | null; repoKey?: string | null } {
  const out: { trigger?: string[]; importance?: number | null; repoKey?: string | null } = {};
  if (input.trigger !== undefined) {
    const phrases: string[] = [];
    for (const raw of Array.isArray(input.trigger) ? input.trigger : []) {
      if (typeof raw !== 'string') continue;
      const v = raw.trim();
      if (v && !phrases.includes(v)) phrases.push(v);
    }
    out.trigger = phrases;
  }
  if (input.importance !== undefined) {
    if (input.importance === null) out.importance = null;
    else if (Number.isInteger(input.importance) && input.importance >= 1 && input.importance <= 10) {
      out.importance = input.importance;
    } else {
      throw new Error(t('importance 须为 1–10 整数或空'));
    }
  }
  if (input.repoKey !== undefined) {
    const v = typeof input.repoKey === 'string' ? input.repoKey.trim() : '';
    out.repoKey = v || null;
  }
  return out;
}

/** 注解行内编辑：解析-改写-原子写；stale（hash 不符）返回最新内容拒绝写入 */
export function memoryCenterUpdateEntry(
  root: string,
  input: MemoryCenterUpdateEntryInput,
  now: Date = new Date()
): MemoryCenterUpdateEntryResult {
  const namespace = input.namespace === 'scheduler' ? 'scheduler' : 'worker';
  const abs = memoryAbsOf(root, namespace);
  const content = readIfExists(abs) ?? '';
  const currentHash = content ? sha116(content) : '';
  if ((input.hash ?? '') !== currentHash) {
    const parsed = parseMemoryEntriesV2(content);
    return {
      stale: true,
      hash: currentHash,
      entries: parsed.map((e) => toCenterEntry(e, namespace, now))
    };
  }
  const entries = parseMemoryEntriesV2(content);
  // id 含内容指纹（ts-sid-fnv1a(raw)），条目 raw 一变 id 即变。两段保存的第一段走
  // legacy memory:saveEntry（不渲染行尾注解），重写后 id 必变——id 未命中时按
  // matchText 唯一匹配回退定位；命中不唯一（如同文重复条目）保守报错，不猜。
  let target = entries.find((e) => e.id === input.id);
  if (!target) {
    const needle = input.matchText?.trim();
    if (needle) {
      const hits = entries.filter((e) => !e.unparsed && (e.text === needle || e.text.includes(needle)));
      if (hits.length === 1) target = hits[0];
    }
  }
  if (!target) throw new Error(t('条目不存在或已被删除：{{id}}', { id: input.id }));
  if (target.unparsed) throw new Error(t('格式异常条目请先修复为结构化条目再编辑注解'));
  const patch = normalizeAnnotations(input);
  const annotations = { ...target.annotations };
  if (patch.trigger !== undefined) {
    if (patch.trigger.length) annotations.trigger = patch.trigger;
    else delete annotations.trigger;
  }
  if (patch.importance !== undefined) {
    if (patch.importance != null) annotations.importance = patch.importance;
    else delete annotations.importance;
  }
  if (patch.repoKey !== undefined) {
    if (patch.repoKey) annotations.project = patch.repoKey;
    else delete annotations.project;
  }
  const block = serializeMemoryEntryV2({ ...target, annotations });
  // 替换按**解析后的** target.id（回退定位时 ≠ input.id）
  const next = entries.map((e) => (e.id === target.id ? block : e.raw)).join('\n\n');
  const finalContent = next ? `${next}\n` : '';
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  writeTextAtomicSync(abs, finalContent);
  const reparsed = parseMemoryEntriesV2(finalContent);
  return {
    stale: false,
    hash: sha116(finalContent),
    entries: reparsed.map((e) => toCenterEntry(e, namespace, now))
  };
}

// ---------------------------------------------------------------------------
// 审批队列（页签 3；执行走 B4 decideConsolidationApproval）
// ---------------------------------------------------------------------------

function parseApprovalPayload(raw: string): ApprovalPayload | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return null;
    const p = v as Partial<ApprovalPayload>;
    if (!Array.isArray(p.operations) || !Array.isArray(p.previewDiff)) return null;
    return p as ApprovalPayload;
  } catch {
    return null;
  }
}

/** 已裁决项回执：consolidation_log 里 `approval:<id>:…` 行的 diff 摘要（新→旧取首条） */
function receiptTextsOf(root: string): Map<number, string> {
  const out = new Map<number, string>();
  try {
    const db = openDb(root);
    for (const row of listConsolidationLog(db, 200)) {
      const m = (row.triggerSource ?? '').match(/^approval:(\d+):(approved|rejected)$/);
      if (!m) continue;
      const id = Number(m[1]);
      if (!out.has(id) && row.diffSummary) out.set(id, row.diffSummary);
    }
  } catch {
    /* 服务未装配等：回执列为空即可 */
  }
  return out;
}

function openDb(root: string): MemoryDb {
  const svc = getMemoryService();
  if (!svc) throw new Error(t('记忆服务尚未就绪'));
  return svc.init(root);
}

export function memoryCenterApprovals(root: string): MemoryCenterApprovalsResult {
  const db = openDb(root);
  const receipts = receiptTextsOf(root);
  const items: MemoryCenterApproval[] = [];
  for (const row of listApprovals(db)) {
    const payload = parseApprovalPayload(row.payload);
    const profilePayload = row.action === 'user_md_change' ? parseProfileApprovalPayload(row.payload) : null;
    const namespace: MemoryCenterApproval['namespace'] =
      profilePayload != null
        ? 'profile'
        : payload?.namespace === 'scheduler'
          ? 'scheduler'
          : 'worker';
    items.push({
      id: row.id,
      action: (row.action as MemoryCenterApproval['action']) ?? 'promote',
      state: (row.state as MemoryCenterApproval['state']) ?? 'pending',
      namespace,
      targetFileRel: profilePayload != null ? 'USER.md（userData 全局）' : payload?.targetFileRel ?? memoryRelOf(namespace as MemoryCenterNamespace),
      confidence: row.confidence,
      operations: profilePayload?.operations.length ?? payload?.operations.length ?? 0,
      operationDetails: profilePayload != null
        ? profilePayload.operations.map((op) => ({
            kind: op.op,
            proposedText: op.directive,
            oldText: op.oldDirective ?? null,
            stagingId: op.stagingId
          }))
        : (payload?.operations ?? []).map((op) => ({
            kind: op.op,
            proposedText: op.text,
            oldText: op.oldSnippet ?? null,
            stagingId: op.stagingId
          })),
      previewDiff: profilePayload?.previewDiff ?? payload?.previewDiff ?? [],
      reason: profilePayload?.reason ?? payload?.reason ?? '',
      createdAt: row.createdAt,
      decidedAt: row.decidedAt,
      execution: null,
      error: null,
      receiptText: receipts.get(row.id) ?? null
    });
  }
  items.sort((a, b) => {
    const pendingDelta = Number(b.state === 'pending') - Number(a.state === 'pending');
    if (pendingDelta !== 0) return pendingDelta;
    return b.id - a.id;
  });
  return { items: items.slice(0, 100) };
}

/** 审批角标：pending 计数（侧栏「记忆整理」入口） */
export function memoryCenterBadge(root: string): MemoryCenterBadgeResult {
  try {
    const db = openDb(root);
    return { pending: listApprovals(db, 'pending').length };
  } catch {
    return { pending: 0 };
  }
}

/**
 * 审批裁决：approve=同 B4 验证组装写安全（evidence 由仍 pending 的 staging 行重建，
 * B4 契约）；reject=候选退场。回执含执行结果（applied/mode/hashConflict）。
 */
export function memoryCenterDecideApproval(
  root: string,
  approvalId: number,
  decision: 'approve' | 'reject',
  now: number = Date.now()
): MemoryCenterApprovalDecisionResult {
  const db = openDb(root);
  const row = getApproval(db, approvalId);
  if (!row) {
    return { ok: false, approvalId, decision: decision === 'approve' ? 'approved' : 'rejected', execution: null, error: t('审批不存在') };
  }
  // 已裁决不再拦截：approve 且执行日志显示文件已落盘时 decide 会按日志幂等重放回执
  // （M1 崩溃恢复后用户再点批准 → 看到与首次成功一致的回执，不重放任何写动作）。
  const payload = parseApprovalPayload(row.payload);
  const profilePayload = row.action === 'user_md_change' ? parseProfileApprovalPayload(row.payload) : null;
  const namespace: MemoryCenterApproval['namespace'] =
    profilePayload != null ? 'profile' : payload?.namespace === 'scheduler' ? 'scheduler' : 'worker';
  if (profilePayload) {
    // 画像改动审批（决策 #7）：走 profile.ts 执行链（supersede-in-place / 上限 / 前镜像）
    const result = decideUserProfileApproval(db, approvalId, decision, {
      targetFileAbs: getUserProfileFilePath() ?? '',
      baseHashFn: userProfileSha256,
      now
    });
    const execution = result.ok && result.decision === 'approved'
      ? {
          applied: result.appliedCount,
          total: result.total,
          mode: 'rewrite' as const,
          hashConflict: result.hashConflict,
          ...(result.rejectedCounts && Object.keys(result.rejectedCounts).length ? { rejectedCounts: result.rejectedCounts } : {})
        }
      : null;
    return {
      ok: result.ok,
      approvalId,
      decision: result.decision,
      execution,
      error: result.ok ? null : (result.error ?? t('操作失败')),
      ...(result.code ? { code: result.code } : {})
    };
  }
  // evidence 重建（B4 契约）：从仍 pending 的 staging 行取证据路径
  const ns: MemoryCenterNamespace = namespace === 'profile' ? 'worker' : namespace;
  const pendingStaging = new Map(listStagingCandidates(db).map((c) => [c.stagingId, c]));
  const evidence = (payload?.operations ?? []).map((op) => ({
    stagingId: op.stagingId,
    evidencePath: pendingStaging.get(op.stagingId)?.evidencePath ?? null,
    lineStart: null,
    lineEnd: null,
    origin: pendingStaging.get(op.stagingId)?.origin ?? null
  }));
  const result = decideConsolidationApproval(db, approvalId, decision, {
    // 防御纵深：payload 的目标文件必须正是该命名空间的策展核心（白名单），否则回落
    // canonical 路径——payload 可含任意字符串，不校验会被拼成越权写目标
    targetFileAbs:
      payload?.targetFileRel && namespaceOfRel(payload.targetFileRel) === ns
        ? path.join(root, ...payload.targetFileRel.split('/'))
        : memoryAbsOf(root, ns),
    budgetChars: budgetCharsOf(ns),
    surface: ns,
    now,
    evidence
  });
  const execution = result.ok && result.plan
    ? {
        applied: result.plan.applied.length,
        total: (payload?.operations.length ?? 0),
        mode: result.plan.mode,
        hashConflict: result.plan.hashConflict,
        ...(result.plan.rejected.length
          ? { rejectedCounts: countRejectCategories(result.plan.rejected) }
          : {})
      }
    : null;
  return {
    ok: result.ok,
    approvalId,
    decision: result.decision,
    execution,
    error: result.ok ? null : (result.error ?? t('操作失败')),
    ...(result.code ? { code: result.code } : {})
  };
}

// ---------------------------------------------------------------------------
// 晋升审阅时间线（页签 2）
// ---------------------------------------------------------------------------

function parseRejectedCounts(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/** log 明细 payload 解析（条目 2A 读取端宽容：旧格式行/坏 JSON → null，只显示计数） */
function parseLogPayload(raw: string | null): MemoryCenterLogPayload | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const p = v as Partial<MemoryCenterLogPayload>;
    if (!Array.isArray(p.applied) || !Array.isArray(p.supersededPairs) || !Array.isArray(p.rejected)) {
      return null;
    }
    return p as MemoryCenterLogPayload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 条目生命周期：来历/血缘派生（条目 3，纯读取端从 consolidation_log 明细聚合；
// 一次扫描建索引，entries 与已取代档共用。派生库不可用 → 全空，不炸。）
// ---------------------------------------------------------------------------

interface LogLineageIndex {
  /** entryId → 最近一次入库途径（listConsolidationLog 新→旧扫描 + has 守卫 = 保留最近轮；「经谁生效」取最新口径） */
  appliedByEntry: Map<string, { via: 'sweep' | 'approval'; logId: number }>;
  /** 继任条目 id → 被它取代的旧条目（取最近一次取代） */
  supersedesByNew: Map<string, MemoryCenterSupersedesInfo>;
  /** 全部取代对（retiredAt 倒序；已取代档数据源） */
  supersededItems: MemoryCenterSupersededItem[];
}

function buildLineageIndex(root: string): LogLineageIndex {
  const out: LogLineageIndex = {
    appliedByEntry: new Map(),
    supersedesByNew: new Map(),
    supersededItems: []
  };
  let rows: Array<{ id: number; finishedAt: number; payload: string | null }> = [];
  try {
    rows = listConsolidationLog(openDb(root), 200);
  } catch {
    return out;
  }
  for (const r of rows) {
    const payload = parseLogPayload(r.payload);
    if (!payload) continue;
    // 逐项形状守卫：payload 顶层数组已验，元素可能因手改/异常数据缺字段——坏项跳过不炸整表
    for (const a of payload.applied) {
      if (!a || typeof a !== 'object' || typeof a.entryId !== 'string' || !a.entryId) continue;
      const via = a.source && (a.source.via === 'approval' || a.source.via === 'sweep') ? a.source.via : null;
      if (!via || out.appliedByEntry.has(a.entryId)) continue;
      out.appliedByEntry.set(a.entryId, { via, logId: r.id });
    }
    for (const p of payload.supersededPairs) {
      if (!p || typeof p !== 'object' || typeof p.oldEntryId !== 'string' || !p.oldEntryId) continue;
      const item: MemoryCenterSupersededItem = {
        oldEntryId: p.oldEntryId,
        oldText: typeof p.oldText === 'string' ? p.oldText : '',
        newEntryId: typeof p.newEntryId === 'string' ? p.newEntryId : null,
        newText: typeof p.newText === 'string' ? p.newText : '',
        preimageId: typeof p.preimageId === 'number' ? p.preimageId : null,
        retiredAt: r.finishedAt
      };
      out.supersededItems.push(item);
      if (item.newEntryId && !out.supersedesByNew.has(item.newEntryId)) {
        out.supersedesByNew.set(item.newEntryId, {
          oldEntryId: item.oldEntryId,
          oldText: item.oldText,
          preimageId: item.preimageId,
          retiredAt: item.retiredAt
        });
      }
    }
  }
  out.supersededItems.sort((a, b) => b.retiredAt - a.retiredAt);
  return out;
}

/** 条目来历派生（判定顺序：log 明细命中最优先——「记住」回合的候选经巩固/审批晋升后
 *  条目同样带 origin:user 注解，此时真实来历是「巩固轮 #n」，不得误标直写；
 *  真直写永不进 consolidation_log，不受影响。判定链见 MemoryCenterProvenance 注释） */
function provenanceOf(
  e: { id: string; sessionId: string; origin: MemoryCenterEntry['origin']; unparsed: boolean },
  lineage: LogLineageIndex
): MemoryCenterProvenance | null {
  if (e.unparsed) return null;
  const hit = lineage.appliedByEntry.get(e.id);
  if (hit) {
    return hit.via === 'approval' ? { kind: 'approval', logId: hit.logId } : { kind: 'sweep', logId: hit.logId };
  }
  if (e.origin === 'user') return { kind: 'direct' };
  if (e.sessionId === 'manual') return { kind: 'manual' };
  if (e.sessionId && e.sessionId !== 'memory') return { kind: 'session', sessionId: e.sessionId };
  // 'memory'=巩固晋升固定短 id：旧 log 无明细时兜底为自动入库（无轮次引用）
  if (e.sessionId === 'memory') return { kind: 'sweep', logId: null };
  return null;
}

/** 已取代档（条目 3A）：退役条目只读考古；retiredAt 倒序，超出 limit 截断（渲染层引导搜索） */
export function memoryCenterSuperseded(root: string, limit = 100): MemoryCenterSupersededResult {
  const lineage = buildLineageIndex(root);
  return {
    items: lineage.supersededItems.slice(0, limit),
    total: lineage.supersededItems.length,
    truncated: lineage.supersededItems.length > limit
  };
}

export function memoryCenterLog(root: string, limit = 50): MemoryCenterLogResult {
  const db = openDb(root);
  const items: MemoryCenterLogItem[] = listConsolidationLog(db, limit).map((r) => ({
    id: r.id,
    triggerSource: r.triggerSource,
    addedCount: r.addedCount,
    mergedCount: r.mergedCount,
    supersededCount: r.supersededCount,
    diffSummary: r.diffSummary,
    rejectedCounts: parseRejectedCounts(r.rejectedCounts),
    payload: parseLogPayload(r.payload),
    startedAt: r.startedAt,
    finishedAt: r.finishedAt
  }));
  return { items };
}

// ---------------------------------------------------------------------------
// 记忆事件流（条目 1A 读面）与情景暂存池（条目 6A 读面 + 面板丢弃）
// ---------------------------------------------------------------------------

function toEventDto(r: MemoryEventRow): MemoryCenterEvent {
  return {
    id: r.id,
    kind: r.kind,
    ts: r.ts,
    namespace: r.namespace,
    stagingId: r.stagingId,
    approvalId: r.approvalId,
    chunkId: r.chunkId,
    entryRef: r.entryRef,
    summary: r.summary,
    summaryArgs: r.summaryArgs
  };
}

/** 事件流读取（新→旧，缺省 50 条；附近 24h/7d 按 kind 计数——总览边流量芯片与 hover 取数面） */
export function memoryCenterEvents(
  root: string,
  opts: MemoryCenterEventsOptions = {},
  now: number = Date.now()
): MemoryCenterEventsResult {
  const db = openDb(root);
  const items = listMemoryEvents(db, { limit: opts.limit ?? 50, kinds: opts.kinds?.filter((kind):kind is import('./events').MemoryEventKind => !['auto_admitted','evidence_linked','conflict_suspended','user_deleted'].includes(kind)) }).map(toEventDto);
  let kindCounts24h: Record<string, number> = {};
  let kindCounts7d: Record<string, number> = {};
  try {
    kindCounts24h = countEventsByKind(db, now - 24 * 3_600_000);
    kindCounts7d = countEventsByKind(db, now - 7 * 24 * 3_600_000);
  } catch {
    kindCounts24h = {};
    kindCounts7d = {};
  }
  return { items, kindCounts24h, kindCounts7d };
}

function stagingItemOf(c: StagingCandidate, ttlDays: number): MemoryCenterStagingItem {
  const ns = namespaceOfOrigin(c.origin);
  return {
    stagingId: c.stagingId,
    text: c.text,
    origin: c.origin,
    namespace: ns,
    // 暂存池只载两种状态（装载面已限定）；终态行不出现
    state: c.state === 'user_discarded' ? 'user_discarded' : 'pending',
    createdAt: c.createdAt,
    expireAt: c.createdAt + ttlDays * 86_400_000,
    evidencePath: c.evidencePath,
    chunkId: c.chunkId,
    signals: {
      recallEvents: c.recallEvents,
      uniqueQueries: c.uniqueQueries,
      relevanceMean: c.relevanceMean
    }
  };
}

/** 暂存池列表（pending + user_discarded 灰显行；expireAt 与巩固 TTL 配置同源） */
export function memoryCenterStagingList(
  root: string,
  opts: { ttlDays?: number; now?: number } = {}
): MemoryCenterStagingResult {
  const db = openDb(root);
  const ttlDays = opts.ttlDays ?? STAGING_CONSTANTS.PENDING_TTL_DAYS;
  const now = opts.now ?? Date.now();
  const cands = listStagingCandidates(db, ['pending', 'user_discarded']);
  const items = cands.map((c) => stagingItemOf(c, ttlDays)).sort((a, b) => {
    if (a.state !== b.state) return a.state === 'pending' ? -1 : 1;
    return b.createdAt - a.createdAt || b.stagingId - a.stagingId;
  });
  return {
    items,
    pendingCount: items.filter((i) => i.state === 'pending' && i.expireAt > now).length
  };
}

/** 面板丢弃（pending → user_discarded；随下次 sweep 物理出池） */
export function memoryCenterStagingDiscard(root: string, stagingId: number): MemoryCenterStagingMutateResult {
  if (!Number.isInteger(stagingId) || stagingId <= 0) return { ok: false, error: t('stagingId 不能为空') };
  const db = openDb(root);
  if (!discardStaging(db, stagingId)) {
    return { ok: false, error: t('候选不存在或不在待处理状态') };
  }
  return { ok: true };
}

/** 撤销丢弃（user_discarded → pending；信号/镜像无损恢复） */
export function memoryCenterStagingUndiscard(root: string, stagingId: number): MemoryCenterStagingMutateResult {
  if (!Number.isInteger(stagingId) || stagingId <= 0) return { ok: false, error: t('stagingId 不能为空') };
  const db = openDb(root);
  if (!undiscardStaging(db, stagingId)) {
    return { ok: false, error: t('候选不存在或未被丢弃') };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 检索试验台（条目 5：索引状态页签；只读试玩）
// ---------------------------------------------------------------------------

/** 试验台入参（ipc 层归一后传入） */
export interface MemoryCenterSearchLabInput {
  query: string;
  mode: MemoryCenterSearchLabMode;
}

export function normalizeMemoryCenterSearchLabInput(raw: unknown): MemoryCenterSearchLabInput {
  const o = (raw ?? {}) as { query?: unknown; mode?: unknown };
  const query = typeof o.query === 'string' ? o.query.trim().slice(0, 200) : '';
  if (!query) throw new Error(t('query 不能为空'));
  return { query, mode: 'lex' };
}

/**
 * 试验台检索：top5 + 得分分项（debug 同源），recordStats=false——**不落 recall_stats**，
 * 不污染巩固信号门的真实召回数据（还原即红：检索前后 recall_stats 行数必须不变）。
 */
export async function memoryCenterSearchLab(
  root: string,
  input: MemoryCenterSearchLabInput
): Promise<MemoryCenterSearchLabResult> {
  const svc = getMemoryService();
  if (!svc) throw new Error(t('记忆服务尚未就绪'));
  const hits = await svc.search(root, input.query, {
    topK: 5,
    recordStats: false,
    debug: true
  });
  return {
    query: input.query,
    mode: input.mode,
    hits: hits.map((h) => ({
      chunkId: h.chunkId,
      sourceType: h.sourceType,
      text: h.text,
      rank: h.rank,
      final: h.finalScore,
      debug: h.debug
        ? {
            lexNorm: h.debug.lexNorm,
            recency: h.debug.recency,
            importance: h.debug.importance,
            affinity: h.debug.affinity,
            final: h.debug.final,
            matchedTerms: h.debug.matchedTerms
          }
        : null
    }))
  };
}

// ---------------------------------------------------------------------------
// 回收站（页签 6）：preimages（可回滚）+ 旧 recovery（只读）
// ---------------------------------------------------------------------------

function absToRel(root: string, abs: string): string {
  const norm = path.resolve(abs);
  const rootNorm = path.resolve(root);
  const rel = path.relative(rootNorm, norm).replace(/\\/g, '/');
  return rel.startsWith('..') ? abs : rel;
}

function namespaceOfRel(rel: string): MemoryCenterNamespace | null {
  if (rel === WORKER_MEMORY_REL) return 'worker';
  if (rel === SCHEDULER_MEMORY_REL) return 'scheduler';
  return null;
}

export { namespaceOfRel };

function preimagePreview(content: string): string {
  const last = content.split('\n').filter((l) => l.trim()).slice(-1)[0] ?? '';
  return last.length > 80 ? `${last.slice(0, 80)}…` : last;
}

interface PreimageRow {
  id: number;
  file_path: string;
  content: string;
  content_hash: string;
  cause: string | null;
  created_at: number;
}

export function memoryCenterRecycle(root: string): MemoryCenterRecycleResult {
  const db = openDb(root);
  const rows = db.handle
    .prepare('SELECT * FROM preimages ORDER BY id DESC LIMIT 100')
    .all() as unknown as PreimageRow[];
  const profilePath = getUserProfileFilePath();
  const preimages: MemoryCenterPreimage[] = rows.map((r) => {
    const rel = absToRel(root, r.file_path);
    const ns = namespaceOfRel(rel) ?? (profilePath && r.file_path === profilePath ? 'profile' : null);
    return {
      id: Number(r.id),
      fileRel: rel,
      namespace: ns,
      contentChars: r.content.length,
      contentHash: String(r.content_hash ?? ''),
      cause: r.cause == null ? null : String(r.cause),
      createdAt: Number(r.created_at),
      preview: preimagePreview(r.content)
    };
  });
  return { preimages, recovery: listRecoveryItems(root) };
}

/**
 * 一键回滚到前镜像：现状先另存为新前镜像（回滚可撤销），再原子写回旧内容。
 * 哈希比对：现状与镜像内容一致时不写盘（no-op 成功）。
 */
export function memoryCenterRollback(
  root: string,
  preimageId: number,
  now: number = Date.now()
): MemoryCenterRollbackResult {
  const db = openDb(root);
  const row = db.handle.prepare('SELECT * FROM preimages WHERE id = ?').get(preimageId) as
    | PreimageRow
    | undefined;
  if (!row) {
    return { ok: false, preimageId, fileRel: null, safetyPreimageId: null, error: t('前镜像不存在：{{id}}', { id: preimageId }) };
  }
  const rel = absToRel(root, row.file_path);
  const profilePath = getUserProfileFilePath();
  const isProfile = profilePath != null && row.file_path === profilePath;
  if (namespaceOfRel(rel) === null && !isProfile) {
    return { ok: false, preimageId, fileRel: rel, safetyPreimageId: null, error: t('该镜像的目标文件不再是策展核心：{{rel}}', { rel }) };
  }
  const currentRead = readCurrentForRollback(row.file_path);
  if ('error' in currentRead) {
    return { ok: false, preimageId, fileRel: rel, safetyPreimageId: null, error: currentRead.error };
  }
  const current = currentRead.content;
  if (current != null && current === row.content) {
    return { ok: true, preimageId, fileRel: rel, safetyPreimageId: null, error: null };
  }
  let safetyId: number | null = null;
  if (current != null) {
    safetyId = insertPreimage(db, {
      filePath: row.file_path,
      content: current,
      contentHash: sha116(current),
      cause: `rollback:${preimageId}`,
      now
    });
  }
  try {
    fs.mkdirSync(path.dirname(row.file_path), { recursive: true });
    writeTextAtomicSync(row.file_path, row.content);
  } catch (err) {
    return { ok: false, preimageId, fileRel: rel, safetyPreimageId: safetyId, error: String((err as Error)?.message ?? err) };
  }
  return { ok: true, preimageId, fileRel: rel, safetyPreimageId: safetyId, error: null };
}

/**
 * 彻底删除一条前镜像（不可恢复）。回滚备份仍有 safety 镜像可再回滚，
 * 但本操作把该条历史从库里抹掉——UI 必须走确认框。
 */
export function memoryCenterPurgePreimage(root: string, preimageId: number): MemoryCenterPurgeResult {
  const db = openDb(root);
  const row = db.handle.prepare('SELECT id FROM preimages WHERE id = ?').get(preimageId) as
    | { id: number }
    | undefined;
  if (!row) return { ok: false, id: preimageId, error: t('前镜像不存在：{{id}}', { id: preimageId }) };
  db.write((tx) => tx.prepare('DELETE FROM preimages WHERE id = ?').run(preimageId));
  return { ok: true, id: preimageId, error: null };
}

// ---------------------------------------------------------------------------
// USER.md 画像命名空间（§10，B7）：页签 1 查看 + 直改（人=终审免审，决策 #7）
// ---------------------------------------------------------------------------

/** 画像全文哈希（画像治理乐观并发基线，与 runtime 侧同算法） */
export function userProfileSha256(text: string): string {
  return createHash('sha256').update(text ?? '', 'utf8').digest('hex');
}

function toProfileEntries(md: string): MemoryCenterProfileEntry[] {
  return parseProfileEntries(md).map((e) => ({
    id: e.id,
    observed: e.observed,
    status: e.status,
    directive: e.directive,
    raw: e.raw,
    unparsed: e.unparsed
  }));
}

/** 画像读取（页签 1 画像命名空间；路径未装配=available:false 面板降级展示） */
export function memoryCenterProfile(): MemoryCenterProfileResult {
  const content = readUserProfile();
  if (content == null && !getUserProfileFilePath()) {
    return { available: false, exists: false, hash: '', chars: 0, maxChars: USER_PROFILE_MAX_CHARS, entries: [] };
  }
  const text = content ?? '';
  return {
    available: true,
    exists: content != null,
    hash: userProfileSha256(text),
    chars: text.trim().length,
    maxChars: USER_PROFILE_MAX_CHARS,
    entries: content ? toProfileEntries(content) : []
  };
}

/**
 * 面板直改画像（终审免审，原子写）：edit=原位改写（observed 刷新为当日，status 可标
 * superseded）/ add=追加 / remove=移除。stale（hash 不符）拒绝并返回最新内容；
 * 4000 字符上限超限拒绝保存。**不走审批队列**——人就是审批者（决策 #7）。
 */
export function memoryCenterUpdateProfile(
  input: MemoryCenterUpdateProfileInput,
  now: Date = new Date()
): MemoryCenterUpdateProfileResult {
  const content = readUserProfile() ?? '';
  const currentHash = userProfileSha256(content);
  if ((input?.hash ?? '') !== currentHash) {
    return { stale: true, hash: currentHash, entries: toProfileEntries(content), chars: content.trim().length };
  }
  const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  let entries = parseProfileEntries(content);
  for (const op of input?.ops ?? []) {
    if (op.kind === 'add') {
      const directive = (op.directive ?? '').trim();
      if (!directive) return { stale: false, error: t('画像指令不能为空') };
      entries = [
        ...entries,
        { id: '', observed: dayKey, status: 'active', directive, raw: '', unparsed: false }
      ];
      continue;
    }
    const target = entries.find((e) => e.id === op.id);
    if (!target || target.unparsed) {
      return { stale: false, error: t('画像条目不存在或已失效：{{id}}', { id: op.id ?? '' }) };
    }
    if (op.kind === 'edit') {
      const directive = (op.directive ?? target.directive).trim();
      if (!directive) return { stale: false, error: t('画像指令不能为空') };
      entries = entries.map((e) =>
        e.id === target.id
          ? { ...e, directive, status: op.status ?? e.status, observed: dayKey }
          : e
      );
    } else {
      entries = entries.filter((e) => e.id !== target.id);
    }
  }
  const parts = entries.map((e) => (e.unparsed ? e.raw : serializeProfileEntry(e))).filter((s) => s.trim());
  const next = parts.length ? `${parts.join('\n\n')}\n` : '';
  if (next.trim().length > USER_PROFILE_MAX_CHARS) {
    return {
      stale: false,
      error: t('画像超出 {{max}} 字符上限（当前 {{n}}）——请先合并/淘汰旧指令', { max: USER_PROFILE_MAX_CHARS, n: next.trim().length })
    };
  }
  const r = writeUserProfile(next);
  if (!r.ok) return { stale: false, error: r.message };
  const fresh = readUserProfile() ?? next;
  return {
    stale: false,
    hash: userProfileSha256(fresh),
    entries: toProfileEntries(fresh),
    chars: fresh.trim().length
  };
}

// ---------------------------------------------------------------------------
// 旧格式完整索引读数；正式状态/配置入口在 centerState.ts。
// ---------------------------------------------------------------------------
export function memoryCenterIndexStatus(root: string): MemoryCenterIndexStatus {
  const db = openDb(root);
  const totalChunks = countChunks(db);
  const sourceRows = db.handle
    .prepare('SELECT source_type st, count(*) n FROM chunks GROUP BY source_type ORDER BY st')
    .all() as Array<{ st: string; n: number }>;
  const transcriptRow = db.handle
    .prepare("SELECT count(DISTINCT ingested_session_id) n FROM chunks WHERE source_type = 'transcript'")
    .get() as { n: number };
  return {
    totalChunks,
    sources: sourceRows.map((r) => ({
      sourceType: r.st as MemoryCenterIndexStatus['sources'][number]['sourceType'],
      chunks: Number(r.n)
    })),
    transcriptSessions: Number(transcriptRow?.n ?? 0)
  };
}
