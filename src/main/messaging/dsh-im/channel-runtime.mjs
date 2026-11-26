// Platform transport runtime for Channels.
import { join } from 'node:path';
import { createDeliveryService } from './adapters/host/delivery-service.mjs';
import { createMusterOutboundArtifact, releaseOutboundArtifact } from './src/channels/shared/semantic/artifact.mjs';
import { logicalDeliveryDraft } from './logical-delivery.mjs';

const channels = {
  'feishu': () => import('./adapters/host/channels/feishu/index.mjs'),
  'weixin': () => import('./adapters/host/channels/weixin/index.mjs'),
  'wecom': () => import('./adapters/host/channels/wecom/index.mjs'),
  'wecom-app': () => import('./adapters/host/channels/wecom-app/index.mjs'),
  'dingtalk': () => import('./adapters/host/channels/dingtalk/index.mjs'),
  'qq': () => import('./adapters/host/channels/qq/index.mjs'),
  'slack': () => import('./adapters/host/channels/slack/index.mjs'),
  'telegram': () => import('./adapters/host/channels/telegram/index.mjs'),
  'discord': () => import('./adapters/host/channels/discord/index.mjs'),
  'whatsapp': () => import('./adapters/host/channels/whatsapp/index.mjs'),
  'imessage': () => import('./adapters/host/channels/imessage/index.mjs'),
  'matrix': () => import('./adapters/host/channels/matrix/index.mjs'),
  'email': () => import('./adapters/host/channels/email/index.mjs'),
  'office': () => import('./adapters/host/channels/office/index.mjs'),
};

export function createRuntime() {
  const delivery = createDeliveryService();
  return {
    async sendLogicalText(source, message, signal) {
      signal?.throwIfAborted();
      const { draft, options } = logicalDeliveryDraft(source, message);
      await delivery.sendLogicalText(source.provider, source.botId, draft, message.text, { ...options, signal });
    },
    async install(channel, ctx, { dataDir, createOfficeHarness, dispatchRemote, claimFeishuConsumer, claimImapConsumer }) {
      if (!Object.hasOwn(channels, channel)) throw new Error('Unknown platform integration');
      const platform = await channels[channel]();
      if (ctx.admissionSignal?.aborted) return;
      const workspace = join(dataDir, 'im');
      return platform.apply(ctx, {
        storageRoot: dataDir,
        workspace,
        dataDir: join(dataDir, 'integrations', `dsh-${channel}`),
        deliveryService: delivery,
        internals: {
          ...(channel === 'office' ? {
            createOfficeHarness: (options) => createOfficeHarness({
              ungroupedWorkspace: workspace,
              ...options,
              createArtifact: createMusterOutboundArtifact,
              releaseArtifact: releaseOutboundArtifact,
            }),
          } : {
            receiveChannelMessage: (input, reply) => dispatchRemote({ ...input, channelKey: channel }, reply),
          }),
          ...(channel === 'feishu' && claimFeishuConsumer && { claimFeishuConsumer }),
          ...(channel === 'email' && claimImapConsumer && { claimImapConsumer }),
          qqConnectorDirectory: join(dataDir, 'optional-connectors', 'qq'),
        },
      });
    },
  };
}
