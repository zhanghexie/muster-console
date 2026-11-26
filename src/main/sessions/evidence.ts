import { userDataStorage } from '../runtimeKernel/storageRootResolver';
/**
 * EvidenceCollector（T4.4）：证据归集主进程服务。
 * 证据按会话落 userData/evidence/<sessionId>/：
 * - pty-slice：看板 phase 翻转时刻的 pty transcript 切片（翻转时尾部 N 行 + 45s 后补抓）；
 * - bgtask-summary：GUI 会话后台终端（bgtasks.shell）构建/测试输出的终态摘要（内联索引）；
 * - browser-shot：内置浏览器截图副本（默认关，config.evidence.browserShots）。
 * 索引 index.json 原子写 + 7 天滚动清理（启动后 30s 首跑、每 24h 一轮）。
 * 证据是 best-effort：任何 IO 失败只 warn，不影响会话主流程。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../atomicJson';
import { stripAnsiForDisplay as ansiStrip } from '../detect/stripAnsi';
import type { BgTaskRecord } from '../../shared/backgroundTasks';
import {
  EVIDENCE_AFTER_MS,
  EVIDENCE_BGTASK_SUMMARY_MAX,
  EVIDENCE_PTY_SLICE_LINES,
  EVIDENCE_PTY_TAIL_CHARS,
  appendEvidenceEntry,
  evidenceDirExpired,
  evidenceEntryId,
  formatAfterSection,
  formatPhaseFlipHeader,
  newEvidenceIndex,
  pruneEvidenceEntries,
  sanitizeEvidenceSessionDir,
  slicePtyTail,
  truncateEvidenceText,
  type EvidenceEntry,
  type EvidenceIndex,
  type EvidencePhaseRef,
  type EvidenceTurnShotMeta
} from '../../shared/evidence';

const CLEANUP_FIRST_DELAY_MS = 30_000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface EvidenceCollectorOpts {
  userDataDir: string;
  /** pty 尾部原始文本（PtyManager.getBufferTail 按字符预算截取）；无会话/无输出返回 undefined */
  getPtyTail: (sessionId: string, maxChars: number) => string | undefined;
  /** browser 截图证据开关（默认关） */
  isBrowserShotEnabled: () => boolean;
  /** 测试注入时钟 */
  now?: () => number;
  /** 翻转后补抓等待（默认 45s；测试调小） */
  afterMs?: number;
}

export class EvidenceCollector {
  private rootDir: string;
  private indexes = new Map<string, EvidenceIndex>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly pendingTimers = new Set<NodeJS.Timeout>();
  private stopped = false;
  private readonly now: () => number;
  private readonly afterMs: number;

  constructor(private opts: EvidenceCollectorOpts) {
    this.rootDir = userDataStorage(opts.userDataDir).resolve('app', 'evidence');
    this.now = opts.now ?? Date.now;
    this.afterMs = opts.afterMs ?? EVIDENCE_AFTER_MS;
  }

  /** 启动滚动清理调度（启动后 30s 首跑 + 每 24h；均 unref 不阻退出） */
  start(): void {
    if (this.stopped) throw new Error('Evidence collector is stopped');
    if (this.cleanupTimer) return;
    const first = setTimeout(() => { this.pendingTimers.delete(first); if (!this.stopped) this.runCleanup(); }, CLEANUP_FIRST_DELAY_MS);
    this.pendingTimers.add(first);
    first.unref?.();
    this.cleanupTimer = setInterval(() => this.runCleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
  }

  private runCleanup(): void {
    try {
      const removed = this.cleanupExpired(this.now());
      if (removed > 0) console.log(`[evidence] 滚动清理删除 ${removed} 个过期会话目录`);
    } catch (e) {
      console.warn('[evidence] 滚动清理失败', e);
    }
  }

  private dirOf(sessionId: string): string | null {
    if (this.stopped) return null;
    const safe = sanitizeEvidenceSessionDir(sessionId);
    return safe ? userDataStorage(this.opts.userDataDir).scopedPath('session', 'evidence', sessionId, () => safe) : null;
  }

  /** 翻转时刻证据：pty 尾部切片落文件 + 索引；afterMs 后补抓 after 段（buffer 已消亡则跳过） */
  recordPhaseFlip(sessionId: string, flip: EvidencePhaseRef, ts: number): void {
    try {
      const dir = this.dirOf(sessionId);
      if (!dir) return;
      const tail = this.opts.getPtyTail(sessionId, EVIDENCE_PTY_TAIL_CHARS);
      if (tail === undefined) return; // GUI（chat）会话无 pty buffer：本条目不归集，见 features/evidence.md 边界
      const before = slicePtyTail(ansiStrip(tail));
      if (!before) return; // 尚无输出的空切片无证据价值
      const entry: EvidenceEntry = {
        id: evidenceEntryId('pty-slice', ts),
        kind: 'pty-slice',
        ts,
        phase: flip
      };
      const file = `${entry.id}.txt`;
      const content =
        `${formatPhaseFlipHeader(flip, ts, EVIDENCE_PTY_SLICE_LINES)}\n` +
        `--- before ---\n${before}\n`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), content, 'utf8');
      entry.file = file;
      this.append(sessionId, entry);
      // 翻转后补抓：等输出继续产生一段时间再取尾部，作为 after 段追加（best-effort）
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        if (this.stopped) return;
        try {
          const later = this.opts.getPtyTail(sessionId, EVIDENCE_PTY_TAIL_CHARS);
          if (later === undefined) return;
          const after = slicePtyTail(ansiStrip(later));
          if (!after || after === before) return;
          fs.appendFileSync(path.join(dir, file), `\n${formatAfterSection(after, this.afterMs)}\n`, 'utf8');
          const idx = this.indexes.get(sessionId);
          if (idx) {
            const target = idx.entries.find((e) => e.id === entry.id);
            if (target) target.afterTs = this.now();
            this.saveIndex(sessionId);
          }
        } catch (e) {
          console.warn('[evidence] after 段补抓失败', sessionId, e);
        }
      }, this.afterMs);
      timer.unref?.();
      this.pendingTimers.add(timer);
    } catch (e) {
      console.warn('[evidence] phase 翻转归集失败', sessionId, e);
    }
  }

  /** bgTasks 终态证据：构建/测试输出摘要内联进索引（只收 shell 类） */
  recordBgTaskFinished(task: BgTaskRecord): void {
    try {
      if (task.kind !== 'shell') return;
      if (task.status === 'running') return;
      const entry: EvidenceEntry = {
        id: evidenceEntryId('bgtask-summary', task.endedAt ?? this.now()),
        kind: 'bgtask-summary',
        ts: task.endedAt ?? this.now(),
        bgTask: {
          taskId: task.id,
          command: truncateEvidenceText(task.detail, 200) ?? '',
          status: task.status,
          ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
          ...(task.summary !== undefined
            ? { summary: truncateEvidenceText(task.summary, EVIDENCE_BGTASK_SUMMARY_MAX) }
            : {})
        }
      };
      this.append(task.parentSessionId, entry);
    } catch (e) {
      console.warn('[evidence] bgTask 摘要归集失败', e);
    }
  }

  /**
   * browser 截图证据（默认关）：复制进会话目录，索引记原始路径。
   * turnShot 元数据（turnId/url）只在回合结束自动截图时带（显式 browser.screenshot 无）。
   */
  recordBrowserShot(sessionId: string, srcPath: string, turnShot?: EvidenceTurnShotMeta): void {
    try {
      if (!this.opts.isBrowserShotEnabled()) return;
      const dir = this.dirOf(sessionId);
      if (!dir) return;
      const ts = this.now();
      const entry: EvidenceEntry = {
        id: evidenceEntryId('browser-shot', ts),
        kind: 'browser-shot',
        ts,
        sourcePath: srcPath,
        ...(turnShot ? { turnShot } : {})
      };
      const file = `${entry.id}.png`;
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(srcPath, path.join(dir, file));
      entry.file = file;
      this.append(sessionId, entry);
    } catch (e) {
      console.warn('[evidence] browser 截图归集失败', e);
    }
  }

  /** 索引快照（测试用；活跃会话内存态） */
  getIndex(sessionId: string): EvidenceIndex | undefined {
    return this.indexes.get(sessionId);
  }

  // ---------- T4.5 证据页：只读访问 ----------

  /** 读索引：活跃缓存优先，miss 落盘（历史/重启后会话）；只读不写回缓存 */
  readIndex(sessionId: string): EvidenceIndex | undefined {
    return this.indexes.get(sessionId) ?? this.loadFromDisk(sessionId);
  }

  /** 读 pty-slice 条目正文（entryId 须命中索引且带 file；防穿越以索引为准） */
  readEntryText(sessionId: string, entryId: string, maxChars = 96_000): string | undefined {
    const entry = this.readIndex(sessionId)?.entries.find((e) => e.id === entryId);
    if (!entry || entry.kind !== 'pty-slice' || !entry.file) return undefined;
    const file = this.entryFilePath(sessionId, entry.file);
    if (!file) return undefined;
    try {
      const text = fs.readFileSync(file, 'utf8');
      return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
    } catch {
      return undefined;
    }
  }

  /** 读 browser-shot 条目图片（data URL；entryId 须命中索引且带 file） */
  readEntryImage(sessionId: string, entryId: string): string | undefined {
    const entry = this.readIndex(sessionId)?.entries.find((e) => e.id === entryId);
    if (!entry || entry.kind !== 'browser-shot' || !entry.file) return undefined;
    const file = this.entryFilePath(sessionId, entry.file);
    if (!file) return undefined;
    try {
      return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
    } catch {
      return undefined;
    }
  }

  /** 条目文件路径（文件名白名单二次校验，杜绝索引被篡改后的穿越） */
  private entryFilePath(sessionId: string, file: string): string | null {
    if (!/^[A-Za-z0-9._-]+\.(txt|png)$/.test(file)) return null;
    const dir = this.dirOf(sessionId);
    return dir ? path.join(dir, file) : null;
  }

  // ---------- 内部：索引读写 ----------

  private append(sessionId: string, entry: EvidenceEntry): void {
    const dir = this.dirOf(sessionId);
    if (!dir) return;
    let idx = this.indexes.get(sessionId);
    if (!idx) {
      idx = this.loadFromDisk(sessionId) ?? newEvidenceIndex(sessionId, this.now());
      this.indexes.set(sessionId, idx);
    }
    const next = appendEvidenceEntry(idx, entry, this.now());
    this.indexes.set(sessionId, next);
    this.saveIndex(sessionId);
  }

  private indexFileOf(sessionId: string): string | null {
    const dir = this.dirOf(sessionId);
    return dir ? path.join(dir, 'index.json') : null;
  }

  /** 磁盘读索引（损坏/缺失误 undefined，不写回） */
  private loadFromDisk(sessionId: string): EvidenceIndex | undefined {
    const file = this.indexFileOf(sessionId);
    if (!file) return undefined;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as EvidenceIndex;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return undefined;
      return parsed;
    } catch {
      console.warn('[evidence] index.json 损坏，重建', sessionId);
      return undefined;
    }
  }

  private saveIndex(sessionId: string): void {
    const file = this.indexFileOf(sessionId);
    const idx = this.indexes.get(sessionId);
    if (!file || !idx) return;
    try {
      writeJsonAtomicSync(file, idx);
    } catch (e) {
      console.warn('[evidence] index.json 落盘失败', sessionId, e);
    }
  }

  // ---------- 滚动清理 ----------

  /**
   * 7 天滚动清理（返回删除的会话目录数）：
   * - 有索引：剔除过期条目并删其文件；条目清空则删整个目录；索引损坏按孤儿处理；
   * - 孤儿目录（无/坏索引）：目录 mtime 超期即删。
   * 删目录前 lstat 防链接（junction 教训：禁对链接 recursive rm）。
   */
  cleanupExpired(now: number): number {
    let removed = 0;
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(this.rootDir, { withFileTypes: true });
    } catch {
      return 0; // 根目录不存在：无事可做
    }
    for (const d of dirs) {
      const name = sanitizeEvidenceSessionDir(d.name);
      if (!name) continue;
      const dir = path.join(this.rootDir, name);
      try {
        if (!d.isDirectory()) continue;
        const idx = this.loadFromDisk(name);
        if (!idx) {
          // 孤儿目录：mtime 判过期
          const mtime = fs.statSync(dir).mtimeMs;
          if (evidenceDirExpired(mtime, now)) {
            this.removeDir(dir);
            removed += 1;
          }
          continue;
        }
        const { kept, dropped } = pruneEvidenceEntries(idx.entries, now);
        for (const e of dropped) {
          if (!e.file) continue;
          try {
            fs.unlinkSync(path.join(dir, e.file));
          } catch {
            /* 文件可能已不存在 */
          }
        }
        if (kept.length === 0) {
          this.removeDir(dir);
          removed += 1;
          this.indexes.delete(name);
          continue;
        }
        if (dropped.length > 0) {
          const next: EvidenceIndex = { ...idx, entries: kept, updatedAt: now };
          this.indexes.set(name, next);
          writeJsonAtomicSync(path.join(dir, 'index.json'), next);
        }
      } catch (e) {
        console.warn('[evidence] 会话目录清理失败', name, e);
      }
    }
    return removed;
  }

  /** 删除目录（lstat 防链接穿透；recursive 只用于确认为真实目录的场景） */
  private removeDir(dir: string): void {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) {
      fs.unlinkSync(dir);
      return;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
