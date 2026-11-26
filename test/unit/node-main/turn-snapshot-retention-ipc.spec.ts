import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/main/context';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../src/main/turnChanges/runtime', () => ({ turnChangesDir: () => state.dir, turnChanges: () => ({ setCollisionHandler() {} }) }));
vi.mock('../../../src/main/agentSession/host/base', () => ({ syncEntry() {}, persistEntry() {} }));
vi.mock('../../../src/main/turnChanges/collisions', () => ({ recordTurnFileCollision() {} }));
import { listRetainedTurnReviews } from '../../../src/main/turnChanges/ipc';

afterEach(() => {
  if (state.dir) {
    expect(path.dirname(path.resolve(state.dir))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(state.dir).startsWith('turn-retention-ipc-')).toBe(true);
    fs.rmSync(state.dir, { recursive: true, force: true });
  }
  state.dir = '';
});

it('exposes only the latest readable snapshot and never ranks by file mtime', async () => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-retention-ipc-'));
  const make = (label: string, write = true) => {
    const id = randomUUID(), messageId = `message-${label}`;
    const summary = { id, state: 'ready', warnings: [], files: [{ path: `${label}.ts`, kind: 'modified', added: 1, removed: 1, revertible: true }] };
    const message = { id: messageId, role: 'assistant', parts: [], ts: 1, turnChanges: summary };
    if (write) fs.writeFileSync(path.join(state.dir, `${id}.json`), JSON.stringify({ owner: 'gui:s', messageId, roots: [], summary,
      files: [{ view: summary.files[0], diff: '+new' }] }));
    return message;
  };
  const old = make('old'), latest = make('latest'), missing = make('missing', false);
  fs.utimesSync(path.join(state.dir, `${old.turnChanges.id}.json`), new Date('2030-01-01'), new Date('2030-01-01'));
  const ctx = { agentSessions: { entries: new Map([['s', { closed: false, messages: [old, latest, missing] }]]) } } as unknown as AppContext;
  const entries = await listRetainedTurnReviews(ctx, { kind: 'gui', id: 's' });
  expect(entries.map(item => item.target.messageId)).toEqual([latest.id]);
  const diagnostic = { id: 'message-empty', role: 'assistant', parts: [], ts: 2,
    turnChanges: { id: randomUUID(), state: 'ready', files: [], warnings: ['partial coverage'] } };
  (ctx.agentSessions!.entries.get('s')!.messages as unknown[]).push(diagnostic);
  const withDiagnostic = await listRetainedTurnReviews(ctx, { kind: 'gui', id: 's' });
  expect(withDiagnostic.map(item => item.target.messageId)).toEqual([diagnostic.id, latest.id]);
});
