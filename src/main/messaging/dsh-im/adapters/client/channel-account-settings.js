import * as React from 'react';
import { DiscordSettingsTab } from './channels/discord/index.js';
import { installDiscordStyles } from './channels/discord/styles.js';
import { DingtalkSettingsTab } from './channels/dingtalk/index.js';
import { installDingtalkStyles } from './channels/dingtalk/styles.js';
import { EmailSettingsTab } from './channels/email/index.js';
import { installEmailStyles } from './channels/email/styles.js';
import { FeishuSettingsTab } from './channels/feishu/index.js';
import { installFeishuStyles } from './channels/feishu/styles.js';
import { IMessageSettingsTab } from './channels/imessage/index.js';
import { installIMessageStyles } from './channels/imessage/styles.js';
import { MatrixSettingsTab } from './channels/matrix/index.js';
import { installMatrixStyles } from './channels/matrix/styles.js';
import { OfficeSettingsTab } from './channels/office/index.js';
import { installOfficeStyles } from './channels/office/styles.js';
import { QqSettingsTab } from './channels/qq/index.js';
import { installQqStyles } from './channels/qq/styles.js';
import { SlackSettingsTab } from './channels/slack/index.js';
import { installSlackStyles } from './channels/slack/styles.js';
import { TelegramSettingsTab } from './channels/telegram/index.js';
import { installTelegramStyles } from './channels/telegram/styles.js';
import { WecomSettingsTab } from './channels/wecom/index.js';
import { installWecomStyles } from './channels/wecom/styles.js';
import { WecomAppSettingsTab } from './channels/wecom-app/index.js';
import { installWecomAppStyles } from './channels/wecom-app/styles.js';
import { WeixinSettingsTab } from './channels/weixin/index.js';
import { installWeixinStyles } from './channels/weixin/styles.js';
import { WhatsappSettingsTab } from './channels/whatsapp/index.js';
import { installWhatsappStyles } from './channels/whatsapp/styles.js';
import { en, ru, zh, setImTranslator } from './i18n.js';
import { installImStyles } from './styles.js';
import { AccountDisclosureContext } from './channels/shared/collapsible-account.js';

const h = React.createElement;

const tabs = {
  feishu: FeishuSettingsTab,
  weixin: WeixinSettingsTab,
  dingtalk: DingtalkSettingsTab,
  wecom: WecomSettingsTab,
  'wecom-app': WecomAppSettingsTab,
  qq: QqSettingsTab,
  slack: SlackSettingsTab,
  telegram: TelegramSettingsTab,
  discord: DiscordSettingsTab,
  whatsapp: WhatsappSettingsTab,
  imessage: IMessageSettingsTab,
  matrix: MatrixSettingsTab,
  email: EmailSettingsTab,
  office: OfficeSettingsTab,
};

export function installChannelAccountStyles() {
  const selector = 'style[data-plugin-css^="muster-channel-"]';
  const existing = new Set(document.querySelectorAll(selector));
  // Keep the same cascade as the reference settings entry, with the common
  // styles after channel-specific defaults.
  const install = [
    installDingtalkStyles, installDiscordStyles, installFeishuStyles, installWeixinStyles,
    installWecomStyles, installWecomAppStyles, installQqStyles, installSlackStyles,
    installTelegramStyles, installWhatsappStyles, installIMessageStyles, installEmailStyles,
    installMatrixStyles, installOfficeStyles, installImStyles,
  ];
  const dispose = install.map(add => add());
  for (const style of document.querySelectorAll(selector)) {
    if (existing.has(style)) continue;
    const css = style.textContent;
    style.textContent = `@scope (.muster-messaging-settings, body > .dim-aliasDialog, body > .dim-contextBackdrop, body > .dim-botNameTooltip) {\n${css}\n}`;
  }
  return () => { for (const remove of dispose.reverse()) remove(); };
}

export function setChannelAccountLocale(language) {
  const base = String(language || 'zh').split('-')[0];
  const dictionary = base === 'zh' ? zh : base === 'ru' ? ru : en;
  setImTranslator(key => String(dictionary[key] ?? key));
}

export function ChannelAccountSettings({ channel, call, disclosure }) {
  const rpcCall = React.useCallback((method, payload = {}, signal) =>
    call(channel, method, payload, signal), [channel, call]);
  const Tab = tabs[channel];
  if (!Tab) return null;
  return h(AccountDisclosureContext.Provider, { value: disclosure },
    h('div', { className: 'dim-page dim-panel muster-channel-account-settings' }, h(Tab, { rpcCall })));
}
