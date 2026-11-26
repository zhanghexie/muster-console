import { join, resolve } from 'node:path';

import { OfficeConfigStore } from '../../../../src/channels/office/config-store.mjs';
import { OfficeController } from '../../../../src/channels/office/office-controller.mjs';
import { OfficeRuntime } from '../../../../src/channels/office/office-runtime.mjs';

export function officePaths(config = {}) {
  const storageRoot = resolve(config.storageRoot ?? config.dataDir);
  const root = resolve(config.dataDir ?? join(storageRoot, 'integrations', 'dsh-office'));
  return { root, config: resolve(config.configPath ?? join(root, 'config.json')) };
}

export async function createProductionController(ctx, config = {}, internals = {}) {
  const Store = internals.ConfigStore ?? OfficeConfigStore;
  const Controller = internals.Controller ?? OfficeController;
  const Runtime = internals.Runtime ?? OfficeRuntime;
  const paths = officePaths(config);
  const configStore = await new Store(paths.config).load();
  const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-im:office') : (ctx.logger ?? console);
  const createOfficeHarness = internals.createOfficeHarness;
  if (typeof createOfficeHarness !== 'function') throw new TypeError('Office requires a session client factory');
  const controller = new Controller({
    credentials: ctx.credentials,
    configStore,
    logger,
    createRuntime: (options) => new Runtime({
      ...options,
      createHarness: ({ workspace }) => createOfficeHarness({ workspace }).forBot(options.config.deviceId),
      ...(internals.transport ? { transport: internals.transport } : {}),
    }),
  });
  await controller.initialize();
  return { controller, close: () => controller.close(), paths };
}
