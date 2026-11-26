import { registerManagementRpc } from '../../../management-rpc.mjs';
import { resolveRpcAuthority } from '../../rpc-authority.mjs';
import { publicChannelInitializing, publicChannelStartupError } from './startup-error.mjs';
import { createConnectionDiagnostics, diagnosticRpcResult } from '../../../../src/channels/shared/connection-error.mjs';

/** Mount the native management RPC before any fallible production initialization. */
export async function installProductionChannel(ctx, config, {
  channel, rpcChannel, createProduction, createHandler, reportStartupError,
}) {
  let startupError = publicChannelInitializing(channel);
  let handler = async () => ({ ok: false, error: startupError });
  const logger = typeof ctx.logger === 'function' ? ctx.logger(`dsh-im:${channel}`) : (ctx.logger ?? console);
  const diagnostics = createConnectionDiagnostics({ channel, logger });
  const disposeRpc = registerManagementRpc(ctx, rpcChannel, async (endpoint, payload, signal) => {
    if (signal?.aborted) {
      return { ok: false, error: { code: 'cancelled', message: 'The request was cancelled.', details: {} } };
    }
    try { return await handler(endpoint, payload, signal); }
    catch (error) {
      // Preserve a final Host diagnostic if an endpoint misses its own catch.
      return diagnosticRpcResult(diagnostics, error, { ok: false, error: { code: `${channel}-operation-failed` } }, { operation: endpoint });
    }
  }, { authority: resolveRpcAuthority(config.rpcAuthority) });
  let production;
  let unregisterDelivery;
  let closing;
  const closeProduction = () => (closing ??= Promise.resolve().then(async () => {
    try {
      await unregisterDelivery?.();
      unregisterDelivery = undefined;
    } finally {
      await production?.close();
    }
  }).catch((error) => {
    closing = undefined;
    throw error;
  }));
  try {
    production = await createProduction();
    ctx.effect(() => closeProduction, `dsh-im: close ${channel} connections`);
    unregisterDelivery = config.deliveryService && production.deliveryAdapter
      ? config.deliveryService.registerAdapter(production.deliveryAdapter) : undefined;
    const readyHandler = createHandler(production.controller);
    handler = readyHandler;
  } catch (error) {
    startupError = reportStartupError
      ? reportStartupError(error, false)
      : diagnostics.report(error, { operation: 'startup', stage: 'startup.load', publicError: publicChannelStartupError(channel, error) }).publicError;
    try {
      await closeProduction();
    } catch (cleanupError) {
      if (reportStartupError) reportStartupError(cleanupError, true);
      else diagnostics.report(cleanupError, { operation: 'startup', stage: 'connection.stop', warning: true });
    }
  }
  return disposeRpc;
}
