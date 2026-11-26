import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures/electron';

test.use({ isolatedSandbox: true });

const previous = process.env.MUSTER_EXTENSION_E2E_PREVIOUS_PACKAGES;
const extensionIds = ['code-animation', 'dsh-media-desk', 'gomoku', 'guizang-design', 'library', 'rubiks-cube'];
test.skip(!previous, 'Requires the extracted previous official extension snapshots');

test('installs the six official releases and upgrades their historical versions', async ({ appCtx }, info) => {
  test.setTimeout(100_000);
  const { app, win } = appCtx;
  const profile = await app.evaluate(({ app }) => {
    if (process.env.MUSTER_SANDBOX !== '1') throw new Error('Expected isolated application storage');
    return app.getPath('userData');
  });
  expect(path.basename(path.resolve(profile, '..', '..'))).toMatch(/^muster-e2e-/);
  const installed = path.join(profile, 'extensions', 'global');

  const toggle = win.getByRole('button', { name: '展开实用工具' });
  if (await toggle.isVisible()) await toggle.click();
  await win.getByRole('listitem').filter({ hasText: '扩展管理' }).click();
  await win.getByRole('tab', { name: '扩展中心', exact: true }).click();
  const center = win.getByRole('tabpanel', { name: '扩展中心', exact: true });
  await expect(center.getByRole('button', { name: '查看扩展详情 五子棋' })).toBeVisible();
  const listing = await win.evaluate(() => window.api.extensionCenter.list());
  const official = listing.releases.filter(row => row.publisherId === 'muster' && extensionIds.includes(row.extensionId));
  expect(official.map(row => row.extensionId).sort()).toEqual(extensionIds);

  for (const release of official) {
    const result = await win.evaluate(key => window.api.extensionCenter.install(key), release.packageKey);
    expect(result, release.packageKey).toMatchObject({ installed: true, updated: false });
    const manifest = JSON.parse(await fs.readFile(path.join(installed, release.extensionId, 'extension.json'), 'utf8'));
    expect(manifest.version).toBe(release.version);
  }
  await center.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(center.getByRole('article').filter({ hasText: 'muster/gomoku' }).getByText('已安装', { exact: true }).first()).toBeVisible();
  await center.screenshot({ path: info.outputPath('official-packages-installed.png') });

  const fresh = path.join(profile, 'compatibility-fresh-packages');
  await fs.mkdir(fresh);
  for (const release of official) {
    const directory = path.join(installed, release.extensionId);
    await fs.rename(directory, path.join(fresh, release.extensionId));
    await fs.cp(path.join(previous!, release.extensionId), directory, { recursive: true, errorOnExist: true, force: false });
    const before = JSON.parse(await fs.readFile(path.join(directory, 'extension.json'), 'utf8'));
    expect(before.version).not.toBe(release.version);
    await fs.mkdir(path.join(directory, 'data'), { recursive: true });
    const data = path.join(directory, 'data', 'release-compatibility.txt');
    await fs.writeFile(data, 'retain across update');

    const result = await win.evaluate(key => window.api.extensionCenter.install(key), release.packageKey);
    expect(result, release.packageKey).toMatchObject({ installed: true, updated: true });
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'extension.json'), 'utf8'));
    expect(manifest.version).toBe(release.version);
    expect(await fs.readFile(data, 'utf8')).toBe('retain across update');
  }
  await center.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(center.getByRole('article').filter({ hasText: 'muster/gomoku' }).getByText('已安装', { exact: true }).first()).toBeVisible();
  await center.screenshot({ path: info.outputPath('official-packages-updated.png') });
});
