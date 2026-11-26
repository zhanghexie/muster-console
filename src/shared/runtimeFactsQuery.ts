/**
 * 把会话/git/任务/合入传感器投影成可查询事实。纯函数，不碰盘、不碰 process。
 */
import {
  liveFactId,
  type RuntimeFact,
  type RuntimeFactKind
} from './runtimeFacts';

export interface SessionFactInput {
  id: string;
  name?: string;
  workspaceId?: string;
  phase?: { value: string; ts?: number };
  note?: { label: string; ts?: number };
  activity?: { kind: string; event?: string; ts?: number };
  lifecycle?: string;
  archived?: boolean;
  worktreePath?: string;
  worktreeBranch?: string;
}

export interface GitFactInput {
  dirtyPaths?: string[];
  uncommittedCount: number;
  aheadCount: number;
  canFastForward: boolean;
  dirtyOverlap: boolean;
  overlapFiles?: string[];
  lastCommit?: { hash: string; subject: string };
  lastFileWriteAt?: number;
}

export interface PipelineVerdictInput {
  kind: string;
  mergeBlocked?: string;
  stalled?: boolean;
  readyToMerge?: boolean;
}

export interface IntegrateEventInput {
  id?: string;
  ts: number;
  sessionId: string;
  workspaceId?: string;
  ok: boolean;
  message: string;
  target?: string;
  branch?: string;
  alreadyMerged?: boolean;
}

function fact(
  kind: RuntimeFactKind,
  input: {
    ts: number;
    sessionId?: string;
    workspaceId?: string;
    paths?: string[];
    summary: string;
    data: Record<string, unknown>;
    source?: RuntimeFact['source'];
    id?: string;
  }
): RuntimeFact {
  return {
    id: input.id ?? liveFactId(kind, input.sessionId, input.workspaceId),
    kind,
    ts: input.ts,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.paths?.length ? { paths: input.paths } : {}),
    summary: input.summary,
    data: input.data,
    source: input.source ?? 'live'
  };
}

export function projectSessionFacts(
  s: SessionFactInput,
  opts?: { git?: GitFactInput; verdict?: PipelineVerdictInput; now?: number }
): RuntimeFact[] {
  const now = opts?.now ?? Date.now();
  const ws = s.workspaceId;
  const out: RuntimeFact[] = [];
  if (s.phase?.value) {
    out.push(
      fact('session.phase', {
        ts: s.phase.ts ?? now,
        sessionId: s.id,
        workspaceId: ws,
        summary: `${s.name || s.id} phase=${s.phase.value}`,
        data: { value: s.phase.value, name: s.name ?? '' }
      })
    );
  }
  if (s.note?.label) {
    out.push(
      fact('session.note', {
        ts: s.note.ts ?? now,
        sessionId: s.id,
        workspaceId: ws,
        summary: `${s.name || s.id} note=${s.note.label}`,
        data: { label: s.note.label, name: s.name ?? '' }
      })
    );
  }
  if (s.activity?.kind) {
    out.push(
      fact('session.activity', {
        ts: s.activity.ts ?? now,
        sessionId: s.id,
        workspaceId: ws,
        summary: `${s.name || s.id} activity=${s.activity.kind}${s.activity.event ? ` ${s.activity.event}` : ''}`,
        data: { kind: s.activity.kind, event: s.activity.event ?? '' }
      })
    );
  }
  if (s.lifecycle) {
    out.push(
      fact('session.lifecycle', {
        ts: now,
        sessionId: s.id,
        workspaceId: ws,
        summary: `${s.name || s.id} lifecycle=${s.lifecycle}${s.archived ? ' archived' : ''}`,
        data: { lifecycle: s.lifecycle, archived: Boolean(s.archived) }
      })
    );
  }
  const git = opts?.git;
  if (git) {
    const dirtyPaths = (git.dirtyPaths ?? []).slice(0, 50);
    out.push(
      fact('git.dirty', {
        ts: git.lastFileWriteAt ?? now,
        sessionId: s.id,
        workspaceId: ws,
        paths: dirtyPaths,
        summary: `${s.name || s.id} dirty=${git.uncommittedCount}${dirtyPaths.length ? ` ${dirtyPaths.slice(0, 3).join(',')}` : ''}`,
        data: {
          uncommittedCount: git.uncommittedCount,
          dirtyOverlap: git.dirtyOverlap,
          overlapFiles: (git.overlapFiles ?? []).slice(0, 20)
        }
      })
    );
    out.push(
      fact('git.commit', {
        ts: git.lastFileWriteAt ?? now,
        sessionId: s.id,
        workspaceId: ws,
        paths: git.lastCommit ? [] : undefined,
        summary: `${s.name || s.id} ahead=${git.aheadCount}${git.lastCommit ? ` ${git.lastCommit.hash.slice(0, 8)} ${git.lastCommit.subject}` : ''}`,
        data: {
          aheadCount: git.aheadCount,
          canFastForward: git.canFastForward,
          branch: s.worktreeBranch ?? '',
          lastCommit: git.lastCommit ?? null
        }
      })
    );
  }
  const verdict = opts?.verdict;
  if (verdict) {
    out.push(
      fact('pipeline.verdict', {
        ts: now,
        sessionId: s.id,
        workspaceId: ws,
        summary: `${s.name || s.id} verdict=${verdict.kind}${verdict.mergeBlocked ? ` ${verdict.mergeBlocked}` : ''}`,
        data: {
          kind: verdict.kind,
          mergeBlocked: verdict.mergeBlocked ?? null,
          stalled: verdict.stalled ?? verdict.kind === 'stalled',
          readyToMerge: verdict.readyToMerge ?? verdict.kind === 'readyToMerge'
        }
      })
    );
  }
  return out;
}

export interface PipelineVerdictEventInput {
  sessionId: string;
  workspaceId?: string;
  name?: string;
  kind: string;
  mergeBlocked?: string;
  lastActivityAt?: number;
  runtimeStartedAt?: number;
  recovered?: boolean;
  ts?: number;
}

/** 扫描写入的 pipeline.verdict 事件（source=event，入账本，可订阅推送）。 */
export function projectPipelineVerdictEvent(input: PipelineVerdictEventInput): RuntimeFact {
  const ts = input.ts ?? Date.now();
  const stalled = input.kind === 'stalled';
  const recovered = Boolean(input.recovered);
  return fact('pipeline.verdict', {
    id: `evt:pipeline.verdict:${input.sessionId}:${ts}`,
    ts,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    summary: `${input.name || input.sessionId} verdict=${input.kind}${recovered ? ' recovered' : ''}${
      input.mergeBlocked ? ` ${input.mergeBlocked}` : ''
    }`,
    data: {
      kind: input.kind,
      mergeBlocked: input.mergeBlocked ?? null,
      stalled,
      readyToMerge: input.kind === 'readyToMerge',
      lastActivityAt: input.lastActivityAt ?? null,
      runtimeStartedAt: input.runtimeStartedAt ?? null,
      recovered
    },
    source: 'event'
  });
}

export function projectIntegrateFact(ev: IntegrateEventInput): RuntimeFact {
  return fact('git.integrate', {
    id: ev.id ?? `evt:git.integrate:${ev.sessionId}:${ev.ts}`,
    ts: ev.ts,
    sessionId: ev.sessionId,
    workspaceId: ev.workspaceId,
    summary: `${ev.sessionId} integrate ${ev.ok ? 'ok' : 'fail'}${ev.target ? ` → ${ev.target}` : ''}${ev.message ? ` ${ev.message}` : ''}`,
    data: {
      ok: ev.ok,
      message: ev.message,
      target: ev.target ?? '',
      branch: ev.branch ?? '',
      alreadyMerged: Boolean(ev.alreadyMerged)
    },
    source: 'event'
  });
}
