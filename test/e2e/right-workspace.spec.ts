import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import http from 'node:http';

test('统一右侧：真实编辑、Git Diff、网页保活、标签归属和固定', async ({}, info) => {
  test.setTimeout(100_000);
  const project = path.resolve(__dirname, '../..'), cwd = info.outputDir, root = path.join(cwd, 'workspace');
  const userData = path.join(cwd, '.dev-sandbox/userData');
  fs.mkdirSync(userData, { recursive: true }); fs.mkdirSync(root, { recursive: true });
  const a = 'export const phase = "ready";\nexport const tabs = ["files", "git", "browser"];\n\nexport function review() {\n  return tabs.map(tab => ({ tab, ready: true }));\n}\n';
  fs.writeFileSync(path.join(root, 'review.ts'), a); fs.writeFileSync(path.join(root, 'design.md'), '# Prototype\n\nA flat editing surface and a compact resource capsule.\n');
  fs.writeFileSync(path.join(root, 'flow-a.txt'), 'First preview');
  fs.writeFileSync(path.join(root, 'flow-b.txt'), 'Second preview');
  fs.writeFileSync(path.join(root, 'prototype.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="#242629"/><rect x="24" y="24" width="432" height="28" rx="8" fill="#3b3e43"/><text x="30" y="105" fill="white" font-size="28">Unified workspace</text><path d="M340 60v160" stroke="#63676d"/></svg>');
  fs.writeFileSync(path.join(root, 'prototype.html'), '<!doctype html><title>交互原型</title><body style="background:#15171a;color:#ddd;font:16px system-ui;padding:40px"><h1>交互原型</h1><a id="details" href="?history=detail">Details</a><input id="draft" placeholder="输入并切走，草稿仍在"><div style="height:1800px"></div></body>');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=NUL', ...args], { cwd: root, stdio: 'pipe' });
  git('init'); git('add', '.'); git('-c', 'user.name=UI test', '-c', 'user.email=ui@test.local', 'commit', '-m', 'fixture');
  fs.appendFileSync(path.join(root, 'review.ts'), '\n// New unified tabs\n');
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', themeId: 'dark', activeWorkspaceId: 'right-tabs', workspaces: [{ id: 'right-tabs', name: 'Tabs workspace', path: root, accentOff: true }], webAccess: { enabled: false }, mcp: { enabled: false, servers: [] } }));
  fs.writeFileSync(path.join(userData, 'sessions.json'), '[]');
  const env = { ...process.env, MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `right-tabs-${process.pid}` } as Record<string, string>;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fs.readFileSync(path.join(root, 'prototype.html'))); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const prototypeUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/prototype`;
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu'], cwd, env, timeout: 45_000 }).catch(error => { server.close(); throw error; });
  const ownedProcess = app.process(), ownedPid = ownedProcess.pid;
  const errors: string[] = [];
  let sessions: string[] = [];
  const snapshots = path.join(project, 'output/right-workspace'); fs.mkdirSync(snapshots, { recursive: true });
  try {
    const win = await app.firstWindow(); win.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 920));
    await win.locator('.app-shell').waitFor({ timeout: 40_000 });
    // Empty GUI sessions test scope only; force bypasses model preflight without sending a model request.
    sessions = await win.evaluate(async root => {
      const request = { runtime: 'pi', force: true, cwd: root, workspaceId: 'right-tabs' };
      const one = await window.api.sessions.create({ ...request, name: '代码审核' });
      const two = await window.api.sessions.create({ ...request, name: '界面开发' }); return [one.id, two.id];
    }, root);
    await win.evaluate(async id => window.api.sessions.select(id), sessions[0]);
    await win.keyboard.press('Escape'); await win.getByRole('button', { name: '展开右侧栏', exact: true }).click();
    const pane = win.locator('.right-workspace'); await expect(pane).toBeVisible();
    const snapshot = async (name: string) => {
      await expect(pane.locator('.right-content-page.is-shown')).toHaveCSS('opacity', '1');
      await win.mouse.move(1, 1);
      const rect = (await pane.boundingBox())!;
      const pixels = await app.evaluate(async ({ BrowserWindow }, rect) => (await BrowserWindow.getAllWindows()[0].capturePage({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) })).toPNG().toString('base64'), rect);
      fs.writeFileSync(path.join(snapshots, name), Buffer.from(pixels, 'base64'));
    };
    const verifyToolbarLevels = async () => {
      const levels = await pane.evaluate(element => {
        const bounds = (selector: string) => { const b = element.querySelector(selector)!.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width }; };
        return { top: bounds('.right-tabs-row'), tools: bounds('.right-current-row'), resources: bounds('.right-resources'), content: bounds('.right-workspace-main'), historyInTop: !!element.querySelector('.right-tabs-row .right-history'), historyInTools: !!element.querySelector('.right-current-row .right-history') };
      });
      expect(levels.historyInTop).toBe(true); expect(levels.historyInTools).toBe(false);
      expect(Math.abs(levels.tools.y - levels.top.bottom)).toBeLessThan(2);
      expect(Math.abs(levels.resources.y - levels.top.bottom)).toBeLessThan(2);
      expect(Math.abs(levels.tools.width - levels.content.width)).toBeLessThan(2);
      expect(levels.tools.right).toBeLessThanOrEqual(levels.resources.x);
    };
    const capsule = pane.getByRole('tablist', { name: '资源面板' });
    await capsule.getByRole('tab', { name: '文件', exact: true }).click();
    const row = (name: string) => pane.locator(`.right-resource-page.is-shown .file-tree-row[title="${name}"]`);
    await row('review.ts').click(); await expect(pane.locator('.right-tab.is-preview')).toHaveCount(1);
    await row('design.md').click(); await expect(pane.locator('.right-tab.is-preview')).toHaveCount(1);
    await row('review.ts').dblclick(); await expect(pane.locator('.right-tab.is-preview')).toHaveCount(0);
    await pane.getByRole('button', { name: '编辑', exact: true }).click();
    const code = pane.locator('.right-content-page.is-shown .cm-content');
    await code.click(); await win.keyboard.press('Control+End'); await win.keyboard.type('\n// Review draft');
    await expect.poll(() => fs.readFileSync(path.join(root, 'review.ts'), 'utf8')).toContain('Review draft');
    const flat = await pane.locator('.right-content-page.is-shown .file-editor-main').evaluate(element => { const style = getComputedStyle(element); return { radius: style.borderRadius, shadow: style.boxShadow, margin: style.margin }; });
    expect(flat).toEqual({ radius: '0px', shadow: 'none', margin: '0px' });
    await verifyToolbarLevels();
    await snapshot('dark-file.png');
    await expect(pane.getByRole('button', { name: '固定标签页', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await row('design.md').dblclick();
    await win.evaluate(async id => window.api.sessions.select(id), sessions[1]); await expect(pane.locator('.right-tab').filter({ hasText: 'design.md' })).toHaveCount(1); await expect(pane.locator('.right-tab').filter({ hasText: 'review.ts' })).toHaveCount(1);
    await win.evaluate(async id => window.api.sessions.select(id), sessions[0]); await expect(pane.locator('.right-tab').filter({ hasText: 'design.md' })).toHaveCount(1);
    // Selecting a session intentionally reveals the terminal page; retained right tabs can be offscreen.
    await expect(win.locator('.main-view')).toHaveClass(/\bh-terminal\b/);
    await win.keyboard.press('Escape');
    const keySink = win.locator('.app-key-sink');
    await keySink.focus();
    await expect(keySink).toBeFocused();
    // Shifted Playwright Backslash becomes '|'; preserve the existing chord's literal key via native input.
    const navigationInput = await win.context().newCDPSession(win);
    try {
      for (const type of ['keyDown', 'keyUp'] as const) await navigationInput.send('Input.dispatchKeyEvent', {
        type, key: '\\', code: 'Backslash', modifiers: 10,
        windowsVirtualKeyCode: 220, nativeVirtualKeyCode: 220
      });
    } finally { await navigationInput.detach().catch(() => {}); }
    await expect(win.locator('.main-view')).toHaveClass(/\bh-git\b/);
    const reviewTab = pane.locator('.right-tab').filter({ hasText: 'review.ts' });
    const designTab = pane.locator('.right-tab').filter({ hasText: 'design.md' });
    await reviewTab.click({ button: 'right' });
    await win.getByText('关闭其他标签页', { exact: true }).click();
    await expect(designTab).toHaveCount(0);
    await row('design.md').dblclick();
    await expect(designTab).toHaveCount(1);
    const gitTab = capsule.getByRole('tab', { name: 'Git', exact: true });
    await expect(gitTab).toBeInViewport();
    await gitTab.click();
    const repository = pane.locator('.right-resource-page.is-shown .git-repo-tree-leaf').first(); await repository.click();
    await expect(pane.locator('.right-content-page.is-shown .git-detail')).toBeVisible();
    await pane.locator('.right-content-page.is-shown .git-changes-scroll').getByText('review.ts', { exact: true }).click();
    await expect(pane.locator('.right-content-page.is-shown .git-diff-view')).toBeVisible();
    expect(await pane.locator('.right-content-page.is-shown .git-diff-scroll').evaluate(element => getComputedStyle(element).borderRadius)).toBe('0px');
    await snapshot('dark-git.png');
    const resourceSplit = pane.getByRole('separator', { name: '调整资源面板宽度' });
    await resourceSplit.focus(); await win.keyboard.press('End');
    await verifyToolbarLevels();
    expect(await pane.locator('.right-current-row').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await snapshot('narrow-git.png');
    await resourceSplit.focus(); for (let i = 0; i < 33; i++) await win.keyboard.press('ArrowRight');
    await pane.getByRole('button', { name: '在新标签中打开 Diff' }).click(); await expect(pane.locator('.right-independent-diff')).toBeVisible();
    await expect(pane.locator('.right-content-page.is-shown .git-diff-view')).toContainText('Review draft');
    const diffTitle = await pane.locator('.right-tab[aria-selected="true"] .right-tab-title').textContent(); expect(diffTitle).toBe('review.ts');
    await snapshot('dark-diff.png');
    await pane.getByRole('button', { name: '撤销', exact: true }).click(); await expect(pane.locator('.right-content-page.is-shown .git-diff-view')).toBeVisible();
    await test.step('同一对撤销重做回放文件预览、开页、原生导航和关页', async () => {
      const undo = pane.getByRole('button', { name: '撤销', exact: true });
      const redo = pane.getByRole('button', { name: '重做', exact: true });
      await expect(pane.locator('.right-history button')).toHaveCount(2);
      await capsule.getByRole('tab', { name: '文件', exact: true }).click();
      const selected = pane.locator('.right-tab[aria-selected="true"]');
      await row('flow-a.txt').click();
      await expect(selected).toHaveText('flow-a.txt');
      await selected.evaluate(element => element.setAttribute('data-test-preview', 'original'));
      await row('flow-b.txt').click();
      await expect(selected).toHaveAttribute('data-test-preview', 'original');
      await expect(selected).toHaveText('flow-b.txt');
      const previews = pane.locator('.right-tab.is-preview');
      const homeUrl = `${prototypeUrl}?history=home`, detailUrl = `${prototypeUrl}?history=detail`;
      const browserTabs = () => win.evaluate(url => window.api.browser.restore().then(state => state.tabs.filter(tab => tab.url.startsWith(url))), `${prototypeUrl}?history=`);
      const guest = (id: string) => pane.locator(`webview[data-tab-id="${id}"]`);
      const guestIdFor = async (id: string) => {
        await expect(guest(id)).toHaveAttribute('data-browser-presentation', 'foreground');
        const idOfGuest = () => guest(id).evaluate(element => (element as Electron.WebviewTag).getWebContentsId());
        await expect.poll(async () => { try { return await idOfGuest(); } catch { return 0; } }).toBeGreaterThan(0);
        return idOfGuest();
      };
      const native = (guestId: number) => app.evaluate(({ webContents }, id) => {
        const contents = webContents.fromId(id);
        if (!contents) return null;
        const history = contents.navigationHistory;
        return { index: history.getActiveIndex(), urls: history.getAllEntries().map(entry => entry.url), url: contents.getURL() };
      }, guestId);
      const opened = await win.evaluate(url => window.api.browser.open({ url, workspaceId: 'right-tabs', scope: 'workspace' }), homeUrl);
      const originalGuest = await guestIdFor(opened.id);
      await expect.poll(() => native(originalGuest)).toMatchObject({ url: homeUrl });
      const home = (await native(originalGuest))!;
      const detail = { index: home.index + 1, urls: [...home.urls.slice(0, home.index + 1), detailUrl], url: detailUrl };
      await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('!!document.querySelector("#details")'), originalGuest)).toBe(true);
      await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('document.querySelector("#details").click(); void 0'), originalGuest);
      await expect.poll(() => native(originalGuest)).toEqual(detail);
      await expect(selected).toHaveAttribute('title', detailUrl);
      await selected.locator('.right-tab-close').click();
      await expect.poll(browserTabs).toHaveLength(0);
      await expect(guest(opened.id)).toHaveCount(0);
      await expect(selected).toHaveText('flow-b.txt');

      await undo.click();
      await expect.poll(browserTabs).toHaveLength(1);
      const [restored] = await browserTabs();
      expect(restored.id).not.toBe(opened.id);
      const restoredGuest = await guestIdFor(restored.id);
      await expect.poll(() => native(restoredGuest)).toEqual(detail);
      await undo.click();
      await expect(selected).toHaveAttribute('title', homeUrl);
      await expect.poll(() => native(restoredGuest)).toEqual({ ...detail, index: home.index, url: homeUrl });
      await redo.click();
      await expect(selected).toHaveAttribute('title', detailUrl);
      await expect.poll(() => native(restoredGuest)).toEqual(detail);
      await snapshot('browser-reopened.png');
      await undo.click();
      await expect(selected).toHaveAttribute('title', homeUrl);
      await undo.click();
      await expect.poll(browserTabs).toHaveLength(0);
      await expect(selected).toHaveText('flow-b.txt');
      await undo.click();
      await expect(selected).toHaveText('flow-a.txt');
      await expect(previews).toHaveCount(1);
      await expect(selected).toHaveAttribute('data-test-preview', 'original');
      await redo.click();
      await expect(selected).toHaveText('flow-b.txt');
      await expect(previews).toHaveCount(1);
      await redo.click();
      await expect(selected).toHaveAttribute('title', homeUrl);
      await expect.poll(browserTabs).toHaveLength(1);
      await redo.click();
      await expect(selected).toHaveAttribute('title', detailUrl);
      await expect.poll(browserTabs).toHaveLength(1);
      await redo.click();
      await expect.poll(browserTabs).toHaveLength(0);
      await expect(selected).toHaveText('flow-b.txt');
      await expect(redo).toBeDisabled();
    });
    const url = prototypeUrl;
    const opened = await win.evaluate(async ({ url, sessionId }) => window.api.browser.open({ url, workspaceId: 'right-tabs', sessionId }), { url, sessionId: sessions[0] });
    const webview = pane.locator(`webview[data-tab-id="${opened.id}"]`); await expect(webview).toBeVisible();
    await expect(pane.locator('.right-tab[aria-selected="true"] .right-tab-session')).toBeVisible();
    const guestId = await webview.evaluate(element => (element as Electron.WebviewTag).getWebContentsId());
    await expect.poll(() => app.evaluate(async ({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('document.title'), guestId)).toBe('交互原型');
    await test.step('网页自己的后退与同网址 pushState 使用原生位置', async () => {
      const undo = pane.getByRole('button', { name: '撤销', exact: true });
      const redo = pane.getByRole('button', { name: '重做', exact: true });
      const checkpoint = () => win.evaluate(id => window.api.browser.restore().then(result => result.tabs.find(tab => tab.id === id)?.panelHistoryKey), opened.id);
      const undoSteps = async () => Number((await undo.getAttribute('title'))?.match(/(\d+) 步/)?.[1] ?? 0);
      const position = () => app.evaluate(async ({ webContents }, id) => {
        const guest = webContents.fromId(id);
        if (!guest) return null;
        return { index: guest.navigationHistory.getActiveIndex(), state: await guest.executeJavaScript('history.state'), url: guest.getURL() };
      }, guestId);
      await expect.poll(checkpoint).toBeTruthy();
      const initial = (await position())!, before = await checkpoint();
      const steps = await undoSteps();
      await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('history.pushState({ detail: true }, "", location.href); void 0'), guestId);
      const detail = { ...initial, index: initial.index + 1, state: { detail: true } };
      await expect.poll(position).toEqual(detail);
      await expect.poll(checkpoint).not.toBe(before);
      await expect.poll(undoSteps).toBe(steps + 1);
      await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('history.back(); void 0'), guestId);
      await expect.poll(position).toEqual(initial);
      await expect.poll(undoSteps).toBe(steps + 2);
      await undo.click();
      await expect.poll(position).toEqual(detail);
      await redo.click();
      await expect.poll(position).toEqual(initial);
      await expect(pane.locator('.right-tab[aria-selected="true"]')).toHaveAttribute('title', url);
      expect(await webview.evaluate(element => (element as Electron.WebviewTag).getWebContentsId())).toBe(guestId);
    });
    await webview.evaluate(async element => {
      const view = element as Electron.WebviewTag; view.focus();
      await view.executeJavaScript('document.getElementById("draft").focus();window.scrollTo(0,0);0');
    });
    await win.keyboard.type('keep guest state');
    await expect.poll(() => app.evaluate(async ({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('document.getElementById("draft").value'), guestId)).toBe('keep guest state');
    await pane.getByRole('button', { name: '收藏当前网页' }).click();
    await expect(pane.locator('.right-bookmark-row').and(pane.getByTitle(prototypeUrl, { exact: true }))).toHaveCount(1);
    await expect.poll(() => pane.locator('.right-content-page.is-shown').evaluate(element => getComputedStyle(element).opacity)).toBe('1');
    await app.evaluate(async ({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'), guestId);
    await snapshot('dark-browser.png');
    await app.evaluate(async ({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('window.scrollTo(0,500)'), guestId);
    await reviewTab.click(); await expect(webview).toBeHidden();
    await pane.locator('.right-tab').and(pane.getByTitle(url, { exact: true })).click(); await expect(webview).toBeVisible();
    expect(await webview.evaluate(element => (element as Electron.WebviewTag).getWebContentsId())).toBe(guestId);
    expect(await app.evaluate(async ({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('window.scrollY'), guestId)).toBe(500);
    expect(await app.evaluate(async ({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('document.getElementById("draft").value'), guestId)).toBe('keep guest state');
    await pane.getByRole('button', { name: '收起资源面板' }).click(); await capsule.getByRole('tab', { name: '文件', exact: true }).click();
    await row('prototype.svg').click(); await expect(pane.locator('.right-content-page.is-shown img.file-media-img')).toBeVisible();
    await pane.locator('.right-tab').filter({ hasText: 'review.ts' }).filter({ has: win.locator('svg') }).first().click();
    await expect(code).toContainText('Review draft');
    await win.evaluate(async () => window.api.themes.activate('light'));
    await expect.poll(() => win.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light');
    await snapshot('light-file.png');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760));
    await verifyToolbarLevels();
    await snapshot('narrow-file.png');
    expect(await pane.locator('.right-workspace-toolbar').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    // The browser tab came from the session, while sidebar files are workspace-scoped.
    await win.evaluate(async id => window.api.sessions.setArchived(id, true), sessions[0]);
    await expect(webview).toHaveCount(0);
    await expect.poll(() => app.evaluate(({ webContents }, id) => {
      const guest = webContents.fromId(id);
      return !guest || guest.isDestroyed();
    }, guestId)).toBe(true);
    expect((await win.evaluate(() => window.api.browser.restore())).tabs.some(tab => tab.id === opened.id)).toBe(false);
    await expect(pane.locator('.right-tab').filter({ hasText: 'design.md' })).toHaveCount(1);
    await win.evaluate(async id => window.api.sessions.setArchived(id, false), sessions[0]);
    await win.evaluate(async id => window.api.sessions.select(id), sessions[0]);
    const restoredTab = pane.locator('.right-tab').filter({ hasText: '交互原型' });
    await expect(restoredTab).toHaveCount(1);
    await expect(pane.locator('webview')).toHaveCount(0);
    await win.keyboard.press('Escape');
    await keySink.focus();
    const reopenInput = await win.context().newCDPSession(win);
    try {
      for (const type of ['keyDown', 'keyUp'] as const) await reopenInput.send('Input.dispatchKeyEvent', {
        type, key: '\\', code: 'Backslash', modifiers: 10,
        windowsVirtualKeyCode: 220, nativeVirtualKeyCode: 220
      });
    } finally { await reopenInput.detach().catch(() => {}); }
    await restoredTab.click();
    const restoredWebview = pane.locator('webview');
    await expect(restoredWebview).toBeVisible();
    const restoredGuestId = await restoredWebview.evaluate(element => (element as Electron.WebviewTag).getWebContentsId());
    expect(restoredGuestId).not.toBe(guestId);
    await expect.poll(() => app.evaluate(async ({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('document.title'), restoredGuestId)).toBe('交互原型');
    const restoredBrowserId = await restoredWebview.getAttribute('data-tab-id');
    const sessionChildUrl = `${prototypeUrl}?source=session`, workspaceChildUrl = `${prototypeUrl}?source=workspace`;
    const openFromGuest = async (id: number, url: string) => app.evaluate(async ({ webContents }, args) => {
      await webContents.fromId(args.id)!.executeJavaScript(`window.open(${JSON.stringify(args.url)}, '_blank'); true`);
    }, { id, url });
    await pane.getByRole('button', { name: '固定标签页', exact: true }).click();
    await expect(restoredTab.locator('.right-tab-session')).toBeVisible();
    expect((await win.evaluate(() => window.api.browser.restore())).tabs.find(tab => tab.id === restoredBrowserId)?.scope).toBe('session');
    await openFromGuest(restoredGuestId, sessionChildUrl);
    await expect.poll(async () => (await win.evaluate(() => window.api.browser.restore())).tabs.find(tab => tab.url === sessionChildUrl)?.scope).toBe('session');
    await capsule.getByRole('tab', { name: '浏览器', exact: true }).click();
    await pane.locator('.right-bookmark-row').and(pane.getByTitle(prototypeUrl, { exact: true })).click();
    const workspacePage = () => win.evaluate(async url => (await window.api.browser.restore()).tabs.find(tab => tab.url === url && tab.scope === 'workspace'), prototypeUrl);
    await expect.poll(workspacePage).toBeDefined();
    const workspaceBrowserId = (await workspacePage())!.id;
    const workspaceView = pane.locator(`webview[data-tab-id="${workspaceBrowserId}"]`);
    await expect(workspaceView).toBeVisible();
    await expect(pane.getByRole('button', { name: '固定标签页', exact: true })).toHaveAttribute('aria-pressed', 'false');
    const workspaceGuestId = await workspaceView.evaluate(element => (element as Electron.WebviewTag).getWebContentsId());
    await expect.poll(() => app.evaluate(async ({ webContents }, id) => webContents.fromId(id)?.executeJavaScript('document.title'), workspaceGuestId)).toBe('交互原型');
    await openFromGuest(workspaceGuestId, workspaceChildUrl);
    await expect.poll(async () => (await win.evaluate(() => window.api.browser.restore())).tabs.find(tab => tab.url === workspaceChildUrl)?.scope).toBe('workspace');
    await win.evaluate(async id => window.api.sessions.select(id), sessions[1]);
    await expect(pane.locator('.right-tab').and(pane.getByTitle(workspaceChildUrl, { exact: true }))).toHaveCount(1);
    await expect(pane.locator('.right-tab').and(pane.getByTitle(sessionChildUrl, { exact: true }))).toHaveCount(0);
    await expect(pane.locator('.right-tab .right-tab-session')).toHaveCount(0);
    // Electron 43 reports this exact error when a destroyed webview element disconnects.
    expect(errors.filter(error => !/^(?:Uncaught )?(?:Error: )?Invalid guestInstanceId: \d+$/.test(error))).toEqual([]);
    await win.evaluate(async () => { for (const tab of (await window.api.browser.restore()).tabs) await window.api.browser.close({ id: tab.id }); });
    await expect(pane.locator('webview')).toHaveCount(0);
  } catch (error) {
    const win = await app.firstWindow(); await win.screenshot({ path: path.join(snapshots, 'failure.png') }).catch(() => {}); throw error;
  } finally {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const win = await app.firstWindow().catch(() => null);
      if (win) for (const id of sessions) {
        await win.evaluate(async sessionId => {
          await window.api.sessions.setArchived(sessionId, true);
          await window.api.sessions.close(sessionId);
        }, id).catch(() => {});
      }
      const result = await Promise.race([
        app.close().then(() => 'closed', error => `error: ${String(error)}`),
        new Promise<string>(resolve => { closeTimer = setTimeout(() => resolve('timeout'), 8000); })
      ]);
      if (result !== 'closed') console.warn(`Electron fixture shutdown: ${result}`);
    } finally {
      clearTimeout(closeTimer);
      if (ownedProcess.exitCode === null && ownedProcess.signalCode === null && ownedPid) {
        try { execFileSync('taskkill', ['/PID', String(ownedPid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
      }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});
