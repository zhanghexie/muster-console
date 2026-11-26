/** Register a provider's management actions within the owning Channels host. */
export function registerManagementRpc(ctx, channel, handler) {
  const key = channel.slice(1);
  if (channel[0] !== '/' || !/^[a-z-]+$/.test(key)) throw new TypeError('Invalid message channel');
  return ctx.registerChannel(key, async (method, payload, signal) => {
    const result = await handler(method, payload, signal);
    return result?.ok === false
      ? { ...result, error: { ...result.error, details: result.error?.details ?? {} } }
      : result;
  });
}
