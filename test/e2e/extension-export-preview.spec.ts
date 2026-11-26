import { test, expect } from './fixtures/electron';
import fs from 'node:fs/promises';
import path from 'node:path';

test('an extension can play its HTML export in the right browser with keyboard and mouse', async ({ appCtx }) => {
  const { win, app } = appCtx;
  const more = win.getByRole('button', { name: '展开更多工具' });
  if (await more.isVisible()) await more.click();
  await win.getByRole('treeitem', { name: '媒体创作台' }).click();
  const trust = win.getByRole('button', { name: '信任开发目录' });
  if (await trust.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)) await trust.click();
  const panel = win.frameLocator('iframe.ext-panel-frame').locator('.md-root');
  await expect(panel).toBeVisible({ timeout: 30000 });
  const exported = await panel.evaluate(async () => {
    const sdk = (window as unknown as { ma: { exports: {
      create(files: { name: string; text: string }[], title: string): Promise<{ exportId: string; directory: string }>;
    } } }).ma.exports;
    return sdk.create([{ name: 'index.html', text: `<!doctype html><button id="next">Next</button><output></output>
      <script>
        let slide = Number(localStorage.getItem('slide') || 0);
        function next() { document.querySelector('output').value = String(++slide); localStorage.setItem('slide', String(slide)); }
        document.getElementById('next').onclick = next;
        addEventListener('keydown', e => { if (e.key === 'ArrowRight') next(); });
      </script>` }], 'e2e-interactive-preview');
  });
  try {
    await panel.evaluate(async (_, id) => {
      const { ma } = window as unknown as { ma: { exports: { preview(id: string, name: string): Promise<unknown> } } };
      await ma.exports.preview(id, 'index.html');
    }, exported.exportId);
    const url = `muster-export://${exported.exportId}/index.html`;
    const getGuestId = () => app.evaluate(({ webContents }, target) =>
      webContents.getAllWebContents().find(wc => wc.getType() === 'webview' && wc.getURL() === target)?.id, url);
    await expect.poll(getGuestId, { timeout: 15000 }).toBeTruthy();
    const id = (await getGuestId())!;
    await app.evaluate(async ({ webContents }, guestId) => {
      const wc = webContents.fromId(guestId)!;
      wc.focus();
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    }, id);
    const getSlide = () => app.evaluate(({ webContents }, guestId) =>
      webContents.fromId(guestId)!.executeJavaScript("document.querySelector('output').value"), id);
    await expect.poll(getSlide).toBe('1');
    await app.evaluate(async ({ webContents }, guestId) => {
      const wc = webContents.fromId(guestId)!;
      const point = await wc.executeJavaScript("const r=document.querySelector('button').getBoundingClientRect(); ({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})");
      wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    }, id);
    await expect.poll(getSlide).toBe('2');
    expect(await app.evaluate(({ webContents }, guestId) =>
      webContents.fromId(guestId)!.executeJavaScript("Boolean(window.api || window.ma || window.__maUiHost)"), id)).toBe(false);
  } finally {
    const docs = await app.evaluate(({ app }) => app.getPath('documents'));
    const expectedDirectory = path.join(docs, 'Muster Extensions', 'e2e-interactive-preview-' + exported.exportId.slice(0, 8));
    expect(path.resolve(exported.directory)).toBe(path.resolve(expectedDirectory));
    await fs.rm(expectedDirectory, { recursive: true, force: true });
  }
});


test('saved project HTML loads sibling scripts and receives page keys in the right browser', async ({ appCtx }) => {
  const { win, app } = appCtx;
  const { root, workspaceId } = await win.evaluate(async () => {
    const { workspaces, activeWorkspaceId } = await window.api.workspaces.list();
    const ws = workspaces.find(item => item.id === activeWorkspaceId)!;
    return { workspaceId: ws.id, root: ws.roots!.find(item => item.id === ws.defaultRootId) ?? ws.roots![0] };
  });
  const directory = await fs.mkdtemp(path.join(root.path, 'html-preview-'));
  try {
    await fs.writeFile(path.join(directory, 'index.html'), '<title>Project presentation</title><output>1</output><script src="deck.js"></script>');
    await fs.writeFile(path.join(directory, 'deck.js'), "onkeydown = e => { if(e.key === 'ArrowRight') document.querySelector('output').value = '2'; }");
    const ref = { workspaceId, rootId: root.id, relativePath: path.basename(directory) + '/index.html' };
    expect(await win.evaluate(ref => window.api.fs.openBrowserPreview(ref), ref)).toEqual({ ok: true });
    const view = win.locator('webview[src^="muster-export:"]').last();
    await expect(view).toBeVisible();
    await expect.poll(() => app.evaluate(({ webContents }) => webContents.getAllWebContents()
      .some(wc => wc.getType() === 'webview' && wc.getTitle() === 'Project presentation'))).toBe(true);
    const page = await app.evaluate(({ webContents }) => webContents.getAllWebContents()
      .find(wc => wc.getType() === 'webview' && wc.getTitle() === 'Project presentation')!.id);
    await app.evaluate(({ webContents }, id) => {
      const wc = webContents.fromId(id)!;
      wc.focus();
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    }, page);
    await expect.poll(() => app.evaluate(({ webContents }, id) =>
      webContents.fromId(id)!.executeJavaScript("document.querySelector('output').value"), page)).toBe('2');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
