import { DiscordConfigStore } from '../../../../src/channels/discord/config-store.mjs';
import { DiscordController } from '../../../../src/channels/discord/discord-controller.mjs';
import { DiscordRuntime } from '../../../../src/channels/discord/discord-runtime.mjs';
import { DiscordStateStore } from '../../../../src/channels/discord/state-store.mjs';
import { createTokenProductionController } from '../shared/production.mjs';

export function createProductionController(ctx, config = {}, internals = {}) {
  return createTokenProductionController(ctx, config, internals, {
    channel: 'discord',
    ConfigStore: DiscordConfigStore,
    StateStore: DiscordStateStore,
    Controller: DiscordController,
    Runtime: DiscordRuntime,
  });
}
