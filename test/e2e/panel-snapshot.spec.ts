import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { PanelSnapshotResponse } from '../../src/shared/panelState';
import type { PanelOpenResponse } from '../../src/shared/panelState';
import type { PanelOpenContent } from '../../src/shared/panelState';
import type { PanelCloseResponse } from '../../src/shared/panelState';
import type { PanelFocusResponse } from '../../src/shared/panelState';
import type { PanelAxisFocusResponse } from '../../src/shared/panelState';
import type { PanelCenterCloseResponse } from '../../src/shared/panelState';
import type { PanelCenterFocusResponse } from '../../src/shared/panelState';
import type { PanelSplitResponse } from '../../src/shared/panelState';

const repoRoot = path.resolve(__dirname, '../..');
const nodeRequire = createRequire(__filename);

async function stopApp(app: ElectronApplication): Promise<void> {
  const proc = app.process();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([app.close().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]); }
  finally { if (timer) clearTimeout(timer); }
  if (proc.exitCode === null && proc.pid) {
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
    } else proc.kill('SIGKILL');
  }
}

test('real renderer reports its workspace, opens file and Git tabs, and closes a view', async ({}, info) => {
  test.setTimeout(105_000);
  fs.mkdirSync(path.join(repoRoot, '.tmp'), { recursive: true });
  const cwd = fs.mkdtempSync(path.join(repoRoot, '.tmp', 'ma-panel-e2e-'));
  const workspace = path.join(cwd, 'workspace'), userData = path.join(cwd, '.dev-sandbox/userData');
  const workspaceId = 'panel-snapshot-test';
  const themeId = process.env.PANEL_E2E_THEME === 'light' ? 'light' : 'dark';
  fs.mkdirSync(path.join(workspace, '.muster'), { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'pipe' });
  fs.writeFileSync(path.join(workspace, 'agent-open.txt'), 'panel open fixture');
  fs.writeFileSync(path.join(workspace, 'center-open.txt'), 'center file fixture');
  fs.writeFileSync(path.join(workspace, 'center-close-workspace.txt'), 'workspace close fixture');
  fs.writeFileSync(path.join(workspace, 'center-image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(path.join(workspace, '.muster/workspace.json'), JSON.stringify({ hVirtualScreen: true, hDock: 'git' }));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId,
    activeWorkspaceId: workspaceId, defaultCwd: workspace, workspaces: [{ id: workspaceId, name: 'Panel test', path: workspace }],
    webAccess: { enabled: false }, mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `panel-snapshot-${process.pid}`,
    MUSTER_WEB_PORT: '0', APPDATA: path.join(cwd, 'appdata'), LOCALAPPDATA: path.join(cwd, 'localappdata') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_NO_SANDBOX']) delete env[key];
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({ executablePath: nodeRequire('electron') as unknown as string,
      args: [repoRoot, '--disable-gpu', '--in-process-gpu'], cwd, env, timeout: 30_000 });
    const page = await app.firstWindow();
    await page.locator('.app-shell').waitFor({ timeout: 30_000 });
    const browserWindow = await app.browserWindow(page);
    const windowId = await browserWindow.evaluate(window => window.id);
    let sequence = 0;
    const query = async (targetWorkspace: string): Promise<PanelSnapshotResponse> => app!.evaluate(async ({ BrowserWindow, ipcMain }, args) => {
      const window = BrowserWindow.fromId(args.windowId);
      if (!window) throw new Error('test window unavailable');
      return await new Promise<PanelSnapshotResponse>((resolve, reject) => {
        const channel = `panel:snapshot:${args.id}`;
        const timer = setTimeout(() => { ipcMain.removeListener(channel, listener); reject(new Error('snapshot timeout')); }, 5000);
        const listener = (event: Electron.IpcMainEvent, payload: PanelSnapshotResponse) => {
          if (event.sender !== window.webContents) return;
          clearTimeout(timer); ipcMain.removeListener(channel, listener); resolve(payload);
        };
        ipcMain.on(channel, listener);
        window.webContents.send('panel:snapshot-request', { requestId: args.id, workspaceId: args.workspaceId });
      });
    }, { windowId, id: `test-${++sequence}`, workspaceId: targetWorkspace });
    await expect.poll(async () => (await query(workspaceId)).ok, { timeout: 15_000 }).toBe(true);
    const result = await query(workspaceId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.snapshot.workspaceId).toBe(workspaceId);
    expect(result.snapshot.right.workspaceId).toBe(workspaceId);
    expect(Array.isArray(result.snapshot.center.panes)).toBe(true);
    const resolved = await page.evaluate(id => window.api.fs.resolveRef(id, 'agent-open.txt'), workspaceId);
    if (!resolved.ok) throw new Error(resolved.error);
    const roots = await page.evaluate(() => window.api.workspaces.list());
    const rootsRevision = roots.workspaces.find(item => item.id === workspaceId)?.rootsRevision ?? 0;
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const initialModal = page.getByRole('dialog', { name: '设置' });
    await expect(initialModal).toBeVisible();
    await expect(initialModal).toBeFocused();
    await initialModal.getByRole('button', { name: /返回工作台/ }).click();
    await expect(initialModal).not.toBeVisible();
    const openContent = async (content: PanelOpenContent, focus = false): Promise<PanelOpenResponse> => app!.evaluate(async ({ BrowserWindow, ipcMain }, args) => {
      const window = BrowserWindow.fromId(args.windowId);
      if (!window) throw new Error('test window unavailable');
      return await new Promise<PanelOpenResponse>((resolve, reject) => {
        const channel = `panel:open-content:${args.id}`;
        const timer = setTimeout(() => { ipcMain.removeListener(channel, listener); reject(new Error('open timeout')); }, 7000);
        const listener = (event: Electron.IpcMainEvent, payload: PanelOpenResponse) => {
          if (event.sender !== window.webContents) return;
          clearTimeout(timer); ipcMain.removeListener(channel, listener); resolve(payload);
        };
        ipcMain.on(channel, listener);
        window.webContents.send('panel:open-content-request', { requestId: args.id, workspaceId: args.workspaceId,
          rootsRevision: args.rootsRevision, focus: args.focus, content: args.content });
      });
    }, { windowId, id: `open-${++sequence}`, workspaceId, rootsRevision, content, focus });
    const fileContent: PanelOpenContent = { kind: 'file', path: resolved.fileRef.relativePath, fileRef: resolved.fileRef };
    const opened = await openContent(fileContent);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error);
    expect(opened.existing).toBe(false);
    const afterOpen = await query(workspaceId);
    if (!afterOpen.ok) throw new Error(afterOpen.error);
    expect(afterOpen.snapshot.right.tabs).toContainEqual(expect.objectContaining({ id: opened.tabId, origin: 'agent',
      content: expect.objectContaining({ kind: 'file', path: 'agent-open.txt' }) }));
    const repeated = await openContent(fileContent);
    expect(repeated).toMatchObject({ ok: true, tabId: opened.tabId, existing: true });
    const diffContent: PanelOpenContent = { kind: 'diff', repoPath: workspace, filePath: 'agent-open.txt', staged: false, untracked: true };
    const diff = await openContent(diffContent);
    expect(diff).toMatchObject({ ok: true, existing: false, selected: false });
    const diffRepeat = await openContent(diffContent);
    if (!diff.ok) throw new Error(diff.error);
    expect(diffRepeat).toMatchObject({ ok: true, tabId: diff.tabId, existing: true });
    const git = await openContent({ kind: 'git', repoPath: workspace });
    expect(git.ok).toBe(true);
    if (!git.ok) throw new Error(git.error);
    const afterGit = await query(workspaceId);
    if (!afterGit.ok) throw new Error(afterGit.error);
    expect(afterGit.snapshot.right.tabs).toContainEqual(expect.objectContaining({ id: git.tabId, origin: 'agent',
      content: expect.objectContaining({ kind: 'git', repoPath: workspace }) }));
    expect(afterGit.snapshot.right.tabs).toContainEqual(expect.objectContaining({ id: diff.tabId, origin: 'agent', content: diffContent }));
    await page.screenshot({ path: info.outputPath('panel-agent-open.png') });
    const gitContent = afterGit.snapshot.right.tabs.find(tab => tab.id === git.tabId)!.content;
    const focusTab = async (expectedContent: string, tabId = git.tabId): Promise<PanelFocusResponse> => app!.evaluate(async ({ BrowserWindow, ipcMain }, args) => {
      const window = BrowserWindow.fromId(args.windowId);
      if (!window) throw new Error('test window unavailable');
      return await new Promise<PanelFocusResponse>((resolve, reject) => {
        const channel = `panel:focus-tab:${args.id}`;
        const timer = setTimeout(() => { ipcMain.removeListener(channel, listener); reject(new Error('focus timeout')); }, 5000);
        const listener = (event: Electron.IpcMainEvent, payload: PanelFocusResponse) => {
          if (event.sender !== window.webContents) return;
          clearTimeout(timer); ipcMain.removeListener(channel, listener); resolve(payload);
        };
        ipcMain.on(channel, listener);
        window.webContents.send('panel:focus-tab-request', { requestId: args.id, workspaceId: args.workspaceId,
          rootsRevision: args.rootsRevision, tabId: args.tabId, expectedContent: args.expectedContent });
      });
    }, { windowId, id: `focus-${++sequence}`, workspaceId, rootsRevision, tabId, expectedContent });
    expect(await focusTab('')).toMatchObject({ ok: false, error: expect.stringMatching(/required/) });
    expect(await focusTab(JSON.stringify({ kind: 'git', repoPath: 'stale' }))).toMatchObject({ ok: false, error: expect.stringMatching(/changed/) });
    const focused = await focusTab(JSON.stringify(gitContent));
    expect(focused).toEqual({ ok: true, tabId: git.tabId, selected: true });
    const afterFocus = await query(workspaceId);
    if (!afterFocus.ok) throw new Error(afterFocus.error);
    expect(afterFocus.snapshot.right.selectedTabId).toBe(git.tabId);
    await page.screenshot({ path: info.outputPath('panel-agent-focus.png') });
    const closeContent = async (tabId: string, expectedContent: string): Promise<PanelCloseResponse> => app!.evaluate(async ({ BrowserWindow, ipcMain }, args) => {
      const window = BrowserWindow.fromId(args.windowId);
      if (!window) throw new Error('test window unavailable');
      return await new Promise<PanelCloseResponse>((resolve, reject) => {
        const channel = `panel:close-tab:${args.id}`;
        const timer = setTimeout(() => { ipcMain.removeListener(channel, listener); reject(new Error('close timeout')); }, 5000);
        const listener = (event: Electron.IpcMainEvent, payload: PanelCloseResponse) => {
          if (event.sender !== window.webContents) return;
          clearTimeout(timer); ipcMain.removeListener(channel, listener); resolve(payload);
        };
        ipcMain.on(channel, listener);
        window.webContents.send('panel:close-tab-request', { requestId: args.id, workspaceId: args.workspaceId,
          rootsRevision: args.rootsRevision, tabId: args.tabId, expectedContent: args.expectedContent });
      });
    }, { windowId, id: `close-${++sequence}`, workspaceId, rootsRevision, tabId, expectedContent });
    const closed = await closeContent(git.tabId, JSON.stringify(gitContent));
    expect(closed).toEqual({ ok: true, tabId: git.tabId, closed: true });
    const afterClose = await query(workspaceId);
    if (!afterClose.ok) throw new Error(afterClose.error);
    expect(afterClose.snapshot.right.tabs.some(tab => tab.id === git.tabId)).toBe(false);
    expect(afterClose.snapshot.right.tabs.some(tab => tab.id === opened.tabId)).toBe(true);
    const centerResolved = await page.evaluate(id => window.api.fs.resolveRef(id, 'center-open.txt'), workspaceId);
    if (!centerResolved.ok) throw new Error(centerResolved.error);
    const centerContent: PanelOpenContent = { kind: 'file', path: centerResolved.fileRef.relativePath, fileRef: centerResolved.fileRef, placement: 'center' };
    const beforeCenter = await query(workspaceId);
    if (!beforeCenter.ok) throw new Error(beforeCenter.error);
    const centerFile = await openContent(centerContent);
    expect(centerFile).toMatchObject({ ok: true, existing: false, selected: false });
    if (!centerFile.ok) throw new Error(centerFile.error);
    const backgroundFile = await query(workspaceId);
    if (!backgroundFile.ok) throw new Error(backgroundFile.error);
    expect(backgroundFile.snapshot.right.selectedTabId).toBe(beforeCenter.snapshot.right.selectedTabId);
    const fileTarget = backgroundFile.snapshot.center.background?.find(item => item.id === centerFile.tabId)?.target;
    expect(fileTarget).toMatchObject({ kind: 'utility', sel: expect.stringMatching(/^center-file:/) });
    const fileBinding = backgroundFile.snapshot.center.fileViews?.find(item => item.sel === (fileTarget as { sel: string }).sel);
    expect(fileBinding).toBeTruthy();
    await expect(page.locator('.center-background-tabs').getByRole('button', { name: 'center-open.txt', exact: true })).toBeVisible();
    const centerFocused = await openContent(centerContent, true);
    expect(centerFocused, JSON.stringify(centerFocused)).toMatchObject({ ok: true, tabId: centerFile.tabId, existing: true, selected: true });
    const centerEditor = page.locator('.center-file-dock .right-content-page.is-shown .file-editor');
    await expect(centerEditor).toBeVisible();
    await expect(centerEditor).toContainText('center file fixture');
    await centerEditor.evaluate(element => element.setAttribute('data-center-file-probe', 'same-instance'));
    await page.screenshot({ path: info.outputPath('center-file-focused.png'), animations: 'disabled' });
    const alternateWorkspace = roots.workspaces.find(item => item.id !== workspaceId);
    if (!alternateWorkspace) throw new Error('Alternate sandbox workspace unavailable');
    expect(await page.evaluate(id => window.api.workspaces.switch(id), alternateWorkspace.id)).toMatchObject({ ok: true });
    await expect.poll(async () => (await query(alternateWorkspace.id)).ok).toBe(true);
    await expect(page.locator('[data-center-file-probe="same-instance"]')).toHaveCount(1);
    expect(await page.evaluate(id => window.api.workspaces.switch(id), workspaceId)).toMatchObject({ ok: true });
    await expect.poll(async () => (await query(workspaceId)).ok).toBe(true);
    const refocused = await openContent(centerContent, true);
    expect(refocused, JSON.stringify(refocused)).toMatchObject({ ok: true, tabId: centerFile.tabId, existing: true, selected: true });
    await expect(centerEditor).toHaveAttribute('data-center-file-probe', 'same-instance');
    if (process.env.PANEL_E2E_NARROW === '1') {
      const originalBounds = await browserWindow.evaluate(window => window.getContentSize());
      await browserWindow.evaluate(window => { window.setMinimumSize(0, 0); window.setContentSize(760, 800); });
      await expect.poll(() => page.evaluate(() => window.matchMedia('(max-width: 820px)').matches)).toBe(true);
      await expect(centerEditor).toBeVisible();
      await expect(centerEditor).toHaveAttribute('data-center-file-probe', 'same-instance');
      await page.screenshot({ path: info.outputPath('center-file-narrow.png'), animations: 'disabled' });
      await browserWindow.evaluate((window, size) => window.setContentSize(size[0], size[1]), originalBounds);
      await expect.poll(() => page.evaluate(() => window.matchMedia('(max-width: 820px)').matches)).toBe(false);
    }
    expect(await closeContent(centerFile.tabId, JSON.stringify({ kind: 'center-background', target: fileTarget, file: fileBinding }))).toEqual({ ok: true, tabId: centerFile.tabId, closed: true });
    await expect(centerEditor).toHaveAttribute('data-center-file-probe', 'same-instance');
    await page.getByTitle(/定时执行提示词任务/).click();
    await expect.poll(async () => { const value = await query(workspaceId); return value.ok && !value.snapshot.center.fileViews?.some(item => item.tabId === fileBinding!.tabId); }).toBe(true);
    const imageRef = await page.evaluate(id => window.api.fs.resolveRef(id, 'center-image.png'), workspaceId);
    if (!imageRef.ok) throw new Error(imageRef.error);
    const imageContent: PanelOpenContent = { kind: 'image', path: imageRef.fileRef.relativePath, fileRef: imageRef.fileRef, placement: 'center' };
    const centerImage = await openContent(imageContent, true);
    expect(centerImage, JSON.stringify(centerImage)).toMatchObject({ ok: true, selected: true });
    if (!centerImage.ok) throw new Error(centerImage.error);
    await expect(page.locator('.center-file-dock .file-media-img')).toBeVisible();
    await expect.poll(() => page.locator('.center-file-dock .file-media-img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    const imageSnapshot = await query(workspaceId);
    if (!imageSnapshot.ok) throw new Error(imageSnapshot.error);
    const imageBackground = imageSnapshot.snapshot.center.background?.find(item => item.id === centerImage.tabId);
    const imageBinding = imageSnapshot.snapshot.center.fileViews?.find(item => item.sel === (imageBackground?.target as { sel?: string } | undefined)?.sel);
    expect(imageBackground).toBeTruthy();
    expect(imageBinding).toBeTruthy();
    expect(await closeContent(centerImage.tabId, JSON.stringify({ kind: 'center-background', target: imageBackground!.target, file: imageBinding }))).toEqual({ ok: true, tabId: centerImage.tabId, closed: true });
    await page.getByTitle(/定时执行提示词任务/).click();
    const focusAxis = async (target: 'terminal' | 'git'): Promise<PanelAxisFocusResponse> => app!.evaluate(async ({ BrowserWindow, ipcMain }, args) => {
      const window = BrowserWindow.fromId(args.windowId);
      if (!window) throw new Error('test window unavailable');
      return await new Promise<PanelAxisFocusResponse>((resolve, reject) => {
        const channel = `panel:focus-axis:${args.id}`;
        const timer = setTimeout(() => { ipcMain.removeListener(channel, listener); reject(new Error('axis timeout')); }, 5000);
        const listener = (event: Electron.IpcMainEvent, payload: PanelAxisFocusResponse) => {
          if (event.sender !== window.webContents) return;
          clearTimeout(timer); ipcMain.removeListener(channel, listener); resolve(payload);
        };
        ipcMain.on(channel, listener);
        window.webContents.send('panel:focus-axis-request', { requestId: args.id, workspaceId: args.workspaceId,
          rootsRevision: args.rootsRevision, page: args.page });
      });
    }, { windowId, id: `axis-${++sequence}`, workspaceId, rootsRevision, page: target });
    expect(await focusAxis('terminal')).toEqual({ ok: true, page: 'terminal' });
    const takeoverFile = await openContent(centerContent, true);
    expect(takeoverFile, JSON.stringify(takeoverFile)).toMatchObject({ ok: true, selected: true });
    if (!takeoverFile.ok) throw new Error(takeoverFile.error);
    const takeoverSnapshot = await query(workspaceId);
    if (!takeoverSnapshot.ok) throw new Error(takeoverSnapshot.error);
    const takeoverTarget = takeoverSnapshot.snapshot.center.background?.find(item => item.id === takeoverFile.tabId)?.target;
    if (!takeoverTarget || takeoverTarget.kind !== 'utility') throw new Error('Center file target unavailable');
    const takeoverBinding = takeoverSnapshot.snapshot.center.fileViews?.find(item => item.sel === takeoverTarget.sel);
    expect(takeoverBinding).toBeTruthy();
    const takeoverEditor = page.locator('.center-file-dock .right-content-page.is-shown .file-editor');
    await expect(takeoverEditor).toBeVisible();
    await takeoverEditor.evaluate(element => element.setAttribute('data-center-takeover', 'same-instance'));
    expect(await focusAxis('git')).toEqual({ ok: true, page: 'git' });
    await page.getByRole('tablist', { name: '资源面板' }).getByRole('tab', { name: '文件', exact: true }).click();
    const expandResources = page.getByRole('button', { name: '展开资源面板' });
    if (await expandResources.isVisible()) await expandResources.click();
    await page.locator('.right-files-resources').getByTitle('center-open.txt', { exact: true }).click();
    await expect(page.locator('.right-workspace-content .right-content-page.is-shown .file-editor')).toHaveAttribute('data-center-takeover', 'same-instance');
    await expect.poll(async () => { const value = await query(workspaceId); return value.ok && !value.snapshot.center.fileViews?.some(item => item.tabId === takeoverBinding!.tabId); }).toBe(true);
    expect(await focusAxis('terminal')).toEqual({ ok: true, page: 'terminal' });
    await page.mouse.move(800, 500);
    const backgroundUtility = await openContent({ kind: 'utility', sel: 'memory', title: 'ignored', placement: 'center' });
    expect(backgroundUtility).toMatchObject({ ok: true, selected: false });
    if (!backgroundUtility.ok) throw new Error(backgroundUtility.error);
    await expect(page.locator('.center-background-tabs').getByRole('button', { name: '记忆整理', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('panel-utility-background.png'), animations: 'disabled' });
    const utilityWindow = await app.evaluate(({ BrowserWindow }, id) => { const window = BrowserWindow.fromId(id)!; return { size: window.getContentSize(), minimum: window.getMinimumSize() }; }, windowId);
    await app.evaluate(({ BrowserWindow }, id) => { const window = BrowserWindow.fromId(id)!; window.setMinimumSize(640, 480); window.setContentSize(860, 720); }, windowId);
    await page.screenshot({ path: info.outputPath('panel-utility-background-narrow.png'), animations: 'disabled' });
    await app.evaluate(({ BrowserWindow }, args) => { const window = BrowserWindow.fromId(args.id)!; window.setMinimumSize(args.minimum[0], args.minimum[1]); window.setContentSize(args.size[0], args.size[1]); }, { id: windowId, ...utilityWindow });
    const backgroundSnapshot = await query(workspaceId);
    if (!backgroundSnapshot.ok) throw new Error(backgroundSnapshot.error);
    expect(backgroundSnapshot.snapshot.center.background).toContainEqual({ id: backgroundUtility.tabId, target: { kind: 'utility', sel: 'memory' } });
    const backgroundIdentity = JSON.stringify({ kind: 'center-background', target: { kind: 'utility', sel: 'memory' } });
    expect(await focusTab(backgroundIdentity, backgroundUtility.tabId)).toEqual({ ok: true, tabId: backgroundUtility.tabId, selected: true });
    expect(await openContent({ kind: 'utility', sel: 'memory', title: 'ignored', placement: 'center' }, true)).toEqual({ ok: true, tabId: backgroundUtility.tabId, existing: true, selected: true });
    expect(await closeContent(backgroundUtility.tabId, backgroundIdentity)).toEqual({ ok: true, tabId: backgroundUtility.tabId, closed: true });
    const reopenedUtility = await openContent({ kind: 'utility', sel: 'memory', title: 'ignored', placement: 'center' }, true);
    expect(reopenedUtility).toMatchObject({ ok: true, existing: true, selected: true });
    if (!reopenedUtility.ok) throw new Error(reopenedUtility.error);
    expect(reopenedUtility.tabId).not.toBe(backgroundUtility.tabId);
    expect(await closeContent(reopenedUtility.tabId, backgroundIdentity)).toEqual({ ok: true, tabId: reopenedUtility.tabId, closed: true });
    const terminalView = await query(workspaceId);
    if (!terminalView.ok) throw new Error(terminalView.error);
    expect(terminalView.snapshot.axis.page).toBe('terminal');
    await page.locator('.h-strip').evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))); });
    await page.screenshot({ path: info.outputPath('panel-axis-terminal.png') });
    await page.getByTitle(/定时执行提示词任务/).click();
    await expect.poll(async () => {
      const state = await query(workspaceId);
      return state.ok && state.snapshot.center.panes.some(pane => pane.kind === 'utility' && pane.sel === 'tasks');
    }).toBe(true);
    const focusCenter = () => app!.evaluate(async ({ BrowserWindow, ipcMain }, args) => {
      const window = BrowserWindow.fromId(args.windowId);
      if (!window) throw new Error('test window unavailable');
      return await new Promise<PanelCenterFocusResponse>((resolve, reject) => {
        const channel = `panel:focus-center:${args.id}`;
        const timer = setTimeout(() => { ipcMain.removeListener(channel, listener); reject(new Error('center focus timeout')); }, 5000);
        const listener = (event: Electron.IpcMainEvent, payload: PanelCenterFocusResponse) => {
          if (event.sender !== window.webContents) return;
          clearTimeout(timer); ipcMain.removeListener(channel, listener); resolve(payload);
        };
        ipcMain.on(channel, listener);
        window.webContents.send('panel:focus-center-request', { requestId: args.id, workspaceId: args.workspaceId,
          rootsRevision: args.rootsRevision, target: { kind: 'utility', sel: 'tasks' } });
      });
    }, { windowId, id: `center-${++sequence}`, workspaceId, rootsRevision });
    expect(await focusCenter()).toEqual({ ok: true, target: { kind: 'utility', sel: 'tasks' }, slot: 0 });
    await expect(page.locator('.center-split-pane[data-pane="0"]')).toBeFocused();
    await page.screenshot({ path: info.outputPath('panel-center-focus.png') });
    expect(await focusAxis('git')).toEqual({ ok: true, page: 'git' });
    expect(await focusCenter()).toMatchObject({ ok: false, error: expect.stringMatching(/not safely visible/) });
    const workers = await page.evaluate(async ({ workspace, workspaceId }) => {
      const profiles = await window.api.shell.listProfiles();
      if (!profiles.length) throw new Error('No local shell profile available');
      const first = await window.api.sessions.create({ name: 'Split worker A', cwd: workspace, workspaceId, shellProfileId: profiles[0].id, activate: false });
      const second = await window.api.sessions.create({ name: 'Split worker B', cwd: workspace, workspaceId, shellProfileId: profiles[0].id, activate: false });
      return [first.id, second.id];
    }, { workspace, workspaceId });
    await expect.poll(async () => (await page.evaluate(() => window.api.sessions.list())).sessions.filter(item => workers.includes(item.id)).length).toBe(2);
    await expect(page.getByText('Split worker A', { exact: true })).toBeVisible();
    const beforeBackgroundSession = await query(workspaceId);
    if (!beforeBackgroundSession.ok) throw new Error(beforeBackgroundSession.error);
    const backgroundSession = await openContent({ kind: 'session', sessionId: workers[0], title: 'ignored', placement: 'center' });
    expect(backgroundSession).toMatchObject({ ok: true, selected: false });
    if (!backgroundSession.ok) throw new Error(backgroundSession.error);
    const afterBackgroundSession = await query(workspaceId);
    if (!afterBackgroundSession.ok) throw new Error(afterBackgroundSession.error);
    expect(afterBackgroundSession.snapshot.axis.page).toBe(beforeBackgroundSession.snapshot.axis.page);
    expect(afterBackgroundSession.snapshot.center.background).toContainEqual({ id: backgroundSession.tabId, target: { kind: 'session', sessionId: workers[0] } });
    expect(await focusAxis('terminal')).toEqual({ ok: true, page: 'terminal' });
    await expect(page.locator('.center-background-tabs').getByRole('button', { name: 'Split worker A', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('panel-session-background-center.png'), animations: 'disabled' });
    const sessionWindow = await app.evaluate(({ BrowserWindow }, id) => { const window = BrowserWindow.fromId(id)!; return { size: window.getContentSize(), minimum: window.getMinimumSize() }; }, windowId);
    await app.evaluate(({ BrowserWindow }, id) => { const window = BrowserWindow.fromId(id)!; window.setMinimumSize(640, 480); window.setContentSize(860, 720); }, windowId);
    await page.screenshot({ path: info.outputPath('panel-session-background-narrow.png'), animations: 'disabled' });
    await app.evaluate(({ BrowserWindow }, args) => { const window = BrowserWindow.fromId(args.id)!; window.setMinimumSize(args.minimum[0], args.minimum[1]); window.setContentSize(args.size[0], args.size[1]); }, { id: windowId, ...sessionWindow });
    expect(await focusAxis('git')).toEqual({ ok: true, page: 'git' });
    const backgroundSessionIdentity = JSON.stringify({ kind: 'center-background', target: { kind: 'session', sessionId: workers[0] } });
    const backgroundSessionView = page.locator(`.terminal-wrap[data-session-id="${workers[0]}"]`);
    await expect(backgroundSessionView).toHaveCount(1);
    await backgroundSessionView.evaluate(element => element.setAttribute('data-background-probe', 'same-instance'));
    expect(await focusTab(backgroundSessionIdentity, backgroundSession.tabId)).toEqual({ ok: true, tabId: backgroundSession.tabId, selected: true });
    await expect(backgroundSessionView).toHaveAttribute('data-background-probe', 'same-instance');
    expect(await closeContent(backgroundSession.tabId, backgroundSessionIdentity)).toEqual({ ok: true, tabId: backgroundSession.tabId, closed: true });
    expect((await page.evaluate(() => window.api.sessions.list())).sessions.some(item => item.id === workers[0] && !item.archived)).toBe(true);
    const panes = workers.map(sessionId => ({ kind: 'session' as const, sessionId }));
    const createSplit = () => app!.evaluate(async ({ BrowserWindow, ipcMain }, args) => {
      const window = BrowserWindow.fromId(args.windowId);
      if (!window) throw new Error('test window unavailable');
      return await new Promise<PanelSplitResponse>((resolve, reject) => {
        const channel = `panel:split:${args.id}`;
        const timer = setTimeout(() => { ipcMain.removeListener(channel, listener); reject(new Error('split timeout')); }, 7000);
        const listener = (event: Electron.IpcMainEvent, payload: PanelSplitResponse) => {
          if (event.sender !== window.webContents) return;
          clearTimeout(timer); ipcMain.removeListener(channel, listener); resolve(payload);
        };
        ipcMain.on(channel, listener);
        window.webContents.send('panel:split-request', { requestId: args.id, workspaceId: args.workspaceId,
          rootsRevision: args.rootsRevision, panes: args.panes, layoutId: 'halves' });
      });
    }, { windowId, id: `split-${++sequence}`, workspaceId, rootsRevision, panes });
    expect(await createSplit()).toEqual({ ok: true, panes, layoutId: 'halves' });
    const afterSplit = await query(workspaceId);
    if (!afterSplit.ok) throw new Error(afterSplit.error);
    expect(afterSplit.snapshot.center.panes).toEqual(panes);
    await page.screenshot({ path: info.outputPath('panel-two-workers.png') });
    const centerClosed = await app.evaluate(async ({ BrowserWindow, ipcMain }, args) => {
      const window = BrowserWindow.fromId(args.windowId);
      if (!window) throw new Error('test window unavailable');
      return await new Promise<PanelCenterCloseResponse>((resolve, reject) => {
        const channel = `panel:close-center:${args.id}`;
        const timer = setTimeout(() => { ipcMain.removeListener(channel, listener); reject(new Error('center close timeout')); }, 7000);
        const listener = (event: Electron.IpcMainEvent, payload: PanelCenterCloseResponse) => {
          if (event.sender !== window.webContents) return;
          clearTimeout(timer); ipcMain.removeListener(channel, listener); resolve(payload);
        };
        ipcMain.on(channel, listener);
        window.webContents.send('panel:close-center-request', { requestId: args.id, workspaceId: args.workspaceId,
          rootsRevision: args.rootsRevision, slot: 1, panes: args.panes });
      });
    }, { windowId, id: `close-center-${++sequence}`, workspaceId, rootsRevision, panes });
    expect(centerClosed).toEqual({ ok: true, target: panes[1], closed: true });
    const afterCenterClose = await query(workspaceId);
    if (!afterCenterClose.ok) throw new Error(afterCenterClose.error);
    expect(afterCenterClose.snapshot.center.panes).toEqual([panes[0]]);
    expect((await page.evaluate(() => window.api.sessions.list())).sessions.filter(item => workers.includes(item.id))).toHaveLength(2);
    await page.screenshot({ path: info.outputPath('panel-center-closed.png') });
    expect(await createSplit()).toEqual({ ok: true, panes, layoutId: 'halves' });
    const sessionView = await openContent({ kind: 'session', sessionId: workers[0], title: 'untrusted' });
    expect(sessionView).toMatchObject({ ok: true, existing: false, selected: false });
    if (!sessionView.ok) throw new Error(sessionView.error);
    await expect(page.locator(`[data-dock-host="session:${workers[0]}"]`)).toHaveCount(0);
    const sessionSnapshot = await query(workspaceId);
    if (!sessionSnapshot.ok) throw new Error(sessionSnapshot.error);
    expect(sessionSnapshot.snapshot.center.panes).toEqual(panes);
    expect(sessionSnapshot.snapshot.right.tabs.find(tab => tab.id === sessionView.tabId)?.deferredDock).toBe(true);
    const sessionContent = sessionSnapshot.snapshot.right.tabs.find(tab => tab.id === sessionView.tabId)!.content;
    expect(sessionContent).toMatchObject({ kind: 'session', sessionId: workers[0], title: 'Split worker A' });
    await page.screenshot({ path: info.outputPath('panel-session-background.png') });
    expect(await focusTab(JSON.stringify(sessionContent), sessionView.tabId)).toEqual({ ok: true, tabId: sessionView.tabId, selected: true });
    const visibleSession = await query(workspaceId);
    if (!visibleSession.ok) throw new Error(visibleSession.error);
    expect(visibleSession.snapshot.axis.page).toBe('git');
    expect(visibleSession.snapshot.right.tabs.find(tab => tab.id === sessionView.tabId)?.deferredDock).toBe(false);
    await expect(page.locator(`[data-dock-host="session:${workers[0]}"]`)).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('panel-session-focused.png') });
    expect(await closeContent(sessionView.tabId, JSON.stringify(sessionContent))).toEqual({ ok: true, tabId: sessionView.tabId, closed: true });
    await expect(page.locator(`[data-dock-host="session:${workers[0]}"]`)).toHaveCount(0);
    const utilityView = await openContent({ kind: 'utility', sel: 'tasks', title: 'untrusted' });
    expect(utilityView).toMatchObject({ ok: true, existing: false, selected: false });
    if (!utilityView.ok) throw new Error(utilityView.error);
    await expect(page.locator('[data-dock-host="utility:tasks"]')).toHaveCount(0);
    const utilitySnapshot = await query(workspaceId);
    if (!utilitySnapshot.ok) throw new Error(utilitySnapshot.error);
    const utilityContent = utilitySnapshot.snapshot.right.tabs.find(tab => tab.id === utilityView.tabId)!.content;
    expect(utilityContent).toMatchObject({ kind: 'utility', sel: 'tasks', title: '定时任务' });
    expect(await focusTab(JSON.stringify(utilityContent), utilityView.tabId)).toEqual({ ok: true, tabId: utilityView.tabId, selected: true });
    await expect(page.locator('[data-dock-host="utility:tasks"]')).toHaveCount(1);
    expect(await closeContent(utilityView.tabId, JSON.stringify(utilityContent))).toEqual({ ok: true, tabId: utilityView.tabId, closed: true });
    await expect(page.locator('[data-dock-host="utility:tasks"]')).toHaveCount(0);
    expect(await focusAxis('terminal')).toEqual({ ok: true, page: 'terminal' });
    const focusedUtility = await openContent({ kind: 'utility', sel: 'usage', title: 'untrusted' }, true);
    expect(focusedUtility).toMatchObject({ ok: true, selected: true });
    if (!focusedUtility.ok) throw new Error(focusedUtility.error);
    const focusedUtilitySnapshot = await query(workspaceId);
    if (!focusedUtilitySnapshot.ok) throw new Error(focusedUtilitySnapshot.error);
    expect(focusedUtilitySnapshot.snapshot.axis.page).toBe('git');
    const reviewContent: PanelOpenContent = { kind: 'review', owner: { kind: 'dispatch', id: workspaceId }, messageId: 'review-a' };
    const review = await openContent(reviewContent);
    expect(review).toMatchObject({ ok: true, existing: false, selected: false });
    if (!review.ok) throw new Error(review.error);
    const nextReview: PanelOpenContent = { ...reviewContent, messageId: 'review-b' };
    expect(await openContent(nextReview)).toEqual({ ok: true, tabId: review.tabId, existing: true, selected: false });
    const reviewSnapshot = await query(workspaceId);
    if (!reviewSnapshot.ok) throw new Error(reviewSnapshot.error);
    expect(reviewSnapshot.snapshot.right.selectedTabId).toBe(focusedUtility.tabId);
    expect(reviewSnapshot.snapshot.right.tabs.find(tab => tab.id === review.tabId)?.content).toEqual(nextReview);
    await page.screenshot({ path: info.outputPath('panel-review-background.png') });
    expect(await closeContent(review.tabId, JSON.stringify(nextReview))).toEqual({ ok: true, tabId: review.tabId, closed: true });
    const focusedUtilityContent = focusedUtilitySnapshot.snapshot.right.tabs.find(tab => tab.id === focusedUtility.tabId)!.content;
    expect(await closeContent(focusedUtility.tabId, JSON.stringify(focusedUtilityContent))).toMatchObject({ ok: true });
    expect((await page.evaluate(() => window.api.sessions.list())).sessions.filter(item => workers.includes(item.id))).toHaveLength(2);
    const wrong = await query('other-workspace');
    expect(wrong.ok).toBe(false);
    if (wrong.ok) throw new Error('Other workspace unexpectedly allowed');
    expect(wrong.error).toContain('not the stable visible workspace');
    await page.evaluate(() => {
      const input = document.createElement('input'); input.id = 'external-focus-probe';
      document.body.append(input); input.focus();
    });
    expect(await openContent({ kind: 'settings' })).toEqual({ ok: true, tabId: 'settings', existing: false, selected: false });
    const background = page.locator('.center-background-tabs');
    await expect(background.getByRole('button', { name: '设置', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('external-focus-probe');
    const hiddenSettings = await query(workspaceId);
    if (!hiddenSettings.ok) throw new Error(hiddenSettings.error);
    expect(hiddenSettings.snapshot.settings).toEqual({ prepared: true, visible: false, dirty: false });
    expect(await focusAxis('terminal')).toEqual({ ok: true, page: 'terminal' });
    await page.screenshot({ path: info.outputPath('panel-settings-background.png'), animations: 'disabled' });
    const originalWindow = await app.evaluate(({ BrowserWindow }, id) => { const window = BrowserWindow.fromId(id)!; return { size: window.getContentSize(), minimum: window.getMinimumSize() }; }, windowId);
    await app.evaluate(({ BrowserWindow }, id) => { const window = BrowserWindow.fromId(id)!; window.setMinimumSize(640, 480); window.setContentSize(860, 720); }, windowId);
    await expect(background.getByRole('button', { name: '设置', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('panel-settings-background-narrow.png'), animations: 'disabled' });
    await app.evaluate(({ BrowserWindow }, args) => { const window = BrowserWindow.fromId(args.id)!; window.setMinimumSize(args.minimum[0], args.minimum[1]); window.setContentSize(args.size[0], args.size[1]); }, { id: windowId, ...originalWindow });
    await background.getByRole('button', { name: '关闭 设置', exact: true }).click();
    await expect.poll(async () => { const value = await query(workspaceId); return value.ok && value.snapshot.settings?.prepared; }).toBe(false);
    expect(await openContent({ kind: 'settings' })).toEqual({ ok: true, tabId: 'settings', existing: false, selected: false });
    await page.locator('.settings-page--embedded').evaluate(element => element.setAttribute('data-background-probe', 'same-instance'));
    await background.getByRole('button', { name: '设置', exact: true }).click();
    await expect.poll(async () => { const value = await query(workspaceId); return value.ok && value.snapshot.settings?.visible; }).toBe(true);
    await expect(page.locator('.settings-page--embedded')).toHaveAttribute('data-background-probe', 'same-instance');
    expect(await openContent({ kind: 'settings' }, true)).toEqual({ ok: true, tabId: 'settings', existing: true, selected: true });
    await expect(page.getByRole('combobox', { name: '搜索设置' })).toBeFocused();
    expect(await openContent({ kind: 'settings' })).toEqual({ ok: true, tabId: 'settings', existing: true, selected: true });
    const settingsGeometry = await page.locator('.settings-page--embedded').evaluate(element => {
      const sheet = element.querySelector('.settings-sheet')!.getBoundingClientRect();
      const title = element.querySelector('.settings-pane-title h1')!.getBoundingClientRect();
      return { sheetWidth: sheet.width, titleHeight: title.height };
    });
    expect(settingsGeometry.sheetWidth).toBeGreaterThan(180);
    expect(settingsGeometry.titleHeight).toBeLessThan(50);
    await page.screenshot({ path: info.outputPath('panel-settings-open.png') });
    if (process.env.PANEL_E2E_NARROW === '1') {
      const previousSize = await browserWindow.evaluate(window => window.getContentSize());
      await browserWindow.evaluate(window => { window.setMinimumSize(0, 0); window.setContentSize(760, 800); });
      await expect.poll(() => page.evaluate(() => window.matchMedia('(max-width: 820px)').matches)).toBe(true);
      await expect(page.locator('.settings-page--embedded')).toBeVisible();
      await page.screenshot({ path: info.outputPath('panel-settings-narrow.png'), animations: 'disabled' });
      await browserWindow.evaluate((window, size) => window.setContentSize(size[0], size[1]), previousSize);
      await expect.poll(() => page.evaluate(() => window.matchMedia('(max-width: 820px)').matches)).toBe(false);
    }
    await page.getByRole('checkbox', { name: '任务运行时阻止休眠' }).click();
    await expect.poll(async () => { const value = await query(workspaceId); return value.ok && value.snapshot.settings?.dirty; }).toBe(true);
    expect(await openContent({ kind: 'utility', sel: 'usage', title: 'ignored' }, true)).toMatchObject({ ok: false, error: expect.stringMatching(/settings.*unsaved/) });
    expect(await openContent({ kind: 'utility', sel: 'usage', title: 'ignored', placement: 'center' }, true)).toMatchObject({ ok: false, error: expect.stringMatching(/unsaved/) });
    const afterBlockedCenter = await query(workspaceId);
    if (!afterBlockedCenter.ok) throw new Error(afterBlockedCenter.error);
    expect(afterBlockedCenter.snapshot.center.background ?? []).not.toContainEqual(expect.objectContaining({ target: { kind: 'utility', sel: 'usage' } }));
    expect(await focusAxis('git')).toMatchObject({ ok: false });
    expect(await page.getByRole('checkbox', { name: '任务运行时阻止休眠' }).isChecked()).toBe(false);
    expect(await closeContent('settings', JSON.stringify({ kind: 'settings' }))).toMatchObject({ ok: false, error: expect.stringMatching(/dirty/) });
    await page.getByRole('checkbox', { name: '任务运行时阻止休眠' }).evaluate(element => element.setAttribute('data-draft-probe', 'same-node'));
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '设置' });
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-draft-probe="same-node"]')).not.toBeChecked();
    await expect(modal.getByText('有 1 项更改未保存')).toBeVisible();
    await modal.getByRole('button', { name: /返回工作台/ }).click();
    await expect(modal.getByText('还有 1 项更改没保存，离开前要保存吗？')).toBeVisible();
    await modal.getByRole('button', { name: /返回工作台/ }).click();
    await expect(page.getByRole('region', { name: '设置' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: '任务运行时阻止休眠' })).toBeChecked();
    await expect.poll(async () => { const value = await query(workspaceId); return value.ok && value.snapshot.settings?.dirty; }).toBe(false);
    expect(await closeContent('settings', JSON.stringify({ kind: 'settings' }))).toEqual({ ok: true, tabId: 'settings', closed: true });
    const afterSettingsClose = await query(workspaceId);
    if (!afterSettingsClose.ok) throw new Error(afterSettingsClose.error);
    expect(afterSettingsClose.snapshot.settings).toEqual({ prepared: false, visible: false, dirty: false });
    await page.evaluate(() => (document.getElementById('external-focus-probe') as HTMLInputElement).focus());
    const rightSettings = await openContent({ kind: 'settings', placement: 'right' });
    expect(rightSettings).toMatchObject({ ok: true, existing: false, selected: false });
    if (!rightSettings.ok) throw new Error(rightSettings.error);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('external-focus-probe');
    const beforeRightFocus = await query(workspaceId);
    if (!beforeRightFocus.ok) throw new Error(beforeRightFocus.error);
    const rightSettingsContent = beforeRightFocus.snapshot.right.tabs.find(tab => tab.id === rightSettings.tabId)!.content;
    expect(rightSettingsContent).toMatchObject({ kind: 'utility', sel: 'settings' });
    expect(await openContent({ kind: 'settings', placement: 'right' }, true)).toEqual({ ok: true, tabId: rightSettings.tabId, existing: true, selected: true });
    const rightPage = page.locator('.right-dock-host .settings-page');
    await expect(rightPage).toBeVisible();
    await expect(rightPage.getByRole('combobox', { name: '搜索设置' })).toBeFocused();
    await page.screenshot({ path: info.outputPath('panel-right-settings-open.png'), animations: 'disabled' });
    const rightCheckbox = rightPage.getByRole('checkbox', { name: '任务运行时阻止休眠' });
    await rightCheckbox.evaluate(element => element.setAttribute('data-right-settings-probe', 'same-node'));
    await rightCheckbox.click();
    await expect.poll(async () => { const value = await query(workspaceId); return value.ok && value.snapshot.settings?.dirty; }).toBe(true);
    expect(await closeContent(rightSettings.tabId, JSON.stringify(rightSettingsContent))).toMatchObject({ ok: false, error: expect.stringMatching(/unsaved/) });
    expect(await openContent({ kind: 'settings', placement: 'center' }, true)).toMatchObject({ ok: false, error: expect.stringMatching(/unsaved/) });
    expect(await focusAxis('terminal')).toMatchObject({ ok: false, error: expect.stringMatching(/unsaved/) });
    await expect(rightPage.locator('[data-right-settings-probe="same-node"]')).not.toBeChecked();
    await rightCheckbox.click();
    await expect.poll(async () => { const value = await query(workspaceId); return value.ok && value.snapshot.settings?.dirty; }).toBe(false);
    expect(await openContent({ kind: 'settings', placement: 'center' }, true)).toMatchObject({ ok: true, tabId: 'settings', selected: true });
    await expect(page.locator('.right-dock-host [data-right-settings-probe="same-node"]')).toHaveCount(0);
    await expect(page.locator('[data-right-settings-probe="same-node"]')).toHaveCount(1);
    const reopenedRightSettings = await openContent({ kind: 'settings', placement: 'right' }, true);
    expect(reopenedRightSettings).toMatchObject({ ok: true, selected: true });
    if (!reopenedRightSettings.ok) throw new Error(reopenedRightSettings.error);
    await expect(rightPage.locator('[data-right-settings-probe="same-node"]')).toHaveCount(1);
    const reopenedSnapshot = await query(workspaceId);
    if (!reopenedSnapshot.ok) throw new Error(reopenedSnapshot.error);
    const reopenedContent = reopenedSnapshot.snapshot.right.tabs.find(tab => tab.id === reopenedRightSettings.tabId)!.content;
    expect(await closeContent(reopenedRightSettings.tabId, JSON.stringify(reopenedContent))).toEqual({ ok: true, tabId: reopenedRightSettings.tabId, closed: true });
    const userCloseSettings = await openContent({ kind: 'settings', placement: 'right' }, true);
    expect(userCloseSettings).toMatchObject({ ok: true, selected: true });
    await rightPage.getByRole('button', { name: /返回工作台/ }).click();
    await expect.poll(async () => { const value = await query(workspaceId); return value.ok && value.snapshot.right.tabs.some(tab => tab.content.kind === 'utility' && tab.content.sel === 'settings'); }).toBe(false);
    expect(await closeContent('settings', JSON.stringify({ kind: 'settings' }))).toEqual({ ok: true, tabId: 'settings', closed: true });
    expect((await page.evaluate(() => window.api.sessions.list())).sessions.filter(item => workers.includes(item.id))).toHaveLength(2);
    if (process.env.PANEL_E2E_NARROW === '1') {
      await browserWindow.evaluate(window => { window.setMinimumSize(0, 0); window.setContentSize(760, 800); });
      await expect.poll(() => page.evaluate(() => window.matchMedia('(max-width: 820px)').matches)).toBe(true);
      const drawer = await openContent({ kind: 'utility', sel: 'usage', title: 'untrusted' }, true);
      expect(drawer).toMatchObject({ ok: true, selected: true });
      if (!drawer.ok) throw new Error(drawer.error);
      await expect(page.locator('.git-page')).toHaveClass(/is-drawer-open/);
      const narrowReview = await openContent(reviewContent);
      expect(narrowReview).toMatchObject({ ok: true, selected: false });
      if (!narrowReview.ok) throw new Error(narrowReview.error);
      expect(await openContent(nextReview)).toEqual({ ok: true, tabId: narrowReview.tabId, existing: true, selected: false });
      const narrowReviewSnapshot = await query(workspaceId);
      if (!narrowReviewSnapshot.ok) throw new Error(narrowReviewSnapshot.error);
      expect(narrowReviewSnapshot.snapshot.right.selectedTabId).toBe(drawer.tabId);
      expect(narrowReviewSnapshot.snapshot.right.tabs.find(tab => tab.id === narrowReview.tabId)?.content).toEqual(nextReview);
      await page.screenshot({ path: info.outputPath('panel-review-narrow.png') });
      expect(await closeContent(narrowReview.tabId, JSON.stringify(nextReview))).toEqual({ ok: true, tabId: narrowReview.tabId, closed: true });
      await page.screenshot({ path: info.outputPath('panel-right-drawer-focused.png') });
      expect(await focusAxis('terminal')).toEqual({ ok: true, page: 'terminal' });
      await expect(page.locator('.git-page')).not.toHaveClass(/is-drawer-open/);
      expect(await focusAxis('git')).toEqual({ ok: true, page: 'git' });
      await expect(page.locator('.git-page')).toHaveClass(/is-drawer-open/);
      const drawerSnapshot = await query(workspaceId);
      if (!drawerSnapshot.ok) throw new Error(drawerSnapshot.error);
      const drawerContent = drawerSnapshot.snapshot.right.tabs.find(tab => tab.id === drawer.tabId)!.content;
      expect(await closeContent(drawer.tabId, JSON.stringify(drawerContent))).toMatchObject({ ok: true });
      const narrowSettings = await openContent({ kind: 'settings', placement: 'right' }, true);
      expect(narrowSettings).toMatchObject({ ok: true, selected: true });
      if (!narrowSettings.ok) throw new Error(narrowSettings.error);
      await expect(page.locator('.right-dock-host .settings-page')).toBeVisible();
      await page.screenshot({ path: info.outputPath('panel-right-settings-narrow.png'), animations: 'disabled' });
      const narrowSettingsSnapshot = await query(workspaceId);
      if (!narrowSettingsSnapshot.ok) throw new Error(narrowSettingsSnapshot.error);
      const narrowSettingsContent = narrowSettingsSnapshot.snapshot.right.tabs.find(tab => tab.id === narrowSettings.tabId)!.content;
      expect(await closeContent(narrowSettings.tabId, JSON.stringify(narrowSettingsContent))).toEqual({ ok: true, tabId: narrowSettings.tabId, closed: true });
      expect(await closeContent('settings', JSON.stringify({ kind: 'settings' }))).toEqual({ ok: true, tabId: 'settings', closed: true });
    }
    const beforeRestart = await openContent({ kind: 'settings', placement: 'right' }, true);
    if (!beforeRestart.ok) throw new Error(beforeRestart.error);
    await expect.poll(async () => page.evaluate(async id => {
      const value = await window.api.workspaceFile.get();
      return value.config.rightWorkspace?.tabs.some(tab => tab.id === id && tab.content.kind === 'utility' && tab.content.sel === 'settings') ?? false;
    }, beforeRestart.tabId)).toBe(true);
    await stopApp(app);
    app = await _electron.launch({ executablePath: nodeRequire('electron') as unknown as string,
      args: [repoRoot, '--disable-gpu', '--in-process-gpu'], cwd, env, timeout: 30_000 });
    const restoredPage = await app.firstWindow();
    await restoredPage.locator('.app-shell').waitFor({ timeout: 30_000 });
    await expect(restoredPage.locator('.right-dock-host .settings-page')).toHaveCount(1, { timeout: 20_000 });
    const restoredSettings = await openContent({ kind: 'settings', placement: 'right' }, true);
    expect(restoredSettings).toMatchObject({ ok: true, existing: true, selected: true });
    if (!restoredSettings.ok) throw new Error(restoredSettings.error);
    const restoredSnapshot = await query(workspaceId);
    if (!restoredSnapshot.ok) throw new Error(restoredSnapshot.error);
    expect(restoredSnapshot.snapshot.right.tabs.filter(tab => tab.content.kind === 'utility' && tab.content.sel === 'settings')).toHaveLength(1);
    expect(restoredSnapshot.snapshot.right.selectedTabId).toBe(restoredSettings.tabId);
    await expect(restoredPage.locator('.right-dock-host .settings-page')).toBeVisible();
    const closeFileRef = await restoredPage.evaluate(id => window.api.fs.resolveRef(id, 'center-close-workspace.txt'), workspaceId);
    if (!closeFileRef.ok) throw new Error(closeFileRef.error);
    const reopenedCenterFile = await openContent({ kind: 'file', path: closeFileRef.fileRef.relativePath, fileRef: closeFileRef.fileRef, placement: 'center' }, true);
    expect(reopenedCenterFile, JSON.stringify(reopenedCenterFile)).toMatchObject({ ok: true, selected: true });
    const closingEditor = restoredPage.locator('.center-file-dock .right-content-page.is-shown .file-editor');
    await expect(closingEditor).toBeVisible();
    await closingEditor.evaluate(element => element.setAttribute('data-closed-workspace-probe', 'retained'));
    await app.evaluate(({ ipcMain }) => {
      const ipc = ipcMain as any;
      const original = ipc._invokeHandlers.get('fs:writeText');
      if (!original) throw new Error('File write handler unavailable');
      (globalThis as any).__workspaceCloseOriginalWrite = original;
      ipc.removeHandler('fs:writeText');
      ipc.handle('fs:writeText', (event: unknown, ref: { relativePath?: string }, ...args: unknown[]) =>
        ref?.relativePath === 'center-close-workspace.txt' ? new Promise(resolve => setTimeout(() => resolve({ ok: false, error: 'injected save failure' }), 600)) : original(event, ref, ...args));
    });
    await closingEditor.getByRole('tab', { name: '编辑', exact: true }).click();
    await closingEditor.locator('.cm-content').click();
    await restoredPage.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
    await restoredPage.keyboard.type(' unsaved draft');
    await expect.poll(async () => { const value = await query(workspaceId); return value.ok && value.snapshot.right.editors.some(editor => editor.path === 'center-close-workspace.txt' && editor.unsaved); }).toBe(true);
    const closing = restoredPage.evaluate(id => window.api.workspaces.close(id), workspaceId);
    await expect(restoredPage.locator('.app-shell')).toHaveAttribute('inert', '');
    expect(await restoredPage.evaluate(id => window.api.workspaces.update(id, { name: 'Must not change' }), workspaceId)).toMatchObject({ ok: false, message: expect.stringMatching(/pending/i) });
    const rejectedClose = await closing;
    expect(rejectedClose).toMatchObject({ ok: false, message: expect.stringMatching(/save|保存/i) });
    expect((await restoredPage.evaluate(() => window.api.workspaces.list())).workspaces.some(item => item.id === workspaceId)).toBe(true);
    await expect(closingEditor.locator('.cm-content')).toContainText('unsaved draft');
    await expect(restoredPage.locator('.app-shell')).not.toHaveAttribute('inert', '');
    await app.evaluate(({ ipcMain }) => {
      const ipc = ipcMain as any, original = (globalThis as any).__workspaceCloseOriginalWrite;
      ipc.removeHandler('fs:writeText');
      ipc.handle('fs:writeText', (event: unknown, ref: { relativePath?: string }, ...args: unknown[]) =>
        ref?.relativePath === 'center-close-workspace.txt' ? new Promise(resolve => { (globalThis as any).__workspaceCloseLateWrite = resolve; }) : original(event, ref, ...args));
    });
    const stalled = restoredPage.evaluate(id => window.api.workspaces.close(id), workspaceId);
    await expect(restoredPage.locator('.app-shell')).toHaveAttribute('inert', '');
    await expect.poll(() => app!.evaluate(() => typeof (globalThis as any).__workspaceCloseLateWrite === 'function')).toBe(true);
    expect(await stalled).toMatchObject({ ok: false, message: expect.stringMatching(/timed out/i) });
    await expect(restoredPage.locator('.app-shell')).not.toHaveAttribute('inert', '');
    await expect(closingEditor.locator('.cm-content')).toContainText('unsaved draft');
    await app.evaluate(() => { (globalThis as any).__workspaceCloseLateWrite({ ok: false, error: 'late save failure' }); delete (globalThis as any).__workspaceCloseLateWrite; });
    expect((await query(workspaceId)).ok).toBe(true);
    await app.evaluate(({ ipcMain }) => {
      const ipc = ipcMain as any, original = (globalThis as any).__workspaceCloseOriginalWrite;
      ipc.removeHandler('fs:writeText'); ipc.handle('fs:writeText', original);
      delete (globalThis as any).__workspaceCloseOriginalWrite;
    });
    const rendererErrors: string[] = [];
    restoredPage.on('pageerror', error => rendererErrors.push(error.message));
    expect(await restoredPage.evaluate(id => window.api.workspaces.close(id), workspaceId)).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(workspace, 'center-close-workspace.txt'), 'utf8')).toContain('unsaved draft');
    await expect.poll(async () => (await restoredPage.evaluate(() => window.api.workspaces.list())).workspaces.some(item => item.id === workspaceId)).toBe(false);
    await expect.poll(async () => (await query(alternateWorkspace.id)).ok).toBe(true);
    await expect(restoredPage.locator('.app-shell')).toBeVisible();
    await expect(restoredPage.locator('[data-closed-workspace-probe="retained"]')).toHaveCount(0);
    const afterWorkspaceClose = await query(alternateWorkspace.id);
    if (!afterWorkspaceClose.ok) throw new Error(afterWorkspaceClose.error);
    expect(JSON.stringify(afterWorkspaceClose.snapshot)).not.toContain('center-close-workspace.txt');
    expect(rendererErrors).toEqual([]);
  } finally {
    if (app) await stopApp(app);
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
