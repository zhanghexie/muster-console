import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.dir } }));
import { GuiSessionStore } from '../../../src/main/agentSession/persist';
import { Store } from '../../../src/main/store';
import { SchedulerSessionAdapter } from '../../../src/main/runtimeKernel/schedulerSession';
import { schedulerSqlitePath } from '../../../src/main/runtimeKernel/schedulerSqlite';

afterEach(() => {
  if (!fixture.dir) return;
  expect(path.dirname(path.resolve(fixture.dir))).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(fixture.dir).startsWith('turn-retention-history-')).toBe(true);
  fs.rmSync(fixture.dir, { recursive: true, force: true });
  fixture.dir = '';
});

it('reads the durable GUI and scheduler references without touching legacy scheduler files', async () => {
  fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-retention-history-'));
  const sessionId = randomUUID(), message = { id: 'message', role: 'assistant' as const, parts: [], ts: 1 };
  const gui = new GuiSessionStore(fixture.dir);
  expect(await gui.loadForReviewRetention(sessionId)).toBeNull();
  gui.save(sessionId, [message], null, [], []);
  gui.flushSync();
  expect((await gui.loadForReviewRetention(sessionId))?.[0].id).toBe(message.id);

  const scheduler = new Store();
  const slashPiDir = scheduler.getPiSessionDir('a/b');
  expect(path.basename(slashPiDir)).toMatch(/^a-b~[a-f0-9]{16}$/);
  expect(slashPiDir).not.toBe(scheduler.getPiSessionDir('a?b'));
  const dispatch = { id: 'dispatch-message', role: 'assistant' as const, content: 'done', createdAt: 1 };
  const log = new SchedulerSessionAdapter(fixture.dir, 'workspace', { display: [], api: [] });
  log.recordMessage(dispatch);
  await log.flush('retention-fixture');
  expect((await scheduler.loadChatForReviewRetention('workspace'))?.[0].id).toBe(dispatch.id);

  const guiFile = path.join(fixture.dir, 'agent-session-events', `${sessionId}.ndjson`);
  const schedulerFile = schedulerSqlitePath(fixture.dir, log.sessionId);
  log.close();
  const legacySchedulerFile = path.join(fixture.dir, 'scheduler-sessions', 'workspace-workspace.ndjson');
  fs.writeFileSync(guiFile, '{bad gui\n{}\n'); fs.writeFileSync(legacySchedulerFile, '{bad scheduler\n{}\n');
  await expect(gui.loadForReviewRetention(sessionId)).rejects.toThrow();
  expect((await scheduler.loadChatForReviewRetention('workspace'))?.[0].id).toBe(dispatch.id);
  expect(fs.readFileSync(guiFile, 'utf8')).toBe('{bad gui\n{}\n');
  expect(fs.readFileSync(legacySchedulerFile, 'utf8')).toBe('{bad scheduler\n{}\n');
  expect(fs.statSync(schedulerFile).size).toBeGreaterThan(0);
});
