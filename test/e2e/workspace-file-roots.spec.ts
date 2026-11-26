import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildWorkspaceFileUrl, buildWorkspaceMediaUrl } from '../../src/shared/mediaKinds';
import type { WorkspaceFileRef } from '../../src/shared/types';

// Dedicated cwd/userData and ephemeral localhost port preserve any running developer app.
test('多根文件身份贯穿真实 IPC、媒体协议与 Web 转发', async ({ request, page }) => {
  test.setTimeout(90_000);
  const project = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'file-roots-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox/userData');
  const initial = path.join(fixture, '.dev-sandbox/workspaces/demo-frontend');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: initial,
    activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'Test', path: initial }],
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] } }));
  const a = path.join(fixture, 'a');
  const b = path.join(fixture, 'b');
  const nested = path.join(a, 'nested');
  for (const root of [a, b, nested]) fs.mkdirSync(root, { recursive: true });
  const relativePath = '同名 # 文本.txt';
  fs.writeFileSync(path.join(a, relativePath), 'A original');
  fs.writeFileSync(path.join(b, relativePath), 'B original');
  for (const [root, label] of [[a, 'A'], [b, 'B']]) {
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'preview.html'), '<!doctype html><html><head><link rel="stylesheet" href="assets/style.css"></head><body><h1 id="hero">HTML</h1><img id="picture" src="assets/image.svg"><p id="data"></p><script type="module" src="assets/script.js"></script></body></html>');
    fs.writeFileSync(path.join(root, 'assets/style.css'), '@import "./theme.css"; #hero { color: rgb(0, 90, 180); }');
    fs.writeFileSync(path.join(root, 'assets/theme.css'), 'body { background: rgb(240, 244, 250); }');
    fs.writeFileSync(path.join(root, 'assets/image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="blue"/></svg>');
    fs.writeFileSync(path.join(root, 'assets/script.js'), `import value from './module.js'; document.getElementById('hero').textContent = 'HTML ' + value; fetch('./assets/data.json').then(r => r.json()).then(data => { document.getElementById('data').textContent = data.value; });`);
    fs.writeFileSync(path.join(root, 'assets/module.js'), `export default '${label}';`);
    fs.writeFileSync(path.join(root, 'assets/data.json'), JSON.stringify({ value: `Data ${label}` }));
    fs.writeFileSync(path.join(root, 'same.csv'), `来源,值\n${label},第二根内容`);
  }
  const outside = path.join(fixture, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
  fs.symlinkSync(outside, path.join(a, 'escape'), 'junction');
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `file-roots-${process.pid}`,
    MUSTER_WEB: '1', MUSTER_WEB_PORT: '0', MUSTER_WEB_HOST: '127.0.0.1'
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu', '--disable-software-rasterizer'], cwd: fixture, env });
  try {
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    const opened = await win.evaluate(async ({ a, b, nested }) => (window as any).api.workspaces.open({ name: '多根文件',
      roots: [{ id: 'a', path: a }, { id: 'b /中文&', path: b }, { id: 'nested', path: nested }], defaultRootId: 'a', controlRootId: 'a'
    }), { a, b, nested });
    expect(opened.ok, opened.message).toBe(true);
    const configGuard = await win.evaluate(async id => {
      const api = (window as any).api; const before = await api.config.get();
      let error = '';
      try {
        await api.config.update({ frameEffects: !before.frameEffects, workspaces: before.workspaces.map((workspace: any) =>
          workspace.id === id ? { ...workspace, roots: workspace.roots.filter((root: any) => root.id !== 'b /中文&') } : workspace) });
      } catch (cause) { error = String(cause); }
      const after = await api.config.get();
      return { error, unchanged: JSON.stringify(before) === JSON.stringify(after) };
    }, opened.activeWorkspaceId);
    expect(configGuard.error).toContain('workspaces API');
    expect(configGuard.unchanged).toBe(true);
    const refA: WorkspaceFileRef = { workspaceId: opened.activeWorkspaceId, rootId: 'a', relativePath };
    const refB = { ...refA, rootId: 'b /中文&' };
    const removeRoot = (rootId: string) => win.evaluate(async ({ id, rootId }) => {
      const api = (window as any).api; const cfg = await api.config.get();
      const workspace = cfg.workspaces.find((item: any) => item.id === id);
      return api.workspaces.update(id, { roots: workspace.roots.filter((root: any) => root.id !== rootId),
        defaultRootId: 'a', expectedRootsRevision: workspace.rootsRevision });
    }, { id: refA.workspaceId, rootId });
    const located = await win.evaluate(async ({ id, file }) => (window as any).api.fs.resolveRef(id, file), { id: refA.workspaceId, file: path.join(b, relativePath) });
    expect(located).toEqual({ ok: true, fileRef: refB });
    const call = (method: string, ref: WorkspaceFileRef, ...args: unknown[]) => win.evaluate(async ({ method, ref, args }) =>
      (window as any).api.fs[method](ref, ...args), { method, ref, args });
    const listing = await call('listDirRef', { ...refB, relativePath: '' });
    expect(listing.error).toBeUndefined();
    expect(listing.entries.find((e: { relativePath: string }) => e.relativePath === relativePath)?.fileRef).toEqual(refB);
    expect((await call('readTextRef', refA)).content).toBe('A original');
    const read = await call('readTextRef', refB);
    expect(read.content).toBe('B original');
    expect((await call('writeTextRef', refB, 'B changed', read.mtimeMs)).ok).toBe(true);
    expect(fs.readFileSync(path.join(a, relativePath), 'utf8')).toBe('A original');
    expect(fs.readFileSync(path.join(b, relativePath), 'utf8')).toBe('B changed');
    const conflict = await call('writeTextRef', refB, 'wrong overwrite', read.mtimeMs - 10_000);
    expect(conflict.conflict).toBe(true);
    expect(fs.readFileSync(path.join(b, relativePath), 'utf8')).toBe('B changed');
    expect((await call('statRef', refB)).ok).toBe(true);
    const queryFiles = await win.evaluate(async (id) => (window as any).api.fs.listFiles(id), refA.workspaceId);
    expect(queryFiles.error).toBeUndefined();
    expect(queryFiles.items.filter((item: { path: string }) => item.path === relativePath).map((item: { fileRef: WorkspaceFileRef }) => item.fileRef)
      .sort((a: WorkspaceFileRef, b: WorkspaceFileRef) => a.rootId.localeCompare(b.rootId))).toEqual([refA, refB]);
    const queryHits = await win.evaluate(async (id) => (window as any).api.fs.searchFiles(id, { query: 'B changed' }), refA.workspaceId);
    expect(queryHits.error).toBeUndefined();
    expect(queryHits.items.some((hit: { fileRef: WorkspaceFileRef }) => JSON.stringify(hit.fileRef) === JSON.stringify(refB))).toBe(true);
    const mentions = await win.evaluate(async (id) => (window as any).api.workspaces.listFiles(id, '同名'), refA.workspaceId);
    expect(mentions.files.map((item: { fileRef: WorkspaceFileRef }) => item.fileRef)
      .sort((a: WorkspaceFileRef, b: WorkspaceFileRef) => a.rootId.localeCompare(b.rootId))).toEqual([refA, refB]);
    expect(mentions.files.find((item: { fileRef: WorkspaceFileRef }) => item.fileRef.rootId === refB.rootId).absolutePath).toBe(path.join(b, relativePath));
    const unscopedPaths = await win.evaluate(async (id) => (window as any).api.fs.listPaths(id), refA.workspaceId);
    expect(unscopedPaths.error).toMatch(/selection required/);
    const missing = await call('readTextRef', { ...refB, rootId: 'removed' });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/source folder not found/);
    const ambiguous = await win.evaluate(async ({ id, relativePath }) => (window as any).api.fs.readText(id, relativePath), { id: refA.workspaceId, relativePath });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error).toMatch(/selection required/);
    for (const ref of [{ ...refA, relativePath: 'nested' }, { ...refB, relativePath: '' }]) {
      const removed = await call('removeRef', ref);
      expect(removed.ok).toBe(false);
      expect(removed.error).toMatch(/cannot delete/);
    }
    expect(fs.existsSync(nested)).toBe(true);
    const transient = { ...refB, relativePath: 'temporary.txt' };
    expect((await call('writeTextRef', transient, 'delete this')).ok).toBe(true);
    expect((await call('removeRef', transient)).ok).toBe(true);
    expect(fs.existsSync(path.join(b, transient.relativePath))).toBe(false);
    const readMedia = (url: string) => win.evaluate(async (url) => {
      const response = await fetch(url);
      return { status: response.status, text: await response.text() };
    }, url);
    expect(await readMedia(buildWorkspaceFileUrl(refB))).toEqual({ status: 200, text: 'B changed' });
    expect((await readMedia(buildWorkspaceMediaUrl(refA.workspaceId, relativePath))).status).toBe(403);
    expect((await readMedia(buildWorkspaceFileUrl({ ...refA, relativePath: 'escape/secret.txt' }))).status).toBe(403);
    const status = await win.evaluate(() => (window as any).api.webAccess.status());
    expect(status.running, status.disabledReason).toBe(true);
    const media = new URL(buildWorkspaceFileUrl(refB));
    const httpUrl = new URL(`/media/ws/${media.host}${media.pathname}${media.search}`, `http://127.0.0.1:${status.port}`);
    httpUrl.searchParams.set('token', status.token);
    const served = await request.get(httpUrl.href);
    expect(served.status()).toBe(200);
    expect(await served.text()).toBe('B changed');
    const range = await request.get(httpUrl.href, { headers: { Range: 'bytes=0-2' } });
    expect(range.status()).toBe(206);
    expect(await range.text()).toBe('B c');
    await page.goto(`http://127.0.0.1:${status.port}/?token=${encodeURIComponent(status.token)}`);
    await page.waitForFunction(() => Boolean((window as any).api));
    const webRead = await page.evaluate(async (ref) => (window as any).api.fs.readTextRef(ref), refB);
    expect(webRead.content).toBe('B changed');
    const webQuery = await page.evaluate(async ({ id, rootId }) => (window as any).api.fs.searchFiles(id, { query: 'B changed', rootIds: [rootId] }), { id: refB.workspaceId, rootId: refB.rootId });
    expect(webQuery.error).toBeUndefined();
    expect(webQuery.items.map((item: { fileRef: WorkspaceFileRef }) => item.fileRef)).toEqual([refB]);
    const webLocated = await page.evaluate(async ({ id, file }) => (window as any).api.fs.resolveRef(id, file), { id: refA.workspaceId, file: path.join(b, relativePath) });
    expect(webLocated).toEqual({ ok: true, fileRef: refB });
    const webListing = await page.evaluate(async (ref) => (window as any).api.fs.listDirRef(ref), { ...refB, relativePath: '' });
    expect(webListing.entries.find((e: { relativePath: string }) => e.relativePath === relativePath)?.fileRef).toEqual(refB);
    expect((await page.evaluate(async (ref) => (window as any).api.fs.statRef(ref), refB)).ok).toBe(true);
    const webFile = { ...refB, relativePath: 'web-created.txt' };
    expect((await page.evaluate(async (ref) => (window as any).api.fs.writeTextRef(ref, 'from web'), webFile)).ok).toBe(true);
    expect(fs.readFileSync(path.join(b, webFile.relativePath), 'utf8')).toBe('from web');
    expect((await page.evaluate(async (ref) => (window as any).api.fs.removeRef(ref), webFile)).ok).toBe(true);
    expect(fs.existsSync(path.join(b, webFile.relativePath))).toBe(false);
    httpUrl.searchParams.set('rootId', 'removed');
    expect((await request.get(httpUrl.href)).status()).toBe(403);
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside secret');

    // Web 真实预览组件：HTML opaque sandbox 的子资源不能依赖父页 Cookie。
    await page.locator('.app-shell').waitFor();
    const webExpand = page.getByTitle('展开右侧栏', { exact: true });
    if (await webExpand.isVisible()) await webExpand.click();
    const webSide = page.locator('.side-tools-panel');
    const webFiles = webSide.locator('.files-panel.is-shown');
    await webSide.getByRole('tab', { name: '文件', exact: true }).click();
    await webSide.getByRole('tree', { name: 'b', exact: true }).getByText('preview.html', { exact: true }).click();
    const webHtml = page.frameLocator('iframe.file-editor-preview-html');
    await expect(webHtml.locator('#hero')).toHaveText('HTML B');
    await expect(webHtml.locator('#data')).toHaveText('Data B');
    expect(await webHtml.locator('#hero').evaluate(el => getComputedStyle(el).color)).toBe('rgb(0, 90, 180)');
    await expect.poll(() => webHtml.locator('#picture').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(32);
    const previewBase = await webHtml.locator('base').getAttribute('href');
    expect(previewBase).not.toContain(status.token);
    expect(previewBase).toContain('/media/preview/');
    const previewAsset = new URL('assets/data.json', previewBase!).href;
    // 单独、未携 Cookie 的请求只获得同一根的只读文件；不能请求 IPC。
    const anon = await page.context().browser()!.newContext();
    try {
      expect((await anon.request.get(previewAsset)).status()).toBe(200);
      expect((await anon.request.head(previewAsset)).status()).toBe(200);
      expect((await anon.request.post(previewAsset)).status()).toBe(405);
      expect((await anon.request.get(new URL('%ZZ', previewBase!).href)).status()).toBe(400);
      expect((await anon.request.get(`http://127.0.0.1:${status.port}/`)).status()).toBe(401);
    } finally { await anon.close(); }
    await webSide.getByRole('tree', { name: 'b', exact: true }).getByText('same.csv', { exact: true }).click();
    await expect(webFiles.locator('td').filter({ hasText: '第二根内容' })).toBeVisible();
    await expect.poll(async () => (await request.get(previewAsset)).status()).toBe(403);
    await webSide.getByRole('tree', { name: 'b', exact: true }).getByText('assets', { exact: true }).click();
    await webSide.getByRole('tree', { name: 'b', exact: true }).getByText('image.svg', { exact: true }).click();
    await expect.poll(() => webFiles.locator('.file-media-img').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(32);

    // 同一网关的手机入口：真实选择第二根，HTML 保留禁脚本语义。
    const mobileContext = await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
    try {
      const mobile = await mobileContext.newPage();
      await mobile.goto(`http://127.0.0.1:${status.port}/?token=${encodeURIComponent(status.token)}`);
      await mobile.locator('.ma-root').waitFor();
      await mobile.locator('.ma-ws-card').filter({ hasText: '多根文件' }).click();
      await mobile.locator('.ma-dispatch-card').click();
      await mobile.getByRole('button', { name: '更多操作', exact: true }).click();
      await mobile.getByRole('button', { name: '文件列表', exact: true }).click();
      const drawer = mobile.getByRole('dialog', { name: '文件列表', exact: true });
      await drawer.getByText(b, { exact: true }).click();
      await drawer.getByRole('button', { name: relativePath, exact: true }).click();
      await expect(drawer.locator('.ma-files-code')).toContainText('B changed');
      await drawer.getByRole('button', { name: '返回', exact: true }).click();
      await drawer.getByRole('button', { name: 'preview.html', exact: true }).click();
      const mobileHtml = mobile.frameLocator('iframe.ma-files-frame');
      await expect(mobileHtml.locator('#hero')).toHaveText('HTML');
      await expect(mobileHtml.locator('#hero')).toBeVisible();
      await expect.poll(() => mobileHtml.locator('#picture').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(32);
      expect(await mobileHtml.locator('#hero').evaluate(el => getComputedStyle(el).color)).toBe('rgb(0, 90, 180)');
      expect(await drawer.locator('iframe').getAttribute('sandbox')).toBe('');
      const mobilePreviewBase = await mobileHtml.locator('base').getAttribute('href');
      await drawer.getByRole('button', { name: '返回', exact: true }).click();
      await expect.poll(async () => (await request.get(new URL('assets/data.json', mobilePreviewBase!).href)).status()).toBe(403);
      await drawer.getByRole('button', { name: 'assets', exact: true }).click();
      await drawer.getByRole('button', { name: 'image.svg', exact: true }).click();
      await expect.poll(() => drawer.getByRole('img', { name: 'image.svg' }).evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(32);
      const mobileShots = path.join(project, '.tmp/ui-captures/workspace-mobile-roots');
      fs.mkdirSync(mobileShots, { recursive: true });
      for (const theme of ['dark', 'light']) {
        expect((await mobile.evaluate(async id => (window as any).api.themes.activate(id), theme)).ok).toBe(true);
        await expect.poll(() => mobile.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
        for (const width of [390, 320]) {
          await mobile.setViewportSize({ width, height: 844 });
          await drawer.screenshot({ path: path.join(mobileShots, `${theme}-image-${width}.png`) });
          await drawer.getByRole('button', { name: '源文件夹', exact: true }).click();
          await drawer.screenshot({ path: path.join(mobileShots, `${theme}-${width}.png`) });
          await drawer.getByText(b, { exact: true }).click();
          await drawer.getByRole('button', { name: 'assets', exact: true }).click();
          await drawer.getByRole('button', { name: 'image.svg', exact: true }).click();
          await expect.poll(() => drawer.getByRole('img', { name: 'image.svg' }).evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(32);
        }
      }
      await drawer.getByRole('button', { name: '源文件夹', exact: true }).click();
      await drawer.getByText(a, { exact: true }).click();
      await drawer.getByRole('button', { name: relativePath, exact: true }).click();
      await expect(drawer.locator('.ma-files-code')).toContainText('A original');
    } finally { await mobileContext.close(); }

    // Close the Web preview so the following dependency is owned only by the desktop editor.
    await page.goto('about:blank');

    await win.bringToFront();
    const expandRight = win.getByTitle('展开右侧栏', { exact: true });
    if (await expandRight.isVisible()) await expandRight.click();
    const side = win.locator('.side-tools-panel');
    await side.getByRole('tab', { name: '文件', exact: true }).click();
    const files = side.locator('.files-panel.is-shown');
    await side.getByRole('tree', { name: 'b', exact: true }).getByText('preview.html', { exact: true }).click();
    const nativeHtml = win.frameLocator('iframe.file-editor-preview-html');
    await expect(nativeHtml.locator('#hero')).toHaveText('HTML B');
    await expect(nativeHtml.locator('#data')).toHaveText('Data B');
    expect(await nativeHtml.locator('#hero').evaluate(el => getComputedStyle(el).color)).toBe('rgb(0, 90, 180)');
    await expect.poll(() => nativeHtml.locator('#picture').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(32);
    const previewShots = path.join(project, '.tmp/ui-captures/workspace-html-preview');
    fs.mkdirSync(previewShots, { recursive: true });
    for (const theme of ['dark', 'light']) {
      expect((await win.evaluate(async id => (window as any).api.themes.activate(id), theme)).ok).toBe(true);
      await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await side.getByRole('button', { name: '复制完整路径', exact: true }).hover();
      await expect(nativeHtml.locator('#hero')).toHaveText('HTML B');
      // DOM/资源已加载不等于已绘制；首次深色预览也必须有实际布局。
      await nativeHtml.locator('body').evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      await expect(nativeHtml.locator('#hero')).toBeVisible();
      await files.screenshot({ path: path.join(previewShots, `${theme}-normal.png`) });
      const oldStyle = await files.getAttribute('style');
      await files.evaluate(el => { (el as HTMLElement).style.width = '560px'; (el as HTMLElement).style.maxWidth = '560px'; });
      await files.screenshot({ path: path.join(previewShots, `${theme}-560.png`) });
      await files.evaluate((el, value) => { if (value === null) el.removeAttribute('style'); else el.setAttribute('style', value); }, oldStyle);
    }
    await side.getByRole('tree', { name: 'b', exact: true }).getByText(relativePath, { exact: true }).click();
    await expect(files.locator('.cm-content')).toHaveText('B changed');
    await side.getByRole('button', { name: '编辑', exact: true }).click();
    await files.locator('.cm-content').click();
    await win.keyboard.press('Control+A');
    await win.keyboard.insertText('B from editor');
    const editorDependency = await removeRoot(refB.rootId);
    expect(editorDependency.ok).toBe(false);
    expect(editorDependency.rootDependencies).toContainEqual(expect.objectContaining({ kind: 'open-file', rootId: refB.rootId, relativePath }));
    await expect.poll(() => fs.readFileSync(path.join(b, relativePath), 'utf8')).toBe('B from editor');
    await side.getByRole('tab', { name: 'Git', exact: true }).first().click();
    await expect(side.locator('.right-files-resources')).not.toBeVisible();
    const hiddenDependency = await removeRoot(refB.rootId);
    expect(hiddenDependency.ok).toBe(false);
    expect(hiddenDependency.rootDependencies).toContainEqual(expect.objectContaining({ kind: 'open-file', rootId: refB.rootId, relativePath }));
    await side.getByRole('tab', { name: '文件', exact: true }).first().click();
    await expect(side.locator('.right-files-resources')).toBeVisible();
    expect(fs.readFileSync(path.join(a, relativePath), 'utf8')).toBe('A original');
    fs.writeFileSync(path.join(b, relativePath), 'B externally changed');
    await expect(files.locator('.cm-content')).toHaveText('B externally changed');
    fs.writeFileSync(path.join(a, relativePath), 'A externally changed');
    await expect(files.locator('.cm-content')).toHaveText('B externally changed');
    await side.getByRole('tree', { name: 'a', exact: true }).getByText(relativePath, { exact: true }).click();
    await expect(files.locator('.cm-content')).toHaveText('A externally changed');
    await side.getByRole('tree', { name: 'b', exact: true }).getByText(relativePath, { exact: true }).click();
    await expect(files.locator('.cm-content')).toHaveText('B externally changed');
    await side.getByRole('button', { name: '在文件树中定位当前文件' }).click();
    await expect(side.getByRole('tree', { name: 'b', exact: true }).locator('.is-active')).toHaveAttribute('data-file-tree-row', relativePath);
    await side.getByRole('button', { name: '搜索文件', exact: true }).click();
    const palette = win.getByRole('dialog', { name: '搜索', exact: true });
    await palette.getByRole('combobox').fill('同名');
    await expect(palette.getByRole('option').filter({ hasText: `b/${relativePath}` })).toBeVisible();
    await expect(palette.getByRole('option').filter({ hasText: `a/${relativePath}` })).toHaveAttribute('aria-selected', 'true');
    await palette.getByRole('combobox').press('ArrowDown');
    await expect(palette.getByRole('option').filter({ hasText: `b/${relativePath}` })).toHaveAttribute('aria-selected', 'true');
    await palette.getByRole('combobox').press('Enter');
    await expect(palette).not.toBeVisible();
    await expect(files.locator('.cm-content')).toHaveText('B externally changed');
    await side.getByRole('button', { name: '所有文件中搜索', exact: true }).click();
    await palette.getByRole('combobox').fill('externally changed');
    await expect(palette.getByRole('option').filter({ hasText: `a/${relativePath}:1` })).toBeVisible();
    const paletteShots = path.join(project, '.tmp/ui-captures/workspace-quick-open');
    fs.mkdirSync(paletteShots, { recursive: true });
    for (const theme of ['dark', 'light']) {
      expect((await win.evaluate(async id => (window as any).api.themes.activate(id), theme)).ok).toBe(true);
      await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await win.addStyleTag({ content: '* { font-family: system-ui !important; }' });
      await palette.screenshot({ path: path.join(paletteShots, `${theme}-normal.png`) });
      const originalStyle = await palette.getAttribute('style');
      await palette.evaluate(el => { (el as HTMLElement).style.width = '390px'; (el as HTMLElement).style.maxWidth = '390px'; });
      await palette.screenshot({ path: path.join(paletteShots, `${theme}-390.png`) });
      await palette.evaluate((el, originalStyle) => { if (originalStyle === null) el.removeAttribute('style'); else el.setAttribute('style', originalStyle); }, originalStyle);
    }
    await palette.getByRole('option').filter({ hasText: `b/${relativePath}:1` }).dblclick();
    await expect(palette).not.toBeVisible();
    await expect(files.locator('.cm-content')).toHaveText('B externally changed');
    await files.locator('.file-editor-main').hover({ position: { x: 50, y: 100 } });
    const shots = path.join(project, '.tmp/ui-captures/workspace-file-roots');
    fs.mkdirSync(shots, { recursive: true });
    for (const theme of ['dark', 'light']) {
      const applied = await win.evaluate(async (id) => (window as any).api.themes.activate(id), theme);
      expect(applied.ok).toBe(true);
      await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      // Explicit system-font verification avoids claiming a network-loaded font passed.
      await win.addStyleTag({ content: '* { font-family: system-ui !important; }' });
      await files.screenshot({ path: path.join(shots, `${theme}-normal.png`) });
      const originalStyle = await files.evaluate(el => el.getAttribute('style'));
      await files.evaluate(el => { (el as HTMLElement).style.width = '560px'; (el as HTMLElement).style.maxWidth = '560px'; });
      await files.screenshot({ path: path.join(shots, `${theme}-560.png`) });
      await files.evaluate((el, originalStyle) => { if (originalStyle === null) el.removeAttribute('style'); else el.setAttribute('style', originalStyle); }, originalStyle);
    }
    // 文件面板在 Git 虚拟屏；先点击工作页露条切回，否则左栏随条带在视口外。
    const workspacePage = win.locator('.workspace-page');
    const workspaceBounds = await workspacePage.boundingBox();
    expect(workspaceBounds).not.toBeNull();
    await workspacePage.click({ position: { x: workspaceBounds!.width - 40, y: 60 } });
    const expandSessions = win.getByRole('button', { name: '展开会话栏', exact: true });
    if (await expandSessions.isVisible()) await expandSessions.click();
    await expect(win.getByRole('button', { name: '折叠会话栏', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const stackToggle = win.getByRole('button', { name: '折叠工作区列表（只留当前工作区）', exact: true });
    if (await stackToggle.isVisible()) await stackToggle.click({ timeout: 5000 });
    await win.getByTitle(/^多根文件\n单击打开\/关闭对话/).click({ timeout: 5000 });
    const panel = win.locator('.agent-float-panel');
    const composer = panel.locator('.agent-composer');
    const input = composer.getByRole('textbox');
    await input.fill('@同名');
    const secondMention = composer.getByRole('option', { name: /@b\/同名/ });
    await expect(secondMention).toBeVisible();
    await secondMention.click();
    await expect(input.locator('.composer-token')).toHaveAttribute('data-token', `@${path.join(b, relativePath)}`);
    await expect(input.locator('.composer-token-label')).toHaveText(`@b/${relativePath}`);
    const mentionShots = path.join(project, '.tmp/ui-captures/workspace-mentions');
    fs.mkdirSync(mentionShots, { recursive: true });
    for (const theme of ['dark', 'light']) {
      expect((await win.evaluate(async id => (window as any).api.themes.activate(id), theme)).ok).toBe(true);
      await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await input.fill('@同名');
      await expect(composer.getByRole('option', { name: /@b\/同名/ })).toBeVisible();
      await panel.screenshot({ path: path.join(mentionShots, `${theme}-normal.png`) });
      const originalStyle = await panel.getAttribute('style');
      await panel.evaluate(el => { (el as HTMLElement).style.width = '390px'; (el as HTMLElement).style.maxWidth = '390px'; });
      await panel.screenshot({ path: path.join(mentionShots, `${theme}-390.png`) });
      await panel.evaluate((el, originalStyle) => { if (originalStyle === null) el.removeAttribute('style'); else el.setAttribute('style', originalStyle); }, originalStyle);
    }
    // Real settings -> rejected root removal -> structured blockers -> original FileRef navigation.
    // 顶栏工作区菜单已撤（2026-10-10）：编辑工作区走左下工作区栈头像右键
    await win.locator('.agent-ws-stack:not(.agent-ws-stack-ghost) .agent-ws-stack-item.is-active .agent-float-avatar').click({ button: 'right' });
    await win.getByRole('menuitemcheckbox', { name: '编辑', exact: true }).click();
    const settings = win.getByRole('dialog', { name: '编辑工作区' });
    await expect(settings).toBeVisible();
    const secondRoot = settings.locator('[data-root-id]').filter({ hasText: b });
    await secondRoot.getByRole('button', { name: b, exact: true }).click();
    await secondRoot.getByRole('button', { name: '移除文件夹' }).click();
    await settings.getByRole('textbox', { name: '工作区名称', exact: true }).fill('未保存的名称');
    await settings.getByRole('button', { name: '保存', exact: true }).click();
    const blockers = settings.getByRole('region', { name: '移除受阻的依赖' });
    await expect(blockers).toBeVisible();
    await expect(blockers).toHaveAttribute('data-mp-stage', 'in');
    await expect(blockers).toContainText(relativePath);
    await expect(blockers).toContainText('请在打开它的原窗口关闭文件视图。');
    const untouched = await win.evaluate(async id => {
      const cfg = await (window as any).api.config.get(); return cfg.workspaces.find((item: any) => item.id === id);
    }, refA.workspaceId);
    expect(untouched.name).toBe('多根文件');
    expect(untouched.roots.some((root: any) => root.id === refB.rootId)).toBe(true);
    const dependencyShots = path.join(project, '.tmp/ui-captures/workspace-root-dependencies');
    fs.mkdirSync(dependencyShots, { recursive: true });
    for (const theme of ['dark', 'light']) {
      expect((await win.evaluate(async id => (window as any).api.themes.activate(id), theme)).ok).toBe(true);
      await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await settings.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await blockers.getByText('请在打开它的原窗口关闭文件视图。', { exact: true }).scrollIntoViewIfNeeded();
      await settings.screenshot({ path: path.join(dependencyShots, `${theme}-normal.png`), animations: 'disabled' });
      const oldStyle = await settings.getAttribute('style');
      await settings.evaluate(element => { (element as HTMLElement).style.width = '390px'; (element as HTMLElement).style.maxWidth = '390px'; });
      await settings.evaluate(element => { element.scrollTop = element.scrollHeight; });
      const fileHint = blockers.getByText('请在打开它的原窗口关闭文件视图。', { exact: true });
      await fileHint.scrollIntoViewIfNeeded();
      expect(await settings.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const dependencyBounds = await blockers.boundingBox(); const settingsBounds = await settings.boundingBox();
      expect(dependencyBounds!.y).toBeGreaterThanOrEqual(settingsBounds!.y);
      expect(dependencyBounds!.y + dependencyBounds!.height).toBeLessThanOrEqual(settingsBounds!.y + settingsBounds!.height);
      const hintBounds = await fileHint.boundingBox();
      const footerBounds = await settings.locator('.create-ws-actions').boundingBox();
      expect(hintBounds!.y + hintBounds!.height).toBeLessThanOrEqual(footerBounds!.y);
      await expect(settings.getByRole('button', { name: '保存', exact: true })).toBeVisible();
      await settings.screenshot({ path: path.join(dependencyShots, `${theme}-390.png`), animations: 'disabled' });
      await settings.evaluate((element, style) => { if (style === null) element.removeAttribute('style'); else element.setAttribute('style', style); }, oldStyle);
    }
    await blockers.getByRole('button', { name: '打开文件' }).click();
    await expect(settings).not.toBeVisible();
    await expect(files).toBeVisible();
    await expect(files.locator('.cm-content')).toHaveText('B externally changed');
    expect(fs.readFileSync(path.join(a, relativePath), 'utf8')).toBe('A externally changed');
    expect(fs.readFileSync(path.join(b, relativePath), 'utf8')).toBe('B externally changed');
    const removable = path.join(fixture, 'removable-source'); fs.mkdirSync(removable); fs.writeFileSync(path.join(removable, 'held.txt'), 'preserved');
    const addRoot = await win.evaluate(async ({ id, source }) => {
      const api = (window as any).api; const cfg = await api.config.get();
      const workspace = cfg.workspaces.find((item: any) => item.id === id);
      return api.workspaces.update(id, { roots: [...workspace.roots, { id: 'removable', path: source }], expectedRootsRevision: workspace.rootsRevision });
    }, { id: refA.workspaceId, source: removable });
    expect(addRoot.ok, addRoot.message).toBe(true);
    await page.goto(`http://127.0.0.1:${status.port}/?token=${encodeURIComponent(status.token)}`);
    await page.waitForFunction(() => Boolean((window as any).api));
    const held = { ...refA, rootId: 'removable', relativePath: 'held.txt' };
    expect((await page.evaluate(async ref => (window as any).api.fs.openFile(ref, 'remote-held-view'), held)).ok).toBe(true);
    expect((await removeRoot('removable')).rootDependencies).toContainEqual(expect.objectContaining({ kind: 'open-file', rootId: 'removable', relativePath: 'held.txt' }));
    await win.evaluate(async () => (window as any).api.fs.closeFile('remote-held-view'));
    expect((await removeRoot('removable')).ok, 'desktop cannot release a Web-owned view').toBe(false);
    // WebSocket disconnect releases its views in the real server, allowing normal unlink.
    await page.goto('about:blank');
    await expect.poll(async () => (await removeRoot('removable')).ok).toBe(true);
    expect(fs.readFileSync(path.join(removable, 'held.txt'), 'utf8')).toBe('preserved');
  } finally {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
});
