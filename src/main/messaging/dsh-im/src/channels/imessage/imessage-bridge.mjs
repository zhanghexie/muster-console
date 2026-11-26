import { TextChannelBridge, createTextBridgeStatus } from '../shared/text-channel-bridge.mjs';

export const IMESSAGE_DESCRIPTOR = Object.freeze({
  key: 'imessage',
  label: 'iMessage',
  connectionLabel: ' macOS Messages 连接',
  reactions: Object.freeze({ processing: '👀', success: '✅', error: '❌' }),
});

export class IMessageChannelBridge extends TextChannelBridge {
  constructor(options) {
    super({ ...options, descriptor: IMESSAGE_DESCRIPTOR });
  }
}

export { createTextBridgeStatus as createIMessageBridgeStatus };
