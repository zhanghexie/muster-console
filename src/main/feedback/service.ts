import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { FeedbackDraft, FeedbackEntry, FeedbackHistoryDetail, FeedbackHistoryItem, FeedbackHistoryPage, FeedbackMatch, FeedbackProposalResult, FeedbackReview, FeedbackSnapshot, FeedbackTarget, ManualFeedbackResult } from '../../shared/feedback';
import { writeTextAtomicSync } from '../atomicJson';
import { cleanFeedbackDraft, cleanFeedbackText, cleanManualFeedbackDraft, feedbackBody, normalizedTitle, titleSimilarity } from './format';
import { FeedbackRemoteError, type FeedbackRemote, type RemoteIssue, type RemoteLookup } from './remote';
import { githubIssueHandoff } from './githubHandoff';

interface StoredState { version: 1; entries: FeedbackEntry[] }
interface ReviewLease { id: string; revision: number; matches: string; target: FeedbackTarget; expiresAt: number }
interface HistoryLease {
  id: string; owner: string; items: FeedbackHistoryItem[]; offset: number; localFingerprint: string;
  remoteFingerprint?: string; remoteAvailable: boolean; expiresAt: number;
  remoteBodyHashes: Map<string, string | undefined>;
}
interface Options {
  file: string;
  appVersion: string;
  remote: FeedbackRemote;
  openIssue?(url: string, clipboardBody?: string): Promise<void>;
  changed?(): void;
  needsAiCheck?(): void;
}

function matchKey(matches: FeedbackMatch[]): string {
  return JSON.stringify(matches.map(m => [m.source, m.id, m.title, m.status, m.url ?? '', m.exact]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function remoteFingerprint(target: FeedbackTarget, issues: RemoteIssue[]): string {
  return fingerprint([target, issues.map(({ id, title, body, bodyHash, state, url }) => [id, title, body, bodyHash ?? '', state, url]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
}
function localHistoryBody(entry: FeedbackEntry): string {
  if (entry.editedBody !== undefined) return entry.editedBody;
  return [`类型：${entry.kind === 'bug' ? '问题' : '改进建议'}`,
    ...(entry.area ? [`涉及功能：${entry.area}`] : []), ...(entry.context ? [`使用场景：${entry.context}`] : []),
    ...(entry.actual ? [`实际情况：${entry.actual}`] : []), ...(entry.expected ? [`期望：${entry.expected}`] : []),
    ...(entry.steps ? [`复现：${entry.steps}`] : []), ...(entry.impact ? [`影响：${entry.impact}`] : []),
    ...(entry.evidence ? [`证据：${entry.evidence}`] : []), ...(entry.suggestion ? [`建议：${entry.suggestion}`] : []),
    ...(entry.environment ? [`环境：${entry.environment}`] : [])].join('\n');
}
function localHistoryFingerprint(entries: FeedbackEntry[], exceptId: string): string {
  return fingerprint(entries.filter(e => e.id !== exceptId).map(e => [e.id, e.status, e.title, e.area, e.context, e.actual, e.expected, e.steps, e.impact, e.evidence, e.suggestion, e.editedBody, e.issueUrl, ...(e.environment ? [e.environment] : [])]));
}

/** Single userData owner: every scheduler/Worker in this app shares this queue. */
export class FeedbackService {
  private state: StoredState;
  private reviews = new Map<string, ReviewLease>();
  private histories = new Map<string, HistoryLease>();
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: Options) {
    if (fs.existsSync(options.file)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(options.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || (parsed as StoredState).version !== 1 ||
        !Array.isArray((parsed as StoredState).entries) ||
        (parsed as StoredState).entries.some(e => !e || typeof e.id !== 'string' || typeof e.title !== 'string' ||
          (e.editedBody !== undefined && typeof e.editedBody !== 'string') || (e.environment !== undefined && typeof e.environment !== 'string') ||
          !Number.isSafeInteger(e.revision) || !Array.isArray(e.sources) || !['pending', 'submitting', 'opened', 'uncertain', 'submitted', 'duplicate', 'rejected'].includes(e.status))) {
        throw new Error('反馈队列文件损坏，未覆盖原文件');
      }
      this.state = { version: 1, entries: (parsed as StoredState).entries };
    } else this.state = { version: 1, entries: [] };
    if (this.state.entries.some(e => e.status === 'submitting')) {
      this.mutate(s => { for (const e of s.entries) if (e.status === 'submitting') { e.status = 'uncertain'; e.error = '应用上次在提交中退出，请先核对是否已创建。'; e.revision++; } });
    }
  }

  private mutate(fn: (state: StoredState) => void): void {
    const next: StoredState = structuredClone(this.state);
    fn(next);
    writeTextAtomicSync(this.options.file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    this.state = next;
    this.options.changed?.();
  }

  private find(id: string, revision?: number): FeedbackEntry {
    const entry = this.state.entries.find(e => e.id === id);
    if (!entry) throw new Error('反馈不存在');
    if (revision !== undefined && entry.revision !== revision) throw new Error('反馈已变化，请重新检查');
    return entry;
  }

  snapshot(): FeedbackSnapshot {
    return { entries: structuredClone(this.state.entries) };
  }

  createManual(input: unknown): ManualFeedbackResult {
    const draft = cleanManualFeedbackDraft(input);
    const id = randomUUID(), now = Date.now();
    this.mutate(state => state.entries.push({ ...draft, id, revision: 1, status: 'pending', createdAt: now, updatedAt: now,
      sources: [], appVersion: this.options.appVersion, aiChecked: false }));
    this.options.needsAiCheck?.();
    return { id, snapshot: this.snapshot() };
  }

  private localFingerprint(): string {
    return fingerprint(this.state.entries.map(e => [e.id, e.revision, e.status, e.title, e.area, e.context, e.actual, e.expected, e.steps, e.impact, e.evidence, e.suggestion, e.editedBody, e.issueUrl, ...(e.environment ? [e.environment] : [])]));
  }

  /** Paginate unfiltered local and remote history for semantic comparison by the calling AI. */
  async history(owner: string, checkId?: string): Promise<FeedbackHistoryPage> {
    let lease: HistoryLease | undefined;
    if (checkId) {
      lease = this.histories.get(checkId);
      if (!lease || lease.owner !== owner || lease.expiresAt < Date.now()) throw new Error('反馈历史已过期，请重新读取');
    } else {
      let remote: Awaited<ReturnType<NonNullable<FeedbackRemote['history']>>> | undefined;
      try { remote = await this.options.remote.history?.(); } catch { /* An unavailable repository is not an empty repository. */ }
      const items: FeedbackHistoryItem[] = this.state.entries.map(e => {
        const body = localHistoryBody(e);
        return { id: e.id, revision: e.revision, needsAiCheck: e.status === 'pending' && e.aiChecked !== true, source: 'local' as const, title: e.title, status: e.status, body: body.slice(0, 4000),
          ...(body.length > 4000 ? { bodyTruncated: true } : {}), ...(e.issueUrl ? { url: e.issueUrl } : {}) };
      });
      const localUrls = new Set(items.map(item => item.url).filter(Boolean));
      for (const row of remote?.issues ?? []) if (!localUrls.has(row.url)) items.push({ id: row.id, source: 'remote', title: row.title,
        status: row.state, body: row.body, ...(row.bodyTruncated ? { bodyTruncated: true } : {}), url: row.url });
      lease = { id: randomUUID(), owner, items, offset: 0, localFingerprint: this.localFingerprint(), remoteAvailable: !!remote,
        remoteBodyHashes: new Map((remote?.issues ?? []).map(issue => [issue.id, issue.bodyHash])),
        ...(remote ? { remoteFingerprint: remoteFingerprint(remote.target, remote.issues) } : {}), expiresAt: Date.now() + 10 * 60_000 };
      for (const [id, old] of this.histories) if (old.expiresAt < Date.now() || old.owner === owner) this.histories.delete(id);
      while (this.histories.size >= 8) this.histories.delete(this.histories.keys().next().value!);
      this.histories.set(lease.id, lease);
    }
    // The host serializes tool results with a 12k-character limit. Budget the actual
    // JSON representation (including escapes), otherwise a page can be discarded
    // after its cursor has already advanced and the AI never saw those records.
    const items: FeedbackHistoryItem[] = [];
    const makePage = (rows: FeedbackHistoryItem[], offset: number): FeedbackHistoryPage => ({
      checkId: lease!.id, items: rows, hasMore: offset < lease!.items.length, remoteAvailable: lease!.remoteAvailable,
      ...(!lease!.remoteAvailable ? { remoteError: '无法读取远端反馈；目前只能比较本机草稿，完成远端查重前不能发送。' } : {})
    });
    const fits = (rows: FeedbackHistoryItem[]) => JSON.stringify({ ok: true, result: makePage(rows, lease!.offset + rows.length) }).length <= 9000;
    while (items.length < 10 && lease.offset + items.length < lease.items.length) {
      const item = lease.items[lease.offset + items.length]!;
      if (fits([...items, item])) { items.push(item); continue; }
      if (items.length) break;
      let low = 0, high = item.body.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits([{ ...item, body: item.body.slice(0, mid), bodyTruncated: true }])) low = mid;
        else high = mid - 1;
      }
      const clipped = { ...item, body: item.body.slice(0, low), bodyTruncated: true };
      if (!fits([clipped])) throw new Error('反馈条目过长，无法提供给 AI 查重');
      items.push(clipped);
      break;
    }
    lease.offset += items.length;
    return makePage(items, lease.offset);
  }

  async historyDetail(owner: string, checkId: string, source: 'local' | 'remote', id: string, offset = 0): Promise<FeedbackHistoryDetail> {
    const lease = this.histories.get(checkId);
    if (!lease || lease.owner !== owner || lease.expiresAt < Date.now() || lease.localFingerprint !== this.localFingerprint()) throw new Error('反馈历史已变化，请重新读取并判断');
    if (!Number.isSafeInteger(offset) || offset < 0 || !lease.items.some(item => item.source === source && item.id === id)) throw new Error('反馈详情参数无效');
    let body: string;
    if (source === 'local') body = localHistoryBody(this.find(id));
    else {
      const item = await this.options.remote.details?.(id);
      if (!item || !item.bodyHash || item.bodyHash !== lease.remoteBodyHashes.get(id) || lease.localFingerprint !== this.localFingerprint()) throw new Error('反馈历史已变化，请重新读取并判断');
      body = item.body;
    }
    if (offset > body.length) throw new Error('反馈详情参数无效');
    let low = 0, high = Math.min(4000, body.length - offset);
    const result = (length: number): FeedbackHistoryDetail => ({ checkId, source, id, text: body.slice(offset, offset + length),
      ...(offset + length < body.length ? { nextOffset: offset + length } : {}) });
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (JSON.stringify({ ok: true, result: result(mid) }).length <= 9000) low = mid;
      else high = mid - 1;
    }
    if (low === 0 && offset < body.length) throw new Error('反馈条目过长，无法提供给 AI 查重');
    return result(low);
  }

  needsAiCheck(): boolean { return this.state.entries.some(entry => entry.status === 'pending' && entry.aiChecked !== true); }

  reportAiCheckIncomplete(): void {
    const message = 'AI 查重未完成，请稍后重试。';
    if (!this.state.entries.some(entry => entry.status === 'pending' && entry.aiChecked !== true && !entry.error)) return;
    this.mutate(state => { for (const entry of state.entries) if (entry.status === 'pending' && entry.aiChecked !== true && !entry.error) {
      entry.error = message; entry.revision++; entry.updatedAt = Date.now();
    } });
  }

  private async checkedHistory(owner: string, checkId: string): Promise<HistoryLease> {
    const lease = this.histories.get(checkId);
    if (!lease || lease.owner !== owner || lease.expiresAt < Date.now() || lease.offset < lease.items.length) throw new Error('请先完整读取反馈历史，再判断是否重复');
    if (lease.localFingerprint !== this.localFingerprint()) throw new Error('反馈历史已变化，请重新读取并判断');
    if (lease.remoteAvailable) {
      const remote = await this.options.remote.history?.();
      if (!remote || remoteFingerprint(remote.target, remote.issues) !== lease.remoteFingerprint || lease.localFingerprint !== this.localFingerprint()) {
        throw new Error('反馈历史已变化，请重新读取并判断');
      }
    }
    return lease;
  }

  async proposeChecked(input: unknown, source: string, owner: string, checkId: string): Promise<FeedbackProposalResult[]> {
    const lease = await this.checkedHistory(owner, checkId);
    if (this.histories.get(checkId) !== lease || lease.localFingerprint !== this.localFingerprint()) throw new Error('反馈历史已变化，请重新读取并判断');
    this.histories.delete(checkId);
    return this.propose(input, source, lease.remoteAvailable, lease.remoteFingerprint);
  }

  /** AI records its decision on a local draft after reading the same full history. */
  async assess(owner: string, checkId: string, input: unknown): Promise<FeedbackSnapshot> {
    const lease = await this.checkedHistory(owner, checkId);
    if (this.histories.get(checkId) !== lease || lease.localFingerprint !== this.localFingerprint()) throw new Error('反馈历史已变化，请重新读取并判断');
    if (!lease.remoteAvailable) throw new Error('无法读取远端反馈，暂不能完成查重');
    if (!Array.isArray(input) || !input.length || input.length > 10) throw new Error('一次请判断 1–10 条反馈');
    const decisions = input as Array<{ id?: unknown; revision?: unknown; duplicateOf?: { source?: unknown; id?: unknown } }>;
    const ids = new Set<string>();
    for (const decision of decisions) {
      if (!decision || typeof decision.id !== 'string' || typeof decision.revision !== 'number' || ids.has(decision.id)) throw new Error('反馈判断参数无效');
      ids.add(decision.id);
      const entry = this.find(decision.id, decision.revision);
      if (entry.status !== 'pending') throw new Error('只有待审核反馈可以查重');
      if (decision.duplicateOf && !lease.items.some(item => item.source === decision.duplicateOf?.source && item.id === decision.duplicateOf?.id && !(item.source === 'local' && item.id === entry.id))) throw new Error('重复项不在本次读取的反馈历史中');
    }
    if (decisions.some(d => d.duplicateOf?.source === 'local' && decisions.some(other => other.id === d.duplicateOf?.id && other.duplicateOf))) throw new Error('重复反馈不能指向另一条重复反馈');
    this.histories.delete(checkId);
    this.mutate(state => {
      for (const decision of decisions) {
        const item = state.entries.find(e => e.id === decision.id)!;
        if (decision.duplicateOf) {
          const match = lease.items.find(m => m.source === decision.duplicateOf!.source && m.id === decision.duplicateOf!.id)!;
          item.status = 'duplicate'; item.issueUrl = match.url; item.aiChecked = true;
        } else item.aiChecked = true;
        item.revision++; item.updatedAt = Date.now(); item.error = undefined;
      }
      for (const decision of decisions) {
        const item = state.entries.find(e => e.id === decision.id)!;
        if (!decision.duplicateOf) item.aiHistory = { local: localHistoryFingerprint(state.entries, item.id), remote: lease.remoteFingerprint! };
      }
    });
    return this.snapshot();
  }

  propose(input: unknown, source: string, aiChecked = true, remoteHistoryFingerprint?: string): FeedbackProposalResult[] {
    if (!Array.isArray(input) || input.length < 1 || input.length > 10) throw new Error('一次请提交 1–10 条反馈草稿');
    // Validate the whole batch before writing anything.
    const drafts = input.map(item => ({ ...cleanFeedbackDraft(item), impact: '' }));
    const results: FeedbackProposalResult[] = [];
    this.mutate(state => {
      for (const draft of drafts) {
        const exact = state.entries.find(e => normalizedTitle(e.title) === normalizedTitle(draft.title));
        if (exact) {
          if (source && !exact.sources.includes(source)) exact.sources.push(source);
          results.push({ id: exact.id, title: exact.title, disposition: 'existing', matches: this.localMatches(draft.title, exact.id, state.entries) });
          continue;
        }
        const now = Date.now();
        const entry: FeedbackEntry = { ...draft, id: randomUUID(), revision: 1, status: 'pending', createdAt: now, updatedAt: now,
          sources: source ? [source] : [], appVersion: this.options.appVersion, aiChecked };
        const matches = this.localMatches(draft.title, entry.id, state.entries);
        state.entries.push(entry);
        results.push({ id: entry.id, title: entry.title, disposition: 'created', matches });
      }
      if (aiChecked && remoteHistoryFingerprint) for (const result of results) if (result.disposition === 'created') {
        const entry = state.entries.find(e => e.id === result.id)!;
        entry.aiHistory = { local: localHistoryFingerprint(state.entries, entry.id), remote: remoteHistoryFingerprint };
      }
    });
    if (!aiChecked && results.some(item => item.disposition === 'created')) this.options.needsAiCheck?.();
    return results;
  }

  update(id: string, revision: number, input: FeedbackDraft): FeedbackSnapshot {
    const entry = this.find(id, revision);
    if (entry.status !== 'pending') throw new Error('只有待审核反馈可以编辑');
    const draft = cleanFeedbackDraft(input);
    if (this.state.entries.some(e => e.id !== id && normalizedTitle(e.title) === normalizedTitle(draft.title))) throw new Error('本地已有相同标题的反馈，请作为重复项处理');
    this.mutate(s => { const item = s.entries.find(e => e.id === id)!; Object.assign(item, draft, { environment: undefined, updatedAt: Date.now(), revision: item.revision + 1, error: undefined, aiChecked: false, aiHistory: undefined, editedBody: undefined }); });
    this.reviews.delete(id);
    this.options.needsAiCheck?.();
    return this.snapshot();
  }

  updateText(id: string, revision: number, input: unknown): FeedbackSnapshot {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('反馈已变化，请重新检查');
    const entry = this.find(id, revision);
    if (entry.status !== 'pending') throw new Error('只有待审核反馈可以编辑');
    const { title, body } = cleanFeedbackText(input);
    if (this.state.entries.some(e => e.id !== id && normalizedTitle(e.title) === normalizedTitle(title))) throw new Error('本地已有相同标题的反馈，请作为重复项处理');
    this.mutate(state => {
      const item = state.entries.find(e => e.id === id)!;
      Object.assign(item, { title, editedBody: body, area: '', context: '', actual: '', expected: '', steps: '', impact: '', evidence: '', suggestion: '', environment: undefined,
        updatedAt: Date.now(), revision: item.revision + 1, error: undefined, aiChecked: false, aiHistory: undefined });
    });
    this.reviews.delete(id);
    this.options.needsAiCheck?.();
    return this.snapshot();
  }

  reject(id: string, revision: number): FeedbackSnapshot {
    const entry = this.find(id, revision);
    if (entry.status !== 'pending') throw new Error('只有待审核反馈可以拒绝');
    this.mutate(s => { const item = s.entries.find(e => e.id === id)!; item.status = 'rejected'; item.revision++; item.updatedAt = Date.now(); });
    this.reviews.delete(id);
    return this.snapshot();
  }

  /** Delete the local queue record only; the remote Issue is never modified. */
  delete(id: string, revision: number): FeedbackSnapshot {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('反馈已变化，请重新检查');
    const entry = this.find(id, revision);
    if (entry.status === 'submitting') throw new Error('反馈正在提交，请稍后再删除');
    this.mutate(state => { state.entries = state.entries.filter(item => item.id !== id); });
    this.reviews.delete(id);
    this.histories.clear();
    return this.snapshot();
  }

  restore(id: string, revision: number): FeedbackSnapshot {
    const entry = this.find(id, revision);
    if (entry.status !== 'rejected' && entry.status !== 'duplicate') throw new Error('只有已拒绝或重复的反馈可以恢复');
    this.mutate(s => { const item = s.entries.find(e => e.id === id)!; item.status = 'pending'; item.issueUrl = undefined; item.error = undefined; item.aiChecked = false; item.aiHistory = undefined; item.revision++; item.updatedAt = Date.now(); });
    this.options.needsAiCheck?.();
    return this.snapshot();
  }

  markDuplicate(id: string, revision: number, match: FeedbackMatch): FeedbackSnapshot {
    const entry = this.find(id, revision);
    const review = this.reviews.get(id);
    if (entry.status !== 'pending' || !review || review.revision !== revision || review.expiresAt < Date.now()) throw new Error('查重结果已失效，请重新检查');
    const matches = JSON.parse(review.matches) as Array<[string, string, string, string, string, boolean]>;
    const selected = matches.find(m => m[0] === match.source && m[1] === match.id && m[4] === (match.url ?? ''));
    if (!selected) throw new Error('该重复项不在已检查的结果中');
    this.mutate(s => { const item = s.entries.find(e => e.id === id)!; item.status = 'duplicate'; item.issueUrl = selected[4] || undefined; item.revision++; item.updatedAt = Date.now(); });
    this.reviews.delete(id);
    return this.snapshot();
  }

  private localMatches(title: string, except: string, entries = this.state.entries): FeedbackMatch[] {
    return entries.filter(e => e.id !== except && e.status !== 'rejected' && titleSimilarity(title, e.title) >= 0.62)
      .map(e => ({ id: e.id, title: e.title, status: e.status, url: e.issueUrl, exact: normalizedTitle(title) === normalizedTitle(e.title), source: 'local' as const }));
  }

  private matches(entry: FeedbackEntry, remote: RemoteIssue[]): FeedbackMatch[] {
    const local = this.localMatches(entry.title, entry.id);
    const remoteMatches: FeedbackMatch[] = remote.filter(e => titleSimilarity(entry.title, e.title) >= 0.62 && !local.some(l => l.url === e.url))
      .map(e => ({ id: e.id, title: e.title, status: e.state, url: e.url, exact: normalizedTitle(entry.title) === normalizedTitle(e.title), source: 'remote' }));
    return [...local, ...remoteMatches];
  }

  async prepare(id: string, revision: number): Promise<FeedbackReview> {
    const entry = this.find(id, revision);
    if (entry.status !== 'pending') throw new Error('只有待审核反馈可以检查');
    if (entry.aiChecked !== true) { this.options.needsAiCheck?.(); throw new Error('反馈正在等待 AI 查重，完成后即可提交'); }
    const history = await this.verifyAiHistory(entry);
    const remote = this.options.openIssue && history ? history : await this.options.remote.find(entry.title);
    const fresh = this.find(id, revision);
    if (fresh.status !== 'pending') throw new Error('反馈已变化，请重新检查');
    const matches = this.matches(fresh, remote.issues);
    const exact = matches.find(match => match.exact);
    if (exact) {
      this.mutate(s => { const item = s.entries.find(e => e.id === id)!; item.status = 'duplicate'; item.issueUrl = exact.url; item.revision++; item.updatedAt = Date.now(); });
      throw new Error('发现相同反馈，已自动标记为重复');
    }
    const reviewId = randomUUID();
    this.reviews.set(id, { id: reviewId, revision, matches: matchKey(matches), target: remote.target, expiresAt: Date.now() + 10 * 60_000 });
    const body = feedbackBody(fresh);
    const copyBody = this.options.openIssue && !!githubIssueHandoff(remote.target, fresh.title, body).clipboardBody;
    return { reviewId, revision, matches, body, ...(copyBody ? { copyBody } : {}) };
  }

  async submit(id: string, revision: number, reviewId: string, distinct: boolean): Promise<FeedbackSnapshot> {
    let release!: () => void;
    const previous = this.sendQueue;
    this.sendQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const entry = this.find(id, revision);
      const lease = this.reviews.get(id);
      if (entry.status !== 'pending' || !lease || lease.id !== reviewId || lease.revision !== revision || lease.expiresAt < Date.now()) throw new Error('审核已失效，请重新检查');
      const history = await this.verifyAiHistory(entry);
      const remote = this.options.openIssue && history ? history : await this.options.remote.find(entry.title);
      const fresh = this.find(id, revision);
      if (fresh.status !== 'pending') throw new Error('反馈已变化，请重新检查');
      const matches = this.matches(fresh, remote.issues);
      if (matchKey(matches) !== lease.matches || JSON.stringify(remote.target) !== JSON.stringify(lease.target)) {
        this.invalidateAiHistory(id);
        throw new Error('反馈历史已变化，正在等待 AI 重新查重');
      }
      const exact = matches.find(m => m.exact);
      if (exact) {
        this.mutate(s => { const item = s.entries.find(e => e.id === id)!; item.status = 'duplicate'; item.issueUrl = exact.url; item.revision++; item.updatedAt = Date.now(); });
        this.reviews.delete(id);
        return this.snapshot();
      }
      // The AI already compared the complete history; a human approves only the feedback content.
      void distinct;
      const target = { ...remote.target };
      const body = feedbackBody(fresh);
      const handoff = this.options.openIssue ? githubIssueHandoff(target, fresh.title, body) : undefined;
      this.mutate(s => { const item = s.entries.find(e => e.id === id)!; item.status = 'submitting'; item.submissionTarget = target; item.updatedAt = Date.now(); });
      this.reviews.delete(id);
      if (handoff && this.options.openIssue) {
        try { await this.options.openIssue(handoff.url, handoff.clipboardBody); }
        catch {
          const message = '无法打开 GitHub 提交流程，请检查默认浏览器或剪贴板后重试。';
          this.mutate(s => { const item = s.entries.find(e => e.id === id)!; item.status = 'pending'; item.submissionTarget = undefined; item.error = message; item.revision++; item.updatedAt = Date.now(); });
          throw new Error(message);
        }
        this.mutate(s => { const item = s.entries.find(e => e.id === id)!; item.status = 'opened'; item.error = undefined; item.revision++; item.updatedAt = Date.now(); });
        return this.snapshot();
      }
      let created: RemoteIssue;
      try { created = await this.options.remote.create(target, fresh.title, body, remote.issues); }
      catch (error) {
        const uncertain = !(error instanceof FeedbackRemoteError) || error.uncertain;
        const historyChanged = error instanceof FeedbackRemoteError && error.message === '查重结果已变化，请重新检查';
        this.mutate(s => { const item = s.entries.find(e => e.id === id)!; item.status = uncertain ? 'uncertain' : 'pending'; item.error = historyChanged ? '反馈历史已变化，正在等待 AI 重新查重' : error instanceof Error ? error.message : '提交失败';
          if (historyChanged) { item.aiChecked = false; item.aiHistory = undefined; } item.revision++; item.updatedAt = Date.now(); });
        if (historyChanged) { this.options.needsAiCheck?.(); throw new Error('反馈历史已变化，正在等待 AI 重新查重'); }
        throw error;
      }
      this.mutate(s => { const item = s.entries.find(e => e.id === id)!; item.status = 'submitted'; item.issueUrl = created.url; item.error = undefined; item.revision++; item.updatedAt = Date.now(); });
      return this.snapshot();
    } finally { release(); }
  }

  private async verifyAiHistory(entry: FeedbackEntry): Promise<RemoteLookup | undefined> {
    if (!entry.aiHistory && !this.options.openIssue) return;
    if (!entry.aiHistory) {
      this.invalidateAiHistory(entry.id);
      throw new Error('反馈历史已变化，正在等待 AI 重新查重');
    }
    const remote = await this.options.remote.history?.();
    if (!remote || remoteFingerprint(remote.target, remote.issues) !== entry.aiHistory.remote ||
        localHistoryFingerprint(this.state.entries, entry.id) !== entry.aiHistory.local) {
      const current = this.find(entry.id, entry.revision);
      if (current.status === 'pending') this.invalidateAiHistory(entry.id);
      throw new Error('反馈历史已变化，正在等待 AI 重新查重');
    }
    this.find(entry.id, entry.revision);
    return remote;
  }

  private invalidateAiHistory(id: string): void {
    this.mutate(s => { const item = s.entries.find(e => e.id === id)!; item.aiChecked = false; item.aiHistory = undefined; item.revision++; item.updatedAt = Date.now(); });
    this.reviews.delete(id);
    this.options.needsAiCheck?.();
  }

  async reconcile(id: string, revision: number, returnToDraft = false): Promise<FeedbackSnapshot> {
    const entry = this.find(id, revision);
    if (entry.status !== 'uncertain' && entry.status !== 'opened') throw new Error('该反馈不需要核对提交结果');
    const remote = await this.options.remote.find(entry.title, id);
    if (!entry.submissionTarget || JSON.stringify(entry.submissionTarget) !== JSON.stringify(remote.target)) throw new Error('提交目标已更换，请联系维护人员核对之前的反馈');
    this.find(id, revision);
    const found = remote.issues.find(issue => issue.body.includes(`<!-- muster-feedback:${id} -->`));
    if (!found && entry.status === 'opened' && returnToDraft === true) {
      this.mutate(s => { const item = s.entries.find(e => e.id === id)!; item.status = 'pending'; item.submissionTarget = undefined; item.error = undefined; item.aiChecked = false; item.aiHistory = undefined; item.revision++; item.updatedAt = Date.now(); });
      this.options.needsAiCheck?.();
      return this.snapshot();
    }
    if (!found && entry.status === 'opened') throw new Error('还没有找到这条 Issue，请在 GitHub 提交后再核对。');
    if (!found) throw new Error('未找到提交标记，不能排除服务端延迟；请在仓库人工核对，勿重复提交。');
    this.mutate(s => { const item = s.entries.find(e => e.id === id)!; item.status = 'submitted'; item.issueUrl = found.url; item.error = undefined; item.revision++; item.updatedAt = Date.now(); });
    return this.snapshot();
  }
}
