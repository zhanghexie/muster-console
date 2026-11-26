import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { app } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { handle } from './handle';
import type { AppContext } from '../context';
import type { InboundMcpSetupStatus } from '../../shared/inboundMcp';
import { t } from '../../shared/i18n';
import { errorMessage } from '../../shared/errors';
import { probeOpenCodeMcpLayout } from '../harnessIntegration/opencodeConfigProbe';
import { readOpenCodeMcpLayout, type OpenCodeMcpLayout } from '../harnessIntegration/opencode';
import { harnessMcpTargets } from '../harnessIntegration/mcp';
import { sourceRootsFor } from '../../shared/workspaceRoots';
import { inboundMcpLaunch } from '../inboundMcp/launch';
import { ensureInboundMcpSetup, readInboundMcpSetupStatus } from '../inboundMcp/registrar';

/** Registering IPC is part of app startup; configuration never depends on visiting Settings. */
export function registerInboundMcpIpc(ctx: AppContext): void {
  const userData = app.getPath('userData');
  // All sandbox/E2E instances must stay out of the real user's CLI configuration.
  const sandbox = process.env.MUSTER_SANDBOX === '1';
  const home = sandbox ? userDataStorage(userData).resolve('app', 'capability-home') : os.homedir();

  const ownershipFile = userDataStorage(userData).file('inbound-mcp-managed');
  let running: Promise<InboundMcpSetupStatus> | undefined;
  let lastNotifiedError = '';
  let reconcileAgain = false;
  const currentTargets = (defaultOpenCodeLayout?: OpenCodeMcpLayout) => {
    const config = ctx.config.get();
    const workspaceRoots = (config.workspaces ?? []).flatMap(workspace => sourceRootsFor(workspace).map(root => ({ id: `${workspace.id}:${root.id}`, path: root.path, label: `${workspace.name} / ${root.label ?? root.id}` })));
    const targets = harnessMcpTargets(ctx.runtimes.list(), { homeDir: home,
      ...(sandbox ? { configDir: path.join(home, '.config'), env: {} } : {}), workspaceRoots, defaultOpenCodeLayout });
    return { config, targets };
  };
  const perform = async (write: boolean): Promise<InboundMcpSetupStatus> => {
    try {
      let { config, targets } = currentTargets();
      if (write && !sandbox && targets.files.some(file => file.checkOpenCodeLayout && !readOpenCodeMcpLayout(file.path))) {
        ({ config, targets } = currentTargets(await probeOpenCodeMcpLayout()));
      }
      const options = { files: targets.files, ownershipFile, legacyTrustedFingerprint: config.inboundMcpTrust?.fingerprint };
      const configured = write ? ensureInboundMcpSetup(inboundMcpLaunch(), options) : readInboundMcpSetupStatus(inboundMcpLaunch(), options);
      const engines = [...configured.engines, ...targets.statuses];
      const failures = engines.filter(engine => engine.state === 'error');
      return { ok: !failures.length, engines, ...(failures.length ? { error: failures.map(engine => `${engine.label}: ${engine.error}`).join('\n') } : {}) };
    } catch (error) { return { ok: false, engines: [], error: errorMessage(error) }; }
  };
  const publish = (status: InboundMcpSetupStatus): void => {
    try {
      const win = ctx.getWindow();
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('inboundMcp:changed', status);
    } catch (error) { console.error('[inboundMcp] setup status broadcast failed', error); }
    if (status.ok) { lastNotifiedError = ''; return; }
    const detail = status.error ?? t('CLI 自动配置失败，请重试');
    if (detail !== lastNotifiedError) {
      lastNotifiedError = detail;
      // UiBridge uses native Electron Notification.show, so hydration/subscription
      // timing cannot lose this startup warning. Settings also reads actual state.
      try { ctx.ui.notify(t('CLI 宿主 MCP 自动配置失败'), detail); }
      catch (error) { console.error('[inboundMcp] setup warning notification failed', error); }
    }
  };
  const ensure = (): Promise<InboundMcpSetupStatus> => {
    if (running) return running;
    running = Promise.resolve().then(async () => {
      let status: InboundMcpSetupStatus;
      do { reconcileAgain = false; status = await perform(true); } while (reconcileAgain);
      publish(status);
      return status;
    }).finally(() => { running = undefined; });
    return running;
  };
  handle('inboundMcp:status', () => perform(false));
  handle('inboundMcp:install', ensure);
  const reconcile = (): void => { if (running) { reconcileAgain = true; return; } void ensure().catch(error => console.error('[inboundMcp] runtime setup failed', error)); };
  const offRuntimes = ctx.runtimes.onChanged(reconcile);
  // Names, LLM settings and keystroke-driven preferences never initiate file writes.
  const topology = (): string => JSON.stringify((ctx.config.get().workspaces ?? []).map(workspace => [workspace.id, workspace.rootsError, workspace.roots ?? workspace.path]));
  let topologySignature = topology();
  const offConfig = ctx.config.onChanged(() => {
    const next = topology(); if (next === topologySignature) return;
    topologySignature = next; reconcile();
  });
  app.once('will-quit', () => { offRuntimes(); offConfig(); });
  setImmediate(() => {
    void ensure().catch(error => {
      // Unexpected notification/transport errors must not become an unhandled boot rejection.
      console.error('[inboundMcp] automatic setup failed', error);
    });
  });
}
