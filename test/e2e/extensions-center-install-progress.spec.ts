import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test as electronTest, expect, repoRoot } from './fixtures/electron';

const extensionId = 'design-progress-fixture';
const packageKey = `muster/${extensionId}`;
const name = '设计工具示例';

interface DownloadFixture {
  firstBytes: number;
  totalBytes: number;
  finish(): void;
  requests(): number;
}

const test = electronTest.extend<{}, { download: DownloadFixture }>({
  download: [async ({}, use) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'muster-extension-progress-'));
    let server: Server | undefined;
    const originalUrl = process.env.MUSTER_EXTENSION_CENTER_URL;
    const originalLocal = process.env.MUSTER_EXTENSION_CENTER_LOCAL;
    try {
      const source = path.join(folder, extensionId);
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, 'extension.json'), JSON.stringify({
        id: extensionId, name, description: '使用设计技能和工作流，在工作区管理作品。', version: '1.0.0', scope: 'global',
        icon: 'builtin-extension:design-tools',
        surface: { kind: 'sidebar', entry: 'panel.html' },
        domain: { entry: 'domain.mjs', queries: [], commands: [], events: [] }, permissions: [],
      }));
      await fs.writeFile(path.join(source, 'panel.html'), '<!doctype html><title>Design test extension</title>');
      await fs.writeFile(path.join(source, 'domain.mjs'), 'export default {};');
      await fs.writeFile(path.join(source, 'asset.bin'), Buffer.alloc(3_600_000));
      const output = path.join(folder, 'package.json');
      const metadata = JSON.parse(execFileSync(process.execPath, [path.join(repoRoot, 'scripts/pack-extension-release.mjs'), source, output], { encoding: 'utf8' }));
      const bytes = await fs.readFile(output);
      const firstBytes = Math.ceil(bytes.length * 0.42);
      let origin: string;
      let requestCount = 0;
      let pending: ServerResponse | undefined;
      server = createServer((request, response) => {
        if (request.url === '/catalog.json') {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ schemaVersion: 1, releases: [{
            ...metadata, packageKey, publisherId: 'muster', category: 'creative', packageUrl: `${origin}/package.json`,
          }] }));
        } else if (request.url === '/package.json' && ++requestCount === 1) {
          response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': bytes.length });
          response.write(bytes.subarray(0, firstBytes));
          pending = response;
        } else {
          response.writeHead(404).end();
        }
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No local catalog port');
      origin = `http://127.0.0.1:${address.port}`;
      process.env.MUSTER_EXTENSION_CENTER_URL = `${origin}/catalog.json`;
      delete process.env.MUSTER_EXTENSION_CENTER_LOCAL;
      await use({ firstBytes, totalBytes: bytes.length, finish: () => {
        if (!pending) throw new Error('No extension download to finish');
        pending.end(bytes.subarray(firstBytes));
      }, requests: () => requestCount });
    } finally {
      if (originalUrl === undefined) delete process.env.MUSTER_EXTENSION_CENTER_URL;
      else process.env.MUSTER_EXTENSION_CENTER_URL = originalUrl;
      if (originalLocal === undefined) delete process.env.MUSTER_EXTENSION_CENTER_LOCAL;
      else process.env.MUSTER_EXTENSION_CENTER_LOCAL = originalLocal;
      const closing = new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
      server?.closeAllConnections();
      await closing;
      await fs.rm(folder, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
  appCtx: async ({ download: _download, appCtx }, use) => { await use(appCtx); },
});

test.use({ isolatedSandbox: true });

async function openCenter(win: Page) {
  const tab = win.getByRole('tab', { name: '扩展中心', exact: true });
  if (!await tab.isVisible()) {
    const tools = win.getByRole('button', { name: '展开实用工具' });
    if (await tools.isVisible()) await tools.click();
    await win.getByRole('listitem').filter({ hasText: '扩展管理' }).click();
  }
  await tab.click();
  return win.getByRole('tabpanel', { name: '扩展中心' });
}

test('renders live byte progress and restores an in-flight install after returning to the center', async ({ appCtx, download }, info) => {
  const { win } = appCtx;
  await win.evaluate(() => window.api.themes.activate('dark', { scope: 'workspace' }));
  const center = await openCenter(win);
  const card = center.getByRole('article').filter({ hasText: packageKey });
  await expect(card.locator('.ext-manager-icon [aria-hidden="true"]')).toHaveCSS('mask-image', /^url\(/);
  const install = card.getByRole('button', { name: '安装', exact: true });
  await install.click();
  const bar = card.getByRole('progressbar', { name: '正在下载安装包' });
  await expect(bar).toHaveAttribute('value', String(download.firstBytes));
  await expect(bar).toHaveAttribute('max', String(download.totalBytes));
  await expect(install).toBeDisabled();
  await win.locator('.ext-extension-manager').evaluate(element => { element.style.inlineSize = '760px'; });
  await card.screenshot({ path: info.outputPath('install-progress-dark.png'), animations: 'disabled' });

  // A new renderer has no pending click to replay. It must recover the host's progress snapshot.
  await win.reload();
  await win.waitForSelector('.app-shell');
  await openCenter(win);
  await expect(bar).toHaveAttribute('value', String(download.firstBytes));
  await expect(install).toBeDisabled();
  await card.getByRole('button', { name: `查看扩展详情 ${name}` }).click();
  const detail = center.getByRole('article', { name });
  await expect(detail.locator('.ext-manager-icon [aria-hidden="true"]')).toHaveCSS('mask-image', /^url\(/);
  await win.evaluate(() => window.api.themes.activate('light', { scope: 'workspace' }));
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
  await win.locator('.ext-extension-manager').evaluate(element => { element.style.inlineSize = '390px'; });
  await expect(detail.getByRole('progressbar')).toHaveAttribute('value', String(download.firstBytes));
  expect(await detail.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await detail.screenshot({ path: info.outputPath('install-progress-light-narrow.png'), animations: 'disabled' });

  const attempt = await win.evaluateHandle((key) => {
    const seen: string[] = [];
    const unsubscribe = window.api.on('extensionCenter:installProgress', snapshot => {
      const progress = snapshot.active.find(item => item.packageKey === key)?.progress;
      if (progress) seen.push(progress.phase);
      else unsubscribe();
    });
    const duplicate = window.api.extensionCenter.install(key).catch(error => ({ error: String(error) }));
    return { seen, duplicate };
  }, packageKey);
  download.finish();
  await expect(detail.getByRole('button', { name: '已安装', exact: true })).toBeDisabled();
  await expect(detail.getByRole('progressbar')).toHaveCount(0);
  const result = await attempt.evaluate(async ({ seen, duplicate }) => ({ seen, duplicate: await duplicate }));
  expect(result.seen.filter(phase => phase !== 'downloading')).toEqual(['verifying', 'installing']);
  expect(result.duplicate).toMatchObject({ installed: true, skipped: false });
  expect(download.requests()).toBe(1);
});
