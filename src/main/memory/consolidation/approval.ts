/**
 * 置信分档与审批（memory-refactor §6.3 / §4.2 approvals 表）：
 * - 高置信 add（confidence ≥ highConfidenceAdd，缺省 0.75）→ 自动应用；
 * - supersede/merge 与低置信 add → approvals 表 pending（payload 带操作与预览 diff）
 *   + 现有通知通道发一条（UiBridge.notify 注入；B6 面板只渲染）；
 * - approve → 同 apply.ts 的验证组装与写安全（含哈希乐观并发）；reject → 对应
 *   staging 行 rejected（候选退场，镜像 chunk 一并清理）。
 *
 * approvals.action 取 CHECK 域内语义：含 supersede 操作 → 'supersede'，否则 'promote'。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MemoryDb } from '../db';
import { getApproval, getApprovalExec, insertPreimage } from '../db';
import { appendEvent, eventNamespaceOfOrigin } from '../events';
import { transitionStaging } from '../staging';
import { readTextForWrite } from '../fileRead';
import { writeTextAtomicSync } from '../../atomicJson';
import { commitMemoryChanges } from '../../git/memoryCommit';
import {
  planConsolidationWrite,
  sha256Content,
  snippetForEvent,
  buildConsolidationLogPayload,
  buildSourceCitation,
  countRejectCategories,
  writeConsolidationLog,
  type ApplyEvidence,
  type ApplyRejectCategory,
  type ApplySurface,
  type ConsolidationWritePlan
} from './apply';
import {
  executeApprovalFilePhase,
  settleApprovalDecision,
  approvalExecRejectGuard,
  type ApprovalExecFailureCode,
  type ApprovalExecPlan
} from './approvalExec';
import type { ModelOperation } from './model';

/** 进审批的延时操作（payload 序列化形态；citation 由代码构造随 payload 走） */
export interface DeferredOperation extends ModelOperation {
  stagingId: number;
  citation: string;
}

export interface ApprovalPayload {
  namespace: 'scheduler' | 'worker';
  /** 目标策展文件（工作区相对 posix 路径） */
  targetFileRel: string;
  /** 入队时目标文件内容哈希（approve 时④乐观并发基线） */
  baseHash: string;
  baseContentChars: number;
  operations: DeferredOperation[];
  /** 预览 diff（一行一操作；B6 面板渲染） */
  previewDiff: string[];
  /** 入队原因（触发源） */
  reason: string;
}

export function buildPreviewDiff(ops: ReadonlyArray<DeferredOperation>): string[] {
  return ops.map((o) => {
    const head = o.text.slice(0, 60).replace(/\s+/g, ' ');
    if (o.op === 'add') return `+ 新增：${head}`;
    if (o.op === 'merge') return `~ 合并（替换旧片段）：${head}`;
    return `- 取代（旧片段退役）：${head}`;
  });
}

export function toDeferredOperation(
  op: ModelOperation,
  stagingId: number,
  evidence: ApplyEvidence | undefined
): DeferredOperation | null {
  const citation = buildSourceCitation(evidence);
  if (!citation) return null;
  return { ...op, stagingId, citation };
}

/** 入队一条审批（action 语义见模块头）；返回 approval id。
 *  `approval_queued` 事件（条目 1A 写点收口）：与 approvals 插入同事务（db.write
 *  可重入），恰好一行事件；事件失败只打日志不阻塞入队。 */
export function enqueueConsolidationApproval(
  db: MemoryDb,
  input: {
    namespace: 'scheduler' | 'worker';
    targetFileRel: string;
    baseHash: string;
    baseContentChars: number;
    operations: ReadonlyArray<DeferredOperation>;
    reason: string;
    now: number;
  }
): number {
  const payload: ApprovalPayload = {
    namespace: input.namespace,
    targetFileRel: input.targetFileRel,
    baseHash: input.baseHash,
    baseContentChars: input.baseContentChars,
    operations: [...input.operations],
    previewDiff: buildPreviewDiff(input.operations),
    reason: input.reason
  };
  return db.write((tx) => {
    // A candidate has at most one live proposal, irrespective of model wording or sweep id.
    const pending = tx.prepare("SELECT id, payload FROM approvals WHERE state = 'pending'").all() as Array<{ id: number; payload: string }>;
    const owned = new Map<number, number>();
    for (const row of pending) {
      const prior = JSON.parse(row.payload) as ApprovalPayload;
      for (const op of prior.operations ?? []) owned.set(op.stagingId, row.id);
    }
    const repeated = payload.operations.map((op) => owned.get(op.stagingId)).find((id) => id != null);
    payload.operations = payload.operations.filter((op) => !owned.has(op.stagingId));
    if (!payload.operations.length && repeated != null) return repeated;
    if (!payload.operations.length) throw new Error('没有可审批的操作');
    payload.previewDiff = buildPreviewDiff(payload.operations);
    const action = payload.operations.some((o) => o.op === 'supersede') ? 'supersede' : 'promote';
    const confidence = payload.operations.reduce((m, o) => Math.min(m, o.confidence), 1);
    const info = tx
      .prepare('INSERT INTO approvals (action, payload, confidence, state, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(action, JSON.stringify(payload), confidence, 'pending', input.now);
    const approvalId = Number(info.lastInsertRowid);
    appendEvent(db, {
      kind: 'approval_queued',
      ts: input.now,
      namespace: input.namespace,
      approvalId,
      entryRef: `approval:${approvalId}`,
      summary: '记忆晋升待审：{{count}} 项操作等你把关',
      summaryArgs: { count: input.operations.length, reason: input.reason }
    });
    return approvalId;
  });
}

export interface ApprovalDecisionResult {
  ok: boolean;
  error?: string;
  /** 失败分类（busy/read_failed/write_failed/conflict/zero_applied；ok=false 时在场） */
  code?: ApprovalExecFailureCode;
  approvalId: number;
  decision: 'approved' | 'rejected';
  /** approve 时的写安全计划（拒绝分类计数用）；reject 时无 */
  plan?: ConsolidationWritePlan;
  /** 被退场的 staging 行数（reject 路径；approve 路径=成功晋升数） */
  stagingSettled: number;
}

export interface ApprovalExecutionDeps {
  /** 工作区根（写盘成功后自动 commit docs/memory） */
  root?: string;
  targetFileAbs: string;
  budgetChars: number;
  surface: ApplySurface;
  now: number;
  evidence: ReadonlyArray<ApplyEvidence>;
}

/** settleJson 形状（approval_exec 日志行内的执行事实；恢复收尾与幂等重放数据源） */
interface ConsolidationSettleFacts {
  mode: 'rewrite' | 'append';
  hashConflict: boolean;
  applied: Array<{ op: string; stagingId: number; entryId?: string | null; oldEntryId?: string | null }>;
  rejected: Array<{ category: string; op?: string; stagingId?: number }>;
  preimageId?: number | null;
}

/** settleJson → 回执用 plan 形状（content 不回放；读取端只用 applied/mode/hashConflict） */
function planOfFacts(facts: ConsolidationSettleFacts): ConsolidationWritePlan {
  return {
    mode: facts.mode,
    content: '',
    applied: facts.applied.map((a) => ({
      op: a.op as 'add' | 'merge' | 'supersede',
      stagingId: a.stagingId,
      entryId: a.entryId ?? null,
      oldEntryId: a.oldEntryId ?? null
    })),
    rejected: facts.rejected.map((r) => ({
      category: r.category as ApplyRejectCategory,
      op: r.op as 'add' | 'merge' | 'supersede' | undefined,
      stagingId: r.stagingId
    })),
    hashConflict: facts.hashConflict,
    hasRewrites: false,
    preimageId: facts.preimageId ?? null
  };
}

/** decide 的文件阶段闭包（读取/哈希/纯组装/写前准备/写盘）；导出供多进程恢复测试
 *  以与生产完全相同的执行面介入（子进程用同款 hooks 持有 claim、模拟崩溃窗口）。 */
export interface ConsolidationApprovalFileHooks {
  readFile: () => string;
  hashOf: (content: string) => string;
  buildPlan: (current: string) => ApprovalExecPlan;
  /** 写前准备（前镜像 + 关联回写；同事务）；settleJson 已带 preimageId 时幂等跳过 */
  prepareWrite: (plan: ApprovalExecPlan, fresh: string, settleJson: string) => string;
  /** 原子写正文（只写文件 + git commit；镜像/事件分别由 prepareWrite/settle 收口） */
  writeContent: (plannedContent: string) => void;
  /** 收尾事务内补发写盘类事件（superseded；靠翻转守卫恰好一次——r1-P2③） */
  emitSettleEvents: (settleJson: string) => void;
}

export function consolidationApprovalFileHooks(
  db: MemoryDb,
  approvalId: number,
  payload: ApprovalPayload,
  deps: ApprovalExecutionDeps,
  state: { plan: ConsolidationWritePlan | null; hashConflict: boolean } = { plan: null, hashConflict: false }
): ConsolidationApprovalFileHooks {
  return {
    readFile: () => readTextForWrite(deps.targetFileAbs),
    hashOf: sha256Content,
    buildPlan: (current) => {
      const currentHash = sha256Content(current);
      const hashConflict = payload.baseHash != null && currentHash !== payload.baseHash;
      // An approval authorizes the displayed revision, never a new append after it changed.
      if (hashConflict) return {
        baseHash: currentHash, plannedContent: current, appliedCount: 0,
        settleJson: JSON.stringify({ mode: 'append', hashConflict: true, applied: [],
          rejected: payload.operations.map((op) => ({ category: 'hash_conflict', op: op.op, stagingId: op.stagingId })), preimageId: null })
      };
      const activeOperations = payload.operations.filter((op) => {
        const row = db.handle.prepare('SELECT state FROM staging WHERE id = ?').get(op.stagingId) as {state: string} | undefined;
        return row?.state === 'pending';
      });
      const plan = planConsolidationWrite({
        currentContent: current,
        ops: activeOperations,
        evidence: deps.evidence,
        budgetChars: deps.budgetChars,
        surface: deps.surface,
        now: new Date(deps.now),
        sessionId: 'memory',
        rewriteMode: hashConflict ? 'append_only' : 'auto',
        // 审批路径关损失界：merge/supersede 全经人工批准（人即内容门），且按全文比例的
        // 损失界在小文件上必然误拦（2026-10-06 生产事故：467 字调度文件换 224 字片段
        // = 48% > 25%，五条审批全部零应用）；预算/引用/哈希门与前镜像回滚仍全部生效
        lossGuard: 'none'
      });
      state.plan = plan;
      state.hashConflict = hashConflict;
      const facts: ConsolidationSettleFacts = {
        mode: plan.mode,
        hashConflict,
        applied: plan.applied.map((a) => ({ ...a })),
        rejected: plan.rejected.map((r) => ({ ...r })),
        preimageId: null
      };
      return {
        baseHash: currentHash,
        plannedContent: plan.content,
        settleJson: JSON.stringify(facts),
        appliedCount: plan.applied.length
      };
    },
    prepareWrite: (plan, fresh, settleJson) => {
      const facts: ConsolidationSettleFacts = JSON.parse(settleJson) as ConsolidationSettleFacts;
      const hasRewrites = facts.applied.some((a) => a.op !== 'add');
      if (hasRewrites && facts.preimageId == null) {
        // 前镜像先于写盘落库，且与 preimageId 入日志同事务（r1-P2③：崩溃后关联不丢）。
        // r2-P2③：接管重规划的新 settle 事实 preimageId 为空——按（cause+文件+内容）
        // 复用上一 attempt 已持久化的镜像身份（文件未写盘时 fresh 与当时一致），
        // 不重复落镜像（prepare 后中断/写前读失败重试：镜像 1 份不变）。
        const cause = `approval:${approvalId}`;
        const prior = db.handle
          .prepare('SELECT id FROM preimages WHERE file_path = ? AND cause = ? AND content = ? ORDER BY id LIMIT 1')
          .get(deps.targetFileAbs, cause, fresh) as { id: number } | undefined;
        facts.preimageId = prior
          ? Number(prior.id)
          : insertPreimage(db, {
              filePath: deps.targetFileAbs,
              content: fresh,
              contentHash: sha256Content(fresh),
              cause,
              now: deps.now
            });
      }
      return JSON.stringify(facts);
    },
    writeContent: (plannedContent) => {
      fs.mkdirSync(path.dirname(deps.targetFileAbs), { recursive: true });
      writeTextAtomicSync(deps.targetFileAbs, plannedContent);
      if (deps.root) void commitMemoryChanges(deps.root);
    },
    emitSettleEvents: (settleJson) => {
      const facts = JSON.parse(settleJson) as ConsolidationSettleFacts;
      const srcByStagingId = new Map(
        payload.operations.map((o) => [o.stagingId ?? o.candidateId, o] as const)
      );
      for (const a of facts.applied) {
        if (a.op !== 'supersede') continue;
        const src = srcByStagingId.get(a.stagingId);
        appendEvent(db, {
          kind: 'superseded',
          ts: deps.now,
          namespace: eventNamespaceOfOrigin(deps.surface),
          stagingId: a.stagingId,
          // entryRef 指向**新**条目：被取代旧条目已退出策展文件；旧文考古走回收站。
          entryRef: a.entryId ?? a.oldEntryId ?? null,
          summary: '旧记忆被新结论取代：{{text}}',
          summaryArgs: { text: snippetForEvent(String(src?.oldSnippet ?? '')) }
        });
      }
    }
  };
}

/**
 * 审批执行：approve = 经 approvalExec 恢复协议的「领取→写盘→收尾」（同一操作重试/
 * 重启不重复应用正文；两进程竞争至多一方执行，另一方明确 busy）；reject = 单事务
 * 原子退场。裁决幂等：非 pending 拒改；已 approved 且有执行日志时按日志幂等重放回执。
 */
export function decideConsolidationApproval(
  db: MemoryDb,
  approvalId: number,
  decision: 'approve' | 'reject',
  deps: ApprovalExecutionDeps
): ApprovalDecisionResult {
  const row = getApproval(db, approvalId);
  if (!row) return { ok: false, error: '审批不存在', approvalId, decision: decision === 'approve' ? 'approved' : 'rejected', stagingSettled: 0 };
  if (row.state !== 'pending') {
    // 幂等重放（崩溃恢复后用户再点批准）：已 approved 且执行日志显示文件已落盘 →
    // 返回与首次成功一致的回执（事实来自 settle_json，不重放任何写动作）
    if (decision === 'approve' && row.state === 'approved') {
      const journal = getApprovalExec(db, approvalId);
      if (journal && journal.phase === 'file_applied') {
        try {
          const facts = JSON.parse(journal.settleJson) as ConsolidationSettleFacts;
          return { ok: true, approvalId, decision: 'approved', plan: planOfFacts(facts), stagingSettled: facts.applied.length };
        } catch {
          /* settle_json 损坏 → 落回已裁决回执 */
        }
      }
    }
    return { ok: false, error: `审批已裁决（state=${row.state}）`, approvalId, decision: decision === 'approve' ? 'approved' : 'rejected', stagingSettled: 0 };
  }
  let payload: ApprovalPayload;
  try {
    payload = JSON.parse(row.payload) as ApprovalPayload;
  } catch {
    settleApprovalDecision(db, {
      approvalId,
      state: 'rejected',
      now: deps.now,
      onSettle: () => {
        appendEvent(db, {
          kind: 'approval_decided',
          ts: deps.now,
          namespace: 'worker',
          approvalId,
          entryRef: `approval:${approvalId}`,
          summary: '审批已驳回（payload 损坏，{{count}} 项操作退场）',
          summaryArgs: { decision: 'rejected', count: 0, error: 'payload 解析失败' }
        });
      }
    }); // 坏 payload 无法执行，标记退场防卡队列
    return { ok: false, error: '审批 payload 解析失败（已标记 rejected）', approvalId, decision: 'rejected', stagingSettled: 0 };
  }

  if (decision === 'reject') {
    // 单事务原子退场：执行日志前置检（r1-P1②：文件已写/在途时阻断，防「正文已写
    // 但裁决=驳回」的账实分裂）→ 状态翻转 + staging 退场 + 日志 + 事件一气呵成
    // （崩溃即整体回滚，重试再驳回——不存在「驳了但候选没退场」的中间态）
    let settled = 0;
    const outcome = settleApprovalDecision(db, {
      approvalId,
      state: 'rejected',
      now: deps.now,
      preCheck: () =>
        approvalExecRejectGuard(db, {
          approvalId,
          now: deps.now,
          readFile: () => readTextForWrite(deps.targetFileAbs),
          hashOf: sha256Content
        }),
      onSettle: () => {
        for (const op of payload.operations) {
          if (transitionStaging(db, op.stagingId, 'rejected')) settled += 1;
        }
        writeConsolidationLog(db, {
          triggerSource: `approval:${approvalId}:rejected`,
          addedCount: 0,
          mergedCount: 0,
          supersededCount: 0,
          diffSummary: `审批拒绝：${payload.operations.length} 项操作退场（${payload.reason}）`,
          rejectedCounts: { rejected: payload.operations.length },
          payload: JSON.stringify(
            buildConsolidationLogPayload({
              plan: { mode: 'append', content: '', applied: [], rejected: [], hashConflict: false, hasRewrites: false },
              ops: [],
              evidence: deps.evidence,
              via: 'approval',
              extraRejected: payload.operations.map((o) => ({
                stagingId: o.stagingId,
                text: o.text,
                reasonKey: 'user_rejected',
                reasonArgs: { approvalId, reason: payload.reason },
                originSessionId: null
              }))
            })
          ),
          now: deps.now
        });
        appendEvent(db, {
          kind: 'approval_decided',
          ts: deps.now,
          namespace: payload.namespace,
          approvalId,
          entryRef: `approval:${approvalId}`,
          summary: '你驳回了这次记忆晋升：{{count}} 项退场，旧记忆一切没变',
          summaryArgs: { decision: 'rejected', count: payload.operations.length, reason: payload.reason }
        });
      }
    });
    if (!outcome.settled) {
      if (outcome.reason === 'blocked') {
        return { ok: false, code: outcome.code, error: outcome.message, approvalId, decision: 'rejected', stagingSettled: 0 };
      }
      return { ok: false, error: '审批状态翻转失败（可能已被裁决）', approvalId, decision: 'rejected', stagingSettled: 0 };
    }
    return { ok: true, approvalId, decision: 'rejected', stagingSettled: settled };
  }

  // approve：经恢复协议执行（领取→写盘→收尾）。组装/写盘闭包收口在
  // consolidationApprovalFileHooks（多进程测试与 decide 共用同一执行面）。
  const hooksState = { plan: null as ConsolidationWritePlan | null, hashConflict: false };
  const hooks = consolidationApprovalFileHooks(db, approvalId, payload, deps, hooksState);
  const file = executeApprovalFilePhase(db, {
    approvalId,
    now: deps.now,
    ...hooks
  });

  if (!file.ok) {
    let message = file.message ?? '审批执行失败';
    // 组装发生在协调器闭包内——读 hooksState 拿最后一次组装产物
    const builtPlan = hooksState.plan as ConsolidationWritePlan | null;
    if (file.code === 'zero_applied' && builtPlan) {
      // M2 同构：零应用给可处理原因（哈希冲突/超预算/全拒绝），审批保持待审
      const cats = countRejectCategories(builtPlan.rejected);
      if (hooksState.hashConflict || cats.hash_conflict) {
        message = '没有操作写入：目标记忆文件已被外部修改（哈希冲突，改写退场保护了你的旧内容）——请驳回后重新巩固，或确认改动后重试';
      } else if (cats.over_budget) {
        message = '没有操作写入：目标记忆超出容量预算——请先在记忆中心合并整理旧条目，再驳回或重试';
      } else {
        // 其余分类（ambiguous/missing_source/invalid_op/over_loss 等）如实入文案——
        // 2026-10-06 事故教训：笼统的「目标可能已变化或被校验拒绝」让 over_loss 拒绝
        // 无法定位（真实原因：oldSnippet 与现状定位失败/缺证据/非法操作），给出分类
        // 才能判断该驳回重建还是检查目标文件
        const detail = Object.entries(cats)
          .filter(([k]) => k !== 'hash_conflict' && k !== 'over_budget')
          .map(([k, n]) => `${k}×${n}`)
          .join('、');
        message = `没有操作写入：全部操作未生效${detail ? `（拒绝分类：${detail}）` : ''}——请检查后驳回或重试`;
      }
    }
    return {
      ok: false,
      code: file.code,
      error: message,
      approvalId,
      decision: 'approved',
      stagingSettled: 0,
      ...(builtPlan && file.code === 'zero_applied' ? { plan: { ...builtPlan, preimageId: null } } : {})
    };
  }

  // 收尾（③）：单事务条件翻转 + staging 退场 + 日志 + 事件；他方已收尾则幂等返回
  let facts: ConsolidationSettleFacts;
  try {
    facts = JSON.parse(file.settleJson!) as ConsolidationSettleFacts;
  } catch {
    return { ok: false, code: 'write_failed', error: '执行日志损坏（settle_json 解析失败）', approvalId, decision: 'approved', stagingSettled: 0 };
  }
  const plan = planOfFacts(facts);
  let settled = 0;
  const outcome = settleApprovalDecision(db, {
    approvalId,
    state: 'approved',
    now: deps.now,
    onSettle: () => {
      // 写盘类事件（superseded）收口到收尾事务内（r1-P2③）：靠翻转守卫恰好一次，
      // 崩溃随事务回滚、恢复/重试只补一次
      hooks.emitSettleEvents(file.settleJson!);
      for (const a of facts.applied) {
        if (transitionStaging(db, a.stagingId, 'promoted')) settled += 1;
      }
      const rejectedCounts: Record<string, number> = countRejectCategories(plan.rejected);
      writeConsolidationLog(db, {
        triggerSource: `approval:${approvalId}:approved`,
        addedCount: facts.applied.filter((a) => a.op === 'add').length,
        mergedCount: facts.applied.filter((a) => a.op === 'merge').length,
        supersededCount: facts.applied.filter((a) => a.op === 'supersede').length,
        diffSummary: `审批通过：应用 ${facts.applied.length}/${payload.operations.length} 项（mode=${facts.mode}${facts.hashConflict ? '，哈希冲突回退 append' : ''}）`,
        rejectedCounts,
        payload: JSON.stringify(
          buildConsolidationLogPayload({
            plan,
            ops: payload.operations,
            evidence: deps.evidence,
            via: 'approval'
          })
        ),
        now: deps.now
      });
      appendEvent(db, {
        kind: 'approval_decided',
        ts: deps.now,
        namespace: payload.namespace,
        approvalId,
        entryRef: `approval:${approvalId}`,
        summary: '你批准了记忆晋升：入库 {{applied}}/{{total}} 项',
        summaryArgs: {
          decision: 'approved',
          applied: facts.applied.length,
          total: payload.operations.length
        }
      });
    }
  });
  if (!outcome.settled) {
    // 他方已裁决（r1-P1②）：核验最终裁决态后再回执——approved 才幂等成功；
    // 被并发驳回等不一致情形如实报失败，不得「ok:true 但正文已写/裁决已驳」
    const finalRow = getApproval(db, approvalId);
    if (finalRow?.state === 'approved') {
      return { ok: true, approvalId, decision: 'approved', plan, stagingSettled: settled };
    }
    return {
      ok: false,
      error: `收尾时审批已被并发裁决（state=${finalRow?.state ?? 'unknown'}）——正文写入已完成，请重试「批准」按恢复协议核对结果`,
      approvalId,
      decision: 'approved',
      plan,
      stagingSettled: 0
    };
  }
  return { ok: true, approvalId, decision: 'approved', plan, stagingSettled: settled };
}

/** 拒绝分类计数的便捷再导出（sweep/approval 共用；类型面统一） */
export type { ApplyRejectCategory };
