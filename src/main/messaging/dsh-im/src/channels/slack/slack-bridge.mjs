import { TextChannelBridge, createTextBridgeStatus } from '../shared/text-channel-bridge.mjs';

export const SLACK_DESCRIPTOR = Object.freeze({
  key: 'slack',
  label: 'Slack',
  connectionLabel: ' Socket Mode 长连接',
  reactions: Object.freeze({
    processing: 'eyes',
    success: 'white_check_mark',
    error: 'x',
  }),
});

export class SlackChannelBridge extends TextChannelBridge {
  constructor(options) {
    super({ descriptor: SLACK_DESCRIPTOR, ...options });
  }
}

export { createTextBridgeStatus as createSlackBridgeStatus };
