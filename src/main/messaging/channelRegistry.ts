import { isMessagingId, type ChannelDescriptor } from './contracts';

/** Registry entries may pair their descriptor with a host-only connection factory. */
export class ChannelRegistry<Definition extends { readonly descriptor: ChannelDescriptor } = { readonly descriptor: ChannelDescriptor }> {
  private readonly definitions = new Map<string, Readonly<Definition>>();

  register(definition: Definition): void {
    const { descriptor } = definition;
    const { channelKey, displayName, connection, inbound, outbound, defaultTriggers, limits, documentationUrl } = descriptor;
    if (!isMessagingId(channelKey) || !isMessagingId(displayName) || !['polling', 'socket', 'webhook', 'local'].includes(connection) ||
        !Array.isArray(inbound) || !inbound.every(item => ['text', 'image', 'file', 'audio'].includes(item)) ||
        !Array.isArray(outbound) || !outbound.every(item => ['text', 'rich-text', 'image', 'file', 'card', 'typing', 'reaction'].includes(item)) ||
        !defaultTriggers || !['allowlist', 'off'].includes(defaultTriggers.direct) || !['mention', 'off', 'all'].includes(defaultTriggers.group) ||
        !limits || [limits.maxTextLength, limits.maxAttachmentBytes].some(value => value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) ||
        (documentationUrl !== undefined && (typeof documentationUrl !== 'string' || !documentationUrl.startsWith('https://')))) {
      throw new Error('Invalid messaging channel descriptor');
    }
    if (this.definitions.has(channelKey)) throw new Error('Messaging channel already registered');
    const snapshot = Object.freeze({
      channelKey, displayName, connection, documentationUrl,
      inbound: Object.freeze([...inbound]),
      outbound: Object.freeze([...outbound]),
      defaultTriggers: Object.freeze({ direct: defaultTriggers.direct, group: defaultTriggers.group }),
      limits: Object.freeze({ maxTextLength: limits.maxTextLength, maxAttachmentBytes: limits.maxAttachmentBytes })
    });
    this.definitions.set(channelKey, Object.freeze({ ...definition, descriptor: snapshot }));
  }

  get(channelKey: string): Readonly<Definition> | undefined {
    return this.definitions.get(channelKey);
  }

  list(): readonly Readonly<Definition>[] {
    return Array.from(this.definitions.values());
  }
}
