import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkedPath, inside, physicalFile, readImageAsync } from './files';
import type { CapturedImage, Root } from './files';
import { TURN_FILE_LIMIT, type ReportedFileChange } from '../../shared/turnChanges';

/** Batch-capture limits apply across the turn, including repeated reads of a path. */
export const CAPTURE_MAX_PATHS = 200;
export const CAPTURE_MAX_BATCHES = 512;
export const CAPTURE_MAX_BYTES = 64 * 1024 * 1024;
const REPORTED_DIFF_MAX_TURN = 2 * 1024 * 1024;

type ImageState = CapturedImage | null;
const bodyBytes = (image: ImageState) => image?.text === undefined ? 0 : Buffer.byteLength(image.text);
type Intent = (before: string | null) => string | null | undefined;
export interface CapturedPath {
  abs: string;
  before: ImageState;
  after?: ImageState;
  safe: boolean;
  successfulNativeWrites: number;
  observedIds: Set<string>;
  reason?: string;
  origin: 'native-tool' | 'observed-tool' | 'explicit-batch' | 'mixed';
}
type NativeEntry = { abs: string; before: ImageState; intended: string | null | undefined; created: boolean };
type NativeBatch = { entries: NativeEntry[]; paths: Set<string>; conflicted: Set<string>; verified: boolean; complete: boolean; ending?: boolean; covered?: boolean };
type ExplicitBatch = { paths: string[]; base: string; complete?: string[] };
export type ProviderFileChange = ReportedFileChange;
export type ProviderDiff = { abs: string; patches: Map<string, { kind: 'added' | 'modified' | 'deleted'; diff: string }> };

const WRITE = /(?:^|[._-])(write|edit|create|delete|remove|patch|replace)(?:$|[._-])/i;
const SHELL = /bash|shell|command|exec|powershell/i;
const OBSERVED_REASON = '工具事件的写前时机无法确认，仅供审阅';
const sameImage = (a: ImageState, b: ImageState) => (a?.text ?? null) === (b?.text ?? null) && a?.stamp === b?.stamp;

/** Pi matches edits against the original content, then preserves BOM/line ending.
 * Fuzzy matches stay review-only: only an exact, unambiguous result is verified. */
function piEditIntent(input: Record<string, unknown>): Intent {
  return before => {
    if (before === null) return undefined;
    let supplied = input.edits;
    if (typeof supplied === 'string') {
      try { supplied = JSON.parse(supplied); } catch { return undefined; }
    }
    const edits: unknown[] = Array.isArray(supplied) ? [...supplied] : supplied && typeof supplied === 'object' ? [supplied] : [];
    if (typeof input.oldText === 'string' && typeof input.newText === 'string') edits.push({ oldText: input.oldText, newText: input.newText });
    if (!edits.length) return undefined;
    const bom = before.startsWith('\uFEFF') ? '\uFEFF' : '';
    const original = bom ? before.slice(1) : before;
    const crlf = original.indexOf('\r\n'), lf = original.indexOf('\n');
    const ending = crlf !== -1 && crlf < lf ? '\r\n' : '\n';
    const normalize = (text: string) => text.replace(/\r\n|\r/g, '\n');
    const content = normalize(original);
    const replacements: Array<{ index: number; length: number; text: string }> = [];
    for (const value of edits) {
      if (!value || typeof value !== 'object') return undefined;
      const { oldText, newText } = value as { oldText?: unknown; newText?: unknown };
      if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined;
      const old = normalize(oldText);
      const index = old ? content.indexOf(old) : -1;
      if (index < 0 || index !== content.lastIndexOf(old)) return undefined;
      replacements.push({ index, length: old.length, text: normalize(newText) });
    }
    replacements.sort((a, b) => a.index - b.index);
    if (replacements.some((item, i) => i > 0 && replacements[i - 1].index + replacements[i - 1].length > item.index)) return undefined;
    let result = content;
    for (const item of replacements.reverse()) result = result.slice(0, item.index) + item.text + result.slice(item.index + item.length);
    return bom + (ending === '\r\n' ? result.replace(/\n/g, '\r\n') : result);
  };
}

function ordinaryIntent(name: string, input: Record<string, unknown>): Intent {
  const key = name.toLowerCase().replace(/[^a-z]/g, '');
  if (['write', 'writefile', 'writetextfile', 'createfile'].includes(key) && typeof input.content === 'string') return () => input.content as string;
  if (['deletefile', 'removefile'].includes(key)) return () => null;
  if (key === 'edit' && (input.edits !== undefined || (typeof input.oldText === 'string' && typeof input.newText === 'string'))) return piEditIntent(input);
  const old = input.oldText ?? input.old_string ?? input.oldString;
  const next = input.newText ?? input.new_string ?? input.newString;
  return before => {
    if (typeof old !== 'string' || !old || typeof next !== 'string' || before === null) return undefined;
    const count = before.split(old).length - 1;
    const all = input.replace_all === true || input.replaceAll === true;
    if (!count || (count !== 1 && !all)) return undefined;
    return all ? before.split(old).join(next) : before.replace(old, () => next);
  };
}

/** Extract only paths explicitly supplied by a write tool, never shell text. */
export function nativeWritePaths(name: string, input: Record<string, unknown>, kind?: string): Array<{ path: string; intent: Intent }> {
  if (SHELL.test(name)) return [];
  const result: Array<{ path: string; intent: Intent }> = [];
  const raw = input.path ?? input.file_path ?? input.filePath ?? input.target_file ?? input.notebook_path;
  const writer = kind ? ['edit', 'delete', 'move'].includes(kind.toLowerCase()) : WRITE.test(name) || /^(write|edit|multiedit|notebookedit|create|delete|remove|applypatch|filechange)$/i.test(name.replace(/[^a-z]/gi, ''));
  if (writer && typeof raw === 'string') result.push({ path: raw, intent: ordinaryIntent(name, input) });
  if (writer) for (const key of ['old_path', 'new_path']) {
    if (typeof input[key] === 'string') result.push({ path: input[key] as string, intent: () => undefined });
  }
  if (writer && Array.isArray(input.locations)) for (const location of input.locations.slice(0, CAPTURE_MAX_PATHS + 1)) {
    if (location && typeof location === 'object' && typeof (location as { path?: unknown }).path === 'string')
      result.push({ path: (location as { path: string }).path, intent: () => undefined });
  }
  if (writer && Array.isArray(input.changes)) for (const change of input.changes.slice(0, CAPTURE_MAX_PATHS + 1)) {
    if (change && typeof change === 'object' && typeof (change as { path?: unknown }).path === 'string') {
      result.push({ path: (change as { path: string }).path, intent: () => undefined });
      const directMove = (change as { movePath?: unknown; move_path?: unknown }).movePath ?? (change as { move_path?: unknown }).move_path;
      if (typeof directMove === 'string') result.push({ path: directMove, intent: () => undefined });
      const kind = (change as { kind?: unknown }).kind;
      if (kind && typeof kind === 'object') {
        const move = (kind as { move_path?: unknown; movePath?: unknown }).move_path ?? (kind as { movePath?: unknown }).movePath;
        if (typeof move === 'string') result.push({ path: move, intent: () => undefined });
      }
    }
  }
  const patch = input.patch ?? input.input;
  if (typeof patch === 'string' && patch.includes('*** Begin Patch')) {
    const blocks = patch.split(/(?=^\*\*\* (?:Add|Update|Delete) File: )/m).slice(1);
    for (const block of blocks) {
      const lines = block.split('\n');
      const match = /^\*\*\* (Add|Update|Delete) File: (.+)\r?$/.exec(lines.shift() ?? '');
      if (!match) continue;
      const operation = match[1];
      const moved = lines.some(line => line.startsWith('*** Move to:'));
      result.push({ path: match[2].trim(), intent: before => {
        if (moved) return undefined;
        if (operation === 'Delete') return null;
        if (operation === 'Add') return lines.filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n';
        if (before === null) return undefined;
        let updated = before;
        for (const chunk of lines.join('\n').split(/^@@.*$/m)) {
          const hunk = chunk.split('\n').filter(line => /^[ +\-]/.test(line));
          if (!hunk.length) continue;
          const old = hunk.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n');
          const next = hunk.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n');
          if (!old || updated.split(old).length !== 2) return undefined;
          updated = updated.replace(old, () => next);
        }
        return updated;
      } });
    }
  }
  return result;
}

/** Turn-local path capture. It never enumerates directories or watches files. */
export class PathCapture {
  readonly files = new Map<string, CapturedPath>();
  readonly providerDiffs = new Map<string, ProviderDiff>();
  private readonly native = new Map<string, NativeBatch>();
  private readonly explicit = new Map<string, ExplicitBatch>();
  private readonly observed = new Set<string>();
  private readonly seen = new Set<string>();
  private bytes = 0;
  private reportedBytes = 0;
  private closed = false;

  constructor(readonly cwd: string, readonly roots: Root[], private readonly warn: (message: string) => void,
    private readonly onTouch: (abs: string) => void) {}

  private resolve(raw: string, relativeOnly: boolean, base = this.cwd): string {
    if (!raw || raw.includes('\0') || (relativeOnly && (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || /(^|[\\/])\.\.([\\/]|$)/.test(raw) || /[*?\[\]{}]/.test(raw))))
      throw new Error('文件路径无效，必须使用精确的范围内路径');
    let abs = path.resolve(base, raw);
    if (!checkedPath(this.roots, abs, true) || !physicalFile(this.roots, abs)) throw new Error(`文件不在可写范围或路径包含链接：${raw}`);
    // On case-insensitive volumes, spell an existing path the way the OS does
    // so aliases within a turn cannot produce separate ownership records.
    const root = this.roots.filter(item => inside(item.path, abs)).sort((a, b) => b.path.length - a.path.length)[0];
    try {
      const physical = fs.realpathSync.native(abs);
      if (!root || !inside(root.physical, physical)) throw new Error('文件的物理路径已离开可写范围');
      abs = path.join(root.path, path.relative(root.physical, physical));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return abs;
  }
  private account(abs: string, image: ImageState): void {
    if (!this.seen.has(abs)) {
      if (this.seen.size >= CAPTURE_MAX_PATHS) throw new Error('本轮采集路径已达到上限');
      this.seen.add(abs);
    }
    this.bytes += bodyBytes(image);
    if (this.bytes > CAPTURE_MAX_BYTES) throw new Error('本轮采集正文已达到上限');
  }
  private countBatch(): void {
    if (this.native.size + this.explicit.size >= CAPTURE_MAX_BATCHES) throw new Error('本轮采集批次已达到上限');
  }
  private include(abs: string, before: ImageState, origin: CapturedPath['origin']): CapturedPath {
    let file = this.files.get(abs);
    if (!file) {
      file = { abs, before, safe: true, successfulNativeWrites: 0, observedIds: new Set(), origin };
      this.files.set(abs, file);
      this.onTouch(abs);
    } else {
      if (file.origin !== origin) file.origin = 'mixed';
      const previous = file.after === undefined ? file.before : file.after;
      if (!sameImage(previous, before)) { file.safe = false; file.reason = '工具之间文件发生其他变化，无法确认全部改动归属'; }
    }
    return file;
  }
  private failure(abs: string, reason: string): void {
    const file = this.files.get(abs);
    if (file) { file.safe = false; file.reason = reason; }
    this.warn(`${reason}：${path.relative(this.cwd, abs).replace(/\\/g, '/')}`);
  }

  /** The caller may assert verified only when execution actually waits for this callback. */
  async toolStart(id: string, name: string, input: Record<string, unknown>, kind?: string, verified = false, superseded?: () => boolean): Promise<void> {
    if (this.closed || !id || (!verified && superseded?.())) return;
    let batch = this.native.get(id);
    if (batch && verified && !batch.verified && !batch.complete && !batch.ending) {
      // A later awaited hook supersedes the stream copy. Remove only untouched
      // records created by that copy; collisions or previous edits stay unsafe.
      for (const entry of batch.entries) {
        const file = this.files.get(entry.abs);
        if (entry.created && file?.origin === 'observed-tool' && file.reason === OBSERVED_REASON && file.after === undefined && !batch.conflicted.has(entry.abs))
          this.files.delete(entry.abs);
      }
      this.native.delete(id); this.observed.delete(id); batch = undefined;
    }
    if (batch && (batch.complete || batch.ending || batch.verified !== verified)) return;
    if (SHELL.test(name) || kind === 'execute') {
      this.warn('未登记的命令改动可能未记录');
      return;
    }
    let entries = nativeWritePaths(name, input, kind);
    if (!entries.length) {
      if (!batch && (kind === 'edit' || kind === 'delete' || kind === 'move' || /^(write|edit|multiedit|notebookedit|delete|remove|applypatch|filechange)$/i.test(name.replace(/[^a-z]/gi, '')))) {
        try {
          this.countBatch();
          batch = { entries: [], paths: new Set(), conflicted: new Set(), verified, complete: false };
          this.native.set(id, batch);
        } catch (error) { this.warn((error as Error).message); }
      }
      return;
    }
    if (!verified) {
      entries = entries.filter(entry => {
        try {
          const abs = this.resolve(entry.path, false);
          return ![...this.explicit.values()].some(batch => !batch.complete && batch.paths.includes(abs));
        } catch { return true; }
      });
      if (!entries.length) { if (batch) batch.covered = true; return; }
      this.observed.add(id);
    } else {
      this.observed.delete(id);
    }
    if (!batch) {
      try { this.countBatch(); } catch (error) { this.warn((error as Error).message); return; }
      batch = { entries: [], paths: new Set(), conflicted: new Set(), verified, complete: false };
      this.native.set(id, batch);
    }
    for (const entry of entries) {
      let abs = '';
      try {
        abs = this.resolve(entry.path, false);
        if (batch.paths.has(abs)) continue;
        batch.paths.add(abs);
        for (const other of this.native.values()) {
          if (other !== batch && !other.complete && other.paths.has(abs)) {
            batch.conflicted.add(abs); other.conflicted.add(abs);
            const existing = this.files.get(abs);
            if (existing) { existing.safe = false; existing.reason = '同一文件有重叠工具调用'; }
          }
        }
        const image = await readImageAsync(this.roots, abs);
        if (this.closed) return;
        if (!verified && superseded?.()) {
          // An awaited hook for this same call arrived while the stream copy
          // was reading. Let the hook establish the before-image instead.
          if (!batch.entries.length) { this.native.delete(id); this.observed.delete(id); }
          return;
        }
        if (image === undefined) throw new Error('文件为二进制、超限、链接或不可读');
        this.account(abs, image);
        const created = !this.files.has(abs);
        const file = this.include(abs, image, verified ? 'native-tool' : 'observed-tool');
        if (!verified) { file.safe = false; file.reason ??= OBSERVED_REASON; file.observedIds.add(id); }
        if (batch.conflicted.has(abs)) {
          file.safe = false; file.reason = '同一文件有重叠工具调用';
        }
        const intended = image && image.text === undefined ? undefined : entry.intent(image?.text ?? null);
        batch.entries.push({ abs, before: image,
          intended: typeof intended === 'string' && Buffer.byteLength(intended) > TURN_FILE_LIMIT ? undefined : intended, created });
      } catch (error) { this.warn(`写前采集失败：${entry.path}（${(error as Error).message}）`); if (abs) this.failure(abs, '写前采集失败'); }
    }
  }

  async toolEnd(id: string, ok: boolean, verified = false): Promise<void> {
    if (this.closed) return;
    const batch = this.native.get(id);
    if (!batch || batch.complete || batch.ending || batch.verified !== verified) return;
    batch.ending = true;
    if (!batch.entries.length && !batch.covered) this.warn('写入工具未提供可采集的文件路径');
    for (const entry of batch.entries) {
      if (!ok) { this.failure(entry.abs, '工具未成功完成或缺少可靠结束通知'); continue; }
      try {
        const after = await readImageAsync(this.roots, entry.abs);
        if (this.closed) return;
        if (after === undefined) throw new Error('文件为二进制、超限、链接或不可读');
        this.account(entry.abs, after);
        const file = this.files.get(entry.abs)!;
        file.after = after;
        if (verified) file.successfulNativeWrites++;
        if (verified && (entry.intended === undefined || (after && after.text === undefined) || entry.intended !== (after?.text ?? null))) {
          file.safe = false; file.reason = '无法核对完整工具意图和实际文件内容';
        }
      } catch (error) { this.failure(entry.abs, `工具结束后采集失败（${(error as Error).message}）`); }
    }
    batch.complete = true;
  }

  /** Preserve the provider's own diff when a start notification is absent or late. */
  recordProviderChanges(id: string, changes: readonly ProviderFileChange[]): void {
    if (this.closed || !id) return;
    for (const change of changes.slice(0, CAPTURE_MAX_PATHS + 1)) {
      try {
        if (typeof change.path !== 'string' || /[\r\n\0]/.test(change.path) || typeof change.diff !== 'string' || (!change.diffOmitted && !change.diff.trim())) continue;
        const abs = this.resolve(change.path, false);
        const prior = this.providerDiffs.get(abs), old = prior?.patches.get(id)?.diff ?? '';
        const size = Buffer.byteLength(change.diff), withoutOld = this.reportedBytes - Buffer.byteLength(old);
        const omit = change.diffOmitted || size > TURN_FILE_LIMIT || withoutOld + size > REPORTED_DIFF_MAX_TURN;
        this.account(abs, null);
        const kind = change.kind === 'add' ? 'added' : change.kind === 'delete' ? 'deleted' : 'modified';
        const file = prior ?? { abs, patches: new Map<string, { kind: 'added' | 'modified' | 'deleted'; diff: string }>() };
        file.patches.set(id, { kind, diff: omit ? '' : change.diff });
        this.reportedBytes = withoutOld + (omit ? 0 : size);
        if (!prior) { this.providerDiffs.set(abs, file); this.onTouch(abs); }
      } catch (error) { this.warn(`引擎差异无法纳入审阅：${(error as Error).message}`); }
    }
  }

  async begin(paths: string[], base = this.cwd): Promise<string> {
    if (this.closed) throw new Error('本轮采集已结束');
    if (!Array.isArray(paths) || !paths.length || paths.length > CAPTURE_MAX_PATHS) throw new Error('文件路径数量无效或超过本轮上限');
    this.countBatch();
    const targets = [...new Set(paths.map(raw => {
      if (typeof raw !== 'string') throw new Error('文件路径必须是字符串');
      return this.resolve(raw, true, base);
    }))];
    if (this.seen.size + targets.filter(abs => !this.seen.has(abs)).length > CAPTURE_MAX_PATHS) throw new Error('本轮采集路径已达到上限');
    if (targets.some(abs => [...this.explicit.values()].some(batch => !batch.complete && batch.paths.includes(abs)))) throw new Error('文件已有尚未完成的登记批次');
    const images: Array<{ abs: string; image: ImageState }> = [];
    let readBytes = 0;
    for (const abs of targets) {
      const image = await readImageAsync(this.roots, abs);
      if (image === undefined) throw new Error(`无法读取文件原文：${path.relative(this.cwd, abs)}`);
      readBytes += bodyBytes(image);
      if (this.bytes + readBytes > CAPTURE_MAX_BYTES) throw new Error('本轮采集正文已达到上限');
      images.push({ abs, image });
    }
    if (this.closed) throw new Error('本轮采集已结束');
    if (targets.some(abs => [...this.explicit.values()].some(batch => !batch.complete && batch.paths.includes(abs)))) throw new Error('文件已有尚未完成的登记批次');
    this.countBatch();
    const newPaths = targets.filter(abs => !this.seen.has(abs)).length;
    if (this.seen.size + newPaths > CAPTURE_MAX_PATHS || this.bytes + readBytes > CAPTURE_MAX_BYTES) throw new Error('本轮采集已达到上限');
    for (const { abs, image } of images) this.account(abs, image);
    for (const { abs, image } of images) this.include(abs, image, 'explicit-batch');
    const id = randomUUID();
    this.explicit.set(id, { paths: targets, base });
    return id;
  }

  async complete(id: string, paths: string[]): Promise<void> {
    if (this.closed) throw new Error('本轮采集已结束');
    const batch = this.explicit.get(id);
    if (!batch) throw new Error('采集批次不存在或不属于本轮');
    if (!Array.isArray(paths)) throw new Error('必须提供完成的文件路径');
    const targets = [...new Set(paths.map(raw => this.resolve(raw, true, batch.base)))].sort();
    if (targets.some(abs => !batch.paths.includes(abs))) throw new Error('完成路径必须属于原登记批次');
    if (batch.complete) {
      if (JSON.stringify(batch.complete) !== JSON.stringify(targets)) throw new Error('已完成批次不能以不同路径重放');
      return;
    }
    const images: Array<{ abs: string; after: ImageState }> = [];
    let readBytes = 0;
    for (const abs of targets) {
      const after = await readImageAsync(this.roots, abs);
      if (after === undefined) throw new Error(`登记完成时无法读取文件：${path.relative(this.cwd, abs)}`);
      readBytes += bodyBytes(after);
      if (this.bytes + readBytes > CAPTURE_MAX_BYTES) throw new Error('本轮采集正文已达到上限');
      images.push({ abs, after });
    }
    if (this.closed) throw new Error('本轮采集已结束');
    if (batch.complete) {
      if (JSON.stringify(batch.complete) !== JSON.stringify(targets)) throw new Error('已完成批次不能以不同路径重放');
      return;
    }
    if (this.bytes + readBytes > CAPTURE_MAX_BYTES) throw new Error('本轮采集正文已达到上限');
    for (const { abs, after } of images) {
      this.account(abs, after);
      const file = this.files.get(abs)!;
      if (file.after !== undefined && !sameImage(file.after, after)) { file.safe = false; file.reason = '登记批次内存在未确认的文件变化'; }
      file.after = after;
      if (!file.successfulNativeWrites) { file.safe = false; file.reason = '显式登记只提供审阅，无法确认改动归属'; }
    }
    for (const abs of batch.paths.filter(item => !targets.includes(item))) this.failure(abs, '登记批次未完成该文件');
    batch.complete = targets;
  }

  finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.observed.size) this.warn('部分改动根据工具事件观察，写前时机无法确认，记录可能不完整');
    for (const batch of this.native.values()) if (!batch.complete) {
      if (!batch.entries.length && !batch.covered) this.warn('写入工具未提供可采集的文件路径');
      for (const entry of batch.entries) this.failure(entry.abs, '工具结束前本轮已收口');
    }
    for (const batch of this.explicit.values()) if (!batch.complete) for (const abs of batch.paths) this.failure(abs, '登记批次未完成');
  }
}
