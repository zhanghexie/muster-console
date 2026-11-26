/**
 * 验证组装与写安全（memory-refactor §6.3，代码侧、非模型）：
 * 模型操作决策 → 四硬校验 → 策展文件改写。任一硬校验失败 → 本 sweep 回退
 * append-only（放弃改写，只追加新增）：
 *
 * ① 旧条目损失 ≤0.25（改写删掉的旧字符占原文比例；merge 也按全删计——保守界）；
 * ② 每条晋升带 Source 引用（citation 由代码从候选证据构造，模型不可伪造）；
 * ③ 不超目标文件预算（调度 6000 / Worker 16000，与直写门 R-22 同口径）；
 * ④ 内容哈希乐观并发（构建模型输入时抓哈希，写前重查；外部编辑过→放弃改写走
 *    append 回退，外部内容原样保留）。
 *
 * 另：merge/supersede 的 oldSnippet 须在文件中**唯一**匹配，歧义拒绝该单条操作
 * （不拖垮整个 sweep）。接受改写前全文前镜像入 preimages；写盘原子（atomicJson）。
 *
 * 纯盘上+db 操作（root/db 注入；.mjs 可转译直测）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { MemoryDb } from '../db';
import { insertConsolidationLog, insertPreimage } from '../db';
import { appendEvent, eventNamespaceOfOrigin } from '../events';
import { writeTextAtomicSync } from '../../atomicJson';
import { commitMemoryChanges } from '../../git/memoryCommit';
import { readTextForWrite } from '../fileRead';
import {
  appendEntryToContent,
  parseMemoryEntries
} from '../../../shared/memoryFormat';
import {
  serializeNewEntryWithAnnotations,
  stripOriginAnnotationTail,
  type EntryOriginAnnotation
} from '../entryFormat';
import type {
  MemoryCenterLogAppliedItem,
  MemoryCenterLogPayload,
  MemoryCenterLogRejectedItem,
  MemoryCenterLogSupersededPair
} from '../../../shared/memoryCenterIpc';
import type { MemoryOrigin } from '../db';
import type { ConsolidationOpKind, ModelOperation } from './model';

export const APPLY_CONSTANTS = {
  /** 硬校验①：旧条目损失上界（改写字符比例） */
  MAX_OLD_ENTRY_LOSS: 0.25,
  /** 巩固条目落盘的 Source 引用行前缀 */
  SOURCE_LINE_PREFIX: 'Source: '
} as const;

export type ApplySurface = 'scheduler' | 'worker';

export type ApplyRejectCategory =
  | 'duplicate'
  | 'invalid_op'
  | 'ambiguous'
  | 'missing_source'
  | 'over_loss'
  | 'over_budget'
  | 'hash_conflict'
  | 'model_failed';

export interface ApplyEvidence {
  stagingId: number;
  evidencePath?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  /**
   * 候选的宿主分类来源（B7）：晋升条目的 origin 注解数据源——由 staging 行带出，
   * 模型不可见不可伪造。仅 user/scheduler/worker 落注解；untrusted/system 不落
   * （污点门本就不放行，防御性兜底同口径）。
   */
  origin?: MemoryOrigin | null;
  /**
   * 巩固信号摘要（条目 2A log payload applied[].signals 数据源；sweep 从信号门候选
   * 带出，审批路径可缺省 null）。
   */
  signals?: { recallCount: number | null; relevance: number | null } | null;
}

/** origin 五类 → 注解三类（untrusted/system 不注解） */
export function originAnnotationOf(origin: MemoryOrigin | string | null | undefined): EntryOriginAnnotation | null {
  return origin === 'user' || origin === 'scheduler' || origin === 'worker' ? origin : null;
}

export interface AppliedOp {
  op: ConsolidationOpKind;
  stagingId: number;
  /**
   * 落盘条目 id（ts-sid-指纹，条目 2A log 明细的定位跳转键）：组装阶段解析改写后
   * 全文按正文指纹定位；定位不到为 null（读取端宽容）。
   */
  entryId?: string | null;
  /** merge/supersede：被替换旧条目的 id（改写前全文定位；无=null） */
  oldEntryId?: string | null;
}

export interface RejectedOp {
  category: ApplyRejectCategory;
  op?: ConsolidationOpKind;
  stagingId?: number;
}

export interface ConsolidationWritePlan {
  mode: 'rewrite' | 'append';
  /** 组装后的全文（mode=append 且无可用 add 时等于原文——不写盘） */
  content: string;
  applied: AppliedOp[];
  rejected: RejectedOp[];
  /** 哈希乐观并发冲突（④触发：外部编辑过，已放弃改写走 append） */
  hashConflict: boolean;
  /** 本次是否产生改写（merge/supersede 生效→写前须落前镜像） */
  hasRewrites: boolean;
  /** 本次改写落下的前镜像 id（执行阶段填；未落镜像=null。条目 2A superseded_pairs 用） */
  preimageId?: number | null;
}

// ---------------------------------------------------------------------------
// Source 引用（②：晋升条目的证据链，代码构造、模型不可伪造）
// ---------------------------------------------------------------------------

/** `Source: <path>#L<start>-L<end>`；无路径回 staging#<id>；完全无证据返回 null（触发②） */
export function buildSourceCitation(ev: ApplyEvidence | undefined): string | null {
  const base =
    ev?.evidencePath?.trim() ||
    (ev ? `staging#${ev.stagingId}` : '');
  if (!base) return null;
  if (ev?.lineStart != null && ev.lineEnd != null && ev.lineStart > 0 && ev.lineEnd >= ev.lineStart) {
    return `${APPLY_CONSTANTS.SOURCE_LINE_PREFIX}${base}#L${ev.lineStart}-L${ev.lineEnd}`;
  }
  if (ev?.lineStart != null && ev.lineStart > 0) {
    return `${APPLY_CONSTANTS.SOURCE_LINE_PREFIX}${base}#L${ev.lineStart}`;
  }
  return `${APPLY_CONSTANTS.SOURCE_LINE_PREFIX}${base}`;
}

export function sha256Content(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Compare semantic body, not source citation / generated tags / timestamps. */
export function memoryBodyIdentity(text: string): string {
  return text.replace(/<!--[^]*?-->/g, '')
    .replace(/^Source:.*$/gm, '')
    .replace(/(^|\s)[#＃][^\s#＃，。；、！？]+/g, '$1')
    .replace(/\[\[[^\]\r\n]+\]\]/g, '')
    .normalize('NFC').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// 组装（纯函数：四硬校验 + append 回退决策）
// ---------------------------------------------------------------------------

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at >= 0) {
    n += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

/** 按原文 span 一次性重组改写（调用方保证各 oldSnippet 在 original 中唯一且 span 不重叠） */
function applyRewritesBySpan(
  original: string,
  rewrites: ReadonlyArray<{ oldSnippet: string; body: string }>
): string {
  const spans = rewrites
    .map((r) => {
      const start = original.indexOf(r.oldSnippet);
      return start < 0 ? null : { start, end: start + r.oldSnippet.length, body: r.body };
    })
    .filter((s): s is { start: number; end: number; body: string } => s !== null)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let last = 0;
  for (const s of spans) {
    if (s.start < last) continue;
    out += original.slice(last, s.start) + s.body;
    last = s.end;
  }
  return out + original.slice(last);
}

/** add/替换正文的条目化（surface 各自的现行序列化合同 + Source 引用行 + 真实来源注解；
 *  注解渲染顺序 trigger → importance → project → origin）。
 *  伪造 origin 剥离（B7 评审 MAJOR-1 单点化）：add 面板不自行剥——正文与 citation
 *  分开传给 serializeNewEntryWithAnnotations（剥离唯一收口，先剥后拼 citation；
 *  若这里先拼再传，引用行会挡住收口的尾部匹配）。改写拼接路径（merge/supersede）
 *  不经本函数，见下方组装循环内的剥离点。 */
function buildEntryBlock(
  surface: ApplySurface,
  body: string,
  citation: string,
  now: Date,
  sessionId: string,
  origin?: EntryOriginAnnotation | null
): string {
  return serializeNewEntryWithAnnotations(
    surface === 'scheduler'
      ? { text: body, surface: 'scheduler', sourceCitation: citation, annotations: origin ? { origin } : {} }
      : { sessionId, tags: [], links: [], text: body, sourceCitation: citation, annotations: origin ? { origin } : {} },
    now
  );
}

export interface PlanConsolidationWriteInput {
  currentContent: string;
  /** 模型操作（candidateId 已由 sweep 映射为 stagingId） */
  ops: ReadonlyArray<ModelOperation & { stagingId?: number }>;
  evidence: ReadonlyArray<ApplyEvidence>;
  budgetChars: number;
  surface: ApplySurface;
  now: Date;
  /** 条目注释行里的会话短 id（缺省 'memory'） */
  sessionId?: string;
  /** 'append_only'：哈希冲突回退等场景直接禁改写（拒绝类别 hash_conflict） */
  rewriteMode?: 'auto' | 'append_only';
  /**
   * 硬校验①（旧条目损失界）开关：'file'（缺省）= 按全文 25% 卡改写，自动应用面的
   * 保护；'none' = 跳过——审批路径专用。理由：supersede/merge 从不自动应用（sweep
   * 只自动放行高置信 add），改写操作全部经人工批准，人就是内容门；且损失界分母是
   * 全文字符数，小文件（条目少、单条占比高）换掉任一大条目必超 25%——2026-10-06
   * 生产事故：467 字调度 MEMORY.md 换 224 字 oldSnippet = 48%，五条 merge 审批全部
   * 零应用卡死。审批路径另有前镜像可回滚、预算/引用/哈希门全部保留。
   */
  lossGuard?: 'file' | 'none';
}

/**
 * 组装计划（纯函数）：
 * 1. 逐条分类：无效操作（缺 text/oldSnippet/stagingId）→ invalid_op；
 * 2. merge/supersede 定位：oldSnippet 非**唯一**匹配 → ambiguous（只拒该条）；
 * 3. 硬校验①②③任一失败 → 全部改写操作退场（①over_loss/②missing_source/③over_budget），mode=append；
 * 4. append 模式：add 逐条追加，超预算的 add 拒 over_budget。
 */
export function planConsolidationWrite(input: PlanConsolidationWriteInput): ConsolidationWritePlan {
  const evMap = new Map(input.evidence.map((e) => [e.stagingId, e]));
  const sessionId = input.sessionId ?? 'memory';
  const rejected: RejectedOp[] = [];
  const applied: AppliedOp[] = [];

  interface Shaped {
    op: ConsolidationOpKind;
    stagingId: number;
    body: string;
    oldSnippet?: string;
    citation: string | null;
    /** 候选宿主分类 → origin 注解（晋升条目带真实来源；模型不可伪造） */
    origin: EntryOriginAnnotation | null;
  }
  let adds: Shaped[] = [];
  const rewrites: Shaped[] = [];
  const seenAddStaging = new Set<number>();
  for (const raw of input.ops) {
    const stagingId = raw.stagingId ?? raw.candidateId;
    const ev = evMap.get(stagingId);
    const citation = buildSourceCitation(ev);
    if (!Number.isInteger(stagingId) || stagingId <= 0 || !raw.text) {
      rejected.push({ category: 'invalid_op', op: raw.op, stagingId: stagingId > 0 ? stagingId : undefined });
      continue;
    }
    // 同一 stagingId 最多一条 add——模型抖动重复出 add 不得双写；add+supersede 同源合法
    if (raw.op === 'add' && seenAddStaging.has(stagingId)) {
      rejected.push({ category: 'invalid_op', op: raw.op, stagingId });
      continue;
    }
    if (raw.op === 'add') seenAddStaging.add(stagingId);
    const shaped: Shaped = {
      op: raw.op,
      stagingId,
      body: raw.text,
      oldSnippet: raw.oldSnippet,
      citation,
      origin: originAnnotationOf(ev?.origin)
    };
    if (raw.op === 'add') adds.push(shaped);
    else rewrites.push(shaped);
  }

  // ②前置：完全无证据的晋升条目直接拒（sweep 级——见下 missingSource 分支）
  const missingSourceAdds = adds.filter((a) => !a.citation);
  for (const a of missingSourceAdds) {
    rejected.push({ category: 'missing_source', op: 'add', stagingId: a.stagingId });
  }
  adds = adds.filter((a) => a.citation);

  let mode: 'rewrite' | 'append' = 'append';
  let workingRewrites: Shaped[] = [];
  // 试组装与正式组装共用的 rewrite 映射（oldSnippet + 剥伪造注解正文 + citation）——
  // 「两处同款」的不变量抽这里单点维持，不再靠复制粘贴。
  const rewritePairs = (
    rewrites: readonly Shaped[]
  ): Array<{ oldSnippet: string; body: string }> =>
    rewrites.map((r) => ({
      oldSnippet: r.oldSnippet!,
      body: `${stripOriginAnnotationTail(r.body)}\n${r.citation}`
    }));

  if (input.rewriteMode === 'append_only') {
    // ④哈希冲突回退：改写退场（外部编辑原样保留，只追加 add）
    for (const r of rewrites) {
      rejected.push({ category: 'hash_conflict', op: r.op, stagingId: r.stagingId });
    }
  } else {
    // —— merge/supersede 定位（歧义/互相重叠只拒单条）——
    const located: Shaped[] = [];
    const locatedSpans: Array<{ start: number; end: number }> = [];
    for (const r of rewrites) {
      if (!r.oldSnippet) {
        rejected.push({ category: 'invalid_op', op: r.op, stagingId: r.stagingId });
        continue;
      }
      const n = countOccurrences(input.currentContent, r.oldSnippet);
      if (n !== 1) {
        rejected.push({ category: 'ambiguous', op: r.op, stagingId: r.stagingId });
        continue;
      }
      const start = input.currentContent.indexOf(r.oldSnippet);
      const end = start + r.oldSnippet.length;
      if (locatedSpans.some((s) => start < s.end && end > s.start)) {
        // 与已定位 span 重叠（互为子串）：该条按歧义退场，避免 span 重组时被静默跳过
        rejected.push({ category: 'ambiguous', op: r.op, stagingId: r.stagingId });
        continue;
      }
      locatedSpans.push({ start, end });
      located.push(r);
    }

    // —— 硬校验②（改写面）：任一 merge/supersede 缺 Source 引用 → sweep 级回退 append ——
    const missingSourceRewrites = located.filter((r) => !r.citation);
    // —— 硬校验①：旧条目损失界（merge 按全删计——保守）；审批路径关（lossGuard:'none'，
    // 见 PlanConsolidationWriteInput 注释——小文件条目占比高，按全文比例的损失界
    // 会让人工批准的 merge/supersede 永远过不了）——
    const originalLen = Math.max(1, input.currentContent.length);
    const loss = located.reduce((sum, r) => sum + (r.oldSnippet?.length ?? 0), 0) / originalLen;
    const overLoss = (input.lossGuard ?? 'file') === 'none' ? false : loss > APPLY_CONSTANTS.MAX_OLD_ENTRY_LOSS;

    // —— 硬校验③（改写形态）：与真实组装同款替换+全量追加后的试组装不超预算 ——
    let overBudget = false;
    if (!missingSourceRewrites.length && !overLoss && located.length) {
      let trial = applyRewritesBySpan(input.currentContent, rewritePairs(located));
      for (const a of adds) trial = appendEntryToContent(trial, buildEntryBlock(input.surface, a.body, a.citation!, input.now, sessionId, a.origin));
      overBudget = trial.trim().length > input.budgetChars;
    }

    if (missingSourceRewrites.length || overLoss || overBudget) {
      const category: ApplyRejectCategory = missingSourceRewrites.length
        ? 'missing_source'
        : overLoss
          ? 'over_loss'
          : 'over_budget';
      for (const r of located) rejected.push({ category, op: r.op, stagingId: r.stagingId });
    } else {
      workingRewrites = located;
      mode = 'rewrite';
    }
  }

  // —— 组装（append/改写模式都把可用 add 追加到尾部；超预算的 add 单条拒）——
  let content = input.currentContent;
  // applied 操作的正文指纹轨迹（条目 2A：组装完成后解析全文定位落盘条目 id）
  const appliedTrail: Array<{ ref: AppliedOp; fingerprint: string; oldSnippet?: string }> = [];
  if (workingRewrites.length) {
    // 按原文 offset/span 一次性重组（勿用 String.replace 连环替换：前一条新正文
    // 可能成为后一条 oldSnippet 的命中点）。replacement 正文含 $&/$`/$'/$$ 等
    // 替换序列时字符串形态会被 JS 展开污染结果——这里按 span 切段拼接、天然字面写入。
    // 伪造 origin 剥离：merge/supersede 的拼接正文**不经过**新条目序列化收口
    // （serializeNewEntryWithAnnotations 只组装新条目块），stripOriginAnnotationTail
    // 在此是改写拼接路径上的唯一防线（B8 评审 MAJOR-1 单点化收口时补查发现该路径
    // 此前完全无剥离——实证探针：supersede 正文带伪造注解原样落盘并被解析为注解）；
    // 与 add/直写面的收口互不构成重复防线。
    content = applyRewritesBySpan(input.currentContent, rewritePairs(workingRewrites));
    for (const r of workingRewrites) {
      const ref: AppliedOp = { op: r.op, stagingId: r.stagingId };
      applied.push(ref);
      appliedTrail.push({ ref, fingerprint: stripOriginAnnotationTail(r.body), oldSnippet: r.oldSnippet });
    }
  }
  for (const a of adds) {
    const identity = memoryBodyIdentity(a.body);
    if (!identity || parseMemoryEntries(content).some((entry) => memoryBodyIdentity(entry.text) === identity)) {
      rejected.push({ category: 'duplicate', op: 'add', stagingId: a.stagingId });
      continue;
    }
    const block = buildEntryBlock(input.surface, a.body, a.citation!, input.now, sessionId, a.origin);
    const next = appendEntryToContent(content, block);
    if (next.trim().length > input.budgetChars) {
      rejected.push({ category: 'over_budget', op: 'add', stagingId: a.stagingId });
      continue;
    }
    content = next;
    const ref: AppliedOp = { op: 'add', stagingId: a.stagingId };
    applied.push(ref);
    appliedTrail.push({ ref, fingerprint: stripOriginAnnotationTail(a.body) });
  }

  attachAppliedEntryIds(input.currentContent, content, appliedTrail);

  return {
    mode,
    content,
    applied,
    rejected,
    hashConflict: false,
    hasRewrites: workingRewrites.length > 0
  };
}

/**
 * 落盘条目 id 定位（条目 2A log 明细的 entryId/oldEntryId 数据源）：解析改写前/后
 * 全文，applied 操作按「正文指纹在条目 text 中命中」定位——新条目在改写后全文找
 * （同指纹多命中按 applied 顺序取首个未用项，防同文重复错配），被替换旧条目在改写
 * 前全文找（oldSnippet 已由组装校验唯一）。定位不到保持 null（M2 展开体无跳转即可，
 * 不猜）。纯函数、解析容错（解析失败=全部 null，不抛）。
 */
function attachAppliedEntryIds(
  currentContent: string,
  content: string,
  trail: ReadonlyArray<{ ref: AppliedOp; fingerprint: string; oldSnippet?: string }>
): void {
  if (!trail.length) return;
  let before: ReturnType<typeof parseMemoryEntries> = [];
  let after: ReturnType<typeof parseMemoryEntries> = [];
  try {
    before = parseMemoryEntries(currentContent);
    after = parseMemoryEntries(content);
  } catch {
    return;
  }
  const used = new Set<number>();
  for (const t of trail) {
    if (t.fingerprint) {
      const ni = after.findIndex((e, i) => !used.has(i) && !!e.text && e.text.includes(t.fingerprint));
      if (ni >= 0) {
        used.add(ni);
        t.ref.entryId = after[ni].id;
      }
    }
    if (t.oldSnippet) {
      const oi = before.find((e) => !!e.text && e.text.includes(t.oldSnippet!));
      if (oi) t.ref.oldEntryId = oi.id;
    }
  }
}

// ---------------------------------------------------------------------------
// 落盘（读新内容 + 哈希门 + 前镜像 + 原子写）
// ---------------------------------------------------------------------------

/**
 * 执行已组装的写入计划（前镜像 + 原子写 + superseded 事件）。
 *
 * M1 审批恢复协议的执行原语：审批路径先经 approvalExec 协调器领取/校验后调本函数，
 * sweep 自动应用仍由 applyConsolidationOperations 内联调用。**本函数不重读目标文件**
 * ——调用方负责传入计划所针对的现状内容（`fresh`）并在写前校验现状未变（协调器用
 * 哈希比对完成）。返回落盘的前镜像 id（无改写=null；未写盘=null）。
 */
export function executeConsolidationWritePlan(
  db: MemoryDb,
  input: {
    /** 计划所针对的现状内容（与 plan 组装基线一致；写前不再重读） */
    fresh: string;
    plan: ConsolidationWritePlan;
    ops: ReadonlyArray<ModelOperation & { stagingId?: number }>;
    targetFile: string;
    surface: ApplySurface;
    cause: string;
    root?: string;
    now: number;
  }
): { wrote: boolean; preimageId: number | null } {
  const { plan } = input;
  let preimageId: number | null = null;
  if (plan.hasRewrites) {
    preimageId = insertPreimage(db, {
      filePath: input.targetFile,
      content: input.fresh,
      contentHash: sha256Content(input.fresh),
      cause: input.cause,
      now: input.now
    });
  }
  if (plan.content !== input.fresh) {
    fs.mkdirSync(path.dirname(input.targetFile), { recursive: true });
    writeTextAtomicSync(input.targetFile, plan.content);
    if (input.root) void commitMemoryChanges(input.root);
    const srcOpByStagingId = new Map(
      input.ops.map((o) => [o.stagingId ?? o.candidateId, o] as const)
    );
    for (const a of plan.applied) {
      if (a.op !== 'supersede') continue;
      const src = srcOpByStagingId.get(a.stagingId);
      appendEvent(db, {
        kind: 'superseded',
        ts: input.now,
        namespace: eventNamespaceOfOrigin(input.surface),
        stagingId: a.stagingId,
        // entryRef 指向**新**条目：被取代旧条目已退出策展文件、不在条目总览列表，
        // 指旧 id 会让事件流点击恒落「要定位的条目不在列表里」；旧文考古走回收站。
        entryRef: a.entryId ?? a.oldEntryId ?? null,
        summary: '旧记忆被新结论取代：{{text}}',
        summaryArgs: { text: snippetForEvent(String(src?.oldSnippet ?? '')) }
      });
    }
  }
  return { wrote: plan.content !== input.fresh, preimageId };
}

export interface ApplyConsolidationOperationsInput {
  ops: ReadonlyArray<ModelOperation & { stagingId?: number }>;
  evidence: ReadonlyArray<ApplyEvidence>;
  /** 目标策展文件绝对路径 */
  targetFile: string;
  budgetChars: number;
  surface: ApplySurface;
  /** 构建模型输入时的内容哈希（④乐观并发基线；null=跳过检查） */
  baseHash?: string | null;
  now: number;
  /** 前镜像 cause（sweep 触发源/审批 id） */
  cause: string;
  sessionId?: string;
  /** 工作区根（有则写盘成功后自动 commit docs/memory） */
  root?: string;
}

/**
 * 验证组装 + 写安全执行：
 * 1. 读目标文件**当前**内容（基线=现状，非模型输入快照）；读取失败（EIO/EACCES
 *    等）直接抛出 `MemoryFileReadError` 中止写入（M3：不得当空文件覆盖旧内容）；
 * 2. ④哈希门：当前内容哈希 ≠ baseHash（外部编辑过）→ 禁改写重规划（append 回退，
 *    外部编辑原样保留）；
 * 3. mode=rewrite → 全文前镜像入 preimages（镜像 id 随回执带出——条目 2A
 *    superseded_pairs 的回滚键）；
 * 4. 原子写（内容无变化不写）+ `superseded` 事件（条目 1A 写点收口）。
 */
export function applyConsolidationOperations(
  db: MemoryDb,
  input: ApplyConsolidationOperationsInput
): ConsolidationWritePlan {
  const fresh = readTextForWrite(input.targetFile);
  const currentHash = sha256Content(fresh);
  const hashConflict = input.baseHash != null && currentHash !== input.baseHash;
  const plan = planConsolidationWrite({
    currentContent: fresh,
    ops: input.ops,
    evidence: input.evidence,
    budgetChars: input.budgetChars,
    surface: input.surface,
    now: new Date(input.now),
    sessionId: input.sessionId,
    rewriteMode: hashConflict ? 'append_only' : 'auto'
  });
  const { preimageId } = executeConsolidationWritePlan(db, {
    fresh,
    plan,
    ops: input.ops,
    targetFile: input.targetFile,
    surface: input.surface,
    cause: input.cause,
    root: input.root,
    now: input.now
  });
  return { ...plan, hashConflict, preimageId };
}

/** 事件参数摘要（人话一句不整段入库；80 字截断；approval settle 事件补发共用） */
export function snippetForEvent(text: string): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

// ---------------------------------------------------------------------------
// consolidation_log（§4.2：每次巩固的计数 + 短 diff + 拒绝分类计数）
// ---------------------------------------------------------------------------

export function writeConsolidationLog(
  db: MemoryDb,
  rec: {
    triggerSource: string;
    addedCount: number;
    mergedCount: number;
    supersededCount: number;
    diffSummary?: string;
    rejectedCounts?: Record<string, number>;
    /** 条目 2A 明细 payload（MemoryCenterLogPayload JSON；缺省 null=无明细，兼容旧读端） */
    payload?: string | null;
    startedAt?: number;
    now: number;
  }
): number {
  return insertConsolidationLog(db, {
    triggerSource: rec.triggerSource,
    addedCount: rec.addedCount,
    mergedCount: rec.mergedCount,
    supersededCount: rec.supersededCount,
    diffSummary: rec.diffSummary ?? null,
    rejectedCounts: rec.rejectedCounts ? JSON.stringify(rec.rejectedCounts) : null,
    payload: rec.payload ?? null,
    startedAt: rec.startedAt ?? rec.now,
    now: rec.now
  });
}

/** 拒绝列表 → 分类计数（{ambiguous:2, over_budget:1, …}） */
export function countRejectCategories(rejected: ReadonlyArray<RejectedOp>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rejected) out[r.category] = (out[r.category] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// log 明细 payload 组装（条目 2A：与 consolidation_log 同事务落库的 JSON 明细）
// ---------------------------------------------------------------------------

/** 来源会话引用：evidencePath 去行号（`agent-session:x#L1-L2` → `agent-session:x`） */
export function originSessionRefOf(evidencePath: string | null | undefined): string | null {
  const s = (evidencePath ?? '').trim();
  if (!s) return null;
  return s.split('#')[0] || null;
}

export interface BuildConsolidationLogPayloadInput {
  /** 执行计划（applied 带 entryId/oldEntryId；preimageId=本次前镜像） */
  plan: ConsolidationWritePlan;
  /** 生效的操作原文（text/confidence/oldSnippet 数据源；stagingId 或 candidateId 定位） */
  ops: ReadonlyArray<ModelOperation & { stagingId?: number }>;
  /** 证据（originSessionId/signals 数据源） */
  evidence: ReadonlyArray<ApplyEvidence>;
  /** 生效途径（sweep=高置信自动 / approval=审批批准） */
  via: 'sweep' | 'approval';
  /** 额外拒绝明细（sweep 的信号门/污点门剔除、model_failed、审批驳回退场等） */
  extraRejected?: ReadonlyArray<MemoryCenterLogRejectedItem>;
}

/**
 * 组装 log 明细 payload（写入端收口——所有写 consolidation_log 的巩固路径统一走本
 * 函数产 payload；applied/supersededPairs 与实际写入条目一一对应）。
 */
export function buildConsolidationLogPayload(input: BuildConsolidationLogPayloadInput): MemoryCenterLogPayload {
  const evByStagingId = new Map(input.evidence.map((e) => [e.stagingId, e]));
  const srcByStagingId = new Map(
    input.ops.map((o) => [o.stagingId ?? o.candidateId, o] as const)
  );
  const applied: MemoryCenterLogAppliedItem[] = input.plan.applied.map((a) => {
    const src = srcByStagingId.get(a.stagingId);
    const ev = evByStagingId.get(a.stagingId);
    return {
      op: a.op,
      stagingId: a.stagingId,
      entryId: a.entryId ?? null,
      mergedInto: a.op === 'merge' ? a.oldEntryId ?? null : null,
      // merge：被合并旧条目正文（「新 ⟵ 旧」行展示真实旧文，条目 2B 复审补——
      // 此前只有 mergedInto id 无旧文，展开体只能显示「既有条目」占位）
      oldText: a.op === 'merge' ? String(src?.oldSnippet ?? '') : null,
      text: String(src?.text ?? ''),
      confidence: typeof src?.confidence === 'number' ? src.confidence : null,
      source: {
        stagingId: a.stagingId,
        sessionId: originSessionRefOf(ev?.evidencePath),
        via: input.via
      },
      signals: {
        recallCount: ev?.signals?.recallCount ?? null,
        relevance: ev?.signals?.relevance ?? null
      }
    };
  });
  const supersededPairs: MemoryCenterLogSupersededPair[] = input.plan.applied
    .filter((a) => a.op === 'supersede')
    .map((a) => {
      const src = srcByStagingId.get(a.stagingId);
      return {
        newEntryId: a.entryId ?? null,
        newText: String(src?.text ?? ''),
        oldEntryId: a.oldEntryId ?? null,
        oldText: String(src?.oldSnippet ?? ''),
        preimageId: input.plan.preimageId ?? null
      };
    });
  const rejected: MemoryCenterLogRejectedItem[] = [
    ...(input.extraRejected ?? []),
    ...input.plan.rejected.map((r) => {
      const src = r.stagingId != null ? srcByStagingId.get(r.stagingId) : undefined;
      const ev = r.stagingId != null ? evByStagingId.get(r.stagingId) : undefined;
      return {
        stagingId: r.stagingId ?? null,
        text: String(src?.text ?? ''),
        reasonKey: r.category,
        reasonArgs: null,
        originSessionId: originSessionRefOf(ev?.evidencePath)
      } satisfies MemoryCenterLogRejectedItem;
    })
  ];
  return { applied, supersededPairs, rejected };
}
