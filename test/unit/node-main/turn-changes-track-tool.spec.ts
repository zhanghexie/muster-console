// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { TurnChangeService } from '../../../src/main/turnChanges/service';

const state = vi.hoisted(() => ({ service: undefined as TurnChangeService | undefined }));
vi.stubGlobal('window', globalThis);
vi.mock('../../../src/main/turnChanges/runtime', () => ({ turnChanges: () => state.service }));
import { TurnChangeService as Service } from '../../../src/main/turnChanges/service';
import { turnChangesHost } from '../../../src/main/capabilities/hosts/turnChanges';
import { runAsAgentSession, runAsAgentWorkspace, runAsSchedulerTool } from '../../../src/main/agent/agentScope';
import { buildSessionToolset } from '../../../src/main/agentSession/tools/registry';
import { buildProjectedGuiTools } from '../../../src/main/agentSession/tools/projectedGuiTools';
import type { AppContext } from '../../../src/main/context';

const directories: string[] = [];
afterEach(() => {
  state.service?.dispose(); state.service = undefined;
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it('binds explicit batches to the active caller and captured writable roots', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-track-tool-')); directories.push(tmp);
  const first = path.join(tmp, 'first'), second = path.join(tmp, 'second'); fs.mkdirSync(first); fs.mkdirSync(second);
  fs.writeFileSync(path.join(second, 'a.txt'), 'before');
  const service = state.service = new Service(path.join(tmp, 'store'));
  const a = service.begin('gui:a', 'a1', first, [first, second], new Map([['root-2', second]]));
  const b = service.begin('gui:b', 'b1', first, [first]);
  const call = turnChangesHost['turnChanges.trackFiles'];
  const ctx = {} as Parameters<typeof call>[0];
  await expect(call(ctx, { action: 'begin', paths: ['a.txt'] })).rejects.toThrow('No active review turn');
  const begin = await runAsAgentSession('a', () => call(ctx, { action: 'begin', paths: ['a.txt'], rootId: 'root-2' }));
  const id = (begin as { captureId: string }).captureId;
  await expect(runAsAgentSession('b', () => call(ctx, { action: 'complete', captureId: id, paths: ['a.txt'] }))).rejects.toThrow('采集批次不存在');
  await expect(runAsAgentSession('a', () => call(ctx, { action: 'begin', paths: ['../a.txt'] }))).rejects.toThrow('路径无效');
  fs.writeFileSync(path.join(second, 'a.txt'), 'after');
  await runAsAgentSession('a', () => call(ctx, { action: 'complete', captureId: id, paths: ['a.txt'] }));
  const result = await a.finish(); await b.finish();
  expect(result.files).toHaveLength(1);
  expect(result.files[0].revertible).toBe(false);
  await expect(runAsAgentSession('a', () => call(ctx, { action: 'complete', captureId: id, paths: ['a.txt'] }))).rejects.toThrow('No active review turn');

  const scheduler = service.begin('dispatch:ws', 's1', first, [first]);
  fs.writeFileSync(path.join(first, 'b.txt'), 'x');
  const invoke = (args: Parameters<typeof call>[1]) => runAsAgentWorkspace('ws', () => runAsSchedulerTool(() => call(ctx, args)));
  const scheduled = await invoke({ action: 'begin', paths: ['b.txt'] });
  fs.writeFileSync(path.join(first, 'b.txt'), 'y');
  await invoke({ action: 'complete', captureId: (scheduled as { captureId: string }).captureId, paths: ['b.txt'] });
  expect((await scheduler.finish()).files).toHaveLength(1);
  await Promise.allSettled([a.ready, b.ready, scheduler.ready]);
});

it('delivers and executes the tool through the actual GUI catalog and gateway', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-track-gateway-')); directories.push(tmp);
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'before');
  const service = state.service = new Service(path.join(tmp, 'store'));
  const tracker = service.begin('gui:session', 'message', tmp, [tmp]);
  const ctx = { bgTasks: null, sessions: {} } as unknown as AppContext;
  const toolset = buildSessionToolset(ctx, { runtimeId: 'pi', sessionIdentity: { sessionId: 'session', cwd: tmp } });
  const input = { sessionId: 'session', cwd: tmp, hostTools: toolset.hostTools,
    getTurnId: () => 'turn', getPolicyState: () => ({ mode: 'default' as const, planExecuting: false }),
    requestApproval: async () => ({ approved: true }) };
  const tools = buildProjectedGuiTools(ctx, input);
  const tool = tools.find(item => item.id === 'host.turnChanges.trackFiles');
  expect(tool).toBeDefined();
  // Qwen repeated "action" when the model-facing schema redeclared it in oneOf.
  expect(tool!.parameters).not.toHaveProperty('oneOf');
  const exec = { sessionId: 'session', cwd: tmp };
  for (const args of [
    { action: 'begin', paths: ['a.txt'], captureId: 'unexpected' },
    { action: 'complete', paths: ['a.txt'] }
  ]) {
    expect(JSON.parse(await tool!.execute(args, exec))).toMatchObject({ ok: false, error: expect.stringContaining('captureId') });
  }
  const started = JSON.parse(await tool!.execute({ action: 'begin', paths: ['a.txt'] }, exec));
  expect(started.ok).toBe(true);
  fs.writeFileSync(path.join(tmp, 'a.txt'), 'after');
  const wrongRoot = await tool!.execute({ action: 'complete', captureId: started.result.captureId, paths: ['a.txt'], rootId: 'other' }, exec);
  expect(JSON.parse(wrongRoot)).toMatchObject({ ok: false, error: expect.stringContaining('rootId') });
  const finished = JSON.parse(await tool!.execute({ action: 'complete', captureId: started.result.captureId, paths: ['a.txt'] }, exec));
  expect(finished.ok).toBe(true);
  expect((await tracker.finish()).files[0].revertible).toBe(false);
  await tracker.ready;
});
