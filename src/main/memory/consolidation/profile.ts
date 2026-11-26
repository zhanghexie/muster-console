/**
 * USER.md 画像巩固（memory-refactor §10 + 决策 #7，B7）：画像命名空间的巩固 pass。
 *
 * 治理路由（严于 MEMORY 一档）：
 * - 素材门：仅 origin=user（用户亲述）的 pending staging 候选进入画像 sweep；
 *   untrusted/system 由来源分类结构性排除（写入素材 §10 口径）。
 * - **新增可自动**：高置信 add（confidence ≥ highConfidenceAdd，同 §6.3 线）自动落盘；
 * - **取代/删除必审**：supersede/delete 与低置信 add 一律进 approvals（action=
 *   'user_md_change'，B1 表枚举早已在册），面板审批队列渲染、人裁决后执行；
 * - supersede-in-place：批准后**原位替换**目标指令（directive 更新、observed 刷新为
 *   裁决日、status 保持 active）——永不追加矛盾 directive（§10）；
 * - 人在面板直改 USER.md = 终审免审（userProfile.writeUserProfile / center 直改通道），
 *   审批流只治理模型写入。
 *
 * 执行安全（照 apply.ts 口径收窄）：oldDirective 须在当前画像中**唯一**定位（歧义只拒
 * 该条）；4000 字符硬上限超限拒写；改写前全文前镜像入 preimages（面板回收站可回滚）；
 * 内容哈希乐观并发（冲突整体放弃——画像无 append 回退，不盲目追加指令）；伪造 origin
 * 注解在 planProfileWrite 组装时剥离（B8 评审收尾，与面板治理路径对称）。
 *
 * 纯盘上 + db 操作（db/路径/baseHashFn 注入；.mjs 可转译直测，LLM 用 mock）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { MemoryDb } from '../db';
import { insertApproval, insertPreimage, getApproval, getApprovalExec } from '../db';
import { transitionStaging } from '../staging';
import { parseProfileEntries, serializeProfileEntry, stripOriginAnnotationTail, USER_PROFILE_MAX_CHARS, type ProfileEntry } from '../entryFormat';
import { writeTextAtomicSync } from '../../atomicJson';
import { writeConsolidationLog } from './apply';
import { listStagingCandidates, type StagingCandidate } from './gates';
import { readTextFile, readTextForWrite } from '../fileRead';
import {
  executeApprovalFilePhase,
  settleApprovalDecision,
  approvalExecRejectGuard,
  type ApprovalExecFailureCode
} from './approvalExec';

// ---------------------------------------------------------------------------
// 模型回合（操作决策；复用巩固传输层 ConsolidationModelCall）
// ---------------------------------------------------------------------------

export const PROFILE_MODEL_CONSTANTS = {
  /** 单回合候选上限 */
  MAX_CANDIDATES: 8,
  /** 单条 directive 上限（画像是指令式短句，比策展条目更收紧） */
  DIRECTIVE_MAX_CHARS: 500,
  /** 画像全文送入上限（超出截断保尾） */
  MAX_TARGET_CHARS: 8_000,
  MAX_OPERATIONS: 8,
  /** 静默回合超时 */
  TIMEOUT_MS: 120_000
} as const;

export type ProfileOpKind = 'add' | 'supersede' | 'delete';

export interface ProfileOperation {
  op: ProfileOpKind;
  /** 模型回显的候选 staging id（-1=未带；plan 侧按 invalid_op 丢弃） */
  stagingId: number;
  /** add=新指令 / supersede=取代后的完整新指令 */
  directive: string;
  /** supersede/delete 定位：当前画像中既有指令的**逐字节片段**（须唯一定位） */
  oldDirective?: string;
  reason?: string;
  /** 0–1（缺省/越界按 0 处理——不确定即低置信） */
  confidence: number;
}

export const PROFILE_SYSTEM_PROMPT = [
  '你是记忆系统的「用户画像（USER.md）」治理环节。下面给你一批来自用户亲述（origin=user）的观察候选，以及当前用户画像文件全文。',
  '画像只收**指令式 directive**（Always/Never/Prefer 开头的一条行为指令，≤100 字），不收事实流水。',
  '操作类型：',
  '- add：候选值得沉淀为一条新画像指令（directive=指令文本）。',
  '- supersede：候选使画像中某既有指令过时，应原位取代（oldDirective=从当前画像**逐字节复制**的既有指令片段，足够唯一定位；directive=取代后的完整新指令）——绝不追加与旧指令矛盾的新条目。',
  '- delete：候选表明某既有指令已失效（oldDirective 同上）。',
  '纪律：',
  '- oldDirective 必须能在当前画像中唯一匹配，否则该操作会被拒绝；不确定就别操作。',
  '- 没有值得沉淀的候选时输出 {"operations":[]}。',
  '- confidence 为 0–1 的数：高置信 add 会自动应用；supersede/delete 与低置信一律进人工审批。',
  '输出格式：**只输出一个 JSON 对象**（不要代码块围栏、不要解释文字），形如 {"operations":[{"op":"add","candidateId":7,"directive":"Always …","confidence":0.9}]}。'
].join('\n');

export interface ProfileModelCandidate {
  candidate: StagingCandidate;
  /** 证据引用行（提示词里供模型理解候选来源；不落盘——画像指令不带 Source 行） */
  citation: string;
}

/** 解析画像模型输出（剥围栏→JSON→逐项校验裁剪；失败 null） */
export function parseProfileOperations(raw: string | null | undefined): ProfileOperation[] | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const stripped = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  const opsRaw = (parsed as { operations?: unknown }).operations;
  if (!Array.isArray(opsRaw)) return null;
  const out: ProfileOperation[] = [];
  for (const v of opsRaw) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const op = String(o.op ?? '');
    if (op !== 'add' && op !== 'supersede' && op !== 'delete') continue;
    const directive =
      typeof o.directive === 'string' ? o.directive.trim().slice(0, PROFILE_MODEL_CONSTANTS.DIRECTIVE_MAX_CHARS) : '';
    const oldDirective =
      typeof o.oldDirective === 'string' && o.oldDirective.trim() ? o.oldDirective : undefined;
    const confRaw = Number(o.confidence);
    const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : 0;
    const candidateId =
      typeof o.candidateId === 'number' && Number.isInteger(o.candidateId) ? o.candidateId : -1;
    if ((op === 'add' || op === 'supersede') && !directive) continue;
    if ((op === 'supersede' || op === 'delete') && !oldDirective) continue;
    out.push({
      op: op as ProfileOpKind,
      stagingId: candidateId,
      directive,
      oldDirective,
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 300) : undefined,
      confidence
    });
    if (out.length >= PROFILE_MODEL_CONSTANTS.MAX_OPERATIONS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 组装（纯函数：唯一定位 / 上限 / supersede-in-place）
// ---------------------------------------------------------------------------

export type ProfileRejectCategory = 'invalid_op' | 'ambiguous' | 'over_cap' | 'hash_conflict';

export interface ProfileWritePlan {
  /** 组装后的全文（无可用操作时等于原文——不写盘） */
  content: string;
  applied: Array<{ op: ProfileOpKind; stagingId: number }>;
  rejected: Array<{ category: ProfileRejectCategory; op?: ProfileOpKind; stagingId?: number }>;
  /** 内容是否变化（=content 与输入不同；写盘判定） */
  changed: boolean;
}

function todayKey(now: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
}

/** 条目列表 → 全文（未识别块原样；条目间空行；空列表=空文件） */
function serializeWorking(working: ReadonlyArray<ProfileEntry>): string {
  const parts = working
    .map((e) => (e.unparsed ? e.raw : serializeProfileEntry(e)))
    .filter((s) => s && s.trim());
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

/** 唯一定位既有指令：先逐字节等值（trim）唯一，再退唯一包含；都不满足=null（ambiguous） */
export function locateDirective(
  entries: ReadonlyArray<ProfileEntry>,
  oldDirective: string
): ProfileEntry | null {
  const needle = oldDirective.trim();
  if (!needle) return null;
  const exact = entries.filter((e) => !e.unparsed && e.directive.trim() === needle);
  if (exact.length === 1) return exact[0];
  const contains = entries.filter((e) => !e.unparsed && e.directive.includes(needle));
  return contains.length === 1 ? contains[0] : null;
}

export interface PlanProfileWriteInput {
  currentContent: string;
  ops: ReadonlyArray<ProfileOperation>;
  now: Date;
  /** 画像硬上限（缺省 USER_PROFILE_MAX_CHARS=4000，只可调低） */
  maxChars?: number;
}

/**
 * 画像写计划（纯函数，逐操作顺序重放）：
 * - add：追加 active 指令（observed=当日）；试组装超上限 → 该条拒（over_cap）；
 * - supersede：唯一 oldDirective 定位 → 原位替换（directive 更新、observed=当日、
 *   status 保持 active——supersede-in-place，永不追加矛盾 directive）；
 * - delete：唯一定位 → 移除。
 * 歧义/越界只拒该条，不拖垮整批；未识别块原样保留。
 * 伪造 origin 剥离（B8 评审收尾）：模型产 directive 尾部的 `<!-- origin: … -->`
 * 在组装时剥除——本函数是 executeProfileWrite（高置信自动落盘/审批执行）唯一组装
 * 点，剥这一道即该入库路径唯一防线（USER.md 虽无提权面，补齐让「每条入库路径
 * 恰好一道剥离」枚举严格成立；面板直改通道由 writeUserProfile 全文剥离）。
 */
export function planProfileWrite(input: PlanProfileWriteInput): ProfileWritePlan {
  const maxChars = input.maxChars ?? USER_PROFILE_MAX_CHARS;
  const entries = parseProfileEntries(input.currentContent);
  const applied: ProfileWritePlan['applied'] = [];
  const rejected: ProfileWritePlan['rejected'] = [];
  let working = [...entries];
  let content = input.currentContent;

  for (const op of input.ops) {
    if (!Number.isInteger(op.stagingId) || op.stagingId <= 0) {
      rejected.push({
        category: 'invalid_op',
        op: op.op,
        stagingId: Number.isInteger(op.stagingId) && op.stagingId > 0 ? op.stagingId : undefined
      });
      continue;
    }
    // 伪造 origin 注解剥离：add/supersede 共用此一处（见上方 jsdoc）
    const directive = stripOriginAnnotationTail(op.directive.trim());
    if (op.op === 'add') {
      if (!directive) {
        rejected.push({ category: 'invalid_op', op: op.op, stagingId: op.stagingId });
        continue;
      }
      const fresh: ProfileEntry = {
        id: '',
        observed: todayKey(input.now),
        status: 'active',
        directive,
        raw: '',
        unparsed: false
      };
      const trial = serializeWorking([...working, fresh]);
      if (trial.trim().length > maxChars) {
        rejected.push({ category: 'over_cap', op: 'add', stagingId: op.stagingId });
        continue;
      }
      working = [...working, fresh];
      content = trial;
      applied.push({ op: 'add', stagingId: op.stagingId });
      continue;
    }
    const target = locateDirective(working, op.oldDirective ?? '');
    if (!target) {
      rejected.push({ category: 'ambiguous', op: op.op, stagingId: op.stagingId });
      continue;
    }
    if (op.op === 'supersede') {
      const next = working.map((e) =>
        e.id === target.id
          ? { ...e, directive, observed: todayKey(input.now), status: 'active' as const }
          : e
      );
      const trial = serializeWorking(next);
      // supersede 可能放大 directive——同样受全文硬上限约束（防绕过 add 侧 over_cap）
      if (trial.trim().length > maxChars) {
        rejected.push({ category: 'over_cap', op: 'supersede', stagingId: op.stagingId });
        continue;
      }
      working = next;
      content = trial;
    } else {
      working = working.filter((e) => e.id !== target.id);
      content = serializeWorking(working);
    }
    applied.push({ op: op.op, stagingId: op.stagingId });
  }

  return { content, applied, rejected, changed: content !== input.currentContent };
}

// ---------------------------------------------------------------------------
// 执行（哈希门 + 前镜像 + 原子写；目标文件绝对路径注入）
// ---------------------------------------------------------------------------

/** 读展示/模型输入用三态读取：失败由调用方显式处理（sweep 跳过、审批中止） */
function readProfileContent(p: string): { ok: true; content: string } | { ok: false; message: string } {
  const r = readTextFile(p);
  if (r.status === 'ok') return { ok: true, content: r.content };
  if (r.status === 'missing') return { ok: true, content: '' };
  return { ok: false, message: `读取 ${p} 失败（${r.code}）：${r.message}` };
}

/**
 * 执行已组装的画像写入计划（前镜像 + 原子写）。M1 恢复协议的执行原语：审批路径经
 * approvalExec 协调器校验现状后调用；本函数不重读目标文件（调用方传计划所针对的
 * 现状 `fresh`）。返回落盘的前镜像 id（未改写=null）。
 */
export function executeProfileWritePlan(
  db: MemoryDb,
  input: {
    fresh: string;
    plan: ProfileWritePlan;
    targetFile: string;
    cause: string;
    now: number;
    /** 前镜像 content_hash 算法（与调用方 baseHashFn 同源；缺省 sha256） */
    hashFn?: (text: string) => string;
  }
): { wrote: boolean; preimageId: number | null } {
  if (!input.plan.changed) return { wrote: false, preimageId: null };
  const hashFn = input.hashFn ?? sha256OfProfile;
  const preimageId = insertPreimage(db, {
    filePath: input.targetFile,
    content: input.fresh,
    contentHash: hashFn(input.fresh),
    cause: input.cause,
    now: input.now
  });
  fs.mkdirSync(path.dirname(input.targetFile), { recursive: true });
  writeTextAtomicSync(input.targetFile, input.plan.content);
  return { wrote: true, preimageId };
}

export interface ExecuteProfileWriteInput {
  ops: ReadonlyArray<ProfileOperation>;
  targetFile: string;
  /** 乐观并发基线（构建模型输入时的全文哈希；null=跳过检查） */
  baseHash?: string | null;
  baseHashFn: (text: string) => string;
  now: number;
  /** 前镜像 cause（sweep 触发源 / 审批 id） */
  cause: string;
  maxChars?: number;
}

export interface ProfileExecuteOutcome {
  plan: ProfileWritePlan;
  hashConflict: boolean;
}

/**
 * 画像写执行：读现状（读取失败抛 `MemoryFileReadError` 中止——M3）→ 哈希门（冲突
 * 整体放弃——画像无 append 回退，不盲目追加指令）→ 有改写先落前镜像 → 原子写。
 */
export function executeProfileWrite(db: MemoryDb, input: ExecuteProfileWriteInput): ProfileExecuteOutcome {
  const fresh = readTextForWrite(input.targetFile);
  const currentHash = input.baseHashFn(fresh);
  const hashConflict = input.baseHash != null && currentHash !== input.baseHash;
  const plan: ProfileWritePlan = hashConflict
    ? {
        content: fresh,
        applied: [],
        rejected: input.ops.map((o) => ({ category: 'hash_conflict' as const, op: o.op, stagingId: o.stagingId })),
        changed: false
      }
    : planProfileWrite({ currentContent: fresh, ops: input.ops, now: new Date(input.now), maxChars: input.maxChars });
  if (plan.changed) {
    const maxChars = input.maxChars ?? USER_PROFILE_MAX_CHARS;
    if (plan.content.trim().length > maxChars) {
      // 防御性复核：组装侧已拒 over_cap，此处再拦一道避免绕过写盘
      return {
        plan: {
          content: fresh,
          applied: [],
          rejected: [
            ...plan.rejected,
            ...plan.applied.map((a) => ({ category: 'over_cap' as const, op: a.op, stagingId: a.stagingId }))
          ],
          changed: false
        },
        hashConflict
      };
    }
    insertPreimage(db, {
      filePath: input.targetFile,
      content: fresh,
      contentHash: currentHash,
      cause: input.cause,
      now: input.now
    });
    fs.mkdirSync(path.dirname(input.targetFile), { recursive: true });
    writeTextAtomicSync(input.targetFile, plan.content);
  }
  return { plan, hashConflict };
}

/** 画像内容哈希（审批恢复协议基线用；与 consolidation 侧 sha256Content 同算法） */
export function sha256OfProfile(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// 审批（approvals.action='user_md_change'；B1 表枚举早已在册）
// ---------------------------------------------------------------------------

export interface UserProfileApprovalPayload {
  kind: 'user_md';
  operations: ProfileOperation[];
  /** 预览 diff（一行一操作；面板审批队列渲染） */
  previewDiff: string[];
  /** 入队时画像全文哈希（approve 时乐观并发基线） */
  baseHash: string;
  baseContentChars: number;
  reason: string;
}

export function buildProfilePreviewDiff(ops: ReadonlyArray<ProfileOperation>): string[] {
  return ops.map((o) => {
    const head = (o.op === 'delete' ? o.oldDirective ?? '' : o.directive).slice(0, 60).replace(/\s+/g, ' ');
    if (o.op === 'add') return `+ 新增画像指令：${head}`;
    if (o.op === 'supersede') return `~ 原位取代画像指令：${head}`;
    return `- 删除画像指令：${head}`;
  });
}

/** 入队一条画像改动审批（action='user_md_change'）；返回 approval id */
export function enqueueUserProfileApproval(
  db: MemoryDb,
  input: {
    operations: ReadonlyArray<ProfileOperation>;
    baseHash: string;
    baseContentChars: number;
    reason: string;
    now: number;
  }
): number {
  const payload: UserProfileApprovalPayload = {
    kind: 'user_md',
    operations: [...input.operations],
    previewDiff: buildProfilePreviewDiff(input.operations),
    baseHash: input.baseHash,
    baseContentChars: input.baseContentChars,
    reason: input.reason
  };
  const confidence = input.operations.length
    ? input.operations.reduce((m, o) => Math.min(m, o.confidence), 1)
    : null;
  return insertApproval(db, {
    action: 'user_md_change',
    payload: JSON.stringify(payload),
    confidence,
    now: input.now
  });
}

export function parseProfileApprovalPayload(raw: string): UserProfileApprovalPayload | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return null;
    const p = v as Partial<UserProfileApprovalPayload>;
    if (p.kind !== 'user_md' || !Array.isArray(p.operations) || !Array.isArray(p.previewDiff)) return null;
    return p as UserProfileApprovalPayload;
  } catch {
    return null;
  }
}

export interface DecideUserProfileApprovalDeps {
  targetFileAbs: string;
  baseHashFn: (text: string) => string;
  now: number;
}

export interface ProfileApprovalDecisionResult {
  ok: boolean;
  error?: string;
  /** 失败分类（busy/read_failed/write_failed/conflict/zero_applied；M2） */
  code?: ApprovalExecFailureCode;
  approvalId: number;
  decision: 'approved' | 'rejected';
  /** approve 时生效笔数 */
  appliedCount: number;
  total: number;
  hashConflict: boolean;
  /** 未生效操作分类计数（M2：部分应用时如实报拒绝原因——ambiguous/over_cap/hash_conflict…） */
  rejectedCounts?: Record<string, number>;
}

/** settleJson 形状（approval_exec 日志行内的画像执行事实） */
interface ProfileSettleFacts {
  applied: Array<{ op: string; stagingId: number }>;
  rejected: Array<{ category: string; op?: string; stagingId?: number }>;
  hashConflict: boolean;
  preimageId?: number | null;
}

function countProfileRejected(rejected: ReadonlyArray<{ category: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rejected) out[r.category] = (out[r.category] ?? 0) + 1;
  return out;
}

/**
 * 画像审批裁决：approve = 经 approvalExec 恢复协议执行（领取→写盘→收尾；重试/
 * 重启不重复应用，竞争得 busy）；reject = 单事务原子退场。幂等（非 pending 拒改；
 * 已 approved 且有执行日志时按日志幂等重放）。
 *
 * M2（2026-10-02 审计）：哈希冲突/超上限/全部操作被拒 → appliedCount=0 时不翻状态、
 * 不返回成功——审批保持待审，用户可明确重试（现状恢复后按新内容重新组装）或驳回；
 * 不自动去掉 baseHash 强行执行旧预览。部分应用正常批准并如实返回 appliedCount 与
 * rejectedCounts。
 */
export function decideUserProfileApproval(
  db: MemoryDb,
  approvalId: number,
  decision: 'approve' | 'reject',
  deps: DecideUserProfileApprovalDeps
): ProfileApprovalDecisionResult {
  const row = getApproval(db, approvalId);
  if (!row) {
    return {
      ok: false, error: '审批不存在', approvalId,
      decision: decision === 'approve' ? 'approved' : 'rejected',
      appliedCount: 0, total: 0, hashConflict: false
    };
  }
  if (row.state !== 'pending') {
    // 幂等重放：崩溃恢复后用户再点批准——回执来自执行日志，不重放任何写动作
    if (decision === 'approve' && row.state === 'approved') {
      const journal = getApprovalExec(db, approvalId);
      if (journal && journal.phase === 'file_applied') {
        try {
          const facts = JSON.parse(journal.settleJson) as ProfileSettleFacts;
          return {
            ok: true, approvalId, decision: 'approved',
            appliedCount: facts.applied.length,
            total: facts.applied.length + facts.rejected.length,
            hashConflict: facts.hashConflict,
            rejectedCounts: countProfileRejected(facts.rejected)
          };
        } catch {
          /* settle_json 损坏 → 落回已裁决回执 */
        }
      }
    }
    return {
      ok: false, error: `审批已裁决（state=${row.state}）`, approvalId,
      decision: decision === 'approve' ? 'approved' : 'rejected',
      appliedCount: 0, total: 0, hashConflict: false
    };
  }
  const payload = parseProfileApprovalPayload(row.payload);
  if (!payload) {
    settleApprovalDecision(db, {
      approvalId,
      state: 'rejected',
      now: deps.now,
      onSettle: () => {
        /* payload 不可解析 → 无从退场候选，仅翻状态防卡队列 */
      }
    });
    return {
      ok: false, error: '审批 payload 解析失败（已标记 rejected）', approvalId,
      decision: 'rejected', appliedCount: 0, total: 0, hashConflict: false
    };
  }

  if (decision === 'reject') {
    // 单事务原子退场：执行日志前置检（r1-P1②：文件已写/在途时阻断，防账实分裂）
    // → 翻转 + 候选退场 + 日志（崩溃整体回滚，重试再驳回）
    const outcome = settleApprovalDecision(db, {
      approvalId,
      state: 'rejected',
      now: deps.now,
      preCheck: () =>
        approvalExecRejectGuard(db, {
          approvalId,
          now: deps.now,
          readFile: () => readTextForWrite(deps.targetFileAbs),
          hashOf: deps.baseHashFn
        }),
      onSettle: () => {
        for (const op of payload.operations) transitionStaging(db, op.stagingId, 'rejected');
        writeConsolidationLog(db, {
          triggerSource: `approval:${approvalId}:rejected`,
          addedCount: 0,
          mergedCount: 0,
          supersededCount: 0,
          diffSummary: `画像审批拒绝：${payload.operations.length} 项操作退场（${payload.reason}）`,
          rejectedCounts: { rejected: payload.operations.length },
          now: deps.now
        });
      }
    });
    if (!outcome.settled) {
      if (outcome.reason === 'blocked') {
        return {
          ok: false, code: outcome.code, error: outcome.message, approvalId,
          decision: 'rejected', appliedCount: 0, total: payload.operations.length, hashConflict: false
        };
      }
      return {
        ok: false, error: '审批状态翻转失败（可能已被裁决）', approvalId,
        decision: 'rejected', appliedCount: 0, total: payload.operations.length, hashConflict: false
      };
    }
    return { ok: true, approvalId, decision: 'rejected', appliedCount: 0, total: payload.operations.length, hashConflict: false };
  }

  // approve：经恢复协议执行（领取→写盘→收尾）
  let built: ProfileWritePlan | null = null;
  let builtConflict = false;
  const file = executeApprovalFilePhase(db, {
    approvalId,
    now: deps.now,
    readFile: () => readTextForWrite(deps.targetFileAbs),
    hashOf: deps.baseHashFn,
    buildPlan: (current) => {
      const currentHash = deps.baseHashFn(current);
      builtConflict = payload.baseHash != null && currentHash !== payload.baseHash;
      let plan: ProfileWritePlan;
      if (builtConflict) {
        // 哈希冲突整体放弃（画像无 append 回退，不盲目追加指令）
        plan = {
          content: current,
          applied: [],
          rejected: payload.operations.map((o) => ({ category: 'hash_conflict' as const, op: o.op, stagingId: o.stagingId })),
          changed: false
        };
      } else {
        plan = planProfileWrite({ currentContent: current, ops: payload.operations, now: new Date(deps.now) });
        // 防御性复核（照 executeProfileWrite 口径）：组装侧已拒 over_cap，此处再拦一道
        if (plan.changed && plan.content.trim().length > USER_PROFILE_MAX_CHARS) {
          plan = {
            content: current,
            applied: [],
            rejected: [
              ...plan.rejected,
              ...plan.applied.map((a) => ({ category: 'over_cap' as const, op: a.op, stagingId: a.stagingId }))
            ],
            changed: false
          };
        }
      }
      built = plan;
      const facts: ProfileSettleFacts = {
        applied: plan.applied.map((a) => ({ ...a })),
        rejected: plan.rejected.map((r) => ({ ...r })),
        hashConflict: builtConflict
      };
      return {
        baseHash: currentHash,
        plannedContent: plan.content,
        settleJson: JSON.stringify(facts),
        appliedCount: plan.applied.length
      };
    },
    prepareWrite: (plan, fresh, settleJson) => {
      // 前镜像先于写盘落库并与 preimageId 入日志同事务（r1-P2③；已关联时幂等跳过）。
      // r2-P2③：接管重规划按（cause+文件+内容）复用上一 attempt 的镜像身份，不重复落。
      const facts = JSON.parse(settleJson) as ProfileSettleFacts;
      const planObj = built!;
      if (planObj.changed && facts.preimageId == null) {
        const cause = `approval:${approvalId}`;
        const prior = db.handle
          .prepare('SELECT id FROM preimages WHERE file_path = ? AND cause = ? AND content = ? ORDER BY id LIMIT 1')
          .get(deps.targetFileAbs, cause, fresh) as { id: number } | undefined;
        facts.preimageId = prior
          ? Number(prior.id)
          : insertPreimage(db, {
              filePath: deps.targetFileAbs,
              content: fresh,
              contentHash: deps.baseHashFn(fresh),
              cause,
              now: deps.now
            });
      }
      return JSON.stringify(facts);
    },
    writeContent: (plannedContent) => {
      fs.mkdirSync(path.dirname(deps.targetFileAbs), { recursive: true });
      writeTextAtomicSync(deps.targetFileAbs, plannedContent);
    }
  });

  if (!file.ok) {
    // M2：零应用/冲突/执行失败都不翻状态——审批保持待审，可明确重试或驳回
    let message = file.message ?? '画像审批执行失败';
    let hashConflict = builtConflict;
    if (file.code === 'zero_applied') {
      const builtPlan = built as ProfileWritePlan | null;
      const cats = builtPlan ? countProfileRejected(builtPlan.rejected) : {};
      if (builtConflict || cats.hash_conflict) {
        message = '画像文件已被其他入口修改（哈希冲突），本次预览未执行——旧审批可驳回后重新巩固，或确认改动后重试';
        hashConflict = true;
      } else if (cats.over_cap) {
        message = '画像超出 4000 字符硬上限，本次预览未执行——请先在用户画像页合并/淘汰旧指令，再驳回或重试';
      } else {
        message = '全部操作未生效（定位歧义或校验拒绝）——请检查后驳回或重试';
      }
    }
    return {
      ok: false, code: file.code, error: message, approvalId, decision: 'approved',
      appliedCount: 0, total: payload.operations.length, hashConflict
    };
  }

  let facts: ProfileSettleFacts;
  try {
    facts = JSON.parse(file.settleJson!) as ProfileSettleFacts;
  } catch {
    return {
      ok: false, code: 'write_failed', error: '执行日志损坏（settle_json 解析失败）', approvalId,
      decision: 'approved', appliedCount: 0, total: payload.operations.length, hashConflict: builtConflict
    };
  }
  const rejectedCounts = countProfileRejected(facts.rejected);
  const outcome = settleApprovalDecision(db, {
    approvalId,
    state: 'approved',
    now: deps.now,
    onSettle: () => {
      for (const a of facts.applied) transitionStaging(db, a.stagingId, 'promoted');
      writeConsolidationLog(db, {
        triggerSource: `approval:${approvalId}:approved`,
        addedCount: facts.applied.filter((a) => a.op === 'add').length,
        mergedCount: facts.applied.filter((a) => a.op === 'supersede').length,
        supersededCount: facts.applied.filter((a) => a.op === 'delete').length,
        diffSummary: `画像审批通过：应用 ${facts.applied.length}/${payload.operations.length} 项${facts.hashConflict ? '（哈希冲突整体放弃）' : ''}`,
        rejectedCounts,
        now: deps.now
      });
    }
  });
  if (!outcome.settled) {
    // 他方已裁决（r1-P1②）：核验最终裁决态——approved 才幂等成功；否则如实失败
    const finalRow = getApproval(db, approvalId);
    if (finalRow?.state === 'approved') {
      return {
        ok: true, approvalId, decision: 'approved',
        appliedCount: facts.applied.length,
        total: payload.operations.length,
        hashConflict: facts.hashConflict,
        rejectedCounts
      };
    }
    return {
      ok: false, error: `收尾时审批已被并发裁决（state=${finalRow?.state ?? 'unknown'}）——画像写入已完成，请重试「批准」按恢复协议核对结果`,
      code: 'conflict', approvalId, decision: 'approved',
      appliedCount: 0, total: payload.operations.length, hashConflict: facts.hashConflict
    };
  }
  return {
    ok: true, approvalId, decision: 'approved',
    appliedCount: facts.applied.length,
    total: payload.operations.length,
    hashConflict: facts.hashConflict,
    rejectedCounts
  };
}

// ---------------------------------------------------------------------------
// sweep（画像命名空间巩固 pass；runtime 在双命名空间 sweep 之后调用）
// ---------------------------------------------------------------------------

export interface UserProfileSweepDeps {
  db: MemoryDb;
  callModel: (input: { system: string; user: string }) => Promise<string>;
  now: number;
  reason: string;
  /** 高置信 add 自动应用线（同 memoryConsolidation.highConfidenceAdd） */
  highConfidenceAdd?: number;
  notify?: (title: string, body: string) => void;
  /** USER.md 绝对路径（未装配=跳过 sweep） */
  targetFileAbs: string | null;
  baseHashFn: (text: string) => string;
  timeoutMs?: number;
}

export interface UserProfileSweepSummary {
  ran: boolean;
  skipped?: 'no_candidates' | 'no_path';
  candidatesTotal: number;
  modelOk: boolean;
  modelError?: string;
  autoApplied: number;
  deferredApprovalId?: number;
  deferredCount: number;
  logId?: number;
}

function buildProfileUserPrompt(currentContent: string, candidates: ReadonlyArray<ProfileModelCandidate>): string {
  const cap = PROFILE_MODEL_CONSTANTS.MAX_TARGET_CHARS;
  const current =
    currentContent.length > cap ? `${currentContent.slice(currentContent.length - cap)}\n…[前文截断]` : currentContent;
  return [
    '## 当前用户画像文件全文（USER.md）',
    current.trim() || '（空文件）',
    '',
    '## 候选观察（origin=user）',
    ...candidates.map((c) =>
      [
        `### 候选 ${c.candidate.stagingId}`,
        `来源证据：${c.citation}`,
        `正文：${c.candidate.text.slice(0, PROFILE_MODEL_CONSTANTS.DIRECTIVE_MAX_CHARS)}`
      ].join('\n')
    )
  ].join('\n');
}

/**
 * 画像巩固 sweep（§10）：origin=user 候选 → 画像模型回合（add/supersede/delete 操作
 * 决策）→ 高置信 add 自动应用，其余必审入队+通知。无候选/无目标文件直接跳过（不留
 * log——画像 sweep 搭既有巩固触发跑，常态空转不制造「晋升审阅」时间线噪音）。
 */
export async function runUserProfileSweep(deps: UserProfileSweepDeps): Promise<UserProfileSweepSummary> {
  const summary: UserProfileSweepSummary = {
    ran: false,
    candidatesTotal: 0,
    modelOk: false,
    autoApplied: 0,
    deferredCount: 0
  };
  if (!deps.targetFileAbs) {
    summary.skipped = 'no_path';
    return summary;
  }
  // 素材门：仅 origin=user 的 pending 候选（untrusted/system 结构性排除——§10 写入素材口径）
  const candidates = listStagingCandidates(deps.db).filter((c) => c.origin === 'user');
  summary.candidatesTotal = candidates.length;
  if (candidates.length === 0) {
    summary.skipped = 'no_candidates';
    return summary;
  }
  summary.ran = true;
  const capped = candidates.slice(0, PROFILE_MODEL_CONSTANTS.MAX_CANDIDATES);
  const byStagingId = new Map(capped.map((c) => [c.stagingId, c]));
  const currentRead = readProfileContent(deps.targetFileAbs);
  if (!currentRead.ok) {
    // M3：现状读失败不进模型回合（空画像提示词会误导操作决策）——留 log、候选不动
    summary.logId = writeConsolidationLog(deps.db, {
      triggerSource: `user_md:${deps.reason}`,
      addedCount: 0,
      mergedCount: 0,
      supersededCount: 0,
      diffSummary: `画像现状读取失败，本轮 sweep 跳过：${currentRead.message}`,
      rejectedCounts: { read_failed: capped.length },
      now: deps.now
    });
    return summary;
  }
  const currentContent = currentRead.content;
  const baseHash = deps.baseHashFn(currentContent);
  const promptCandidates: ProfileModelCandidate[] = capped.map((c) => ({
    candidate: c,
    citation: c.evidencePath?.trim() || `staging#${c.stagingId}`
  }));

  // 画像模型回合（超时竞速同 model.ts；失败落 log 不动画像）
  let operations: ProfileOperation[] | null;
  try {
    const timeoutMs = deps.timeoutMs ?? PROFILE_MODEL_CONSTANTS.TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`画像模型回合超时（${timeoutMs}ms）`)), timeoutMs);
    });
    let raw: string;
    try {
      raw = await Promise.race([
        deps.callModel({
          system: PROFILE_SYSTEM_PROMPT,
          user: buildProfileUserPrompt(currentContent, promptCandidates)
        }),
        timed
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    operations = parseProfileOperations(raw);
    if (!operations) summary.modelError = `操作决策 JSON 解析失败：${(raw ?? '').slice(0, 160)}`;
  } catch (err) {
    summary.modelError = String((err as Error)?.message ?? err);
    operations = null;
  }
  if (!operations) {
    summary.logId = writeConsolidationLog(deps.db, {
      triggerSource: `user_md:${deps.reason}`,
      addedCount: 0,
      mergedCount: 0,
      supersededCount: 0,
      diffSummary: `画像候选${capped.length}，模型回合失败：${summary.modelError ?? ''}`,
      rejectedCounts: { model_failed: capped.length },
      now: deps.now
    });
    return summary;
  }
  summary.modelOk = true;

  // 候选映射（模型引用未知候选 → model_failed 丢弃）
  const validOps: ProfileOperation[] = [];
  let unknown = 0;
  for (const op of operations) {
    if (!byStagingId.has(op.stagingId)) {
      unknown += 1;
      continue;
    }
    validOps.push(op);
  }

  // 置信分档（决策 #7）：高置信 add 自动；supersede/delete/低置信 add → 必审
  const highConfidenceAdd = deps.highConfidenceAdd ?? 0.75;
  const autoOps = validOps.filter((o) => o.op === 'add' && o.confidence >= highConfidenceAdd);
  const deferredOps = validOps.filter((o) => !(o.op === 'add' && o.confidence >= highConfidenceAdd));

  const rejectedCounts: Record<string, number> = {};
  if (unknown) rejectedCounts.model_failed = unknown;

  if (autoOps.length) {
    const outcome = executeProfileWrite(deps.db, {
      ops: autoOps,
      targetFile: deps.targetFileAbs,
      baseHash,
      baseHashFn: deps.baseHashFn,
      now: deps.now,
      cause: `user_md:${deps.reason}`
    });
    for (const a of outcome.plan.applied) {
      if (transitionStaging(deps.db, a.stagingId, 'promoted')) summary.autoApplied += 1;
    }
    for (const r of outcome.plan.rejected) {
      rejectedCounts[r.category] = (rejectedCounts[r.category] ?? 0) + 1;
    }
  }

  if (deferredOps.length) {
    // 审批基线重抓（B4 评审 MAJOR-1 同口径）：auto-apply 已改写画像时取写入后现状；
    // 读失败不硬入队（错误基线会静默命中哈希冲突）——留 log、候选保持 pending
    const baseRead = readProfileContent(deps.targetFileAbs);
    if (!baseRead.ok) {
      rejectedCounts.read_failed = (rejectedCounts.read_failed ?? 0) + deferredOps.length;
      summary.logId = writeConsolidationLog(deps.db, {
        triggerSource: `user_md:${deps.reason}`,
        addedCount: summary.autoApplied,
        mergedCount: 0,
        supersededCount: 0,
        diffSummary: `画像候选${capped.length}，自动 add${summary.autoApplied}；审批基线读取失败未入队：${baseRead.message}`,
        rejectedCounts,
        now: deps.now
      });
      return summary;
    }
    const approvalBase = baseRead.content;
    summary.deferredApprovalId = enqueueUserProfileApproval(deps.db, {
      operations: deferredOps,
      baseHash: deps.baseHashFn(approvalBase),
      baseContentChars: approvalBase.length,
      reason: deps.reason,
      now: deps.now
    });
    summary.deferredCount = deferredOps.length;
    try {
      deps.notify?.(
        '用户画像改动待审批',
        `${deferredOps.length} 项画像指令操作待确认（取代/删除必审，决策 #7）`
      );
    } catch {
      /* 通知失败不影响巩固 */
    }
  }

  summary.logId = writeConsolidationLog(deps.db, {
    triggerSource: `user_md:${deps.reason}`,
    addedCount: summary.autoApplied,
    mergedCount: 0,
    supersededCount: 0,
    diffSummary: [
      `画像候选${capped.length}`,
      `自动 add${summary.autoApplied}`,
      summary.deferredApprovalId ? `审批#${summary.deferredApprovalId} 待${summary.deferredCount}项` : ''
    ]
      .filter(Boolean)
      .join('，'),
    rejectedCounts,
    now: deps.now
  });
  return summary;
}
