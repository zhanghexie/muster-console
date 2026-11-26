import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('文件树展开工作区外技能链接并只读预览', async ({ page }) => {
  test.setTimeout(90_000);
  const project = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'file-links-e2e-'));
  const userData = path.join(fixture, '.dev-sandbox/userData');
  const initial = path.join(fixture, '.dev-sandbox/workspaces/demo-frontend');
  const root = path.join(fixture, 'project');
  const target = path.join(fixture, 'outside-skills');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.mkdirSync(path.join(target, 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(target, 'my-skill', 'SKILL.md'), '# Linked Skill\nExternal skill content');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(target, path.join(root, '.agents', 'skills'), linkType);
  fs.symlinkSync(path.join(fixture, 'missing'), path.join(root, 'broken-link'), linkType);
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: initial,
    activeWorkspaceId: 'demo-frontend', workspaces: [{ id: 'demo-frontend', name: 'Test', path: initial }],
    openai: { baseUrl: '', apiKey: '', model: '' }, mcp: { enabled: false, servers: [] } }));
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: `file-links-${process.pid}`,
    MUSTER_WEB: '1', MUSTER_WEB_PORT: '0', MUSTER_WEB_HOST: '127.0.0.1'
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT']) delete env[key];
  const app = await _electron.launch({ executablePath: require('electron'), args: [project, '--disable-gpu', '--disable-software-rasterizer'], cwd: fixture, env });
  try {
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({ timeout: 60_000 });
    const opened = await win.evaluate(async root => (window as any).api.workspaces.open({ name: '链接测试',
      roots: [{ id: 'source', path: root }], defaultRootId: 'source', controlRootId: 'source' }), root);
    expect(opened.ok, opened.message).toBe(true);
    const ref = { workspaceId: opened.activeWorkspaceId, rootId: 'source', relativePath: '.agents/skills/my-skill' };
    const listing = await win.evaluate(async ref => (window as any).api.fs.listTreeDirRef(ref), ref);
    expect(listing.entries.find((entry: any) => entry.name === 'SKILL.md')?.externalPath).toBe(fs.realpathSync(path.join(target, 'my-skill', 'SKILL.md')));
    expect((await win.evaluate(async ref => (window as any).api.fs.writeTextRef({ ...ref, relativePath: `${ref.relativePath}/SKILL.md` }, 'bad'), ref)).ok).toBe(false);
    const web = await win.evaluate(() => (window as any).api.webAccess.status());
    expect(web.running, web.disabledReason).toBe(true);
    await page.goto(`http://127.0.0.1:${web.port}/?token=${encodeURIComponent(web.token)}`);
    await page.locator('.app-shell').waitFor();
    const webListing = await page.evaluate(async ref => (window as any).api.fs.listTreeDirRef(ref), ref);
    expect(webListing.entries.find((entry: any) => entry.name === 'SKILL.md')?.externalPath).toBe(listing.entries.find((entry: any) => entry.name === 'SKILL.md').externalPath);
    const webExpand = page.getByTitle('展开右侧栏', { exact: true });
    if (await webExpand.isVisible()) await webExpand.click();
    const webSide = page.locator('.side-tools-panel');
    await webSide.getByRole('tab', { name: '文件', exact: true }).click();
    const webTree = webSide.getByRole('tree', { name: 'project', exact: true });
    await webTree.getByText('.agents', { exact: true }).click();
    await webTree.getByText('skills', { exact: true }).click();
    await webTree.getByText('my-skill', { exact: true }).click();
    await webTree.getByText('SKILL.md', { exact: true }).click();
    await expect(webSide.getByText('外部文件 · 只读', { exact: true })).toBeVisible();
    await expect(webSide.locator('.files-panel.is-shown')).toContainText('External skill content');
    await page.goto('about:blank');
    const expandRight = win.getByTitle('展开右侧栏', { exact: true });
    if (await expandRight.isVisible()) await expandRight.click();
    const side = win.locator('.side-tools-panel');
    await side.getByRole('tab', { name: '文件', exact: true }).click();
    const tree = side.getByRole('tree', { name: 'project', exact: true });
    await tree.getByText('.agents', { exact: true }).click();
    await tree.getByText('skills', { exact: true }).click();
    await tree.getByText('my-skill', { exact: true }).click();
    await tree.getByText('SKILL.md', { exact: true }).click();
    await expect(side.getByText('外部文件 · 只读', { exact: true })).toBeVisible();
    await expect(side.locator('.files-panel.is-shown')).toContainText('External skill content');
    await expect(tree.getByText('无法读取文件', { exact: true })).toBeVisible();
    await tree.getByText('skills', { exact: true }).click({ button: 'right' });
    await expect(win.getByText('删除', { exact: true })).toHaveCount(0);
    await win.keyboard.press('Escape');
    await expect(tree.getByText('SKILL.md', { exact: true })).toBeVisible();
    const shots = path.join(project, '.tmp/ui-captures/file-tree-links');
    fs.mkdirSync(shots, { recursive: true });
    for (const theme of ['dark', 'light']) {
      expect((await win.evaluate(async id => (window as any).api.themes.activate(id), theme)).ok).toBe(true);
      await expect.poll(() => win.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      const container = tree.locator('..');
      const old = await container.getAttribute('style');
      for (const width of [280, 200]) {
        await container.evaluate((el, width) => { (el as HTMLElement).style.width = `${width}px`; }, width);
        await container.screenshot({ path: path.join(shots, `${theme}-${width}.png`) });
      }
      await container.evaluate((el, original) => { if (original === null) el.removeAttribute('style'); else el.setAttribute('style', original); }, old);
    }
    expect(fs.readFileSync(path.join(target, 'my-skill', 'SKILL.md'), 'utf8')).toContain('External skill content');
  } finally {
    await app.close();
    const relative = path.relative(fs.realpathSync(path.join(project, '.tmp')), fs.realpathSync(fixture));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('invalid temporary fixture path');
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
