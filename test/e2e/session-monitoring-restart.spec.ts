import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('重启后未点击 TUI 不启动、不报停滞；点击才恢复', async () => {
  test.setTimeout(140_000);
  const project = path.resolve(__dirname, '../..');
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'session-monitor-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox/userData');
  const source = path.join(fixture, 'workspace'), home = path.join(fixture, 'home');
  for (const dir of [userData, source, home]) fs.mkdirSync(dir, { recursive: true });
  const old = Date.now() - 24 * 60 * 60_000;
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: source,
    activeWorkspaceId: 'ws', workspaces: [{ id: 'ws', name: 'Restart fixture', path: source, roots: [{ id: 'root', path: source }], defaultRootId: 'root' }],
    defaultRuntime: 'fixture-monitor', pipeline: { stallMs: 60_000, stallScanMs: 60_000 },
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify(['working', 'quiet', 'idle'].map(lifecycle => ({
    id: `restored-${lifecycle}`, name: `重启未点击-${lifecycle}`, type: 'terminal', launchKind: 'agent',
    workspaceId: 'ws', cwd: source, runtime: 'fixture-monitor', status: 'running', lifecycle,
    createdAt: old, lastUsedAt: old, runtimeStartedAt: old, orchestrated: true,
    activity: { kind: lifecycle === 'idle' ? 'idle' : 'active', ts: old }
  }))));
  const launched = path.join(fixture, 'launched.ndjson');
  const child = path.join(fixture, 'worker.cjs');
  fs.writeFileSync(child, `require('node:fs').appendFileSync(${JSON.stringify(launched)},JSON.stringify({id:process.env.MUSTER_SESSION_ID,pid:process.pid})+${JSON.stringify('\n')});console.log('fixture ready');process.stdin.resume();setInterval(()=>{},1000);`);
  execFileSync(process.execPath, ['--check', child], { windowsHide: true });
  const runtimeRoot = path.join(userData, 'agent-runtimes');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const builtins = path.join(project, 'src/main/runtime/builtins');
  fs.cpSync(path.join(builtins, 'scripts'), path.join(runtimeRoot, 'scripts'), { recursive: true });
  const registry = JSON.parse(fs.readFileSync(path.join(builtins, 'registry.json'), 'utf8'));
  for (const runtime of registry.runtimes) runtime.enabled = false;
  registry.runtimes.push({ id: 'fixture-monitor', label: 'Monitor fixture', surface: 'pty', enabled: true, script: 'fixture-monitor.mjs', updatedAt: 0 });
  fs.writeFileSync(path.join(runtimeRoot, 'registry.json'), JSON.stringify(registry));
  fs.writeFileSync(path.join(runtimeRoot, 'scripts/fixture-monitor.mjs'), `export async function allocate(){return{sessionId:'fixture'};}export function resolveLaunch(){return{command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(child)}]};}`);
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_HOST', 'MUSTER_STATUS_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `session-monitor-${process.pid}`, MUSTER_WEB_PORT: '0',
    APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), HOME: home, USERPROFILE: home });
  fs.mkdirSync(env.APPDATA, { recursive: true });
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  const stop = async () => {
    if (!app) return;
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close(); app = undefined;
  };
  try {
    for (let boot = 0; boot < 2; boot++) {
      app = await _electron.launch({ executablePath: require('electron'), args: [project, `--user-data-dir=${userData}`, '--disable-gpu', '--no-sandbox'], cwd: fixture, env, timeout: 20_000 });
      app.process().stderr?.on('data', data => fs.appendFileSync(path.join(fixture, 'electron-stderr.log'), data));
      const win = await app.firstWindow();
      await win.locator('.app-shell').waitFor({ timeout: 45_000 });
      await win.evaluate(async () => (window as any).api.app.bootWait());
      const rows = await win.evaluate(async () => (await (window as any).api.sessions.list()).sessions);
      for (const row of rows.filter((s: any) => s.id.startsWith('restored-'))) {
        expect(row.runtimePresence).toBe('dormant'); expect(row.lifecycle).toBe('idle'); expect(row.activity).toBeUndefined();
      }
      expect(rows.filter((s: any) => s.id.startsWith('restored-'))).toHaveLength(3);
      expect(fs.existsSync(launched)).toBe(false);
      if (boot === 1) {
        // Both production timers run at least once (scanner min=60s, guard=60s).
        await win.waitForTimeout(62_000);
        const factsPath = path.join(userData, 'runtime-awareness.json');
        const facts = fs.existsSync(factsPath) ? JSON.parse(fs.readFileSync(factsPath, 'utf8')).facts : [];
        expect(facts.filter((f: any) => f.kind === 'pipeline.verdict' && f.data.stalled)).toEqual([]);
        const guards = JSON.parse(fs.readFileSync(path.join(userData, 'orchestrator-guard-state.json'), 'utf8'));
        expect(Object.keys(guards.fired).filter(key => key.startsWith('heartbeat_stale:'))).toEqual([]);
        expect(fs.existsSync(launched)).toBe(false);
        await win.locator('[data-session-row="restored-working"]').click();
        await expect.poll(() => fs.existsSync(launched), { timeout: 20_000 }).toBe(true);
        await expect.poll(async () => (await win.evaluate(async () => (await (window as any).api.sessions.list()).sessions))
          .find((s: any) => s.id === 'restored-working')?.runtimePresence).toBe('running');
        expect(fs.readFileSync(launched, 'utf8').trim().split('\n')).toHaveLength(1);
      }
      await stop();
    }
  } finally {
    await stop();
    // Retain the isolated fixture as E2E evidence, including boot/scan state and launch marker.
    console.log('session monitoring E2E evidence:', fixture);
  }
});
