/** Production receiver/store, Electron preload and Channel phone; initial Feishu events are synthetic. */
import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';
import type { AgentAppsService as Service } from '../../src/main/agentApps/service';
import { CHANNEL_APP_ID } from '../../src/shared/agentApps';

test('已有飞书私信和群消息通过真实手机 IPC 迁移到统一渠道', async () => {
  test.setTimeout(80_000);
  const root = path.resolve(__dirname, '../..');
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const fixture = fs.mkdtempSync(path.join(root, '.tmp/phone-feishu-e2e-'));
  const data = path.join(fixture, '.dev-sandbox/userData'), project = path.join(fixture, 'work'), otherProject = path.join(fixture, 'other-work');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(project); fs.mkdirSync(otherProject);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ locale: 'zh-CN', workspace: project, activeWorkspaceId: 'phone-test', workspaces: [
    { id: 'phone-test', name: '应用实验室', path: project }, { id: 'phone-second', name: '第二工作区', path: otherProject }
  ], mcp: { enabled: false, servers: [] } }));
  const receiverBundle = path.join(fixture, 'receiver.cjs');
  buildSync({ entryPoints: [path.join(root, 'src/main/agentApps/service.ts')], outfile: receiverBundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { AgentAppsService } = require(receiverBundle) as { AgentAppsService: typeof Service };
  const receiver = new AgentAppsService({
    root: path.join(data, 'agent-apps'), workspaces: () => ['phone-test'], emit: () => {},
    encrypt: value => value, decrypt: value => value, confirmSend: async () => false, deliver: async () => ({ muted: true }),
    connectors: { listFeishuChats: async () => ({ chats: [] }), feed: async () => [], sync: async () => ({ records: [], cursor: {} }), test: async () => {}, send: async () => { throw new Error('No external sends in this fixture'); } }
  });
  receiver.start();
  receiver.receiveFeishuMessage('phone-test', { messageId: 'om_private', chatId: 'oc_fixture_private', sender: '小王', body: '第一条私信', date: new Date().toISOString() }, { type: 'p2p', name: '小王' });
  receiver.receiveFeishuMessage('phone-test', { messageId: 'om_marked', chatId: 'oc_fixture_private', sender: '未知发送者', body: '此消息已撤回', date: new Date().toISOString() }, { type: 'p2p', name: '小王' }, { sender: 'message-unknown-sender', body: 'message-withdrawn' });
  receiver.receiveFeishuMessage('phone-test', { messageId: 'om_legacy', chatId: 'oc_fixture_private', sender: '未知发送者', body: '此消息已撤回', date: new Date().toISOString() }, { type: 'p2p', name: '小王' });
  receiver.receiveFeishuMessage('phone-test', { messageId: 'om_group', chatId: 'oc_fixture_news', sender: '小李', body: '@手机 第一条群消息', date: new Date().toISOString() }, { type: 'group', mentionedBot: true, name: '行业信息' });
  receiver.store.transact('phone-test', state => { for (const event of state.outbox) event.deliveredAt = Date.now(); });
  receiver.stop();
  receiver.store.close?.();
  const captures = path.join(root, '.tmp/ui-captures/phone-feishu-setup'); fs.mkdirSync(captures, { recursive: true });
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'MUSTER_NO_SANDBOX', 'MUSTER_DEVTOOLS_PORT', 'MUSTER_WEB_PORT']) delete env[key];
  env.MUSTER_SANDBOX = '1'; env.MUSTER_INSTANCE_ID = `feishu-test-${process.pid}`;
  const app = await _electron.launch({ executablePath: require('electron'), args: [root], cwd: fixture, env });
  try {
    const win = await app.firstWindow(); const errors: string[] = []; win.on('pageerror', error => errors.push(error.message));
    await win.locator('.app-shell').waitFor({ timeout: 45_000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 850));
    await win.getByRole('button', { name: '对话', exact: true }).first().click();
    await win.locator('.agent-phone-toggle').click();
    const phone = win.getByRole('region', { name: /(?:的手机| phone)$/ });
    await expect(phone.getByRole('button', { name: '短信', exact: true })).toHaveCount(0);
    await expect(phone.getByRole('button', { name: '邮箱', exact: true })).toHaveCount(0);
    await phone.getByRole('button', { name: 'Channel', exact: true }).click();
    await expect(phone.getByRole('button', { name: /小王/ })).toBeVisible();
    await expect(phone.getByRole('button', { name: /行业信息/ })).toBeVisible();
    await phone.screenshot({ path: path.join(captures, 'channel-list.png'), animations: 'disabled' });
    await phone.getByRole('button', { name: '绑定 Channel', exact: true }).click();
    await expect(phone.getByRole('button', { name: '解除绑定 小王', exact: true })).toBeVisible();
    await phone.screenshot({ path: path.join(captures, 'channel-bindings-dark.png'), animations: 'disabled' });
    await phone.getByRole('button', { name: '解除绑定 小王', exact: true }).click();
    await expect(phone.getByRole('button', { name: '绑定 小王', exact: true })).toBeVisible();
    await phone.getByRole('button', { name: '返回', exact: true }).click();
    await expect(phone.getByRole('button', { name: /小王/ })).toHaveCount(0);
    await expect(phone.getByRole('button', { name: /行业信息/ })).toBeVisible();
    await phone.getByRole('button', { name: '绑定 Channel', exact: true }).click();
    await phone.getByRole('button', { name: '绑定 小王', exact: true }).click();
    await expect(phone.getByRole('button', { name: '解除绑定 小王', exact: true })).toBeVisible();
    await win.evaluate(() => window.api.themes.activate('light'));
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
    await phone.screenshot({ path: path.join(captures, 'channel-bindings-light.png'), animations: 'disabled' });
    await phone.getByRole('button', { name: '返回', exact: true }).click();
    const shared = await win.evaluate(async appId => {
      const catalog = await window.api.agentApps.query('phone-second', { appId, viewId: 'bindings' });
      const entry = catalog.channelCatalog!.find(item => item.name === '小王')!;
      const before = await window.api.agentApps.query('phone-second', { appId });
      await window.api.agentApps.call('phone-second', { appId, commandId: 'bind', params: { channelId: entry.id } });
      const after = await window.api.agentApps.query('phone-second', { appId, channelId: entry.id });
      const message = after.channelMessages!.messages.find(item => item.text === '第一条私信')!;
      await window.api.agentApps.call('phone-second', { appId, commandId: 'state', params: { channelId: entry.id, messageId: message.id, read: true } });
      const owner = await window.api.agentApps.query('phone-test', { appId, channelId: entry.id });
      const second = await window.api.agentApps.query('phone-second', { appId, channelId: entry.id });
      return { entry, before, ownerRead: owner.channelMessages!.messages.find(item => item.text === '第一条私信')!.read,
        secondRead: second.channelMessages!.messages.find(item => item.text === '第一条私信')!.read };
    }, CHANNEL_APP_ID);
    expect(shared.entry.bound).toBe(false); expect(shared.before.channels).toEqual([]);
    expect(shared.ownerRead).toBe(false); expect(shared.secondRead).toBe(true);
    await phone.getByRole('button', { name: /小王/ }).click();
    await expect(phone.getByText('此消息已撤回', { exact: true })).toHaveCount(2);
    await win.evaluate(() => window.api.config.update({ locale: 'en' }));
    await expect(phone.getByText('This message was withdrawn.', { exact: true })).toBeVisible();
    await expect(phone.getByText('此消息已撤回', { exact: true })).toBeVisible();
    await expect(phone.getByText('Unknown sender', { exact: true })).toBeVisible();
    await win.evaluate(() => window.api.themes.activate('light'));
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'light');
    await phone.screenshot({ path: path.join(captures, 'channel-messages-en-light.png'), animations: 'disabled' });
    await win.evaluate(() => window.api.config.update({ locale: 'zh-CN' }));
    await expect(phone.getByText('此消息已撤回', { exact: true })).toHaveCount(2);
    await phone.getByRole('button', { name: '返回', exact: true }).click();
    await phone.getByRole('button', { name: /行业信息/ }).click();
    await phone.getByRole('button', { name: /@手机 第一条群消息/ }).click();
    await expect(phone.getByText('@手机 第一条群消息', { exact: true })).toBeVisible();
    await phone.getByRole('button', { name: '标为已处理' }).click();
    await expect(phone.getByRole('button', { name: '标为未处理' })).toBeVisible();
    await expect(phone.getByRole('button', { name: '标为已读' })).toBeVisible();
    await win.evaluate(() => window.api.themes.activate('dark'));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(790, 760));
    await phone.screenshot({ path: path.join(captures, 'channel-message-dark-narrow.png'), animations: 'disabled' });
    const channels = await win.evaluate(appId => window.api.agentApps.query('phone-test', { appId }), CHANNEL_APP_ID);
    const channel = channels.channels!.find(c => c.name === '行业信息')!;
    const received = await win.evaluate(({ appId, channelId }) => window.api.agentApps.query('phone-test', { appId, channelId }), { appId: CHANNEL_APP_ID, channelId: channel.id });
    expect(received.channelMessages?.messages).toEqual([expect.objectContaining({ text: '@手机 第一条群消息', processed: true, read: false })]);
    expect(errors).toEqual([]);
    fs.writeFileSync(path.join(captures, 'evidence.json'), JSON.stringify({ platform: process.platform, fixture, mocked: ['incoming event payloads'], messageCount: received.channelMessages?.messages.length, errors }, null, 2));

  } finally { await app.close(); }
});
