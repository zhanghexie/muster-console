import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { MessagingHost } from '../../src/main/messaging/messagingHost';
import { LogicalChannelService } from '../../src/main/messaging/logicalChannelService';
import { RemoteBindingService } from '../../src/main/messaging/remoteBindingService';
import { registerMessagingIpc } from '../../src/main/ipc/messaging';
import type { AppContext } from '../../src/main/context';

const profile = process.env.MUSTER_MESSAGING_E2E_PROFILE!;
app.setPath('userData', profile);
let host: MessagingHost;
let channels: LogicalChannelService;
let quitting = false;
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  void Promise.allSettled([host?.stopAndWait(), channels?.stopAndWait()]).finally(() => app.quit());
});
void app.whenReady().then(async () => {
  // The fixture never connects external accounts or reads the real profile.
  globalThis.fetch = async () => { throw new Error('External requests are disabled in this fixture'); };
  const bindings = new RemoteBindingService({ file: path.join(profile, 'fixture-remote-bindings.json'),
    async dispatch() { throw new Error('Remote execution is disabled in this fixture'); } });
  app.once('before-quit', () => bindings.stopAdmission());
  channels = new LogicalChannelService({
    file: path.join(profile, 'channels.sqlite'),
    workspaceIds: () => ['fixture-workspace'],
    workspaceExists: id => id === 'fixture-workspace',
    connected: (channel, id, signal) => host.accountConnected(channel, id, signal),
    send: (source, message, signal) => host.sendLogicalText(source, message, signal),
    remote: { intent: (input, scope) => bindings.intent(input, scope), handle: (input, scope) => bindings.handle(input, scope),
      manage: (scope, method, id) => bindings.manageScope(scope, method, id), revoke: scope => bindings.revokeScope(scope) }
  });
  host = new MessagingHost({ dataDir: path.join(profile, 'messaging'),
    credentials: { async resolve() { return undefined; }, async describe() { return { configured: false }; },
      async set() { throw new Error('Accounts are disabled in this fixture'); }, async unset() {} },
    createOfficeHarness: () => { throw new Error("No Office account is configured in this fixture"); },
    handleRemote: input => channels.receive(input),
    beforeAccountRemoval: (channel, botId, deleting) => {
      channels.revokeAccount(channel, botId, deleting);
      bindings.revokeAccount(channel, botId);
    },
  });
  registerMessagingIpc({ messaging: host, messagingChannels: channels } as AppContext);
  host.start();
  const win = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { preload: process.env.MUSTER_MESSAGING_E2E_PRELOAD!, contextIsolation: true, sandbox: false, nodeIntegration: false } });
  await win.loadFile(process.env.MUSTER_MESSAGING_E2E_HTML!);
});
