/**
 * 审批执行协调器（2026-10-02 审计 M1 修复；r1 审查修订）：批准一条审批 =「写正文
 * 文件」+「翻转 approvals 状态 + staging 退场 + 巩固日志 + 事件」两组跨存储操作，
 * 之间没有事务。旧序（先写文件再翻状态）在文件写成功、状态翻转前失败（DB 异常或
 * 进程崩溃）时，审批仍 pending——重试会把同一批操作**再写一遍**（重复晋升）。
 *
 * 恢复协议（持久化执行凭据 + 哈希幂等重放；r1 三处加固）：
 *
 * ```
 * ①领取 claim（CAS 原子，r1-P1①）：claimApprovalExecRow 单条 upsert 完成检查+写入
 *   ——仅当「无行 / failed / claimed 且过期（claimed_at < staleBefore）」且新 attempt
 *   严格大于既有 attempt 才生效；两进程同时领取只成一方，另一方明确 busy。
 *   日志行落：baseHash（计划基线）+ plannedContent/plannedHash（将要写入的完整正文
 *   及其哈希）+ settleJson（收尾事实）。
 * ②写盘（r1-P2③ 前镜像/事件收口）：
 *   a. 写前复核现状哈希 === baseHash（外部竞写→标 failed 释放，报 conflict）；
 *   b. prepareWrite 同事务「落前镜像 + preimageId 并入 settleJson 入日志」——
 *      前镜像关联先于写盘持久化，崩溃后可精确续接（不再遗漏镜像关联）；
 *   c. writeContent 只做原子写（tmp+rename：要么旧要么新）；
 *   d. markFileApplied（attempt 条件推进）。
 * ③收尾 settle：单事务「条件翻转 approvals.state（WHERE state='pending'）+ 写盘类
 *   事件（superseded 等）+ staging 退场 + log + approval_decided」。事件身份收口到
 *   翻转守卫之后——恢复/重试只补一次，崩溃在事务中则随回滚归零（幂等补齐）。
 *   翻转失败（changes=0）= 他方已裁决：调用方**核验最终裁决态**后回执（r1-P1②）。
 * ```
 *
 * 崩溃窗口与恢复规则（每个窗口恰好一次正文效果/镜像/事件）：
 * - 崩在 ①后②a 前 / ②a 后②b 前（未落镜像）：现状===baseHash → 重规划+CAS 续领，
 *   prepareWrite 落镜像（恰好一次）再写；
 * - 崩在 ②b 后②c 前（镜像已落已关联）：现状===baseHash → 重规划（内容等价），
 *   prepareWrite 按日志已关联的 preimageId 幂等跳过，不重复落镜像；
 * - 崩在 ②c 中（rename 原子性）：现状 ∈ {baseHash, plannedHash} 二选一；
 * - 崩在 ②c 后②d 前：现状===plannedHash → 条件推进 file_applied 只补收尾；
 * - 崩在 ③事务中：整事务回滚（含事件）→ 状态仍 pending，重试收尾恰好一次。
 * 现状两者皆非 = 外部修改过 → 标 failed 释放并明确报错，不盲目重放。
 *
 * reject 协调（r1-P1②）：驳回不再「不看执行日志直接翻状态」——settle 事务内先过
 * approvalExecRejectGuard：file_applied（或 claimed 且现状===plannedHash）= 文件已写
 * → 阻断驳回（in_flight，唯一一致出路是重试批准完成收尾）；claimed 新鲜 = 在途
 * → busy；claimed 过期且未写盘 → 释放僵尸领取后放行驳回。
 *
 * 不做的事：不把 approved 提前到写文件之前（文件失败会变成「批准了但永远没写入」）；
 * 不只用内存锁（重启/多实例失效）；不跳过校验或删旧记忆换幂等（预算/哈希门/
 * preimage/来源剥离全部保留）。
 *
 * 本模块只做执行协调（M1）；普通记忆与画像各自的**纯计划器**（planConsolidationWrite /
 * planProfileWrite）与内容政策保持分离，不合成万能引擎（设计优化建议 §2 的边界）。
 */
import {
  getApproval,
  getApprovalExec,
  markApprovalExecFailed,
  markApprovalExecFileApplied,
  claimApprovalExecRow,
  decideApprovalRow,
  type MemoryDb
} from '../db';
import { MemoryFileReadError } from '../fileRead';

/** claim 过期接管窗（同步执行全链 <1s，30s 足以排除「慢但在跑」的误接管） */
export const APPROVAL_EXEC_STALE_MS = 30_000;

/** 执行失败分类（两族审批共用；调用方映射到各自回执/文案） */
export type ApprovalExecFailureCode =
  | 'busy' // 他人在执行（claim 新鲜 / 领取竞争失败）
  | 'in_flight' // 文件已写但收尾未完成——唯一一致出路是重试批准（r1）
  | 'read_failed' // 写前读取失败（M3 中止，审批保持 pending，可重试）
  | 'write_failed' // 文件写失败（标 failed 释放，可重试）
  | 'conflict' // 现状与计划基线不一致（外部竞写），重试会重规划
  | 'zero_applied'; // 组装后 0 项生效（哈希冲突/超预算/全拒绝——M2：不能算批准成功）

export interface ApprovalExecPlan {
  /** 计划所针对的现状内容哈希（写前校验 + 恢复比对基线） */
  baseHash: string;
  /** 将要写入的目标文件完整正文（幂等重放锚点） */
  plannedContent: string;
  /** 收尾所需执行事实 JSON（applied/rejected/计数等，调用方自定义形状） */
  settleJson: string;
  /** 生效操作数（0 = 零应用，协调器在领取前拦截——M2） */
  appliedCount: number;
}

export interface ApprovalExecFileOutcome {
  ok: boolean;
  /** 失败分类（ok=false 时在场） */
  code?: ApprovalExecFailureCode;
  message?: string;
  /** 实际生效的 settle 事实（ok=true 时在场；恢复路径为旧 attempt 的事实） */
  settleJson?: string;
  /** true = 未执行本次写盘（恢复收尾或他人已写） */
  resumed?: boolean;
}

export interface ApprovalFilePhaseInput {
  approvalId: number;
  now: number;
  /** 读目标文件现状（读取失败抛 MemoryFileReadError——M3 语义） */
  readFile: () => string;
  hashOf: (content: string) => string;
  /** 纯计划器：现状 → 执行计划（不得有副作用） */
  buildPlan: (current: string) => ApprovalExecPlan;
  /**
   * 写前准备：在「落前镜像 + preimageId 并入 settleJson 回写日志」的同事务内调用，
   * 返回合并后的 settleJson（r1-P2③：前镜像关联先于写盘持久化）。fresh 为写前
   * 复核通过的现状内容（哈希 === plan.baseHash）。settleJson 里已有关联 id 时应
   * 幂等跳过（崩溃恢复重放不重复落镜像）。
   */
  prepareWrite: (plan: ApprovalExecPlan, fresh: string, settleJson: string) => string;
  /** 原子写正文（只写文件——镜像/事件分别由 prepareWrite/settle 收口） */
  writeContent: (plannedContent: string) => void;
}

const readFailedOf = (err: unknown): string =>
  err instanceof MemoryFileReadError ? err.message : String((err as Error)?.message ?? err);

/**
 * 文件阶段执行（①领取 → ②写盘 → 推进日志）。返回 ok=true 时 settleJson 就绪，
 * 调用方紧接着 `settleApprovalDecision` 收尾；任何失败都不改 approvals.state
 * （审批保持 pending，用户可重试/驳回——重试走恢复或重规划）。
 */
export function executeApprovalFilePhase(
  db: MemoryDb,
  input: ApprovalFilePhaseInput
): ApprovalExecFileOutcome {
  // 恢复入口：上一 attempt 已把文件写盘（崩溃在收尾前）——不再碰文件
  const journal0 = getApprovalExec(db, input.approvalId);
  if (journal0?.phase === 'file_applied') {
    return { ok: true, settleJson: journal0.settleJson, resumed: true };
  }

  let current: string;
  try {
    current = input.readFile();
  } catch (err) {
    return { ok: false, code: 'read_failed', message: readFailedOf(err) };
  }
  // 领取/接管判定（先于新计划组装：旧 attempt 的现场可能已决定走哪条恢复分支）
  const existing = getApprovalExec(db, input.approvalId);
  if (existing && existing.phase === 'claimed') {
    if (input.now - existing.claimedAt < APPROVAL_EXEC_STALE_MS) {
      return {
        ok: false,
        code: 'busy',
        message: `审批正在另一执行中（attempt ${existing.attempt}，${new Date(existing.claimedAt).toISOString()} 领取）——请稍后重试`
      };
    }
    // 过期接管：按旧日志恢复现场——现状哈希识别「已写/未写/外部改」
    const currentHash = input.hashOf(current);
    if (currentHash === existing.plannedHash) {
      // 旧 attempt 的写盘已落成（崩溃在 phase 推进前）——条件推进（只推自己那行）
      // 并收尾旧事实；不重新组装（重组装会对已应用过的操作得出 0 项可用，误报零应用）
      const marked = markApprovalExecFileApplied(
        db,
        input.approvalId,
        existing.settleJson,
        input.now,
        { attempt: existing.attempt }
      );
      if (marked) return { ok: true, settleJson: existing.settleJson, resumed: true };
      const j = getApprovalExec(db, input.approvalId);
      if (j?.phase === 'file_applied') return { ok: true, settleJson: j.settleJson, resumed: true };
      return {
        ok: false,
        code: 'busy',
        message: `审批执行现场已被接管（attempt ${j?.attempt ?? '?'}）——请稍后重试`
      };
    }
    if (currentHash !== existing.baseHash) {
      // 现状既非旧基线也非旧产物 = 外部修改——释放并明确报错（重试会重规划）
      const error = `审批执行接管时发现目标文件已被外部修改（现状哈希与领取基线/计划产物均不符）`;
      markApprovalExecFailed(db, input.approvalId, error, input.now);
      return { ok: false, code: 'conflict', message: `${error}——请重试（将按现状重新规划）或驳回` };
    }
    // 现状 === 旧基线：旧 attempt 未写盘，走重规划（下方案例路径的 CAS 会接管旧行）
  }

  const plan = input.buildPlan(current);
  if (plan.appliedCount === 0) {
    // M2：零应用不能算批准成功——不领取、不写盘、审批保持 pending（可驳回/重试）。
    // 注意此检查在接管判定之后：已写盘的旧 attempt 不因「新组装 0 项」被误报。
    return { ok: false, code: 'zero_applied', message: '没有操作写入：目标文件可能已变化或操作全部被拒' };
  }
  // 原子领取（CAS，r1-P1① + r2-P1①）：检查+写入同条 upsert，且**同事务内核验审批
  // 仍 pending**——两连接初检后一方驳回、另一方 approve 时，后者领取必然失败，不会写正文
  const attempt = (existing?.attempt ?? 0) + 1;
  let claimed: boolean;
  try {
    claimed = claimApprovalExecRow(db, {
      approvalId: input.approvalId,
      attempt,
      baseHash: plan.baseHash,
      plannedHash: input.hashOf(plan.plannedContent),
      plannedContent: plan.plannedContent,
      settleJson: plan.settleJson,
      staleBefore: input.now - APPROVAL_EXEC_STALE_MS,
      now: input.now
    });
  } catch (err) {
    // 他方持写锁（含写盘事务内停滞超 busy_timeout）——明确 busy，不死锁
    if (/database is locked|SQLITE_BUSY/i.test(String((err as Error)?.message ?? err))) {
      return { ok: false, code: 'busy', message: '执行日志写锁被占用（他方正在写盘或停滞）——请稍后重试' };
    }
    throw err;
  }
  if (!claimed) {
    const j = getApprovalExec(db, input.approvalId);
    if (j?.phase === 'file_applied') return { ok: true, settleJson: j.settleJson, resumed: true };
    const state = getApproval(db, input.approvalId)?.state ?? 'unknown';
    if (state !== 'pending') {
      return {
        ok: false,
        code: 'conflict',
        message: `领取执行权时审批已被并发裁决（state=${state}）——请重试核对结果`
      };
    }
    return {
      ok: false,
      code: 'busy',
      message: `领取审批执行权失败（他方已领取/接管，attempt ${j?.attempt ?? '?'}）——请稍后重试`
    };
  }

  // 写前准备（r1-P2③ + r2-P2③）：前镜像落库 + preimageId 并入 settleJson 回写日志——
  // 同一事务；接管重规划路径上按（cause+文件+内容）复用已持久化的镜像身份，不重复落镜像
  let settleJson: string;
  try {
    settleJson = db.write(() => {
      const merged = input.prepareWrite(plan, current, plan.settleJson);
      const info = db.handle
        .prepare(
          `UPDATE approval_exec SET settle_json = ?, updated_at = ? WHERE approval_id = ? AND attempt = ? AND phase = 'claimed'`
        )
        .run(merged, input.now, input.approvalId, attempt);
      if (Number(info.changes) === 0) throw new Error('CLAIM_SUPERSEDED');
      return merged;
    });
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (message === 'CLAIM_SUPERSEDED') {
      return {
        ok: false,
        code: 'conflict',
        message: '写盘前执行凭据被接管（长时间停滞）——请重试，将按恢复规则继续'
      };
    }
    markApprovalExecFailed(db, input.approvalId, `写前准备失败：${message}`, input.now, { attempt });
    return { ok: false, code: 'write_failed', message: `写前准备（前镜像）失败：${message}` };
  }

  // 写盘（r2-P1②）：资格核验→哈希复核→rename→日志推进收进**同一个写事务**——
  // 跨进程由 BEGIN IMMEDIATE 写锁串行化，持锁期间他方既不能领取/接管也不能驳回；
  // 旧执行者若在停滞期间被接管，复活后在此核验失败，绝不重写（防外部内容被旧产物覆盖）
  return writeOwnedApprovalContent(db, {
    approvalId: input.approvalId,
    attempt,
    now: input.now,
    readFile: input.readFile,
    hashOf: input.hashOf,
    baseHash: plan.baseHash,
    plannedContent: plan.plannedContent,
    settleJson,
    writeContent: input.writeContent
  });
}

/**
 * 持所有权的原子写盘（r2-P1②）：单写事务内「核验 attempt/phase 归属 → 复核现状哈希
 * === baseHash → rename 原子写 → attempt 条件推进 file_applied」。任何一步失败整事务
 * 回滚（写前失败文件保持原样；写后崩溃由 rename 原子性 + 日志哈希恢复兜底）。导出供
 * 旧执行者复活回归直接验证所有权门（不满足时 writeContent 不会被调用）。
 */
export function writeOwnedApprovalContent(
  db: MemoryDb,
  input: {
    approvalId: number;
    attempt: number;
    now: number;
    readFile: () => string;
    hashOf: (content: string) => string;
    baseHash: string;
    plannedContent: string;
    settleJson: string;
    writeContent: (plannedContent: string) => void;
  }
): ApprovalExecFileOutcome {
  try {
    db.write(() => {
      const row = db.handle
        .prepare('SELECT attempt, phase FROM approval_exec WHERE approval_id = ?')
        .get(input.approvalId) as { attempt: number; phase: string } | undefined;
      if (!row || row.attempt !== input.attempt || row.phase !== 'claimed') {
        throw new Error('CLAIM_SUPERSEDED');
      }
      const fresh = input.readFile(); // 哈希复核收进保护窗（claim 后外部竞写在拒）
      if (input.hashOf(fresh) !== input.baseHash) {
        throw new Error('HASH_CHANGED');
      }
      input.writeContent(input.plannedContent); // rename（ms 级；锁内跨进程互斥）
      const info = db.handle
        .prepare(
          `UPDATE approval_exec SET phase = 'file_applied', settle_json = ?, updated_at = ?
           WHERE approval_id = ? AND attempt = ? AND phase = 'claimed'`
        )
        .run(input.settleJson, input.now, input.approvalId, input.attempt);
      if (Number(info.changes) === 0) throw new Error('CLAIM_SUPERSEDED');
    });
    return { ok: true, settleJson: input.settleJson };
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (message === 'CLAIM_SUPERSEDED') {
      // 所有权已失（被接管/他方推进）：绝不重写；按当前日志回明确状态
      const j = getApprovalExec(db, input.approvalId);
      if (j?.phase === 'file_applied') return { ok: true, settleJson: j.settleJson, resumed: true };
      return {
        ok: false,
        code: 'conflict',
        message: `写盘时执行凭据已被接管（attempt ${j?.attempt ?? '?'}）——本执行者已让位，未写任何内容；请重试按恢复规则继续`
      };
    }
    if (message === 'HASH_CHANGED') {
      const error = '写盘前目标文件已发生变化（外部竞写）';
      markApprovalExecFailed(db, input.approvalId, error, input.now, { attempt: input.attempt });
      return { ok: false, code: 'conflict', message: `${error}——请重试（将按现状重新规划）或驳回` };
    }
    if (/database is locked|SQLITE_BUSY/i.test(message)) {
      // 他方持写锁（含他方在写盘事务内停滞超 busy_timeout）——明确 busy，不死锁
      return {
        ok: false,
        code: 'busy',
        message: '执行日志写锁被占用（他方正在写盘或停滞）——请稍后重试'
      };
    }
    markApprovalExecFailed(db, input.approvalId, `文件写入失败：${message}`, input.now, { attempt: input.attempt });
    return { ok: false, code: 'write_failed', message: `文件写入失败：${message}` };
  }
}

/**
 * reject 前的执行日志协调（r1-P1②；在 settle 事务内调用，读文件+判哈希均同步）：
 * 文件已写（file_applied，或 claimed 且现状===plannedHash）→ 阻断驳回（in_flight，
 * 唯一一致出路是重试批准完成收尾）；claimed 新鲜 → busy；claimed 过期且未写盘 →
 * 释放僵尸领取后放行。返回 null = 可驳回。
 */
export function approvalExecRejectGuard(
  db: MemoryDb,
  input: {
    approvalId: number;
    now: number;
    readFile: () => string;
    hashOf: (content: string) => string;
  }
): { code: 'in_flight' | 'busy'; message: string } | null {
  const journal = getApprovalExec(db, input.approvalId);
  if (!journal) return null;
  if (journal.phase === 'file_applied') {
    return {
      code: 'in_flight',
      message: `文件已写入但收尾未完成（attempt ${journal.attempt}）——请重试「批准」完成收尾；此时驳回会造成裁决与正文不一致`
    };
  }
  if (journal.phase === 'claimed') {
    let fileWritten = false;
    let readFailed = false;
    try {
      fileWritten = input.hashOf(input.readFile()) === journal.plannedHash;
    } catch {
      readFailed = true;
    }
    if (readFailed) {
      return { code: 'busy', message: '执行现场无法核验（目标文件读取失败）——请稍后重试驳回' };
    }
    if (fileWritten) {
      // 崩在 rename 后、phase 推进前——补推进后同样阻断（重试批准完成收尾）
      markApprovalExecFileApplied(db, input.approvalId, journal.settleJson, input.now, {
        attempt: journal.attempt
      });
      return {
        code: 'in_flight',
        message: `文件已写入但收尾未完成（attempt ${journal.attempt}）——请重试「批准」完成收尾；此时驳回会造成裁决与正文不一致`
      };
    }
    if (input.now - journal.claimedAt < APPROVAL_EXEC_STALE_MS) {
      return {
        code: 'busy',
        message: `审批正在另一执行中（attempt ${journal.attempt}）——请稍后重试驳回`
      };
    }
    // 过期且未写盘：释放僵尸领取后放行驳回
    markApprovalExecFailed(db, input.approvalId, '驳回前释放过期领取', input.now);
  }
  return null;
}

export type SettleOutcome =
  | { settled: true }
  | { settled: false; reason: 'already_decided' }
  | { settled: false; reason: 'blocked'; code: 'in_flight' | 'busy'; message: string };

/**
 * 收尾阶段（③）：单事务「（可选前置检 approvalExecRejectGuard）+ 条件翻转
 * approvals.state + settle 回调」。翻转条件失败（changes=0）= 他方已裁决——返回
 * already_decided，**调用方必须核验最终裁决态**（approved → 幂等回执；rejected →
 * 明确失败，不得报成功——r1-P1②）。
 */
export function settleApprovalDecision(
  db: MemoryDb,
  input: {
    approvalId: number;
    state: 'approved' | 'rejected';
    now: number;
    /** 翻转前置检（同事务内执行；返回非 null = 中止收尾并整体回滚） */
    preCheck?: () => { code: 'in_flight' | 'busy'; message: string } | null;
    /** 状态翻转成功后在同事务内执行（内部再用 db.write 的函数会重入当前事务） */
    onSettle: () => void;
  }
): SettleOutcome {
  return db.write(() => {
    if (input.preCheck) {
      const blocked = input.preCheck();
      if (blocked) return { settled: false, reason: 'blocked', ...blocked };
    }
    const flipped = decideApprovalRow(db, input.approvalId, input.state, input.now);
    if (!flipped) return { settled: false, reason: 'already_decided' };
    input.onSettle();
    return { settled: true };
  });
}
