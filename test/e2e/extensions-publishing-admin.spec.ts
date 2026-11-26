import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/electron';

test.use({ isolatedSandbox: true });

test('the hidden publishing controls start and stop the real local service', async ({ appCtx }, info) => {
  test.setTimeout(55_000);
  const { app, win } = appCtx;
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'muster publishing admin '));
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const address = occupied.address();
  if (!address || typeof address === 'string') throw new Error('No local test port');
  const origin = `http://127.0.0.1:${address.port}`;
  const config = path.join(folder, 'publishing.env');
  await fs.writeFile(config, [
    `MUSTER_PUBLISH_ORIGIN=${origin}`, `MUSTER_PUBLISH_PORT=${address.port}`,
    'MUSTER_PUBLISH_DATA=review data', 'MUSTER_PUBLISH_REVIEWERS_FILE=reviewers.json',
    'MUSTER_PUBLISH_GITHUB_CLIENT_ID=test-client-id', 'MUSTER_PUBLISH_GITHUB_CLIENT_SECRET=test-client-secret',
  ].join('\n'));
  await fs.writeFile(path.join(folder, 'reviewers.json'), '[123]');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, config);
  try {
    const expand = win.getByRole('button', { name: '展开实用工具' });
    if (await expand.isVisible()) await expand.click();
    await win.getByRole('listitem').filter({ hasText: '扩展管理' }).click();
    const center = win.getByRole('tab', { name: '扩展中心', exact: true });
    await center.click();
    const management = win.getByRole('dialog', { name: '发布管理' });
    await expect(management).toHaveCount(0);
    for (let i = 0; i < 3; i++) await center.click({ modifiers: ['Shift'] });
    await expect(management).toBeVisible();
    const start = management.getByRole('button', { name: '启动本机服务…' });
    await start.click();
    await expect(management.getByRole('alert')).toContainText(`端口 ${address.port} 已占用`, { timeout: 12_000 });
    await new Promise<void>(resolve => occupied.close(() => resolve()));
    await start.click();
    const stop = management.getByRole('button', { name: '停止本机服务' });
    await expect(stop).toBeEnabled();
    await expect(management.getByText(origin, { exact: true })).toBeVisible();
    await expect(management.getByRole('button', { name: '登录 GitHub' })).toBeEnabled();
    await expect(management.getByRole('button', { name: '待审核' })).toHaveCount(0);
    expect(await (await fetch(`${origin}/session`)).json()).toEqual({ reviewer: false });
    expect((await fetch(`${origin}/review`)).status).toBe(401);
    await win.evaluate(() => window.api.themes.activate('dark'));
    await management.screenshot({ path: info.outputPath('publishing-management-dark.png'), animations: 'disabled' });
    await win.evaluate(() => window.api.themes.activate('light'));
    await win.setViewportSize({ width: 390, height: 760 });
    await expect.poll(() => management.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await management.screenshot({ path: info.outputPath('publishing-management-light-narrow.png'), animations: 'disabled' });
    await stop.click();
    await expect(start).toBeEnabled();
    await expect.poll(async () => fetch(`${origin}/session`).then(() => true, () => false)).toBe(false);
    await win.keyboard.press('Escape');
    await expect(management).toBeHidden();
    await expect(center).toBeFocused();
  } finally {
    await win.evaluate(() => window.api.extensionPublishing.stopLocal()).catch(() => {});
    if (occupied.listening) occupied.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});
