import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, repoRoot, test } from './fixtures/electron';

test.use({ isolatedSandbox: true });

test('一键打包从项目顶栏授权，并在绑定项目的终端运行 npm', async ({ appCtx }, info) => {
  const platform = {
    darwin: { label: 'macOS', script: 'build:mac', shellProfileId: 'zsh' },
    win32: { label: 'Windows', script: 'build:win', shellProfileId: 'powershell' },
    linux: { label: 'Linux', script: 'build:linux', shellProfileId: 'bash' }
  }[process.platform as 'darwin' | 'win32' | 'linux'];
  test.skip(!platform, '打包终端支持 macOS、Windows 和 Linux');

  const { app, win } = appCtx;
  // The isolated app fixture removes this directory after the terminal exits.
  const sandbox = await app.evaluate(() => process.cwd());
  const project = await realpath(await mkdtemp(path.join(sandbox, '打包项目 ')));
  const packagePath = path.join(project, 'package.json');
  const marker = path.join(project, 'built.json');
  await mkdir(path.join(project, 'node_modules', 'electron-builder'), { recursive: true });
  await writeFile(packagePath, JSON.stringify({
    name: 'build-package-e2e', version: '1.2.3', scripts: { [platform.script]: 'node build.cjs' }
  }));
  await writeFile(path.join(project, 'build.cjs'), `require('node:fs').writeFileSync('built.json', JSON.stringify({
    cwd: process.cwd(), version: require('./package.json').version
  }));`);

  const directory = path.join(repoRoot, 'resources', 'extensions', 'build-package');
  const installed = path.join(project, '.muster', 'extensions', 'build-package');
  await mkdir(path.dirname(installed), { recursive: true });
  await cp(directory, installed, { recursive: true });
  const trustInput = await win.evaluate(async projectRoot => {
    const { ok, activeWorkspaceId: workspaceId, message } = await window.api.workspaces.open(projectRoot);
    if (!ok || !workspaceId) throw new Error(message || '未能打开打包测试项目');
    const { sourceRootId, selectionRevision, listing } = await window.api.extensions.snapshot(workspaceId);
    const extension = listing.project.find(item => item.id === 'build-package');
    if (!extension) throw new Error('未发现项目版一键打包');
    const input = { scope: 'project' as const, workspaceId, sourceRootId, extensionId: extension.id };
    await window.api.extensions.setEnabled({ ...input, selectionRevision, enabled: true });
    return input;
  }, project);

  const toolbar = win.getByRole('button', { name: '一键打包', exact: true });
  const trustDialog = win.getByRole('dialog', { name: '允许运行「一键打包」？' });
  const isTrusted = () => win.evaluate(async input => (await window.api.extensionCatalog.trustStatus(input)).trusted, trustInput);
  const dialog = win.getByRole('dialog', { name: '一键打包 · Agent 提问' });
  const next = dialog.getByRole('button', { name: '确定', exact: true });
  const openPlatform = async (): Promise<void> => {
    await expect(dialog.getByRole('textbox')).toHaveValue('1.2.4');
    await next.click();
    await expect(dialog.getByText('选择目标平台', { exact: true })).toBeVisible();
  };

  await win.evaluate(async () => {
    await window.api.config.update({ locale: 'zh-CN' });
    await window.api.themes.activate('dark');
  });
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'dark');
  const before = await win.evaluate(() => window.api.sessions.list());
  await toolbar.click();
  const cancelTrust = trustDialog.getByRole('button', { name: '取消', exact: true });
  await expect(cancelTrust).toBeFocused();
  await win.screenshot({ path: info.outputPath('toolbar-development-trust-dark.png'), animations: 'disabled' });
  await win.keyboard.press('Escape');
  await expect(trustDialog).toBeHidden();
  await expect(dialog).toBeHidden();
  expect(await isTrusted()).toBe(false);

  await win.evaluate(() => window.api.themes.activate('light'));
  await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1100, 720));
  await toolbar.click();
  const confirmTrust = trustDialog.getByRole('button', { name: '信任并运行', exact: true });
  await expect(confirmTrust).toBeVisible();
  await win.screenshot({ path: info.outputPath('toolbar-development-trust-light.png'), animations: 'disabled' });
  await confirmTrust.click();
  await openPlatform();
  expect(await isTrusted()).toBe(true);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(toolbar).toBeEnabled();
  await expect(win.getByText(/Question was aborted before the user answered/)).toHaveCount(0);
  expect((await win.evaluate(() => window.api.sessions.list())).sessions.map(session => session.id))
    .toEqual(before.sessions.map(session => session.id));
  expect(JSON.parse(await readFile(packagePath, 'utf8')).version).toBe('1.2.3');

  await toolbar.click();
  await openPlatform();
  await expect(dialog.getByRole('radio').first()).toHaveText(`${platform.label}当前平台（默认）`);
  await dialog.getByRole('radio').first().click();
  await next.click();
  await expect(dialog.getByText(`确认执行打包命令？ npm version 1.2.4 --no-git-tag-version && npm run ${platform.script}`, { exact: true })).toBeVisible();
  await dialog.getByRole('radio', { name: '确认', exact: true }).click();
  await next.click();

  await expect.poll(() => existsSync(marker), { timeout: 20_000 }).toBe(true);
  expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({ cwd: project, version: '1.2.4' });
  const state = await win.evaluate(() => window.api.sessions.list());
  expect(state.sessions.find(session => session.id === state.activeId)).toMatchObject({
    name: '一键打包 v1.2.4', cwd: project, shellProfileId: platform.shellProfileId
  });

  const otherProject = await realpath(await mkdtemp(path.join(sandbox, '另一项目 ')));
  await win.evaluate(async projectRoot => {
    const result = await window.api.workspaces.open(projectRoot);
    if (!result.ok) throw new Error(result.message || '未能打开另一项目');
  }, otherProject);
  await expect(toolbar).toHaveCount(0);
});
