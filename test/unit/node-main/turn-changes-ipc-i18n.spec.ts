import { afterEach, expect, it, vi } from 'vitest';
import { applyLocaleSetting } from '../../../src/shared/i18n';
import type { AppContext } from '../../../src/main/context';

vi.mock('../../../src/main/turnChanges/runtime', () => ({ turnChanges: () => ({ setCollisionHandler() {} }) }));
vi.mock('../../../src/main/agentSession/host/base', () => ({ syncEntry() {}, persistEntry() {} }));
vi.mock('../../../src/main/turnChanges/collisions', () => ({ recordTurnFileCollision() {} }));
import { listTurnReviews } from '../../../src/main/turnChanges/ipc';

afterEach(() => applyLocaleSetting('zh-CN'));

it('localizes unavailable review errors without changing access checks', () => {
  applyLocaleSetting('en');
  const ctx = { agentSessions: { entries: new Map([['closed', { closed: true }]]) } } as unknown as AppContext;
  expect(() => listTurnReviews(ctx, { kind: 'gui', id: 'closed' })).toThrow('Session closed');
  expect(() => listTurnReviews(ctx, { kind: 'gui', id: 'missing' })).toThrow('The change snapshot for this turn is unavailable');
  expect(() => listTurnReviews(ctx, null as any)).toThrow('Invalid session.');
  applyLocaleSetting('zh-CN');
  expect(() => listTurnReviews(ctx, { kind: 'gui', id: 'closed' })).toThrow('会话已关闭');
});
