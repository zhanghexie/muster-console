import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { LogicalChannelService } from '../../src/main/messaging/logicalChannelService';
import { RemoteBindingService } from '../../src/main/messaging/remoteBindingService';
import type { WorkbenchRemoteInput } from '../../src/main/messaging/messagingHost';
import { registerMessagingIpc } from '../../src/main/ipc/messaging';
import type { AppContext } from '../../src/main/context';

const profile = process.env.MUSTER_CHANNEL_TEST_PROFILE!;
app.setPath('userData', profile);
let service: LogicalChannelService;
let bindings: RemoteBindingService;
let closing = false;
const sends: unknown[] = [], dispatches: unknown[] = [], replies: string[] = [];
let sequence = 0;

app.on('before-quit', event => {
  if (closing) return;
  event.preventDefault(); closing = true;
  bindings?.stopAdmission();
  void service?.stopAndWait().finally(() => app.quit());
});

void app.whenReady().then(async () => {
  globalThis.fetch = async () => { throw Error('Network disabled in isolated Channel test'); };
  bindings = new RemoteBindingService({ file: path.join(profile, 'bindings.json'), async dispatch(input, scope) {
    dispatches.push({ text: input.text, scope }); return { text: '已在目标会话受理：' + input.text };
  } });
  service = new LogicalChannelService({ file: path.join(profile, 'channels.sqlite'),
    workspaceIds: () => ['fixture-workspace', 'second-workspace'],
    workspaceExists: workspace => ['fixture-workspace', 'second-workspace'].includes(workspace),
    connected: async () => true,
    send: async (source, message, signal) => { signal.throwIfAborted(); sends.push({ source, message }); },
    remote: { intent: (input, scope) => bindings.intent(input, scope), handle: (input, scope) => bindings.handle(input, scope),
      manage: (scope, method, bindingId) => bindings.manageScope(scope, method, bindingId), revoke: scope => bindings.revokeScope(scope) }
  });
  const receive = async (text: string, senderId = 'fixture-owner', chatId = 'fixture-chat') => {
    const input: WorkbenchRemoteInput = { channelKey: 'weixin', botId: 'fixture-bot', conversationId: chatId,
      conversationLabel: '我的微信对话', senderLabel: '测试操作人', senderId, conversationType: 'direct', addressed: true,
      senderIsBot: false, messageId: `fixture-message-${++sequence}`, text,
      deliver: async (reply, signal) => { signal.throwIfAborted(); replies.push(reply.text); }
    };
    return service.receive(input);
  };
  await receive('发现此对话');
  registerMessagingIpc({ messagingChannels: service, messaging: {
    status: () => ({ state: 'ready', channels: [{ key: 'weixin', label: '微信', supported: true }] }),
    invoke: async () => ({ ok: true, value: { revision: 1, bots: [] } })
  } } as unknown as AppContext);
  ipcMain.handle('channels-fixture:receive', (_event, text: string, senderId?: string, chatId?: string) => receive(text, senderId, chatId));
  ipcMain.handle('channels-fixture:evidence', () => ({ sends, dispatches, replies }));
  const win = new BrowserWindow({ show: false, width: 1000, height: 900,
    webPreferences: { preload: process.env.MUSTER_CHANNEL_TEST_PRELOAD!, contextIsolation: true, sandbox: false, nodeIntegration: false } });
  await win.loadFile(process.env.MUSTER_CHANNEL_TEST_HTML!);
});
