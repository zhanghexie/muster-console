/**
 * 巩固 sweep（memory-refactor §6.3 全链装配；一次 = 一个命名空间一个目标文件）：
 *
 *   过期清扫 → 候选装载 → 污点门+命名空间分拣+信号门 → 巩固模型回合（操作决策）
 *   → 置信分档（高置信 add 自动应用；supersede/merge/低置信 → approvals pending+通知）
 *   → 验证组装写安全（apply.ts）→ consolidation_log
 *
 * 审批入队的④乐观并发基线在 auto-apply 写入**之后**回读文件重抓（B4 评审 MAJOR-1：
 * 混批里自动 add 已改写目标文件，旧基线会让用户批准时与「自己刚写的内容」哈希冲突）。
 *
 * 依赖全注入（db/callModel/notify/配置值）——本模块零 electron 链，.mjs 可转译直测
 * （LLM 用 mock）；触发去抖/运行锁在 trigger.ts，模型配置解析在 runtime.ts。
 */
import type { MemoryDb } from '../db';
import { sweepDiscardedStaging, sweepExpiredStaging, transitionStaging } from '../staging';
import { deleteEventsBefore } from '../events';
import { deleteTranscriptChunksBefore } from '../db';
import { readTextFile } from '../fileRead';
import {
  DEFAULT_GATE_THRESHOLDS,
  listStagingCandidates,
  siftCandidates,
  type GateThresholds
} from './gates';
import {
  CONSOLIDATION_MODEL_CONSTANTS,
  runConsolidationModelTurn,
  type ConsolidationModelCall,
  type ConsolidationModelCandidate,
  type ModelOperation
} from './model';
import {
  applyConsolidationOperations,
  buildConsolidationLogPayload,
  buildSourceCitation,
  countRejectCategories,
  originSessionRefOf,
  sha256Content,
  writeConsolidationLog,
  type ApplyEvidence,
  type ConsolidationWritePlan
} from './apply';
import type { MemoryCenterLogRejectedItem } from '../../../shared/memoryCenterIpc';
import {
  enqueueConsolidationApproval,
  toDeferredOperation,
  type DeferredOperation
} from './approval';

export interface ConsolidationSweepDeps {
  db: MemoryDb;
  namespace: 'scheduler' | 'worker';
  /** 工作区根（写盘成功后自动 commit docs/memory） */
  root?: string;
  /** 目标策展文件绝对路径 */
  targetFileAbs: string;
  /** 目标策展文件（工作区相对 posix 路径；审批 payload 用） */
  targetFileRel: string;
  budgetChars: number;
  callModel: ConsolidationModelCall;
  thresholds?: GateThresholds;
  /** pending staging 过期天数（memoryConsolidation.stagingPendingTtlDays） */
  ttlDays?: number;
  /** 高置信 add 自动应用线（memoryConsolidation.highConfidenceAdd） */
  highConfidenceAdd?: number;
  /** transcript chunk 滚动保留天数（memoryConsolidation.transcriptRetentionDays，缺省 90；B8 收尾） */
  transcriptRetentionDays?: number;
  now: number;
  /** 触发源（task_close/session_end/needs_you/idle/manual；进 log） */
  reason: string;
  /** 通知通道（UiBridge.notify 注入；入审批队列时发一条） */
  notify?: (title: string, body: string) => void;
  timeoutMs?: number;
}

export interface ConsolidationSweepSummary {
  namespace: 'scheduler' | 'worker';
  reason: string;
  expiredStaging: number;
  /** 面板丢弃行物理出池条数（条目 6A：user_discarded → 整行删除，随 sweep piggyback） */
  discardedSwept: number;
  /** transcript chunk 滚动淘汰条数（sweep 首步顺带；B8 收尾） */
  transcriptEvicted: number;
  /** memory_events 滚动淘汰条数（条目 1A：保留窗与 transcriptRetentionDays 同源） */
  eventsEvicted: number;
  candidatesTotal: number;
  tainted: number;
  otherNamespace: number;
  gateFailed: number;
  gatePassed: number;
  modelOk: boolean;
  modelError?: string;
  /** 模型引用了不存在的候选（按 model_failed 计） */
  unknownCandidateOps: number;
  autoApplied: { add: number; merge: number; supersede: number };
  deferredApprovalId?: number;
  deferredCount: number;
  plan?: ConsolidationWritePlan;
  logId: number;
}

/** 目标文件三态读取（M3）：失败时 sweep 跳过模型回合/入队，不当空文件处理 */
function readTargetContent(p: string): { ok: true; content: string } | { ok: false; message: string } {
  const r = readTextFile(p);
  if (r.status === 'ok') return { ok: true, content: r.content };
  if (r.status === 'missing') return { ok: true, content: '' };
  return { ok: false, message: `读取 ${p} 失败（${r.code}）：${r.message}` };
}

/** 信号门/污点门逐候选拒绝明细 → log payload rejected 项（条目 2A） */
function gateRejectionsToPayload(
  rejected: ReadonlyArray<{
    stagingId: number;
    text: string;
    evidencePath: string | null;
    reasonKey: string;
    reasonArgs: Record<string, unknown>;
  }>
): MemoryCenterLogRejectedItem[] {
  return rejected.map((r) => ({
    stagingId: r.stagingId,
    text: r.text,
    reasonKey: r.reasonKey,
    reasonArgs: r.reasonArgs,
    originSessionId: originSessionRefOf(r.evidencePath)
  }));
}

/**
 * 执行一次巩固 sweep。全链异常在内消化（返回 summary 携带 error 字段）——
 * 触发层（trigger.ts）无需再兜业务错误。
 */
export async function runConsolidationSweep(deps: ConsolidationSweepDeps): Promise<ConsolidationSweepSummary> {
  const startedAt = deps.now;
  const thresholds = deps.thresholds ?? DEFAULT_GATE_THRESHOLDS;
  const ttlDays = deps.ttlDays ?? 14;
  const highConfidenceAdd = deps.highConfidenceAdd ?? 0.75;

  const summary: ConsolidationSweepSummary = {
    namespace: deps.namespace,
    reason: deps.reason,
    expiredStaging: 0,
    discardedSwept: 0,
    transcriptEvicted: 0,
    eventsEvicted: 0,
    candidatesTotal: 0,
    tainted: 0,
    otherNamespace: 0,
    gateFailed: 0,
    gatePassed: 0,
    modelOk: false,
    unknownCandidateOps: 0,
    autoApplied: { add: 0, merge: 0, supersede: 0 },
    deferredCount: 0,
    logId: 0
  };

  try {
    // ⓪ 滚动淘汰（保留窗缺省 90 天，可配；piggyback 在 sweep，不加新定时子系统）：
    //   transcript chunk（B8；只动 transcript 源——策展/情景 markdown 是 canonical 永不淘汰）
    //   + memory_events（条目 1A：事件账本同源保留窗）+ 面板丢弃行物理出池（条目 6A）
    const retentionDays = deps.transcriptRetentionDays ?? 90;
    summary.transcriptEvicted = deleteTranscriptChunksBefore(
      deps.db,
      deps.now - retentionDays * 86_400_000
    );
    summary.eventsEvicted = deleteEventsBefore(deps.db, deps.now - retentionDays * 86_400_000);
    summary.discardedSwept = sweepDiscardedStaging(deps.db);

    // ① 过期清扫（pending 超 TTL → expired，镜像 chunk 一并删除）
    summary.expiredStaging = sweepExpiredStaging(deps.db, deps.now, ttlDays);

    // ② 候选装载 + 污点门/命名空间/信号门
    const candidates = listStagingCandidates(deps.db, ['pending'], true);
    summary.candidatesTotal = candidates.length;
    const sift = siftCandidates(candidates, deps.namespace, thresholds, deps.now);
    summary.tainted = sift.tainted;
    summary.otherNamespace = sift.otherNamespace;
    summary.gateFailed = sift.gateFailed;
    summary.gatePassed = sift.passed.length;

    const capped = sift.passed.slice(0, CONSOLIDATION_MODEL_CONSTANTS.MAX_CANDIDATES);
    if (!capped.length) {
      summary.logId = writeConsolidationLog(deps.db, {
        triggerSource: `consolidation:${deps.reason}:${deps.namespace}`,
        addedCount: 0,
        mergedCount: 0,
        supersededCount: 0,
        diffSummary: `候选${summary.candidatesTotal}（污点剔除${summary.tainted}/他空间${summary.otherNamespace}/门未过${summary.gateFailed}），过期清扫${summary.expiredStaging}；无门内候选`,
        rejectedCounts: {},
        payload: JSON.stringify(buildConsolidationLogPayload({
          plan: { mode: 'append', content: '', applied: [], rejected: [], hashConflict: false, hasRewrites: false },
          ops: [],
          evidence: [],
          via: 'sweep',
          extraRejected: gateRejectionsToPayload(sift.rejected)
        })),
        startedAt,
        now: deps.now
      });
      return summary;
    }

    // ③ 目标文件快照（模型输入 + ⑥auto-apply 的④哈希乐观并发基线；
    //    审批入队基线在 auto-apply 写入后重抓——见 ⑥ 内 MAJOR-1 修正）。
    //    M3：读失败不进模型回合（空快照会误导操作决策且基线必冲突）——留 log、候选不动
    const targetRead = readTargetContent(deps.targetFileAbs);
    if (!targetRead.ok) {
      summary.modelError = targetRead.message;
      summary.logId = writeConsolidationLog(deps.db, {
        triggerSource: `consolidation:${deps.reason}:${deps.namespace}`,
        addedCount: 0,
        mergedCount: 0,
        supersededCount: 0,
        diffSummary: `门内候选${capped.length}，目标文件读取失败，本轮 sweep 跳过：${targetRead.message}`,
        rejectedCounts: { read_failed: capped.length },
        startedAt,
        now: deps.now
      });
      return summary;
    }
    const targetContent = targetRead.content;
    const baseHash = sha256Content(targetContent);
    const evidence: ApplyEvidence[] = capped.map((c) => ({
      stagingId: c.stagingId,
      evidencePath: c.evidencePath,
      lineStart: null,
      lineEnd: null,
      origin: c.origin,
      signals: { recallCount: c.recallEvents, relevance: c.relevanceMean }
    }));
    const modelCandidates: ConsolidationModelCandidate[] = [];
    for (let i = 0; i < capped.length; i += 1) {
      const citation = buildSourceCitation(evidence[i]);
      if (!citation) continue; // 完全无证据的候选不进提示词（②硬校验同源拒收）
      modelCandidates.push({ candidate: capped[i], citation });
    }

    // ④ 巩固模型回合（操作决策 JSON；失败→model_failed 全军退场，不动策展文件）
    const outcome = await runConsolidationModelTurn({
      curatedContent: targetContent,
      candidates: modelCandidates,
      callModel: deps.callModel,
      timeoutMs: deps.timeoutMs
    });
    if (!outcome.ok) {
      summary.modelError = outcome.error;
      summary.logId = writeConsolidationLog(deps.db, {
        triggerSource: `consolidation:${deps.reason}:${deps.namespace}`,
        addedCount: 0,
        mergedCount: 0,
        supersededCount: 0,
        diffSummary: `门内候选${capped.length}，模型回合失败：${outcome.error ?? ''}`,
        rejectedCounts: { model_failed: capped.length },
        payload: JSON.stringify(buildConsolidationLogPayload({
          plan: { mode: 'append', content: '', applied: [], rejected: [], hashConflict: false, hasRewrites: false },
          ops: [],
          evidence: [],
          via: 'sweep',
          extraRejected: [
            ...capped.map((c) => ({
              stagingId: c.stagingId,
              text: c.text,
              reasonKey: 'model_failed',
              reasonArgs: { error: outcome.error ?? '' },
              originSessionId: originSessionRefOf(c.evidencePath)
            })),
            ...gateRejectionsToPayload(sift.rejected)
          ]
        })),
        startedAt,
        now: deps.now
      });
      return summary;
    }
    summary.modelOk = true;

    // ⑤ 候选映射（模型引用未知候选 → model_failed 计数丢弃）
    const byStagingId = new Map(capped.map((c) => [c.stagingId, c]));
    const evByStagingId = new Map(evidence.map((e) => [e.stagingId, e]));
    const validOps: Array<ModelOperation & { stagingId: number }> = [];
    const modelFailedItems: MemoryCenterLogRejectedItem[] = [];
    for (const op of outcome.operations ?? []) {
      const sid = op.candidateId;
      if (!byStagingId.has(sid)) {
        summary.unknownCandidateOps += 1;
        modelFailedItems.push({
          stagingId: sid,
          text: '',
          reasonKey: 'model_failed',
          reasonArgs: { candidateId: sid },
          originSessionId: null
        });
        continue;
      }
      validOps.push({ ...op, stagingId: sid });
    }

    // ⑥ 置信分档：高置信 add 自动应用；supersede/merge/低置信 add → approvals pending
    const autoOps = validOps.filter((o) => o.op === 'add' && o.confidence >= highConfidenceAdd);
    const deferredOps = validOps.filter((o) => !(o.op === 'add' && o.confidence >= highConfidenceAdd));
    const rejectedCounts: Record<string, number> = {};
    if (summary.unknownCandidateOps) rejectedCounts.model_failed = summary.unknownCandidateOps;

    if (autoOps.length) {
      const plan = applyConsolidationOperations(deps.db, {
        root: deps.root,
        ops: autoOps,
        evidence,
        targetFile: deps.targetFileAbs,
        budgetChars: deps.budgetChars,
        surface: deps.namespace,
        baseHash,
        now: deps.now,
        cause: `consolidation:${deps.reason}`,
        sessionId: 'memory'
      });
      summary.plan = plan;
      for (const a of plan.applied) {
        if (transitionStaging(deps.db, a.stagingId, 'promoted')) {
          summary.autoApplied[a.op] += 1;
        }
      }
      for (const [k, v] of Object.entries(countRejectCategories(plan.rejected))) {
        rejectedCounts[k] = (rejectedCounts[k] ?? 0) + v;
      }
    }

    if (deferredOps.length) {
      const deferred: DeferredOperation[] = [];
      for (const op of deferredOps) {
        const d = toDeferredOperation(op, op.stagingId, evByStagingId.get(op.stagingId));
        if (d) deferred.push(d);
        else rejectedCounts.missing_source = (rejectedCounts.missing_source ?? 0) + 1;
      }
      if (deferred.length) {
        // 审批基线重抓（B4 评审 MAJOR-1）：⑥auto-apply 的 add 已在本 sweep 内改写
        // 目标文件——入队审批的④基线必须取**写入后**的现状，否则用户批准时与自己的
        // auto-apply 产物哈希冲突、0/N 应用（真外部编辑产生的冲突仍在 approve 时检出）。
        // 无 auto-apply（autoOps 为空/全部被拒）时文件未动，重读结果与 ③ 快照一致。
        // M3：读失败不硬入队（错误基线会静默冲突）——候选保持 pending，留 log。
        const baseRead = readTargetContent(deps.targetFileAbs);
        if (!baseRead.ok) {
          rejectedCounts.read_failed = (rejectedCounts.read_failed ?? 0) + deferred.length;
          summary.logId = writeConsolidationLog(deps.db, {
            triggerSource: `consolidation:${deps.reason}:${deps.namespace}`,
            addedCount: summary.autoApplied.add,
            mergedCount: summary.autoApplied.merge,
            supersededCount: summary.autoApplied.supersede,
            diffSummary: `候选${summary.candidatesTotal}（门过${summary.gatePassed}），自动 add${summary.autoApplied.add}；审批基线读取失败未入队：${baseRead.message}`,
            rejectedCounts,
            startedAt,
            now: deps.now
          });
          return summary;
        }
        const approvalBase = baseRead.content;
        summary.deferredApprovalId = enqueueConsolidationApproval(deps.db, {
          namespace: deps.namespace,
          targetFileRel: deps.targetFileRel,
          baseHash: sha256Content(approvalBase),
          baseContentChars: approvalBase.length,
          operations: deferred,
          reason: deps.reason,
          now: deps.now
        });
        summary.deferredCount = deferred.length;
        try {
          deps.notify?.(
            '记忆巩固待审批',
            `${deferred.length} 项记忆操作待确认（${deps.namespace === 'scheduler' ? '调度' : 'Worker'}策展；含 ${deferred.filter((d) => d.op !== 'add').length} 项改写）`
          );
        } catch {
          /* 通知失败不影响巩固 */
        }
      }
    }

    summary.logId = writeConsolidationLog(deps.db, {
      triggerSource: `consolidation:${deps.reason}:${deps.namespace}`,
      addedCount: summary.autoApplied.add,
      mergedCount: summary.autoApplied.merge,
      supersededCount: summary.autoApplied.supersede,
      diffSummary: [
        `候选${summary.candidatesTotal}（污点${summary.tainted}/他空间${summary.otherNamespace}/门未过${summary.gateFailed}/门过${summary.gatePassed}）`,
        `自动 add${summary.autoApplied.add}`,
        summary.plan ? `mode=${summary.plan.mode}${summary.plan.hashConflict ? '（哈希冲突回退 append）' : ''}` : '',
        summary.deferredApprovalId ? `审批#${summary.deferredApprovalId} 待${summary.deferredCount}项` : ''
      ]
        .filter(Boolean)
        .join('，'),
      rejectedCounts,
      payload: JSON.stringify(
        buildConsolidationLogPayload({
          plan: summary.plan ?? {
            mode: 'append',
            content: '',
            applied: [],
            rejected: [],
            hashConflict: false,
            hasRewrites: false
          },
          ops: autoOps,
          evidence,
          via: 'sweep',
          extraRejected: [
            ...gateRejectionsToPayload(sift.rejected),
            ...modelFailedItems
          ]
        })
      ),
      startedAt,
      now: deps.now
    });
    return summary;
  } catch (err) {
    // 全链兜底：任何意外（盘上/db 异常）落 log 不上抛——触发层零业务兜底负担
    summary.modelError = String((err as Error)?.message ?? err);
    try {
      summary.logId = writeConsolidationLog(deps.db, {
        triggerSource: `consolidation:${deps.reason}:${deps.namespace}`,
        addedCount: 0,
        mergedCount: 0,
        supersededCount: 0,
        diffSummary: `sweep 异常：${summary.modelError}`,
        rejectedCounts: { model_failed: 1 },
        startedAt,
        now: deps.now
      });
    } catch {
      /* log 写失败也不再抛 */
    }
    return summary;
  }
}
