import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { AppContext } from '../../../src/main/context';
import { listDesktop } from '../../../src/main/capabilities/hosts/desktop';
import { CuaAppDiscovery } from '../../../src/main/desktop/cuaAppDiscovery';
import { resolveCuaDriverPath } from '../../../src/main/desktop/cuaDriverPath';
import { DesktopActivityRuntime } from '../../../src/main/desktop/desktopActivityRuntime';
import { DesktopIndicatorWindow } from '../../../src/main/desktop/desktopIndicatorWindow';
import { runAsAgentWorkspace, runAsSchedulerTool, runWithSchedulerDesktopTurnSource,
  runAsCapturedSchedulerDesktopTurn } from '../../../src/main/agent/agentScope';

const userData = process.env.MUSTER_TEST_USER_DATA;
if (userData) app.setPath('userData', userData);
let stage = 'setup';
app.whenReady().then(async () => {
  let activity: DesktopActivityRuntime | undefined;
  let discovery: CuaAppDiscovery | undefined;
  let target: BrowserWindow | undefined;
  let result: Record<string, unknown> | undefined;
  try {
    if (!userData) throw new Error('missing fixture directory');
    const binary = resolveCuaDriverPath({ appPath: process.cwd(), resourcesPath: userData, isPackaged: false,
      platform: process.platform, arch: process.arch });
    target = new BrowserWindow({ width: 360, height: 200, show: false,
      webPreferences: { sandbox: true, contextIsolation: true } });
    await target.loadURL('data:text/html,<title>MetaAgent application inventory fixture</title><p>Owned test window</p>');
    target.show();
    discovery = new CuaAppDiscovery({ binary });
    activity = new DesktopActivityRuntime({
      labels: { active: 'AI 正在操作电脑', stopping: '正在停止', unknown: '结果未知', escape: 'Esc 停止', stop: '停止', escapeUnavailable: '请点停止' },
      releaseAll: async () => {}, stopBackend: () => discovery!.stopAll(),
      createIndicator(stop, unavailable) {
        const indicator = new DesktopIndicatorWindow(stop, unavailable, path.resolve('out/preload/desktopIndicator.js'), path.resolve('out/renderer'));
        indicator.registerIpc(); return indicator;
      }
    });
    const workspace = { id: 'fixture-workspace', name: 'Fixture', path: process.cwd(), rootsRevision: 1,
      defaultRootId: 'root', controlRoot: process.cwd(), roots: [{ id: 'root', path: process.cwd() }] };
    const owner = 'orchestrator:fixture-workspace', turn = 'fixture-turn', task = 'fixture-task';
    const ctx = { config: { get: () => ({ activeWorkspaceId: workspace.id, workspaces: [workspace] }) },
      sessions: { get: () => undefined }, desktopTurns: () => activity!.turns, desktopAppDiscovery: () => discovery!,
      desktopSchedulerTask: () => ({ ensureCapture: async () => task, currentBinding: () => ({ epoch: task }) }) } as unknown as AppContext;
    activity.turns.begin(owner, turn, () => true);
    const source = () => ({ sessionId: owner, desktopTurnId: turn, isDesktopCurrent: () => true });
    const call = <T,>(fn: () => Promise<T>): Promise<T> => runAsAgentWorkspace(workspace.id, () => runWithSchedulerDesktopTurnSource(source, () =>
      runAsCapturedSchedulerDesktopTurn(() => runAsSchedulerTool(fn))));
    stage = 'discovery';
    const first = await call(() => listDesktop(ctx, { view: 'applications', limit: 10 })) as any;
    if (!first?.applications || !activity.isVisible()) {
      const code = typeof first?.code === 'string' ? first.code : 'unexpected';
      throw Object.assign(new Error('application discovery failed'), { code });
    }
    const page = first.applications;
    const check = (value: any): void => {
      if (!Array.isArray(value.apps) || typeof value.total !== 'number' || value.coverage?.completeness !== 'unverified' ||
          value.apps.some((item: any) => Object.keys(item).sort().join(',') !== 'active,installed,kind,name,running' ||
            typeof item.name !== 'string' || typeof item.running !== 'boolean' ||
            (item.installed !== null && item.installed !== true) ||
            (item.active !== null && typeof item.active !== 'boolean') || typeof item.kind !== 'string')) {
        throw new Error('invalid projected page');
      }
    };
    check(page);
    let secondPage = false;
    if (page.nextOffset !== null) {
      stage = 'paging';
      const next = await call(() => listDesktop(ctx, { view: 'applications', snapshotId: page.snapshotId, offset: page.nextOffset, limit: 10 })) as any;
      if (!next?.applications) throw new Error('page unavailable');
      check(next.applications); secondPage = true;
    }
    result = { total: page.total, firstPageCount: page.apps.length, secondPage,
      fields: { name: 'string', running: 'boolean', installed: 'true|null', active: 'boolean|null', kind: 'string' },
      coverage: { platform: page.coverage.platform, session: page.coverage.session, completeness: page.coverage.completeness,
        sourceTruncated: page.coverage.sourceTruncated, snapshotTruncated: page.coverage.snapshotTruncated,
        limitations: page.coverage.limitations }, visibleIndicator: true };
    stage = 'cleanup';
    activity.turns.end(owner, turn);
  } finally {
    await activity?.dispose();
    await discovery?.close();
    if (target && !target.isDestroyed()) target.destroy();
  }
  console.log(`CUA_APPS_FIXTURE_OK ${JSON.stringify(result)}`);
  app.exit(0);
}).catch(error => {
  const allowed = ['invalid', 'unsupported_platform', 'dependency_missing', 'driver_error', 'invalid_driver_response',
    'cancelled', 'timeout', 'stale', 'capacity', 'busy', 'closed', 'cleanup_unconfirmed'];
  const code = typeof error?.code === 'string' && allowed.includes(error.code) ? error.code : 'unexpected';
  console.error(`CUA_APPS_FIXTURE_FAIL ${stage} ${code}`);
  app.exit(1);
});
app.on('window-all-closed', () => {});
