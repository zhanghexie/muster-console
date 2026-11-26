import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { test, expect, repoRoot } from './fixtures/electron';

test.use({ isolatedSandbox: true });
const repository = process.env.MUSTER_EXTENSION_PUBLISH_TEST_REPOSITORY;
test.skip(!repository, 'Requires a publishing service and an authorized extension repository');

test('uploads Chinese chess from the installed card and plays the exact reviewed package in a trial profile', async ({ appCtx }, info) => {
  test.setTimeout(125_000);
  const { app, win } = appCtx;
  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const address = portServer.address();
  if (!address || typeof address === 'string') throw new Error('Test debug port was unavailable');
  const port = address.port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));

  await app.evaluate(({ dialog }, { source, port }) => {
    const originalDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => { dialog.showOpenDialog = originalDialog; return { canceled: false, filePaths: [source] }; };
    const childProcess = process.getBuiltinModule('node:child_process')!;
    const originalSpawn = childProcess.spawn;
    const sync = process.getBuiltinModule('node:module')!.syncBuiltinESMExports;
    childProcess.spawn = new Proxy(originalSpawn, { apply(target, receiver, args) {
      const options = args[2] as import('node:child_process').SpawnOptions | undefined;
      if (!options?.env?.MUSTER_EXTENSION_TRIAL_ROOT) return Reflect.apply(target, receiver, args);
      const child = Reflect.apply(target, receiver, [args[0], args[1], { ...options, env: { ...options.env, MUSTER_DEVTOOLS_PORT: String(port) } }]);
      (globalThis as typeof globalThis & { trialProcess?: number }).trialProcess = child.pid;
      childProcess.spawn = originalSpawn;
      sync();
      return child;
    } });
    sync();
  }, { source: path.join(repoRoot, 'resources', 'extensions', 'xiangqi'), port });

  let browser: Browser | undefined;
  try {
    const expand = win.getByRole('button', { name: '展开实用工具' });
    if (await expand.isVisible()) await expand.click();
    await win.getByRole('listitem').filter({ hasText: '扩展管理' }).click();
    await win.getByRole('button', { name: '安装本地扩展' }).click();
    const chess = win.getByRole('article').filter({ hasText: '中国象棋' });
    await chess.getByRole('button', { name: /提交到扩展中心|提交更新/ }).click();
    const submit = win.getByRole('dialog', { name: '提交到扩展中心' });
    const url = submit.getByLabel('公开 GitHub 仓库地址');
    if (await url.isEditable()) await url.fill(repository!);
    await submit.screenshot({ path: info.outputPath('xiangqi-submission.png') });
    await submit.getByRole('button', { name: '提交审核' }).click();
    await expect(submit).toBeHidden({ timeout: 45_000 });
    await expect(chess.getByRole('status')).toHaveText('待审核', { timeout: 35_000 });
    const receipt = await win.evaluate(async () => (await window.api.extensionPublishing.mine()).find(row => row.extensionId === 'xiangqi'));
    expect(receipt?.commit).toMatch(/^[a-f0-9]{40}$/);
    console.log(`Xiangqi upload verified: ${receipt?.repository} ${receipt?.version} ${receipt?.commit}`);

    const center = win.getByRole('tab', { name: '扩展中心', exact: true });
    for (let i = 0; i < 3; i++) await center.click({ modifiers: ['Shift'] });
    await win.getByRole('dialog', { name: '发布管理' }).getByRole('button', { name: '待审核', exact: true }).click();
    const review = win.getByRole('dialog', { name: '待审核' });
    await review.getByRole('button', { name: /中国象棋/ }).click();
    await expect(review.getByRole('button', { name: '批准并发布' })).toBeDisabled();
    await review.getByRole('button', { name: '试装', exact: true }).click();
    await expect(review.getByRole('button', { name: '批准并发布' })).toBeEnabled({ timeout: 35_000 }).catch(async error => {
      throw new Error(`${error.message}\n${await review.getByRole('status').textContent()}`);
    });
    await win.evaluate(() => window.api.themes.activate('light'));
    await review.screenshot({ path: info.outputPath('xiangqi-review.png') });
    await win.setViewportSize({ width: 390, height: 760 });
    await expect.poll(() => review.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await review.screenshot({ path: info.outputPath('xiangqi-review-narrow.png') });

    const debugOrigin = `http://127.0.0.1:${port}`;
    await expect.poll(async () => (await fetch(`${debugOrigin}/json/version`).catch(() => undefined))?.ok, { timeout: 25_000 }).toBe(true);
    browser = await chromium.connectOverCDP(debugOrigin);
    const trialContext = browser.contexts()[0];
    const trial = trialContext.pages().find(page => page.url().includes('index.html')) ?? await trialContext.waitForEvent('page');
    const board = trial.frameLocator('iframe[aria-label="扩展面板 中国象棋"]');
    await expect(board.locator('#turn')).toHaveText('轮到你走棋', { timeout: 20_000 });
    await board.locator('[data-square="58"]').click();
    await board.locator('[data-square="49"]').click();
    await expect(board.locator('#move-count')).toHaveText('2 着');
    await trial.locator('iframe[aria-label="扩展面板 中国象棋"]').screenshot({ path: info.outputPath('xiangqi-trial.png') });
  } finally {
    await browser?.close();
    const pid = await app.evaluate(() => (globalThis as typeof globalThis & { trialProcess?: number }).trialProcess);
    if (pid) try { process.kill(pid); } catch { /* Already closed. */ }
  }
});
