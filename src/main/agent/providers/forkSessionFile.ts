import { closeSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type * as Pi from '@earendil-works/pi-coding-agent';
import type { Api } from '@earendil-works/pi-ai';
import type { AppConfig } from '../../../shared/types';
import type { WorkspaceExecutionContext } from '../../../shared/workspaceExecutionContext';
import { forkSeedAppendPayloads, type OrchestratorForkSeed } from '../../../shared/orchestratorFork';
import { bindSchedulerSessionContext, SCHEDULER_SOURCE_ENTRY } from '../schedulerWorkspaceContext';
import { assertWorkspaceExecutionContextCurrent } from '../../workspaceExecutionContext';
import { sourcePathKey } from '../../workspacePaths';

type Config = { get(): Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'> };
type PiArchiveApi = Pick<typeof Pi, 'SessionManager' | 'parseSessionEntries'>;

/** Only the current line and source metadata are retained while validating a parent. */
function readParentIdentity(file: string): { header?: Pi.SessionHeader; source?: Pi.CustomEntry } {
  const fd = openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let header: Pi.SessionHeader | undefined, source: Pi.CustomEntry | undefined;
  const consume = (line: Buffer): void => {
    if (!line.toString('utf8').trim()) return;
    const entry = JSON.parse(line.toString('utf8')) as Pi.FileEntry;
    if (!header) {
      if (entry.type !== 'session') throw new Error('scheduler parent header is unavailable');
      header = entry;
    } else if (entry.type === 'session') throw new Error('scheduler parent has duplicate header');
    if (entry.type === 'custom' && entry.customType === SCHEDULER_SOURCE_ENTRY) source = entry;
  };
  try {
    let count: number;
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      pending = (pending.length ? Buffer.concat([pending, chunk.subarray(0, count)]) : Buffer.from(chunk.subarray(0, count))) as Buffer<ArrayBufferLike>;
      let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        consume(pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
      }
    }
    if (pending.length) consume(pending);
    return { header, source };
  } finally { closeSync(fd); }
}

/** SDK-generated wire entries streamed to an exclusive archive. The SDK's
 * transient manager is reset after each entry, so its byId/fileEntries cannot
 * silently retain another full conversation. */
export function writeSchedulerForkFile(config: Config, pi: PiArchiveApi, args: {
  context: WorkspaceExecutionContext; sessionDir: string; seeds: Iterable<OrchestratorForkSeed>;
  title: string; model: { api: string; provider: string; model: string }; parentFile?: string;
}): { sessionFile: string; id: string } {
  let context = args.context;
  assertWorkspaceExecutionContextCurrent(config.get(), context);
  if (args.parentFile) {
    const { header, source } = readParentIdentity(args.parentFile);
    if (!header || !path.isAbsolute(header.cwd) || sourcePathKey(header.cwd) !== sourcePathKey(context.cwd)) throw new Error('scheduler parent cwd changed');
    const parentIdentity = { getCwd: () => header.cwd, getEntries: () => source ? [source] : [] } as Parameters<typeof bindSchedulerSessionContext>[1];
    context = bindSchedulerSessionContext(config.get(), parentIdentity, context, { persistSource: false });
  }
  const manager = pi.SessionManager.inMemory(context.cwd, { parentSession: args.parentFile });
  bindSchedulerSessionContext(config.get(), manager, context);
  const header = manager.getHeader();
  if (!header) throw new Error('scheduler fork header is unavailable');
  const file = path.join(args.sessionDir, `${header.timestamp.replace(/[:.]/g, '-')}_${header.id}.jsonl`);
  assertWorkspaceExecutionContextCurrent(config.get(), context);
  let created = false;
  try {
    const fd = openSync(file, 'wx'); created = true;
    try {
      writeFileSync(fd, `${JSON.stringify(header)}\n`);
      let parentId: string | null = null;
      const writeEntries = (): void => {
        for (const entry of manager.getEntries()) {
          // A UUID avoids relying on a per-archive set of all historical IDs.
          const linked = { ...entry, id: randomUUID(), parentId };
          writeFileSync(fd, `${JSON.stringify(linked)}\n`);
          parentId = linked.id;
        }
        manager.newSession();
      };
      writeEntries();
      for (const seed of args.seeds) {
        const payload = forkSeedAppendPayloads([seed], args.model)[0];
        if (payload.role === 'user') manager.appendMessage({ role: 'user', content: String(payload.content), timestamp: payload.timestamp });
        else manager.appendMessage({ role: 'assistant', content: Array.isArray(payload.content) ? payload.content : [{ type: 'text', text: payload.content }],
          api: payload.api as Api, provider: payload.provider!, model: payload.model!, usage: payload.usage!, stopReason: 'stop', timestamp: payload.timestamp });
        writeEntries();
      }
      if (args.title.trim()) { manager.appendSessionInfo(args.title.trim()); writeEntries(); }
    } finally { closeSync(fd); }
    assertWorkspaceExecutionContextCurrent(config.get(), context);
    return { sessionFile: file, id: header.id };
  } catch (error) {
    if (created) { try { unlinkSync(file); } catch (cleanupError) { console.warn('[pi] failed to clean fork file', cleanupError); } }
    throw error;
  }
}
