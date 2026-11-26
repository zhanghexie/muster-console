/**
 * 记忆面板存储层（docs/memory/MEMORY.md 的受控文件 IO；自 metaAgent/memoryStore.ts
 * 迁入——memory-refactor B8 旧件退役：注入/检索职责已由 MemoryService 承接并随旧
 * 模块删除，这里只保留面板 IPC（memory:get/saveEntry/forget/restore）与回收站恢复
 * 通道仍在消费的部分。记忆中心 hub（center.ts）与本层并存：条目注解走 hub 通道，
 * 正文编辑/删除/恢复走本层（shared/memoryIpc 合同）。
 *
 * 写路径纪律：整文件重写仅限本模块，全部带 stale hash 防护；删除必落 recovery 备份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeTextAtomicSync } from '../atomicJson';
import { t } from '../../shared/i18n';
import {
  appendEntryToContent,
  findConflictPairs,
  findDuplicatePairs,
  isRecoveryRecord,
  MEMORY_INPUT_MAX,
  normalizeLinkInput,
  normalizeTagInput,
  parseMemoryEntries,
  removeEntryById,
  replaceRawBlock,
  selectEntriesForInjection,
  stripLeadingMarkers,
  serializeMemoryEntry,
  type MemoryEntry,
  type MemoryRecoveryRecord
} from '../../shared/memoryFormat';
import { readTextFile } from './fileRead';
import type {
  MemoryDerived,
  MemoryForgetResult,
  MemoryGetResult,
  MemoryInjectionInfo,
  MemoryPatchResult,
  MemoryRecoveryItem
} from '../../shared/memoryIpc';
import {
  contentHash,
  memoryFilePath,
  recoveryDirFor
} from './paths';

/**
 * 共享核心注入预算（面板「注入信息」展示口径；实际注入组装在 memory/injection.ts）。
 */
export const MEMORY_CONTEXT_MAX_CHARS = 16_000;

function readIfExists(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 读取（面板共用）
// ---------------------------------------------------------------------------

/** 回收站条目预览：正文末行截 80 字符（超长带省略号） */
function recoveryPreview(removedContent: string[]): string {
  const last = (removedContent[0] ?? '').split('\n').filter((l) => l.trim()).slice(-1)[0] ?? '';
  return last.length > 80 ? `${last.slice(0, 80)}…` : last;
}

function listRecovery(root: string): MemoryRecoveryItem[] {
  const recovery: MemoryRecoveryItem[] = [];
  const dir = recoveryDirFor(root);
  try {
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed: unknown = JSON.parse(readIfExists(path.join(dir, name)) ?? '');
        if (!isRecoveryRecord(parsed)) continue;
        recovery.push({ id: parsed.id, createdAt: parsed.createdAt, preview: recoveryPreview(parsed.removedContent) });
      } catch {
        /* 单个坏文件不拖垮列表 */
      }
    }
  } catch {
    /* ignore */
  }
  return recovery.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function injectionInfoOf(entries: MemoryEntry[]): MemoryInjectionInfo {
  const sel = selectEntriesForInjection(entries, MEMORY_CONTEXT_MAX_CHARS);
  return {
    budgetChars: MEMORY_CONTEXT_MAX_CHARS,
    includedIds: sel.selected.map((e) => e.id),
    droppedIds: sel.dropped.map((e) => e.id)
  };
}

/** 派生数据（duplicates/conflicts/recovery/injection）与 MemoryGetResult 同源重算 */
function derivedOf(root: string, entries: MemoryEntry[]): MemoryDerived {
  return {
    duplicates: findDuplicatePairs(entries),
    conflicts: findConflictPairs(entries),
    recovery: listRecovery(root),
    injection: injectionInfoOf(entries)
  };
}

export function memoryGet(root: string, now?: Date): MemoryGetResult {
  void now;
  const content = readIfExists(memoryFilePath(root));
  const entries = content ? parseMemoryEntries(content) : [];
  return {
    exists: content != null,
    hash: content ? contentHash(content) : '',
    entries,
    ...derivedOf(root, entries)
  };
}

// ---------------------------------------------------------------------------
// 写路径（全部整文件重写 + stale hash 防护；删除先落 recovery）
// ---------------------------------------------------------------------------

/** 写前读取（M3）：ENOENT/真实空文件→''；读取失败抛错（saveEntry/forget/restore
 *  的整文件重写不把读失败当空文件——否则一次 EIO 就把旧记忆全部覆盖掉） */
function readFreshForWrite(root: string, baseHash: string): { content: string; stale: boolean } {
  const r = readTextFile(memoryFilePath(root));
  let content: string;
  if (r.status === 'ok') content = r.content;
  else if (r.status === 'missing') content = '';
  else throw new Error(t('读取 {{file}} 失败（{{code}}）——已中止写入，防止覆盖既有记忆', { file: memoryFilePath(root), code: r.code }));
  const current = content ? contentHash(content) : '';
  return { content, stale: baseHash !== current };
}

function staleResult(root: string, content: string): { stale: true; hash: string; entries: MemoryEntry[] } & MemoryDerived {
  const entries = parseMemoryEntries(content);
  return { stale: true, hash: contentHash(content), entries, ...derivedOf(root, entries) };
}

/** 写入约束：text 非空且不超长（tags/links 在 shared 归一） */
function normalizeInput(input: { tags: unknown; links: unknown; text: unknown }): {
  tags: string[];
  links: string[];
  text: string;
} {
  const text = String(input.text ?? '').trim();
  if (!text) throw new Error(t('记忆内容不能为空'));
  if (text.length > MEMORY_INPUT_MAX.text) {
    throw new Error(t('记忆内容超长（{{max}} 字符上限，当前 {{n}}）', { max: MEMORY_INPUT_MAX.text, n: text.length }));
  }
  return { tags: normalizeTagInput(input.tags), links: normalizeLinkInput(input.links), text };
}

function writeFileHash(root: string, content: string): { hash: string; entries: MemoryEntry[] } & MemoryDerived {
  const file = memoryFilePath(root);
  // 原子写收口到 shared 同款（tmp + rename 重试 + 失败清 tmp），不再本地另养一份 renameWithRetry
  writeTextAtomicSync(file, content);
  const entries = parseMemoryEntries(content);
  return { hash: contentHash(content), entries, ...derivedOf(root, entries) };
}

/** 新增/更新一条：id 为空 = 追加新条目（自动盖时间戳）；有 id = 原位替换正文。
 *  未识别条目的「原位替换」= 把原 raw 块替换为结构化条目（不再追加留双份）。 */
export function memorySaveEntry(
  root: string,
  baseHash: string,
  input: { id?: string; tags: unknown; links: unknown; text: unknown },
  now?: Date
): MemoryPatchResult {
  const fresh = readFreshForWrite(root, baseHash);
  if (fresh.stale) return staleResult(root, fresh.content);
  const entries = parseMemoryEntries(fresh.content);
  const { tags, links, text } = normalizeInput(input);
  const block = serializeMemoryEntry({ ts: '', sessionId: '', tags, links, text: stripLeadingMarkers(text) }, now);
  let next: string;
  if (input.id) {
    const target = entries.find((e) => e.id === input.id);
    if (!target) throw new Error(t('条目不存在或已被删除：{{id}}', { id: input.id }));
    next = target.unparsed
      ? replaceRawBlock(fresh.content, target.raw, block)
      : `${entries
          .map((e) =>
            e.id === input.id
              ? serializeMemoryEntry(
                  { ts: e.ts, sessionId: e.sessionId, tags, links, text: stripLeadingMarkers(text) },
                  now
                )
              : e.raw
          )
          .join('\n\n')}\n`;
  } else {
    next = appendEntryToContent(fresh.content, block);
  }
  return { stale: false, ...writeFileHash(root, next) };
}

/** 删除一条：先落 recovery 备份（wx 独占创建），再整写移除；整写失败回滚备份文件防孤儿 */
export function memoryForget(root: string, baseHash: string, id: string): MemoryForgetResult {
  const fresh = readFreshForWrite(root, baseHash);
  if (fresh.stale) return staleResult(root, fresh.content);
  const removed = removeEntryById(fresh.content, id);
  if (!removed) throw new Error(t('条目不存在或已被删除：{{id}}', { id }));
  const record: MemoryRecoveryRecord = {
    version: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    removedContent: [removed.removed.raw]
  };
  const dir = recoveryDirFor(root);
  fs.mkdirSync(dir, { recursive: true });
  const recFile = path.join(dir, `${record.id}.json`);
  fs.writeFileSync(recFile, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  let result: { stale: false; hash: string; entries: MemoryEntry[]; recoveryId: string } & MemoryDerived;
  try {
    result = { stale: false, recoveryId: record.id, ...writeFileHash(root, removed.content) };
  } catch (err) {
    // 整写失败：条目其实没删掉，回收站不该出现「可恢复的幽灵」——回滚备份后原样抛出
    try {
      fs.rmSync(recFile, { force: true });
    } catch {
      /* 回滚失败保留备份也无害（恢复即多一条重复） */
    }
    throw err;
  }
  return result;
}

/** 恢复一条删除：把备份条目追加回文末，并消费（删除）recovery 文件 */
export function memoryRestore(root: string, baseHash: string, recoveryId: string): MemoryPatchResult {
  if (!/^[0-9a-f-]{36}$/i.test(recoveryId)) throw new Error(t('非法的恢复 ID'));
  const recFile = path.join(recoveryDirFor(root), `${recoveryId}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readIfExists(recFile) ?? '');
  } catch {
    parsed = undefined;
  }
  if (!isRecoveryRecord(parsed)) throw new Error(t('恢复记录不存在或已损坏'));
  const fresh = readFreshForWrite(root, baseHash);
  if (fresh.stale) return staleResult(root, fresh.content);
  const next = appendEntryToContent(fresh.content, (parsed as MemoryRecoveryRecord).removedContent.join('\n\n'));
  const result = writeFileHash(root, next);
  try {
    fs.rmSync(recFile);
  } catch {
    /* 恢复已生效，清理失败不影响 */
  }
  return { stale: false, ...result };
}

/**
 * 彻底删除一条旧 recovery 备份（不可恢复）。只删备份文件，不动策展正文——
 * 与 memoryRestore（消费备份并写回正文）相对；UI 必须走确认框。
 */
export function memoryPurgeRecovery(root: string, recoveryId: string): { ok: boolean; id: string; error: string | null } {
  if (!/^[0-9a-f-]{36}$/i.test(recoveryId)) throw new Error(t('非法的恢复 ID'));
  const recFile = path.join(recoveryDirFor(root), `${recoveryId}.json`);
  if (!fs.existsSync(recFile)) return { ok: false, id: recoveryId, error: t('恢复记录不存在：{{id}}', { id: recoveryId }) };
  try {
    fs.rmSync(recFile);
  } catch (err) {
    return { ok: false, id: recoveryId, error: String((err as Error)?.message ?? err) };
  }
  return { ok: true, id: recoveryId, error: null };
}

// 面板「注入信息」外的旧导出（readMemoryContext/memoryVersionToken/memoryAppend/
// truncateTail）已随 memory-refactor B8 注入收敛/工具退役删除——注入走 MemoryService.inject。
