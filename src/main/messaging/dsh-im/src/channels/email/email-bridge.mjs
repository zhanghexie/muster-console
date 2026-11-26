import { TextChannelBridge, createTextBridgeStatus } from '../shared/text-channel-bridge.mjs';

export const EMAIL_DESCRIPTOR = Object.freeze({
  key: 'email',
  label: 'Email',
  connectionLabel: ' IMAP/SMTP 邮箱',
  // Email has no reaction concept; the fields stay for descriptor parity.
  reactions: Object.freeze({ processing: '', success: '', error: '' }),
});

export class EmailChannelBridge extends TextChannelBridge {
  #useTransportMessageId;

  constructor(options) {
    super({ ...options, descriptor: EMAIL_DESCRIPTOR });
    this.#useTransportMessageId = options.useTransportMessageId === true;
  }

  accept(message) {
    const to = message?.replyTarget?.to;
    if (!to) return Promise.resolve();
    const id = this.#useTransportMessageId ? message.replyTarget.transportMessageId : message.messageId;
    return super.accept({ ...message, conversationId: to, ...(id == null ? {} : { nativeMessageId: String(id) }) });
  }
}

export { createTextBridgeStatus as createEmailBridgeStatus };
