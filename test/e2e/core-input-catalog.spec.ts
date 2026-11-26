import { _electron, expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

test('Core and settings read endpoint input specifications from the offline v2 cache', async ({}, info) => {
  const project = path.resolve(__dirname, '../..');
  const userData = path.join(info.outputDir, '.dev-sandbox', 'userData');
  const home = path.join(info.outputDir, 'home');
  const workspace = path.join(info.outputDir, 'workspace');
  const cache = path.join(userData, 'cache');
  for (const directory of [workspace, home, cache]) fs.mkdirSync(directory, { recursive: true });
  const baseUrl = 'https://fixture-provider.example/v1';
  const id = 'fixture-provider';
  const model = { id: 'catalog-chat', name: 'Catalog chat' };
  const relayed = { id: 'fixture-relay', name: 'Relay', baseUrl: 'https://relay.example/v1', apiKey: '', models: [model] };
  const provider = { id, name: 'Fixture provider', baseUrl, apiKey: '', models: [model] };
  const spec = { providerId: id, baseUrl, protocol: 'openai-completions', modelId: model.id,
    contextWindow: 65536, input: ['text'], verified: true, sources: ['https://fixture.example/models'] };
  fs.writeFileSync(path.join(cache, 'core-reasoning-v2.json'), JSON.stringify({ catalog: {
    schemaVersion: 2, revision: '2026-11-19.2',
    pi: { [id]: [{ id: model.id, api: spec.protocol, baseUrl, reasoning: true }] },
    models: [{ providerId: id, baseUrl, protocol: spec.protocol, modelId: model.id,
      reasoning: { format: 'openai-chat', effort: ['low', 'high'], canDisable: true }, sources: spec.sources }],
    capabilities: [spec]
  } }));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    locale: 'zh-CN', themeId: 'dark', defaultCwd: workspace, activeWorkspaceId: 'catalog-fixture',
    workspaces: [{ id: 'catalog-fixture', name: 'Fixture', path: workspace }], webAccess: { enabled: false },
    llm: { activeProviderId: id, activeModelId: model.id, providers: [provider, relayed] }
  }));
  const bootstrap = path.join(info.outputDir, 'electron-entry.cjs');
  fs.writeFileSync(bootstrap, `
    const { app } = require('electron');
    const home = ${JSON.stringify(home)};
    require('node:os').homedir = () => home;
    require('node:module').syncBuiltinESMExports();
    app.setPath('home', home);
    app.setPath('appData', home);
    app.setAppPath(${JSON.stringify(project)});
    require(${JSON.stringify(path.join(project, 'out/main/index.js'))});
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  Object.assign(env, { MUSTER_SANDBOX: '1', MUSTER_INSTANCE_ID: randomUUID(), MUSTER_WEB: '0' });
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_WEB_PORT', 'MUSTER_NO_SANDBOX']) delete env[name];
  const app = await _electron.launch({ executablePath: require('electron'), cwd: info.outputDir, env,
    args: [bootstrap, '--disable-gpu', '--no-proxy-server', '--host-resolver-rules=MAP muster-model-catalog.pages.dev ~NOTFOUND, MAP pi.dev ~NOTFOUND'] });
  try {
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor();
    await expect.poll(() => win.evaluate(() => window.api.chat.context())).toMatchObject({
      provider: id, modelId: model.id, contextWindow: 65536, supportsImages: false
    });
    for (const [providerId, supportsImages] of [[id, false], [relayed.id, true]] as const) {
      expect(await win.evaluate(selection => window.api.config.coreModelInput(selection),
        { providerId, modelId: model.id })).toEqual({ supportsImages });
    }
    await win.getByRole('button', { name: '设置', exact: true }).first().click();
    await win.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '模型与输入', exact: true }).click();
    const row = win.locator('.llm-model-row-item');
    await expect(row.getByText('64k')).toBeVisible();
    await expect(row.getByText('多模态')).toHaveCount(0);
    await row.getByTitle('编辑模型配置').click();
    const dialog = win.locator('.llm-model-dialog');
    await expect(dialog.getByLabel('上下文窗口')).toHaveValue('65536');
    await dialog.getByRole('button', { name: /高级$/ }).click();
    await expect(dialog.getByRole('checkbox', { name: '支持图片输入（多模态）' })).not.toBeChecked();
    await dialog.screenshot({ path: info.outputPath('cached-text-only.png'), animations: 'disabled' });
  } finally { await app.close(); }
});
