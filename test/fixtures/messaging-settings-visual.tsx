import React from 'react';
import { createRoot } from 'react-dom/client';
import { applyLocaleSetting } from '@workbench/src/shared/i18n';
import { builtinTheme } from '@workbench/src/shared/theme';
import '@workbench/src/renderer/src/i18n';
import { RemoteAccessSettings } from '@workbench/src/renderer/src/components/settings/RemoteAccessSettings';
import { SettingsContent } from '@workbench/src/renderer/src/components/settings/SettingsContent';
import { applyTheme } from '@workbench/src/renderer/src/theme';

const channels = [
  ['telegram', 'Telegram'], ['weixin', '微信'], ['feishu', '飞书'], ['dingtalk', '钉钉'], ['wecom', '企业微信'],
  ['wecom-app', '企业微信应用'], ['qq', 'QQ'], ['slack', 'Slack'], ['discord', 'Discord'],
  ['whatsapp', 'WhatsApp'], ['imessage', 'iMessage'], ['matrix', 'Matrix'], ['email', '邮箱'], ['office', 'AI Office']
].map(([key, label]) => ({ key, label, supported: key !== 'imessage' }));
const calls: [string, string][] = [];
const unmocked: string[] = [];
const fixtureWindow = window as unknown as {
  __uiFixture: { calls: typeof calls; unmocked: typeof unmocked; approveWeixin: () => void; redeemWeixin: () => void };
  api: unknown;
};
let wechatConnected = false;
let bound = false;
let binding: { code: string; expiresAt: number } | null = null;
fixtureWindow.__uiFixture = {
  calls, unmocked,
  approveWeixin: () => { wechatConnected = true; },
  redeemWeixin: () => { binding = null; bound = true; }
};

const pattern = Array.from({ length: 21 }, (_, row) => Array.from({ length: 21 }, (_, col) =>
  ((row * row + col * col + row * col) % 7) < 3 ? `<rect x="${col + 2}" y="${row + 2}" width="1" height="1"/>` : ''
).join('')).join('');
const qrCodeDataUrl = 'data:image/svg+xml;base64,' + btoa(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25"><rect width="25" height="25" fill="white"/>${pattern}</svg>`
);
const provisioning = {
  attemptId: 'fixture-attempt', status: 'pending', pollIntervalMs: 800, expiresAt: Date.now() + 300_000, qrCodeDataUrl
};
const bots = [{
  botId: 'sample-telegram', connected: true,
  bot: { name: '生产线状态助手', username: 'fixture_status_bot', idMasked: '••••42' },
  workspace: '团队工作区/生产线', health: { summary: '消息通道运行正常' }
}];
const wechatBot = {
  botId: 'fixture-wechat', connected: true, bot: { name: '我的微信', accountIdMasked: '••••68' },
  workspace: '/private-agent-workspace', model: { provider: 'fixture', model: 'obsolete' }, agentPreset: 'fixture-agent-preset'
};

fixtureWindow.api = {
  app: { setChromeTheme: async () => ({ ok: true, material: 'solid' }) },
  webAccess: { status: async () => ({ running: false, urls: [], hook: null, disabledReason: '未启动' }) },
  on: () => () => {},
  messaging: {
    status: async () => ({ state: 'ready', channels }),
    cancel: async () => ({ ok: true }),
    async call(channel: string, method: string) {
      calls.push([channel, method]);
      if (channel === 'channels' && method === 'list') return { ok: true, value: [] };
      if (method === 'connection.status') {
        const accounts = channel === 'telegram' ? bots : channel === 'weixin' && wechatConnected ? [wechatBot] : [];
        return { ok: true, value: { revision: 1, bots: accounts } };
      }
      if (method === 'provision.begin') return { ok: true, value: provisioning };
      if (method === 'provision.poll') return {
        ok: true, value: wechatConnected ? { ...provisioning, status: 'connected', botId: wechatBot.botId } : provisioning
      };
      if (channel === 'weixin' && (method === 'remote.status' || method === 'remote.begin')) {
        if (method === 'remote.begin') binding = { code: '123456', expiresAt: Date.now() + 600_000 };
        return { ok: true, value: {
          ready: bound, binding, boundUsers: bound ? [{ id: 'fixture-owner', label: '已授权的微信用户', boundAt: Date.now() }] : []
        } };
      }
      unmocked.push(`${channel}:${method}`);
      return { ok: false, error: { code: 'fixture-unmocked' } };
    }
  }
};

applyLocaleSetting('zh-CN', 'zh-CN');
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 16, position: 'relative', zIndex: 100 }}>
    <SettingsContent><RemoteAccessSettings /></SettingsContent>
  </main>
);
