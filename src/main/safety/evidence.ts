import { createHash } from 'node:crypto';
import type { SafetyGitEvidence } from '../../shared/safety';

export type GitEvidencePart = 'diff' | 'workingDiff' | 'stagedDiff' | 'commits';
export type GitEvidenceContents = Record<GitEvidencePart, string>;

// Captures are request-local, deduplicated and never written to disk. The
// original snapshot still binds the complete hashes, even if this budget is
// exceeded. An incomplete capture cannot be automatically approved.
const MAX_CAPTURE_CHARS = 4_000_000;
const PARTS: readonly GitEvidencePart[] = ['diff', 'workingDiff', 'stagedDiff', 'commits'];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function createSafetyGitEvidenceCollector(maxChars = MAX_CAPTURE_CHARS) {
  const contents: Record<string, string> = Object.create(null);
  const captured = new Map<string, Partial<Record<GitEvidencePart, string>>>();
  let total = 0;
  let incomplete = false;
  return {
    capture(sessionId: string, root: string, parts: GitEvidenceContents): void {
      const refs: Partial<Record<GitEvidencePart, string>> = {};
      for (const part of PARTS) {
        const value = parts[part];
        const id = hash(value);
        refs[part] = id;
        if (Object.hasOwn(contents, id)) continue;
        if (total + value.length > maxChars) { incomplete = true; continue; }
        contents[id] = value;
        total += value.length;
      }
      captured.set(JSON.stringify([sessionId, root]), refs);
    },
    finish(snapshot: string, delivery?: string): SafetyGitEvidence {
      const parsed = JSON.parse(snapshot) as { operation?: 'integrate' | 'delete'; sessions?: Array<{ session?: { id?: string; name?: string }; repositories?: Array<Record<string, any>> }> };
      if (!Array.isArray(parsed.sessions)) throw new Error('审批 Git 快照无效');
      let integrationIncomplete = false;
      const repositories: SafetyGitEvidence['repositories'] = [];
      const sessions: SafetyGitEvidence['sessions'] = [];
      for (const item of parsed.sessions) {
        const sessionId = item.session?.id;
        if (typeof sessionId !== 'string' || !Array.isArray(item.repositories)) throw new Error('审批 Git 快照无效');
        sessions.push({ id: sessionId, name: item.session?.name });
        for (const repo of item.repositories) {
          const root = typeof repo.root === 'string' ? repo.root : '';
          const refs = captured.get(JSON.stringify([sessionId, root]));
          const unavailable = typeof repo.unavailable === 'string' ? repo.unavailable : undefined;
          const critical = parsed.operation !== 'integrate' || (repo.role === 'task' && !repo.roleUnknown);
          if (critical && (!refs || unavailable)) { incomplete = true; integrationIncomplete = true; }
          if (critical && refs) for (const part of parsed.operation === 'integrate' ? ['diff'] as const : PARTS) {
            if (typeof repo[part]?.sha256 !== 'string' || refs[part] !== repo[part].sha256 || !Object.hasOwn(contents, refs[part]!)) { incomplete = true; integrationIncomplete = true; }
          }
          repositories.push({
            id: `repo-${repositories.length}`, sessionId, sessionName: item.session?.name, root,
            sourceRef: repo.sourceRef, targetRef: repo.targetRef, source: repo.source, target: repo.target,
            unavailable, role: repo.role, roleUnknown: repo.roleUnknown, workingTreeEvidence: repo.workingTreeEvidence,
            tests: typeof repo.tests === 'object' ? repo.tests : { status: 'not-collected' }, status: repo.status,
            untrackedFiles: Array.isArray(repo.untrackedFiles) ? repo.untrackedFiles : [], content: refs ?? {},
          });
        }
      }
      // Recompute integration completeness per task diff: auxiliary captures may exceed the budget.
      if (parsed.operation === 'integrate') incomplete = integrationIncomplete;
      return { kind: 'git', operation: parsed.operation, delivery, sessions, repositories, contents, incomplete };
    },
    clear(): void { for (const key of Object.keys(contents)) delete contents[key]; captured.clear(); },
  };
}

export interface SafetyEvidenceQuery {
  action: 'repositories' | 'files' | 'read' | 'status' | 'untracked' | 'commits';
  repositoryId?: string;
  part?: 'diff' | 'workingDiff' | 'stagedDiff';
  fileId?: number;
  offset?: number;
  limit?: number;
}

interface PatchPart { header: string; text: string }
function patchParts(text: string): PatchPart[] {
  const matches = [...text.matchAll(/^diff --git [^\r\n]*/gm)];
  if (!matches.length) return text ? [{ header: '(unparsed diff)', text }] : [];
  const out: PatchPart[] = [];
  if (matches[0].index! > 0) out.push({ header: '(diff preamble)', text: text.slice(0, matches[0].index) });
  for (let i = 0; i < matches.length; i++) out.push({
    header: matches[i][0].slice(0, 1000),
    text: text.slice(matches[i].index!, matches[i + 1]?.index ?? text.length),
  });
  return out;
}

/** The view can only address captured content, not filesystem paths or commands. */
export function createSafetyGitEvidenceView(source: SafetyGitEvidence) {
  const indexes = new Map<string, PatchPart[]>();
  const getText = (repo: SafetyGitEvidence['repositories'][number], part: GitEvidencePart): string => {
    const id = repo.content[part];
    if (!id || !Object.hasOwn(source.contents, id)) throw new Error('审批证据不可用');
    return source.contents[id];
  };
  const getParts = (repo: SafetyGitEvidence['repositories'][number], part: 'diff' | 'workingDiff' | 'stagedDiff') => {
    const id = repo.content[part];
    if (!id) throw new Error('审批证据不可用');
    if (!indexes.has(id)) indexes.set(id, patchParts(getText(repo, part)));
    return indexes.get(id)!;
  };
  const firstDiffRepo = new Map<string, string>();
  for (const repo of source.repositories) if (repo.content.diff && !firstDiffRepo.has(repo.content.diff)) firstDiffRepo.set(repo.content.diff, repo.id);
  const repoSummary = (repo: SafetyGitEvidence['repositories'][number]) => {
    const status = repo.status as { branch?: string; tracking?: string | null; ahead?: number; behind?: number; files?: unknown[] } | undefined;
    const diffId = repo.content.diff;
    const available = !!diffId && Object.hasOwn(source.contents, diffId);
    const diff = available ? getParts(repo, 'diff') : [];
    const sameDiffAs = diffId ? firstDiffRepo.get(diffId) : undefined;
    return {
      id: repo.id, sessionId: repo.sessionId, sessionName: repo.sessionName, root: repo.root,
      sourceRef: repo.sourceRef, targetRef: repo.targetRef, source: repo.source, target: repo.target,
      unavailable: repo.unavailable, role: repo.role, roleUnknown: repo.roleUnknown, workingTreeEvidence: repo.workingTreeEvidence, tests: repo.tests,
      status: { branch: status?.branch, tracking: status?.tracking, ahead: status?.ahead, behind: status?.behind,
        count: Array.isArray(status?.files) ? status.files.length : 0 },
      untrackedCount: repo.untrackedFiles?.length ?? 0,
      diffHashes: repo.content, changedFileCount: available ? diff.length : null,
      ...(sameDiffAs && sameDiffAs !== repo.id ? { sameDiffAs } : {
        changedFiles: diff.slice(0, 8).map((item, fileId) => ({ fileId, header: item.header.slice(0, 160) })),
        moreChangedFiles: diff.length > 8,
      }),
    };
  };
  const page = <T>(items: readonly T[], offset: number, limit: number) => ({
    items: items.slice(offset, offset + limit), total: items.length, limit,
    nextOffset: offset + limit < items.length ? offset + limit : null,
  });
  const textPage = (text: string, offset: number, limit: number) => ({
    text: text.slice(offset, offset + limit), totalChars: text.length, limit,
    nextOffset: offset + limit < text.length ? offset + limit : null,
  });
  const relevant = source.repositories.filter(repo => source.operation !== 'integrate' || (repo.role === 'task' && !repo.roleUnknown));
  const incomplete = source.incomplete || relevant.some(repo => !!repo.unavailable);
  const unavailable = relevant.find(repo => !!repo.unavailable);
  const unavailableReason = unavailable?.unavailable
    ? `${unavailable.id}: ${unavailable.unavailable.replace(/\s+/g, ' ').slice(0, 400)}` : undefined;
  const summary = { kind: 'git', operation: source.operation, delivery: source.delivery, sessions: source.sessions.slice(0, 20), sessionCount: source.sessions.length,
    repositoryCount: source.repositories.length, incomplete,
    repositories: source.repositories.slice(0, 4).map(repoSummary), moreRepositories: source.repositories.length > 4 };
  const hasDiff = relevant.some(repo => (source.operation === 'integrate' ? ['diff'] as const : ['diff', 'workingDiff', 'stagedDiff'] as const).some(part => {
    const id = repo.content[part]; return id && source.contents[id]?.length;
  }));
  const hasStatus = source.operation !== 'integrate' && relevant.some(repo => {
    const status = repo.status as { files?: unknown[] } | undefined;
    return (Array.isArray(status?.files) && status.files.length > 0) || !!repo.untrackedFiles?.length;
  });
  return {
    summary, hasDiff: !!hasDiff, incomplete, unavailableReason,
    query(input: SafetyEvidenceQuery): { result: unknown; contentRead: boolean; selectionError?: boolean } {
      const offset = input.offset ?? 0;
      const max = input.action === 'read' || input.action === 'commits' ? 6000 : 30;
      const requestedLimit = input.limit ?? max;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1)
        throw new Error('审批证据分页参数无效');
      const limit = Math.min(requestedLimit, max);
      if (input.action === 'repositories') {
        const result = page(source.repositories, offset, limit);
        return { result: { ...result, items: result.items.map(repoSummary) }, contentRead: !hasDiff && !hasStatus && (result.items.length > 0 || result.total === 0) };
      }
      const part = input.part ?? 'diff';
      if ((input.action === 'files' || input.action === 'read') && !['diff', 'workingDiff', 'stagedDiff'].includes(part))
        throw new Error('审批证据类型无效');
      const sharedPart: GitEvidencePart | undefined = input.action === 'files' || input.action === 'read' ? part
        : input.action === 'commits' ? 'commits' : undefined;
      let repo = input.repositoryId === undefined && source.repositories.length === 1
        ? source.repositories[0] : source.repositories.find(item => item.id === input.repositoryId);
      // Worktree and target often expose exactly the same captured diff. Only
      // default across multiple repositories when the requested content is
      // identical and present for every one of them.
      if (!repo && input.repositoryId === undefined && sharedPart && source.repositories.length > 1) {
        const first = source.repositories[0];
        const id = first.content[sharedPart];
        if (id && Object.hasOwn(source.contents, id) && source.repositories.every(item => !item.unavailable && item.content[sharedPart] === id))
          repo = first;
      }
      if (!repo) return {
        result: { ok: false, code: 'repository_selection_required',
          message: 'Select a repository id from this request and retry. Use repositories to list more.',
          repositories: source.repositories.slice(0, 30).map(item => ({ id: item.id, root: item.root, available: !item.unavailable })),
          repositoryCount: source.repositories.length },
        contentRead: false, selectionError: true,
      };
      if (repo.unavailable) return {
        result: { ok: false, code: 'repository_unavailable', repositoryId: repo.id,
          reason: repo.unavailable, message: relevant.includes(repo) ? 'Critical repository was not captured; report concern.' : 'Auxiliary repository unavailable; informational only.' },
        contentRead: false, selectionError: relevant.includes(repo),
      };
      if (input.action === 'status') {
        const status = repo.status as { files?: unknown[] } | undefined;
        const result = page(Array.isArray(status?.files) ? status.files : [], offset, limit);
        return { result: { repositoryId: repo.id, ...result }, contentRead: !hasDiff && (result.items.length > 0 || !hasStatus) };
      }
      if (input.action === 'untracked') {
        const result = page(repo.untrackedFiles ?? [], offset, limit);
        return { result: { repositoryId: repo.id, ...result }, contentRead: !hasDiff && (result.items.length > 0 || !hasStatus) };
      }
      if (input.action === 'commits') return { result: { repositoryId: repo.id, ...textPage(getText(repo, 'commits'), offset, limit) }, contentRead: !hasDiff && !hasStatus };
      if (!['diff', 'workingDiff', 'stagedDiff'].includes(part)) throw new Error('审批证据类型无效');
      const parts = getParts(repo, part);
      if (input.action === 'files') return { result: { repositoryId: repo.id, part, ...page(parts.map((item, fileId) => ({ fileId, header: item.header, totalChars: item.text.length })), offset, limit) }, contentRead: !hasDiff && !hasStatus };
      if (input.action !== 'read') throw new Error('审批证据类型无效');
      if (!Number.isSafeInteger(input.fileId) || input.fileId! < 0 || !parts[input.fileId!]) return {
        result: { ok: false, code: 'file_selection_required', repositoryId: repo.id, part,
          message: 'Select a fileId from this captured diff and retry. Use files to list more.',
          files: parts.slice(0, 30).map((item, fileId) => ({ fileId, header: item.header, totalChars: item.text.length })),
          fileCount: parts.length },
        contentRead: false, selectionError: true,
      };
      const result = textPage(parts[input.fileId!].text, offset, limit);
      return { result: { repositoryId: repo.id, part, fileId: input.fileId, ...result }, contentRead: (source.operation !== 'integrate' || (relevant.includes(repo) && part === 'diff')) && result.text.length >= Math.min(256, result.totalChars) };
    },
  };
}
