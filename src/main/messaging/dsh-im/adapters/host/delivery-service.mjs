import { normalizeDeliveryTarget } from './delivery-adapter.mjs';

const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const DRAFT_TARGET_ID = '__test__';

const ADAPTER_METHODS = ['ownsBot', 'sendText'];

const DELIVERY_ERROR_CODES = new Set([
  'ds-bot-unavailable',
  'ds-bot-not-found',
  'ds-bot-bound',
  'ds-bot-private-required',
  'ds-bot-binding-conflict',
  'bad-request',
  'account-unverified',
  'account-changed',
  'target-changed',
  'capability-unavailable',
  'unknown-bot',
  'unknown-target',
  'target-conflict',
  'invalid-target',
  'bot-not-connected',
  'target-rejected',
  'delivery-failed',
  'send-result-unknown',
  'session-sync-unavailable',
  'cancelled',
  'provider-unavailable',
  'consumer-unavailable',
  'consumer-conflict',
  'ingress-not-accepted',
  'invalid-inbound',
  'stale-route',
  'reply-result-unknown',
  'history-permission-denied',
  'history-unavailable',
  'thread-unavailable',
  'delivery-context-unavailable',
  'untrusted-source',
]);

function deliveryError(code, message = code, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function botIdOf(value) {
  if (typeof value !== 'string' || !BOT_ID_PATTERN.test(value)) {
    throw deliveryError('bad-request', 'Invalid bot id');
  }
  return value;
}

function draftTargetObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'kind') || !Object.hasOwn(value, 'route')) {
    throw deliveryError('bad-request', 'Invalid delivery target');
  }
  return value;
}

function cancellation(signal) {
  if (signal?.aborted) throw deliveryError('cancelled', 'Request cancelled');
}

function publicOperationError(error, fallback = 'delivery-failed') {
  if (error?.code === 'workspace-bot-not-found') {
    return deliveryError('unknown-bot', 'Unknown bot', { cause: error });
  }
  if (DELIVERY_ERROR_CODES.has(error?.code)) return error;
  return deliveryError(fallback, fallback, { cause: error });
}

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object'
    || typeof adapter.channel !== 'string' || !CHANNEL_PATTERN.test(adapter.channel)) {
    throw new TypeError('A delivery adapter with a valid channel is required');
  }
  for (const method of ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(`A complete delivery adapter is required (${method})`);
    }
  }
  return adapter;
}

class DeliveryService {
  #adapters = new Map();

  registerAdapter(value) {
    const adapter = validateAdapter(value);
    this.#adapters.get(adapter.channel)?.controller.abort(deliveryError('provider-unavailable'));
    const registration = Object.freeze({ adapter, controller: new AbortController() });
    this.#adapters.set(adapter.channel, registration);
    return () => {
      if (this.#adapters.get(adapter.channel) !== registration) return false;
      this.#adapters.delete(adapter.channel);
      registration.controller.abort(deliveryError('provider-unavailable'));
      return true;
    };
  }

  async sendLogicalText(channel, botId, draft, text, { signal, ...options } = {}) {
    const id = botIdOf(botId);
    const target = normalizeDeliveryTarget(channel, { targetId: DRAFT_TARGET_ID, ...draftTargetObject(draft) });
    if (typeof text !== 'string' || !text.trim() || text.length > 64 * 1024) throw deliveryError('bad-request');
    cancellation(signal);
    const registration = this.#adapters.get(channel);
    if (!registration) throw deliveryError('provider-unavailable');
    const { adapter, controller } = registration;
    const sendSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    if (!await adapter.ownsBot(id)) throw deliveryError('unknown-bot');
    this.#assertRegistered(registration);
    cancellation(sendSignal);
    try {
      await adapter.sendText(id, target, text, { ...options, signal: sendSignal });
    } catch (error) {
      // Once a provider operation starts, an interruption may follow an
      // accepted delivery. Never retry it through another route.
      throw publicOperationError(error, 'send-result-unknown');
    }
  }

  #assertRegistered(registration) {
    if (this.#adapters.get(registration.adapter.channel) !== registration) {
      throw deliveryError('capability-unavailable');
    }
  }

}

export function createDeliveryService() {
  return new DeliveryService();
}
