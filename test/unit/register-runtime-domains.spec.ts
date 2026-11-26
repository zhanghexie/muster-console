import { describe, expect, it, vi } from 'vitest';
import { DomainRegistry } from '../../src/main/runtimeKernel/domainRegistry';
import { registerRuntimeDomains } from '../../src/main/bootstrap/registerRuntimeDomains';

function bindings(domains: DomainRegistry, order: string[]) {
  const noop = vi.fn();
  return {
    domains,
    registerIpcDomains: vi.fn(() => {
      order.push('ipc-registered');
      domains.register({ id: 'ipc:session', start: () => {} });
      return ['ipc:session'];
    }),
    registerHostDomains: vi.fn(() => {
      order.push('host-registered');
      domains.register({ id: 'host-entrypoints', start: () => {} });
      domains.register({ id: 'phone-apps', dependsOn: ['host-entrypoints'], start: (_ctx, scope) => {
        scope.add(() => { order.push('phone-apps-stop'); });
      } });
    }),
    eventRouter: { start: vi.fn(() => order.push('event-start')), shutdown: noop },
    stallScanner: { start: noop, shutdown: noop },
    evidence: { start: noop, stop: noop },
    messagingChannels: {
      start: vi.fn(() => { order.push('messaging-start'); }),
      stopAdmission: vi.fn(() => { order.push('messaging-admission-stop'); }),
      stopAndWait: vi.fn(async () => { order.push('messaging-release'); })
    },
    orchestratorEvents: { start: noop, shutdown: noop },
    orchestrator: { shutdown: vi.fn(() => { order.push('scheduler-close'); }) },
    closeGuiSessions: vi.fn(() => { order.push('gui-close'); }),
    workflow: { runtime: { start: noop, resumeAll: noop }, dispose: noop },
    promptTasks: { start: noop, shutdown: noop },
    restoreMemoryCurators: noop,
    stopMemoryCuratorsAndWait: noop,
    disposeNodeRepl: noop,
    backgroundTasks: { shutdown: noop },
    mailboxOwner: noop,
    applyExtensions: vi.fn(async () => {
      order.push('extensions-applied');
      domains.register({ id: 'extensions', dependsOn: ['background-tasks', 'mailbox-admission'], start: () => {} });
    })
  };
}

describe('registerRuntimeDomains', () => {
  it('registers the composition graph through explicit host and extension hooks', async () => {
    const domains = new DomainRegistry();
    const order: string[] = [];
    const input = bindings(domains, order);

    await registerRuntimeDomains(input);

    expect(input.registerIpcDomains).toHaveBeenCalledOnce();
    expect(input.registerHostDomains).toHaveBeenCalledOnce();
    expect(input.applyExtensions).toHaveBeenCalledOnce();
    expect(order.indexOf('ipc-registered')).toBeLessThan(order.indexOf('host-registered'));
    expect(order.indexOf('host-registered')).toBeLessThan(order.indexOf('extensions-applied'));
    expect(domains.list().map(domain => domain.id)).toEqual([
      'event-infrastructure',
      'messaging-channels',
      'orchestrator-events',
      'ipc:session',
      'host-entrypoints',
      'phone-apps',
      'scheduler-sessions',
      'gui-sessions',
      'messaging-admission',
      'workflow-runtime',
      'prompt-tasks',
      'memory-curators',
      'node-execution',
      'background-tasks',
      'mailbox-admission',
      'extensions'
    ]);
    expect(domains.list().find(domain => domain.id === 'scheduler-sessions')?.dependsOn).toEqual([
      'ipc:session',
      'phone-apps',
      'event-infrastructure',
      'messaging-channels'
    ]);
    expect(domains.list().find(domain => domain.id === 'messaging-admission')?.dependsOn).toEqual(['gui-sessions']);

    await domains.startAll();
    expect(order.indexOf('extensions-applied')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('extensions-applied')).toBeLessThan(order.indexOf('event-start'));
    await domains.dispose();
    expect(order.slice(-6)).toEqual([
      'messaging-start', 'messaging-admission-stop', 'gui-close', 'scheduler-close', 'phone-apps-stop', 'messaging-release'
    ]);
  });

  it('quiesces messaging before retiring sessions on domain startup rollback', async () => {
    const domains = new DomainRegistry();
    const order: string[] = [];
    const input = bindings(domains, order);
    const error = new Error('workflow startup failed');
    input.workflow.runtime.start = vi.fn(() => { throw error; });
    await registerRuntimeDomains(input);

    await expect(domains.startAll()).rejects.toBe(error);

    expect(order.slice(-6)).toEqual([
      'messaging-start', 'messaging-admission-stop', 'gui-close', 'scheduler-close', 'phone-apps-stop', 'messaging-release'
    ]);
  });
});
