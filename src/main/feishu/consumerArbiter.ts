type Consumer = { owner: string; streams: Set<string> };
const consumers = new Map<string, Consumer>();

/** One main-process Feishu application owner across the SDK and CLI profiles. */
export function claimFeishuConsumer(appId: string, owner: string, event = 'im.message.receive_v1'): () => void {
  if (typeof appId !== 'string' || !/^cli_[A-Za-z0-9_-]{1,128}$/u.test(appId) || !owner || !event) {
    throw Object.assign(new Error('无法确认飞书应用身份，请检查已连接的应用。'), { code: 'feishu-account-unverified' });
  }
  const existing = consumers.get(appId);
  if (existing && (existing.owner !== owner || existing.streams.has(event))) {
    throw Object.assign(new Error('已有连接在使用同一个飞书应用。请在工作台关闭原连接后重试。'), { code: 'feishu-account-in-use' });
  }
  const consumer = existing ?? { owner, streams: new Set<string>() };
  consumer.streams.add(event);
  consumers.set(appId, consumer);
  let owned = true;
  return () => {
    if (!owned) return;
    owned = false;
    consumer.streams.delete(event);
    if (!consumer.streams.size && consumers.get(appId) === consumer) consumers.delete(appId);
  };
}
