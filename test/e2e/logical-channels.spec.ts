import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { LogicalChannel, LogicalChannelMessagePage } from '../../src/shared/messagingChannels';

const root = path.resolve(__dirname, '../..');
const requireModule = createRequire(__filename);
type FixtureBridge = { receive(text: string, sender?: string, chat?: string): Promise<unknown>; evidence(): Promise<{ sends: { source: { conversationId: string }; message: { text: string } }[]; dispatches: { text: string; scope: { id: string; source: { conversationId: string } } }[]; replies: string[] }> };

test('Channel settings use real desktop IPC, persistent inbox, original-source replies and source-scoped remote authorization', async () => {
  fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const temp = fs.mkdtempSync(path.join(root, '.tmp/logical-channels-electron-'));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const main = path.join(temp, 'main.cjs'), renderer = path.join(temp, 'renderer.js');
    await build({ entryPoints: [path.join(root, 'test/fixtures/logical-channels-electron-main.ts')], outfile: main,
      bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' });
    await build({ entryPoints: [path.join(root, 'test/fixtures/logical-channels-electron-renderer.tsx')], outfile: renderer,
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
    const html = path.join(temp, 'index.html');
    fs.writeFileSync(html, `<!doctype html><html><head><link rel="stylesheet" href="${pathToFileURL(path.join(root, 'src/renderer/src/styles/base.css')).href}"><link rel="stylesheet" href="${pathToFileURL(path.join(temp, 'renderer.css')).href}"></head><body><div id="root"></div><script src="${pathToFileURL(renderer).href}"></script></body></html>`);
    fs.mkdirSync(path.join(temp, 'profile'));
    const env: NodeJS.ProcessEnv = { ...process.env, MUSTER_CHANNEL_TEST_PROFILE: path.join(temp, 'profile'), MUSTER_CHANNEL_TEST_HTML: html,
      MUSTER_CHANNEL_TEST_PRELOAD: path.join(root, 'test/fixtures/logical-channels-electron-preload.cjs') };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ executablePath: requireModule('electron') as string, args: [main], env: env as Record<string, string> });
    const page = await application.firstWindow();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const screenshotRoot = path.join(root, '.tmp/ui-captures/logical-channels');
    fs.mkdirSync(screenshotRoot, { recursive: true });
    const capture = async (state: string) => {
      for (const theme of ['dark', 'light'] as const) {
        await page.evaluate(mode => (window as unknown as { setChannelTestTheme(mode: 'light' | 'dark'): void }).setChannelTestTheme(mode), theme);
        for (const width of [1000, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
          expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
          await page.screenshot({ path: path.join(screenshotRoot, `${state}-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
        }
      }
      await page.setViewportSize({ width: 1000, height: 900 });
    };
    await page.getByText('新建 Channel', { exact: true }).click();
    await page.getByLabel('Channel 名称', { exact: true }).fill('项目 A');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByRole('heading', { name: '项目 A', exact: true })).toBeVisible();
    await page.getByText('添加消息源', { exact: true }).click();
    await page.getByRole('button', { name: '加入 Channel' }).click();
    await expect(page.getByText('消息源已加入。远程输入需单独授权。')).toBeVisible();
    await capture('channel');
    const channel = await page.evaluate(async () => {
      const result = await window.api.messaging.call('channels', 'list', {});
      if (!result.ok) throw Error('Could not read Channel');
      return (result.value as LogicalChannel[])[0];
    });
    await page.evaluate(async () => { await (window as unknown as { channelsFixture: FixtureBridge }).channelsFixture.receive('项目验收改到周四'); });
    const bindingEvidence = await page.evaluate(async channelId => {
      const initiallyBound = await window.api.messaging.call('channels', 'bindings.list', { workspaceId: 'fixture-workspace' });
      const unboundRead = await window.api.messaging.call('channels', 'messages.list', { workspaceId: 'fixture-workspace', channelId });
      const first = await window.api.messaging.call('channels', 'bindings.add', { workspaceId: 'fixture-workspace', channelId });
      const second = await window.api.messaging.call('channels', 'bindings.add', { workspaceId: 'second-workspace', channelId });
      return { initiallyBound, unboundRead, first, second };
    }, channel.id);
    expect(bindingEvidence.initiallyBound).toEqual({ ok: true, value: [] });
    expect(bindingEvidence.unboundRead.ok).toBe(false);
    expect(bindingEvidence.first.ok).toBe(true); expect(bindingEvidence.second.ok).toBe(true);
    const inbox = await page.evaluate(async channelId => {
      const result = await window.api.messaging.call('channels', 'messages.list', { workspaceId: 'fixture-workspace', channelId });
      if (!result.ok) throw Error('Could not read inbox');
      return result.value as LogicalChannelMessagePage;
    }, channel.id);
    expect(inbox.messages).toHaveLength(1); expect(inbox.messages[0].text).toBe('项目验收改到周四');
    const result = await page.evaluate(async ({ channelId, sourceId, messageId }) => {
      const denied = await window.api.messaging.call('channels', 'messages.reply', { workspaceId: 'fixture-workspace', channelId, messageId, text: '收到', requestId: 'read-only' });
      const changed = await window.api.messaging.call('channels', 'sources.update', { workspaceId: 'fixture-workspace', channelId, sourceId, permission: 'reply' });
      if (!changed.ok) throw Error('Could not grant reply');
      const sent = await window.api.messaging.call('channels', 'messages.reply', { workspaceId: 'fixture-workspace', channelId, messageId, text: '收到', requestId: 'reply-once' });
      const repeated = await window.api.messaging.call('channels', 'messages.reply', { workspaceId: 'fixture-workspace', channelId, messageId, text: '收到', requestId: 'reply-once' });
      return { denied, sent, repeated };
    }, { channelId: channel.id, sourceId: channel.sources[0].sourceId, messageId: inbox.messages[0].id });
    expect(result.denied.ok).toBe(false); expect(result.sent.ok).toBe(true); expect(result.repeated).toEqual(result.sent);
    const detached = await page.evaluate(async channelId => {
      for (const workspaceId of ['fixture-workspace', 'second-workspace']) {
        const response = await window.api.messaging.call('channels', 'bindings.remove', { workspaceId, channelId });
        if (!response.ok) throw Error('Could not unbind');
      }
      return window.api.messaging.call('channels', 'messages.list', { workspaceId: 'fixture-workspace', channelId });
    }, channel.id);
    expect(detached.ok).toBe(false);
    await page.getByRole('button', { name: '配置远程输入' }).click();
    await page.getByRole('button', { name: '启用并验证操作人' }).click();
    const code = await page.locator('.logical-channel-code code').textContent();
    expect(code).toMatch(/^\d{6}$/);
    await capture('remote-pairing');
    await page.evaluate(async code => { const bridge = (window as unknown as { channelsFixture: FixtureBridge }).channelsFixture;
      await bridge.receive(code!); await bridge.receive('继续处理前端'); await bridge.receive('未授权操作', 'different-person');
    }, code);
    await expect(page.getByText('仅下列操作人可以在此对话输入指令。')).toBeVisible();
    const evidence = await page.evaluate(() => (window as unknown as { channelsFixture: FixtureBridge }).channelsFixture.evidence());
    expect(evidence.sends).toHaveLength(1); expect(evidence.sends[0].source.conversationId).toBe('fixture-chat');
    expect(evidence.dispatches).toHaveLength(1); expect(evidence.dispatches[0].text).toBe('继续处理前端');
    expect(evidence.dispatches[0].scope.source.conversationId).toBe('fixture-chat');
    expect(evidence.dispatches[0].scope).not.toHaveProperty('workspaceId');
    expect(evidence.dispatches[0].scope).not.toHaveProperty('target');
    expect(evidence.replies.some(text => text.includes('继续处理前端'))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await application?.close();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  }
});
