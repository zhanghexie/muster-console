import type { DomainRegistry } from '../runtimeKernel/domainRegistry';

type Startable = {
  start(): void;
  shutdown(): void | Promise<void>;
};

type AsyncStartable = {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
};

export type RuntimeDomainBindings = {
  domains: DomainRegistry;
  registerIpcDomains: () => string[];
  registerHostDomains: () => void;
  eventRouter: Startable;
  stallScanner: Startable;
  evidence: AsyncStartable;
  messagingChannels: {
    start(): void;
    stopAdmission(): void;
    stopAndWait(): Promise<void>;
  };
  orchestratorEvents: Startable;
  orchestrator: { shutdown(): void | Promise<void> };
  closeGuiSessions: () => void | Promise<void>;
  workflow: {
    runtime: {
      start(): void;
      resumeAll(): void;
    };
    dispose(): void | Promise<void>;
  };
  promptTasks: Startable;
  restoreMemoryCurators: () => void;
  stopMemoryCuratorsAndWait: () => void | Promise<void>;
  disposeNodeRepl: () => void | Promise<void>;
  backgroundTasks: { shutdown(): void | Promise<void> };
  mailboxOwner: () => void | Promise<void>;
  applyExtensions: () => void | Promise<void>;
};

/**
 * Registers the Runtime Kernel domains in dependency order.
 *
 * The composition root still owns concrete service construction. This module
 * owns only the domain graph and its lifecycle contracts, which keeps startup
 * ordering testable without importing Electron or boot-time singletons.
 */
export async function registerRuntimeDomains(bindings: RuntimeDomainBindings): Promise<void> {
  const {
    domains,
    eventRouter,
    stallScanner,
    evidence,
    messagingChannels,
    orchestratorEvents,
    orchestrator,
    workflow,
    promptTasks,
    backgroundTasks
  } = bindings;

  domains.register({
    id: 'event-infrastructure',
    start: (_runtimeContext, scope) => {
      scope.add(() => eventRouter.shutdown());
      scope.add(() => stallScanner.shutdown());
      scope.add(() => evidence.stop());
      eventRouter.start();
      stallScanner.start();
      evidence.start();
    }
  });

  domains.register({
    id: 'messaging-channels',
    dependsOn: ['event-infrastructure'],
    start: (_runtimeContext, scope) => {
      scope.add(() => messagingChannels.stopAndWait());
    }
  });

  domains.register({
    id: 'orchestrator-events',
    start: (_runtimeContext, scope) => {
      orchestratorEvents.start();
      scope.add(() => orchestratorEvents.shutdown());
    }
  });

  const ipcDomains = bindings.registerIpcDomains();
  bindings.registerHostDomains();

  domains.register({
    id: 'scheduler-sessions',
    dependsOn: [...ipcDomains, 'phone-apps', 'event-infrastructure', 'messaging-channels'],
    start: (_runtimeContext, scope) => {
      scope.add(() => orchestrator.shutdown());
    }
  });

  domains.register({
    id: 'gui-sessions',
    dependsOn: ['scheduler-sessions'],
    start: (_runtimeContext, scope) => {
      scope.add(() => bindings.closeGuiSessions());
    }
  });

  // Rollback and normal shutdown stop admission before sessions retire.
  // The dependency above keeps messaging resources available during session shutdown.
  domains.register({
    id: 'messaging-admission',
    dependsOn: ['gui-sessions'],
    start: (_runtimeContext, scope) => {
      scope.add(() => messagingChannels.stopAdmission());
      messagingChannels.start();
    }
  });

  domains.register({
    id: 'workflow-runtime',
    dependsOn: ['gui-sessions'],
    start: (_runtimeContext, scope) => {
      scope.add(() => workflow.dispose());
      workflow.runtime.start();
      const resume = setTimeout(() => {
        try { workflow.runtime.resumeAll(); }
        catch (error) { console.error('[workflow] 续跑失败', error); }
      }, 3_000);
      resume.unref?.();
      scope.add(() => clearTimeout(resume));
    }
  });

  domains.register({
    id: 'prompt-tasks',
    dependsOn: ['gui-sessions'],
    start: (_runtimeContext, scope) => {
      scope.add(() => promptTasks.shutdown());
      promptTasks.start();
    }
  });

  domains.register({
    id: 'memory-curators',
    dependsOn: ['gui-sessions'],
    start: (_runtimeContext, scope) => {
      scope.add(() => bindings.stopMemoryCuratorsAndWait());
      bindings.restoreMemoryCurators();
    }
  });

  domains.register({
    id: 'node-execution',
    dependsOn: ['gui-sessions'],
    start: (_runtimeContext, scope) => {
      scope.add(() => bindings.disposeNodeRepl());
    }
  });

  domains.register({
    id: 'background-tasks',
    dependsOn: ['gui-sessions'],
    start: (_runtimeContext, scope) => {
      scope.add(() => backgroundTasks.shutdown());
    }
  });

  domains.register({
    id: 'mailbox-admission',
    dependsOn: ['background-tasks'],
    start: (_runtimeContext, scope) => {
      scope.add(() => bindings.mailboxOwner());
    }
  });

  await bindings.applyExtensions();
}
