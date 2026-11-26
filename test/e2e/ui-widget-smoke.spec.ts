/** Actual Electron sandbox execution; no app accounts, SDKs, or external services. */
import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';

test('ui.render production smoke catches author exceptions on creation and update and cleans hidden windows', async () => {
  test.setTimeout(25000);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-widget-smoke-test-'));
  const root = path.resolve(__dirname, '../..');
  buildSync({ entryPoints: [path.join(root, 'src/main/uiWidgetSmoke.ts'), path.join(root, 'src/main/capabilities/hosts/uiWidgets.ts')],
    outdir: fixture, entryNames: '[name]', bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outExtension: { '.js': '.cjs' } });
  buildSync({ stdin: { contents: `export { uiWidgetsHost } from './src/main/capabilities/hosts/uiWidgets';
    export { runAsAgentWorkspace, runAsSchedulerTool } from './src/main/agent/agentScope';`, resolveDir: root },
    outfile: path.join(fixture, 'uiWidgets.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  fs.writeFileSync(path.join(fixture, 'main.cjs'), `const {app}=require('electron');const fs=require('node:fs'),path=require('node:path');app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});const data=path.join(__dirname,'data');fs.mkdirSync(data);app.setPath('userData',data);globalThis.widgetSmoke=require('./uiWidgetSmoke.cjs');globalThis.widgetModule=require('./uiWidgets.cjs');globalThis.widgetHost=globalThis.widgetModule.uiWidgetsHost;app.whenReady();`);
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath: require('electron'), args: [path.join(fixture, 'main.cjs'), '--disable-gpu'], env });
  try {
    const results = await app.evaluate(async ({ app, BrowserWindow }, folder) => {
      await app.whenReady();
      const { smokeUiWidget } = (globalThis as any).widgetSmoke;
      const host = (globalThis as any).widgetHost;
      const { runAsAgentWorkspace, runAsSchedulerTool } = (globalThis as any).widgetModule;
      const scheduler = (fn: () => Promise<unknown>) => runAsAgentWorkspace('12345678-1234-1234-1234-123456789abc', () => runAsSchedulerTool(fn));
      const ctx = { themes: { payload: () => ({ active: { appearance: 'dark' } }) }, getWindow: () => null, sessions: { get: () => undefined } };
      const check = (html: string, update?: string) => {
        return host['ui.render'](ctx, { sessionId: 'smoke', title: '运行时探针', html, ...(update ? { update } : {}) });
      };
      const initial = await check('<ma-text text="显示说明"></ma-text><script>throw new Error("HOST_SMOKE_CREATE")</script>');
      const update = await check('<script>Promise.reject(new Error("HOST_SMOKE_UPDATE"))</script>', initial.link);
      const recovered = await check('<ma-text text="恢复成功"></ma-text><script>if(typeof require!=="undefined"||window.__maUiHost)throw Error("HOST_CAPABILITY_LEAK")</script>', initial.link);
      const missing = await smokeUiWidget(folder + '/missing.inline.html');
      const unavailable = await host['ui.render']({ ...ctx, sessions: { get: () => ({ runtime: 'fixture-cli' }), isChatRuntime: () => false } }, { sessionId: 'cli', title: 'CLI 打开失败', html: '<ma-text text="产物保留"></ma-text>' });
      const diagnostic = await host['ui.render'](ctx, { sessionId: 'diagnostics', title: '表达式定位', html: '<ma-text id="first" expr="n @ 2"></ma-text><ma-text id="second" expr="n @ 3"></ma-text>' });
      const schedulerInitial = await scheduler(() => host['ui.render'](ctx, { title: 'Scheduler', html: '<ma-text>Scheduler</ma-text>' })) as any;
      const schedulerUpdate = await scheduler(() => host['ui.render'](ctx, { title: 'Scheduler updated', html: '<ma-text>Updated</ma-text>', update: schedulerInitial.link })) as any;
      const schedulerInspect = await scheduler(() => host['ui.inspect'](ctx, {})) as any;
      return { initial, update, recovered, missing, unavailable, diagnostic, schedulerInitial, schedulerUpdate, schedulerInspect, windows: BrowserWindow.getAllWindows().length };
    }, fixture);
    expect(results.initial.warnings.join('\n')).toMatch(/HOST_SMOKE_CREATE.*行 \d+/);
    expect(results.update.warnings.join('\n')).toContain('HOST_SMOKE_UPDATE');
    expect(results.recovered.warnings).toBeUndefined();
    expect([results.initial.version, results.update.version, results.recovered.version]).toEqual([1, 2, 3]);
    expect(results.initial.receipt.status).toBe('generated');
    expect(results.schedulerInitial.link.replace(/\\/g, '/')).toContain('/orchestrator.12345678-1234-1234-1234-123456789abc/ui/');
    expect(results.schedulerInitial.warnings).toBeUndefined();
    expect(results.schedulerUpdate.warnings).toBeUndefined();
    expect(results.schedulerUpdate.version).toBe(2);
    expect(results.schedulerInspect.widgets[0].version).toBe(2);
    expect(results.missing.join('\n')).toContain('运行时冒烟未完成');
    expect(results.windows).toBe(0);
    expect(results.unavailable.presentation.opened).toBe(false);
    expect(results.unavailable.warnings.join('\n')).toContain('右侧浏览器打开失败');
    expect(results.unavailable.markdown).toContain('CLI 打开失败');
    expect(results.diagnostic.diagnostics.map((detail: { id: string }) => detail.id)).toEqual(['first', 'second']);
    expect(results.diagnostic.diagnostics[0]).toMatchObject({ attribute: 'expr', position: 3, code: 'expression_character', expression: 'n @ 2' });
    expect(results.diagnostic.warnings.join('\n')).toContain('ma-text#second');
  } finally {
    await app.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
