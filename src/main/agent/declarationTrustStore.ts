/**
 * DeclarationTrustStore（zcode-adopt-batch-b B1 / S2.1）：声明 digest 信任账本的
 * userData 单写者文件 IO + 注入门裁决。
 *
 * 存储：`userData/declaration-trust/<workspaceId>.json`（本地审计，不进 git）；
 * 条目 key = (workspaceIdentity, declarationDigest)，value = 记录（纯函数层定义）。
 * 裁决与单调比较一律走 shared/declarationTrust（禁止本层手写比较）。
 * 一期接入面（registry 条目 / HOST 片段）的主体构造见 declarationTrustSources.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../atomicJson';
import {
  declarationTrustKey,
  evaluateSubjectTrust,
  isDeclarationTrustState,
  reviewMonotonicity,
  subjectDigest,
  type DeclarationDigestRecord,
  type DeclarationSubject,
  type DeclarationTrustRecord,
  type DeclarationTrustState,
  type ReviewRef
} from '../../shared/declarationTrust';
import { safeScopedKey, userDataStorage } from '../runtimeKernel/storageRootResolver';

/** userData 下的信任账本子目录（每工作区一个 <workspaceId>.json） */
export const DECLARATION_TRUST_DIR = 'declaration-trust';
export const DECLARATION_TRUST_SCHEMA_VERSION = 1;

export interface DeclarationTrustBook {
  schemaVersion: number;
  /** key = declarationTrustKey(workspaceIdentity, digest) */
  entries: Record<string, DeclarationTrustRecord>;
}

export function emptyDeclarationTrustBook(): DeclarationTrustBook {
  return { schemaVersion: DECLARATION_TRUST_SCHEMA_VERSION, entries: {} };
}

/**
 * userData 目录：index.ts 启动时注入（app.getPath('userData')）；测试注入临时目录。
 * 未注入即调用属装配错误，抛出。
 */
let declarationTrustUserDataDir: string | null = null;

export function setDeclarationTrustUserDataDir(dir: string): void {
  declarationTrustUserDataDir = path.resolve(dir);
}

function requireDeclarationTrustUserDataDir(): string {
  if (!declarationTrustUserDataDir) {
    throw new Error('[declarationTrust] userData 目录未注入（setDeclarationTrustUserDataDir）');
  }
  return declarationTrustUserDataDir;
}

export function declarationTrustFilePath(workspaceId: string): string {
  const root = userDataStorage(requireDeclarationTrustUserDataDir()).manifestPath('declaration-trust');
  return path.join(root, `${safeScopedKey(workspaceId.trim() || 'default')}.json`);
}

function coerceRecord(v: unknown): DeclarationTrustRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const grantedAt = Number.isFinite(o.grantedAt) ? Math.floor(o.grantedAt as number) : null;
  const event = typeof o.event === 'string' ? o.event.slice(0, 200) : '';
  const displayCommand = typeof o.displayCommand === 'string' ? o.displayCommand.slice(0, 500) : '';
  const sourcePath = typeof o.sourcePath === 'string' ? o.sourcePath.slice(0, 500) : '';
  const state = isDeclarationTrustState(o.state) ? (o.state as DeclarationTrustState) : null;
  if (grantedAt === null || !event || !state) return null;
  let review: ReviewRef | undefined;
  if (typeof o.review === 'object' && o.review !== null) {
    const r = o.review as Record<string, unknown>;
    if (
      typeof r.reviewFlowId === 'string' &&
      Number.isFinite(r.generation) &&
      typeof r.interactionId === 'string'
    ) {
      review = {
        reviewFlowId: r.reviewFlowId.slice(0, 200),
        generation: Math.floor(r.generation as number),
        interactionId: r.interactionId.slice(0, 200)
      };
    }
  }
  return {
    grantedAt,
    event,
    displayCommand,
    sourcePath,
    state,
    ...(review ? { review } : {})
  };
}

export function parseDeclarationTrustBook(raw: unknown): DeclarationTrustBook {
  try {
    const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown> | null;
    const entriesIn =
      parsed !== null && typeof parsed.entries === 'object' && parsed.entries !== null ? parsed.entries : {};
    const entries: Record<string, DeclarationTrustRecord> = {};
    for (const [k, v] of Object.entries(entriesIn as Record<string, unknown>)) {
      const rec = coerceRecord(v);
      if (rec) entries[k] = rec;
    }
    return { schemaVersion: DECLARATION_TRUST_SCHEMA_VERSION, entries };
  } catch {
    return emptyDeclarationTrustBook();
  }
}

/** 读当前账本：缺失/损坏 → 空账本（查询不被坏文件拖垮；写路径重建） */
export function readDeclarationTrustBook(workspaceId: string): DeclarationTrustBook {
  const file = declarationTrustFilePath(workspaceId);
  try {
    // X3-F11：JSON.parse 提到读侧，损坏与 fs 错误都能在这一个 catch 留诊断线索
    // （fail-safe 方向不变：重新确认即可重建）；ENOENT=从未确认过，属正常态
    return parseDeclarationTrustBook(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `[declaration-trust] 信任账本文件损坏/不可读，按空账本起步（重新确认即可重建）：${file}`,
        err instanceof Error ? err.message : err
      );
    }
    return emptyDeclarationTrustBook();
  }
}

/**
 * 取某 workspaceIdentity 下匹配（可选 sourcePath/displayCommand 过滤）的已裁决记录。
 * 返回 DeclarationDigestRecord[]（含 digest）供 evaluateSubjectTrust 使用。
 */
export function readDeclarationRecords(
  workspaceId: string,
  workspaceIdentity: string,
  filter?: { sourcePath?: string; displayCommand?: string }
): DeclarationDigestRecord[] {
  const book = readDeclarationTrustBook(workspaceId);
  const out: DeclarationDigestRecord[] = [];
  const prefix = `${workspaceIdentity}\u0000`;
  for (const [key, record] of Object.entries(book.entries)) {
    if (!key.startsWith(prefix)) continue;
    const digest = key.slice(prefix.length);
    if (filter?.sourcePath !== undefined && record.sourcePath !== filter.sourcePath) continue;
    if (filter?.displayCommand !== undefined && record.displayCommand !== filter.displayCommand) {
      continue;
    }
    out.push({ digest, record });
  }
  return out;
}

/**
 * 写入/覆盖一条裁决（读盘 → 纯函数裁决 → 原子写）。
 * 双方都带 review 时用 reviewMonotonicity 拒绝倒退写；否则直接落账。
 * 返回是否实际写入。
 */
export function putDeclarationTrustRecord(
  workspaceId: string,
  workspaceIdentity: string,
  digest: string,
  record: DeclarationTrustRecord
): boolean {
  const file = declarationTrustFilePath(workspaceId);
  const book = readDeclarationTrustBook(workspaceId);
  const key = declarationTrustKey(workspaceIdentity, digest);
  const prev = book.entries[key];
  if (prev?.review && record.review) {
    if (!reviewMonotonicity(prev.review, record.review)) return false;
  }
  book.entries[key] = record;
  writeJsonAtomicSync(file, book);
  return true;
}

export interface DeclarationGateResult {
  subject: DeclarationSubject;
  digest: string;
  state: DeclarationTrustState;
  /** 仅 trusted_persistent 放行（未信任/stale/拒绝/撤销一律不注入） */
  inject: boolean;
}

/**
 * 注入门裁决：主体 × 账本记录 → 每条 {state, inject}。
 * 未信任不注入、信任后注入、内容变 digest 变回 stale_digest——本函数是唯一口径。
 */
export function evaluateDeclarationGate(
  workspaceId: string,
  workspaceIdentity: string,
  subjects: readonly DeclarationSubject[]
): DeclarationGateResult[] {
  const records = readDeclarationRecords(workspaceId, workspaceIdentity);
  return subjects.map((subject) => {
    const verdict = evaluateSubjectTrust(subject, records);
    return {
      subject,
      digest: verdict.digest,
      state: verdict.state,
      inject: verdict.inject
    };
  });
}

/** 注入门：只返回可注入主体（未信任/stale/拒绝/撤销被滤掉） */
export function filterInjectableDeclarations(
  workspaceId: string,
  workspaceIdentity: string,
  subjects: readonly DeclarationSubject[]
): DeclarationSubject[] {
  return evaluateDeclarationGate(workspaceId, workspaceIdentity, subjects)
    .filter((r) => r.inject)
    .map((r) => r.subject);
}

/** 首见登记：无记录的主体落 pending_trust（进 pending 审批，不自动放行）。
 * 同声明已有旧 digest 记录（内容变）→ 不落账，有效态由 evaluate 裁为 stale_digest。
 * 批量单读单写（复审：逐主体全量读+写放大 ~4×N 次同步 IO）；顺带裁剪同主体
 * 被新 digest 取代的旧记录（每主体留最新 3 条，防 HOST-EXT 类高频变更无界累积）。 */
export function registerPendingDeclarations(
  workspaceId: string,
  workspaceIdentity: string,
  subjects: readonly DeclarationSubject[],
  now = Date.now()
): number {
  const file = declarationTrustFilePath(workspaceId);
  const book = readDeclarationTrustBook(workspaceId);
  const prefix = `${workspaceIdentity}\u0000`;
  const pairOf = (sourcePath: string, displayCommand: string): string =>
    `${sourcePath}\u0000${displayCommand}`;
  const digestCountByPair = new Map<string, number>();
  for (const [key, record] of Object.entries(book.entries)) {
    if (!key.startsWith(prefix)) continue;
    const pair = pairOf(record.sourcePath, record.displayCommand);
    digestCountByPair.set(pair, (digestCountByPair.get(pair) ?? 0) + 1);
  }
  let n = 0;
  for (const subject of subjects) {
    const digest = subjectDigest(subject);
    const key = declarationTrustKey(workspaceIdentity, digest);
    if (book.entries[key]) continue;
    const pair = pairOf(subject.sourcePath, subject.displayCommand);
    // 内容变：同 sourcePath+displayCommand 已有其它 digest → 保持 stale 语义，不写 pending
    if ((digestCountByPair.get(pair) ?? 0) > 0) continue;
    book.entries[key] = {
      grantedAt: now,
      event: 'register_pending',
      displayCommand: subject.displayCommand,
      sourcePath: subject.sourcePath,
      state: 'pending_trust'
    };
    digestCountByPair.set(pair, 1);
    n += 1;
  }
  // 裁剪不论本次是否新增：HOST-EXT 类高频内容变更走的是「不落 pending」路径，
  // 若只在 n>0 时裁剪，被取代的旧 digest 会永远累积。
  const before = Object.keys(book.entries).length;
  pruneSupersededDigests(book, prefix, 3);
  if (n > 0 || Object.keys(book.entries).length !== before) {
    writeJsonAtomicSync(file, book);
  }
  return n;
}

/** 裁剪同主体被取代的旧 digest 记录（每主体保留最新 keep 条；grantedAt 新者留） */
function pruneSupersededDigests(book: DeclarationTrustBook, prefix: string, keep: number): void {
  const byPair = new Map<string, Array<{ key: string; grantedAt: number }>>();
  for (const [key, record] of Object.entries(book.entries)) {
    if (!key.startsWith(prefix)) continue;
    const pair = `${record.sourcePath}\u0000${record.displayCommand}`;
    const list = byPair.get(pair) ?? [];
    list.push({ key, grantedAt: record.grantedAt });
    byPair.set(pair, list);
  }
  const drop = new Set<string>();
  for (const list of byPair.values()) {
    if (list.length <= keep) continue;
    list.sort((a, b) => b.grantedAt - a.grantedAt);
    for (const item of list.slice(keep)) drop.add(item.key);
  }
  for (const k of drop) delete book.entries[k];
}

/**
 * 人审裁决（grant / deny / revoke）：写账并返回是否被单调时钟接受。
 * 内容变更后 digest 变，需对新 digest 重新裁决（旧 trusted 记录留在旧 digest 键下）。
 */
export function applyDeclarationReview(input: {
  workspaceId: string;
  workspaceIdentity: string;
  subject: DeclarationSubject;
  state: Extract<
    DeclarationTrustState,
    'trusted_persistent' | 'blocked_untrusted' | 'blocked_policy' | 'revoked'
  >;
  event: string;
  grantedAt?: number;
  review?: ReviewRef;
}): boolean {
  const digest = subjectDigest(input.subject);
  return putDeclarationTrustRecord(input.workspaceId, input.workspaceIdentity, digest, {
    grantedAt: input.grantedAt ?? Date.now(),
    event: input.event,
    displayCommand: input.subject.displayCommand,
    sourcePath: input.subject.sourcePath,
    state: input.state,
    ...(input.review ? { review: input.review } : {})
  });
}
