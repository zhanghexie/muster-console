import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import unidiff from 'unidiff';
import type { TurnChangedFile, TurnChanges } from '../../shared/turnChanges';
import { TURN_DIFF_OMITTED, TURN_FILE_COLLISION } from '../../shared/turnChanges';
import { pathKey } from '../../shared/pathKey';
import { readGitIdentity } from '../git/identity';
import { hash, physicalFile, readImageAsync } from './files';
import type { CapturedImage, Image, Root } from './files';
import { nativeWritePaths, PathCapture } from './pathCapture';
import type { ProviderFileChange } from './pathCapture';
import type { TurnChangeService } from './service';

type SavedFile = { view: TurnChangedFile; abs: string; before?: Image | null; beforeHash: string | null;
  after: { hash: string; stamp: string } | null; diff: string };

function omittedFile(abs: string, path: string, kind: TurnChangedFile['kind'], origin: TurnChangedFile['origin']): SavedFile {
  return { abs, view: { path, kind, origin, diffOmitted: true, added: null, removed: null, revertible: false, reason: TURN_DIFF_OMITTED },
    beforeHash: null, after: null, diff: '' };
}

function providerFragment(rel: string, kind: TurnChangedFile['kind'], raw: string): string {
  const hunk = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/m.exec(raw);
  if (!hunk) return raw;
  const quoted = (name: string) => /[\s"\\]/.test(name) ? JSON.stringify(name) : name;
  const oldName = kind === 'added' ? '/dev/null' : `a/${rel}`;
  const newName = kind === 'deleted' ? '/dev/null' : `b/${rel}`;
  const body = raw.slice(hunk.index);
  if (/^diff --git /m.test(body)) return raw;
  return `diff --git ${quoted(`a/${rel}`)} ${quoted(`b/${rel}`)}\n` +
    (kind === 'added' ? 'new file mode 100644\n' : kind === 'deleted' ? 'deleted file mode 100644\n' : '') +
    `--- ${quoted(oldName)}\n+++ ${quoted(newName)}\n` + (body.endsWith('\n') ? body : `${body}\n`);
}

export class TurnChangeTracker {
  readonly summary: TurnChanges = { id: randomUUID(), state: 'collecting', files: [], warnings: [] };
  readonly capture: PathCapture;
  readonly ready: Promise<void>;
  private readonly touched = new Map<string, { abs: string; physical: string; existed: boolean }>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly toolOperations = new Map<string, Promise<void>>();
  private readonly trustedTools = new Set<string>();
  private executionStarted = false;
  private finishing?: Promise<TurnChanges>;
  finished = false;

  constructor(readonly service: TurnChangeService, readonly owner: string, readonly messageId: string,
    readonly cwd: string, readonly roots: Root[], private readonly rootDirs: ReadonlyMap<string, string> = new Map()) {
    this.capture = new PathCapture(cwd, roots, text => this.warn(text), abs => this.touch(abs));
    this.ready = readGitIdentity(cwd).then(identity => {
      if (identity && !this.finished) this.summary.repository = {
        root: identity.root, branch: identity.branch, baseCommit: identity.commit, scopeStable: !this.executionStarted
      };
    }).catch(error => { console.error('[turn-changes] repository identity failed', error); });
  }

  private warn(text: string): void { if (!this.summary.warnings.includes(text)) this.summary.warnings.push(text); }
  noteRootFailure(text: string): void { this.warn(text); }
  markExecutionStarted(): void { this.executionStarted = true; }

  private touch(abs: string): void {
    const intended = physicalFile(this.roots, abs);
    if (!intended) return;
    let physical = intended, existed = false;
    try { physical = fs.realpathSync.native(abs); existed = true; } catch { /* absent paths are matched conservatively */ }
    const key = physical.replace(/\\/g, '/');
    this.touched.set(key, { abs, physical: key, existed });
    for (const other of this.service.active) {
      const otherTouch = [...other.touched.values()].find(item => item.physical === key ||
        ((!item.existed || !existed) && item.physical.toLowerCase() === key.toLowerCase()));
      const otherAbs = otherTouch?.abs;
      if (other === this || !otherAbs || other.finished) continue;
      for (const [tracker, target] of [[this, abs], [other, otherAbs]] as const) {
        const file = tracker.capture.files.get(target);
        if (file) { file.safe = false; file.reason = TURN_FILE_COLLISION; }
      }
      if (this.owner === other.owner) continue;
      const add = (tracker: TurnChangeTracker, peer: TurnChangeTracker, target: string): boolean => {
        const file = path.relative(tracker.cwd, target).replace(/\\/g, '/');
        const edits = tracker.summary.concurrentEdits ?? [];
        if (edits.some(edit => pathKey(edit.path) === pathKey(file) && edit.otherOwner === peer.owner)) return false;
        tracker.summary.concurrentEdits = [...edits, { path: file, otherOwner: peer.owner, otherLabel: peer.owner }];
        return true;
      };
      const first = add(this, other, abs), second = add(other, this, otherAbs);
      if (first || second) this.service.reportCollision({ file: abs, participants: [this, other] });
    }
  }

  toolStart(id: string, name: string, input: Record<string, unknown>, kind?: string, verified = false): Promise<void> {
    if (this.finished) return Promise.resolve();
    if (verified && nativeWritePaths(name, input, kind).length && this.trustedTools.size < 512) this.trustedTools.add(id);
    return this.toolOperation(id, () => this.capture.toolStart(id, name, input, kind, verified, () => this.trustedTools.has(id)))
      .catch(error => { this.warn(`改动采集失败：${(error as Error).message}`); });
  }
  toolEnd(id: string, ok: boolean, _patch?: string, verified = false, changes?: readonly ProviderFileChange[]): Promise<void> {
    if (this.finished) return Promise.resolve();
    if (!verified && this.trustedTools.has(id)) return Promise.resolve();
    return this.toolOperation(id, async () => {
      await this.capture.toolEnd(id, ok, verified);
      if (ok && changes?.length) this.capture.recordProviderChanges(id, changes);
    })
      .catch(error => { this.warn(`改动采集失败：${(error as Error).message}`); });
  }

  /** Stream notifications are not awaited by providers; preserve per-call order. */
  private toolOperation(id: string, work: () => Promise<void>): Promise<void> {
    const previous = this.toolOperations.get(id);
    const pending = this.operation(() => previous ? previous.catch(() => {}).then(work) : work());
    this.toolOperations.set(id, pending);
    void pending.finally(() => { if (this.toolOperations.get(id) === pending) this.toolOperations.delete(id); }).catch(() => {});
    return pending;
  }

  private operation<T>(work: () => Promise<T>): Promise<T> {
    if (this.finished) return Promise.reject(new Error('本轮采集已结束'));
    const pending = work();
    this.operations.add(pending);
    void pending.finally(() => this.operations.delete(pending)).catch(() => {});
    return pending;
  }
  beginFiles(paths: string[], rootId?: string): Promise<string> {
    const base = rootId === undefined ? this.cwd : this.rootDirs.get(rootId);
    if (!base) return Promise.reject(new Error('未知或不可写的工作区根目录'));
    return this.operation(() => this.capture.begin(paths, base));
  }
  completeFiles(id: string, paths: string[]): Promise<void> { return this.operation(() => this.capture.complete(id, paths)); }

  finish(): Promise<TurnChanges> {
    if (!this.finishing) { this.finished = true; this.finishing = this.finalize(); }
    return this.finishing;
  }

  private async finalize(): Promise<TurnChanges> {
    const files: SavedFile[] = [];
    try {
      if (this.operations.size) await Promise.allSettled([...this.operations]);
      this.capture.finish();
      for (const root of this.roots) {
        if (await fs.promises.realpath(root.path) !== root.physical) throw new Error('源目录身份已变化，已停止本轮审阅');
      }
      for (const captured of this.capture.files.values()) {
        const { abs, before, after } = captured;
        const reported = this.capture.providerDiffs.get(abs);
        if (captured.origin === 'observed-tool' && captured.observedIds.size && reported &&
            [...captured.observedIds].every(id => reported.patches.get(id)?.diff)) continue;
        if (after === undefined) continue;
        const rel = path.relative(this.cwd, abs).replace(/\\/g, '/');
        const kind = before ? after ? 'modified' : 'deleted' : 'added';
        if ((before && 'oversized' in before) || (after && 'oversized' in after)) {
          if (before && 'oversized' in before && after && 'oversized' in after && before.contentStamp === after.contentStamp) continue;
          files.push(omittedFile(abs, rel, kind, captured.origin));
          continue;
        }
        if ((before?.text ?? null) === (after?.text ?? null)) continue;
        let current: CapturedImage | null | undefined;
        try { current = await readImageAsync(this.roots, abs); }
        catch (error) { this.warn(`无法检查文件后续变化：${(error as Error).message}`); }
        if (current === undefined || (current?.text ?? null) !== (after?.text ?? null) || current?.stamp !== after?.stamp) {
          captured.safe = false;
          captured.reason = '文件在工具完成后发生变化，已保留当前内容';
        }
        const quoted = (name: string) => /[\s"\\]/.test(name) ? JSON.stringify(name) : name;
        const header = `diff --git ${quoted(`a/${rel}`)} ${quoted(`b/${rel}`)}\n` +
          (!before ? 'new file mode 100644\n' : !after ? 'deleted file mode 100644\n' : '');
        const unified = unidiff.createTwoFilesPatch(before ? `a/${rel}` : '/dev/null', after ? `b/${rel}` : '/dev/null', before?.text ?? '', after?.text ?? '');
        const diff = header + unified.replace(/^=+\r?\n/, '');
        const lines = diff.split('\n');
        const hunk = lines.findIndex(line => line.startsWith('@@'));
        const body = hunk < 0 ? [] : lines.slice(hunk + 1);
        const owned = captured.safe && captured.successfulNativeWrites > 0;
        const view: TurnChangedFile = {
          path: rel, kind,
          added: body.filter(line => line.startsWith('+')).length, removed: body.filter(line => line.startsWith('-')).length,
          revertible: owned, origin: captured.origin,
          ...(!owned ? { reason: captured.reason ?? '无法确认全部改动归属，已保留文件' } : {})
        };
        files.push({ view, abs, ...(owned ? { before } : {}), beforeHash: before ? hash(before.text) : null,
          after: after ? { hash: hash(after.text), stamp: after.stamp } : null, diff });
      }
      for (const reported of this.capture.providerDiffs.values()) {
        // Verified/explicit net captures take precedence. Fully covered
        // observations use the provider's own patches, avoiding a late read.
        if (files.some(file => file.abs === reported.abs)) continue;
        const rel = path.relative(this.cwd, reported.abs).replace(/\\/g, '/');
        const patches = [...reported.patches.values()];
        const kind = patches.every(patch => patch.kind === patches[0].kind) ? patches[0].kind : 'modified';
        if (patches.some(patch => !patch.diff)) {
          files.push(omittedFile(reported.abs, rel, kind, 'provider-diff'));
          continue;
        }
        const parts = patches.map(patch => providerFragment(rel, patch.kind, patch.diff));
        const diff = parts.join('\n');
        const body = diff.split('\n').filter(line => !line.startsWith('+++ ') && !line.startsWith('--- '));
        const view: TurnChangedFile = { path: rel, kind,
          added: body.filter(line => line.startsWith('+')).length, removed: body.filter(line => line.startsWith('-')).length,
          revertible: false, origin: 'provider-diff', reason: '引擎提供的差异仅供审阅，不能自动回退' };
        files.push({ view, abs: reported.abs, beforeHash: null, after: null, diff });
        this.warn('部分差异由引擎报告，仅供审阅，不能自动回退');
        if (parts.length > 1) this.warn('同一文件的引擎差异按工具片段展示，并非合并后的净变化');
      }
      this.summary.files = files.map(file => file.view);
      if (this.summary.repository) {
        const end = await readGitIdentity(this.cwd).catch(() => null);
        const before = this.summary.repository;
        this.summary.repository = { ...before, endCommit: end?.commit ?? null,
          scopeStable: before.scopeStable && !!end && pathKey(end.root) === pathKey(before.root) && end.branch === before.branch };
      }
      if (files.length) await this.service.save({ owner: this.owner, messageId: this.messageId, roots: this.roots,
        summary: { ...this.summary, state: 'ready' }, files });
      this.summary.state = 'ready';
    } catch (error) {
      this.summary.state = 'error';
      this.warn(`改动快照汇总或保存失败：${(error as Error).message}`);
    } finally { this.service.active.delete(this); }
    return this.summary;
  }
}
