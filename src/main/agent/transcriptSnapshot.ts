/**
 * B3 transcript 快照（zcode-adoption-plan B3）：compact 执行前把 pi 会话 JSONL
 * 复制为快照，压缩摘要丢细节时模型可用文件工具按需回读（ZCode
 * buildCompactSummaryMessage 的 transcriptPath 条款同思路；pi 的摘要消息由引擎
 * 生成宿主不掺写，指针改走 C1 同款回合前缀注入）。
 *
 * **会话数据布局（2026-09-23 spike，详见 docs/features/scheduler-prompt-injection.md）**：
 * 调度 pi 会话文件在 `store.getPiSessionDir(wsId)` = `<userData>/pi-sessions/<safe wsId>/`，
 * 文件名 `<时间戳>_<sessionId>.jsonl`（pi session-manager.js:667，时间戳内 `:.` 已被
 * 替换为 `-`，首个 `_` 前是时间戳）。快照落同一目录：
 * `transcript-<sessionId>-<毫秒时间戳>.jsonl`（不加 gzip——模型要用 Read 工具读原文，
 * 压缩后不可读；体积控制靠「每 sessionId 保留最近 2 份、更旧的删」）。
 *
 * **失败语义**：快照 fail-open——任何失败只降级日志，绝不阻塞 compact（压缩是主
 * 流程；丢快照的代价是细节回读不可用，可接受）。
 */
import { promises as fsp } from 'node:fs';
import { join as pathJoin, basename } from 'node:path';

/** 每个 sessionId 保留的最近快照份数（更旧的删） */
export const TRANSCRIPT_SNAPSHOT_KEEP = 2;

/** 快照文件名前缀（同目录会话文件非此前缀，prune 按 sessionId 归组互不误伤） */
export const TRANSCRIPT_SNAPSHOT_PREFIX = 'transcript-';

/**
 * 从 pi 会话文件名提取 sessionId：`<时间戳>_<sessionId>.jsonl` 取最后一段
 * （时间戳已被 pi 规范为无 `_` 形态；sessionId 为 UUID 无 `_`）。不形态匹配时
 * 回落为去扩展名的完整文件名主干（幂等：对快照名再解析得到自身主干）。
 */
export function parseSessionIdFromSessionFile(sessionFile: string): string {
  const stem = basename(sessionFile).replace(/\.jsonl$/i, '');
  const idx = stem.indexOf('_');
  return idx >= 0 ? stem.slice(idx + 1) : stem;
}

/** 快照目标文件名（同目录平铺；时间戳毫秒精度防同回合重名） */
export function snapshotFileName(sessionId: string, nowMs: number): string {
  return `${TRANSCRIPT_SNAPSHOT_PREFIX}${sessionId}-${nowMs}.jsonl`;
}

/** 删除计划（纯函数，可测）：同 sessionId 的旧快照按名内时间戳倒序保留 keep 份，其余删除 */
export function prunePlan(
  files: readonly string[],
  sessionId: string,
  keep: number = TRANSCRIPT_SNAPSHOT_KEEP
): string[] {
  const mine: Array<{ file: string; ts: number }> = [];
  const head = `${TRANSCRIPT_SNAPSHOT_PREFIX}${sessionId}-`;
  for (const f of files) {
    const name = basename(f);
    if (!name.startsWith(head) || !name.endsWith('.jsonl')) continue;
    const ts = Number(name.slice(head.length, -'.jsonl'.length));
    mine.push({ file: f, ts: Number.isFinite(ts) ? ts : 0 });
  }
  mine.sort((a, b) => b.ts - a.ts);
  return mine.slice(keep).map((m) => m.file);
}

export interface TranscriptSnapshotArgs {
  /** 当前绑定的 pi 会话文件（无 → 无可快照，返回 null） */
  sessionFile?: string | null;
  /** 会话目录（store.getPiSessionDir(wsId)） */
  sessionDir: string;
  /** 快照时间戳（缺省 Date.now()；测试注入时钟） */
  nowMs?: number;
  /** 保留份数（缺省 2） */
  keep?: number;
}

/**
 * compact 前快照：复制会话 JSONL → 快照 → 清旧。全程 fail-open：
 * 会话文件缺失/读失败/写失败都只 console.warn 并返回 null（调用方不注入指针行）。
 */
export async function snapshotTranscriptForCompact(args: TranscriptSnapshotArgs): Promise<string | null> {
  const sessionFile = args.sessionFile?.trim();
  if (!sessionFile) return null;
  const nowMs = typeof args.nowMs === 'number' && Number.isFinite(args.nowMs) ? args.nowMs : Date.now();
  const keep = typeof args.keep === 'number' && Number.isFinite(args.keep) && args.keep >= 1 ? Math.floor(args.keep) : TRANSCRIPT_SNAPSHOT_KEEP;
  try {
    await fsp.access(sessionFile);
    const sessionId = parseSessionIdFromSessionFile(sessionFile);
    const target = pathJoin(args.sessionDir, snapshotFileName(sessionId, nowMs));
    await fsp.copyFile(sessionFile, target);
    // 清旧：只动本 sessionId 的快照（同目录还有会话本体与其他快照）
    const files = await fsp.readdir(args.sessionDir);
    const stale = prunePlan(
      files.map((f) => pathJoin(args.sessionDir, f)),
      sessionId,
      keep
    );
    for (const old of stale) {
      if (old === target) continue;
      await fsp.rm(old, { force: true }).catch(() => {});
    }
    return target;
  } catch (err) {
    console.warn('[orchestrator] transcript 快照失败（忽略，压缩继续）', err);
    return null;
  }
}
