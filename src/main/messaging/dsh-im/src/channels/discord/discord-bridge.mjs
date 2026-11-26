import { TextChannelBridge, createTextBridgeStatus } from '../shared/text-channel-bridge.mjs';

export const DISCORD_DESCRIPTOR = Object.freeze({
  key: 'discord',
  label: 'Discord',
  connectionLabel: ' Gateway 长连接',
  reactions: Object.freeze({ processing: '👀', success: '✅', error: '❌' }),
});

export class DiscordChannelBridge extends TextChannelBridge {
  constructor(options) {
    super({ descriptor: DISCORD_DESCRIPTOR, ...options });
  }
}

export { createTextBridgeStatus as createDiscordBridgeStatus };
