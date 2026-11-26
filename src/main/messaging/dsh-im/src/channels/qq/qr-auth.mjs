import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function loadOptionalConnector(directory, callbacks, options) {
  let entry;
  try {
    if (!directory) throw new Error('No optional SDK directory');
    entry = createRequire(join(directory, 'loader.cjs')).resolve('@tencent-connect/qqbot-connector');
  } catch {
    throw Object.assign(new Error('QQ QR connector must be installed separately'), { code: 'qq-qr-connector-unavailable' });
  }
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let close;
  void import(pathToFileURL(entry).href).then(module => {
    if (signal.aborted) return;
    const start = module.startQrConnect ?? module.default?.startQrConnect;
    if (typeof start !== 'function') throw new TypeError('Missing QQ QR entry point');
    close = start(callbacks, { ...options, signal });
  }).catch(() => {
    if (!signal.aborted) callbacks.onFailure(Object.assign(new Error('QQ QR connector could not be loaded'), {
      code: 'qq-qr-connector-unavailable',
    }));
  });
  return () => {
    controller.abort();
    close?.();
  };
}

export class QqQrAuth {
  #start;
  #source;

  constructor({ start = (callbacks, options) => loadOptionalConnector(directory, callbacks, options),
    directory, source = 'deepseek-harness' } = {}) {
    if (typeof start !== 'function') throw new TypeError('QQ QR connector is required');
    this.#start = start;
    this.#source = source;
  }

  start(callbacks, { signal } = {}) {
    if (!callbacks || typeof callbacks.onSuccess !== 'function'
      || typeof callbacks.onFailure !== 'function') {
      throw new TypeError('QQ QR callbacks are required');
    }
    return this.#start(callbacks, {
      displayQrCodeToConsole: false,
      source: this.#source,
      signal,
    });
  }
}
