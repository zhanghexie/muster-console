import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/electron';
import { hasExtensionTestCenter, installCenterExtension } from './fixtures/centerExtension';

test.use({ isolatedSandbox: true });

test.skip(!hasExtensionTestCenter, 'Requires an explicit extension center fixture or GitHub credential');

test('gomoku 面板与 DomainRuntime 落子链路', async ({ appCtx, mockLlm }, testInfo) => {
  const { win } = appCtx;
  await installCenterExtension(win, 'gomoku');
  await win.evaluate(baseUrl => window.api.config.update({
    llm: { activeProviderId: 'gomoku-test', activeModelId: 'mock',
      providers: [{ id: 'gomoku-test', name: 'Gomoku test', enabled: true, api: 'openai-completions', baseUrl,
        apiKey: 'fixture', models: [{ id: 'mock', name: 'Mock' }] }] }
  }), `http://127.0.0.1:${mockLlm.port}/v1`);
  const expandExtensions = win.getByRole('button', { name: '展开更多工具' });
  if (await expandExtensions.isVisible().catch(() => false)) await expandExtensions.click();
  await win.locator('[role="treeitem"][aria-label="五子棋"]').click();
  const frameSelector = 'iframe[aria-label="扩展面板 五子棋"]';
  const frame = win.frameLocator(frameSelector);
  await frame.locator('#board').waitFor({ state: 'visible', timeout: 20_000 }).catch(async error => {
    throw new Error(`${error.message} (${await win.locator('.ext-panel').allTextContents()})`);
  });
  await expect(frame.locator('#statusMain')).toHaveText('轮到你落子');
  const board = frame.locator('#board');
  await win.locator(frameSelector).evaluate(element => { element.style.width = '390px'; });
  await expect.poll(() => board.evaluate(element => {
    const stage = element.parentElement!;
    const padding = getComputedStyle(stage);
    const available = stage.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
    return Math.abs(element.getBoundingClientRect().width - available);
  })).toBeLessThan(1);
  const box = await board.boundingBox();
  if (!box) throw new Error('gomoku board has no layout box');
  await board.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(frame.locator('#moves')).not.toHaveText('0 手', { timeout: 15_000 });
  await expect(frame.locator('.board-stage')).toBeVisible();
  await frame.locator('.app').screenshot({ path: testInfo.outputPath('gomoku.png') });
  // Edit only the sandbox's installed package. Keep the manifest version, filenames
  // and session unchanged so a reused document or cached worker fails here.
  const profile = await appCtx.app.evaluate(({ app }) => {
    if (process.env.MUSTER_SANDBOX !== '1') throw new Error('Expected the isolated Electron test profile');
    return app.getPath('userData');
  });
  const installed = path.join(profile, 'extensions', 'global', 'gomoku');
  const paths = ['ui/panel.html', 'ui/ui.mjs', 'domain.mjs', 'extension.json'].map(file => path.join(installed, file));
  const originals = await Promise.all(paths.map(file => fs.readFile(file, 'utf8')));
  const marker = frame.locator('#reload-marker');
  await expect(marker).toHaveCount(0);
  try {
    await fs.writeFile(paths[0], originals[0].replace('</h1>', '</h1><output id="reload-marker">HTML v2</output>'));
    await fs.writeFile(paths[1], originals[1] + "\nawait ma.ready; const refreshed = await ma.agent.domain.query('game.status', {}); document.querySelector('#reload-marker').textContent += ' / JS v2 / ' + refreshed.reloadVersion;");
    await fs.writeFile(paths[2], originals[2].replace('async query(name) {', "async query(name) { if (name === 'game.status') return { reloadVersion: 'Domain v2' };"));
    const manifest = JSON.parse(originals[3]);
    manifest.permissions.push('hostTools');
    await fs.writeFile(paths[3], JSON.stringify(manifest));
    await win.evaluate(async () => {
      const { activeWorkspaceId: workspaceId } = await window.api.config.get();
      if (!workspaceId) throw new Error('Expected an active workspace');
      const { sourceRootId, selectionRevision } = await window.api.extensions.snapshot(workspaceId);
      await window.api.extensions.setEnabled({ workspaceId, sourceRootId, selectionRevision, scope: 'global', extensionId: 'gomoku', enabled: true });
    });
    await win.getByRole('button', { name: '重载', exact: true }).click();
    await expect(marker).toHaveText('HTML v2 / JS v2 / Domain v2', { timeout: 20_000 });
    const runtimes = await marker.evaluate(() => (window as unknown as { ma: { tool(name: string, args: unknown): Promise<unknown> } }).ma.tool('host.runtimes.run', { action: 'list', params: {} }));
    expect(runtimes).toBeTruthy();
    await frame.locator('body').screenshot({ path: testInfo.outputPath('gomoku-reloaded.png') });
  } finally {
    await Promise.all(paths.map((file, index) => fs.writeFile(file, originals[index])));
  }
  expect(appCtx.consoleErrors, `console errors: ${appCtx.consoleErrors.slice(0, 4).join(' | ')}`).toEqual([]);
});
