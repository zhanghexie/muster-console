/**
 * 桌面 preload 的 `window.api` 位置参数 → 网关 invoke 单对象 payload 的打包表。
 *
 * 桌面调用是多位置参数、preload/主进程收单对象。漏打包会让 handler 解构出的
 * 字段全为 undefined——GUI 聊天消息静默发不出去 / 忙时误插话的根因。
 * 契约以 src/preload/index.ts 为准；纯函数便于 test/web-api-packing.mjs 守字段齐全。
 */

export type ArgPacker = (args: unknown[]) => unknown[];

/** 第 4 参是可选 opts 对象时并进 payload（与 preload `...opts` 语义一致） */
function withOpts(base: Record<string, unknown>, opts: unknown): Record<string, unknown> {
  return { ...base, ...(opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {}) };
}

export const ARG_PACKERS: Record<string, ArgPacker> = {
  'agentSession:send': (a) => [withOpts({ sessionId: a[0], text: a[1], images: a[2] }, a[3])],
  'agentSession:setMode': (a) => [{ sessionId: a[0], mode: a[1] }],
  'agentSession:setNativeConfig': (a) => [{ sessionId: a[0], change: a[1] }],
  'agentSession:setPiMode': (a) => [{ sessionId: a[0], modeId: a[1] }],
  'agentSession:setModel': (a) => [{ sessionId: a[0], model: a[1], ...(a[2] !== undefined ? { expected: a[2] } : {}) }],
  'agentSession:setThinking': (a) => [{ sessionId: a[0], level: a[1] }],
  'agentSession:setModelParameters': (a) => [{ sessionId: a[0], changes: a[1] }],
  'agentSession:planAction': (a) => [{ sessionId: a[0], action: a[1] }],
  'agentSession:cancelQueued': (a) => [{ sessionId: a[0], messageId: a[1] }],
  'agentSession:editQueued': (a) => [{ sessionId: a[0], messageId: a[1], text: a[2] }],
  'agentSession:reorderQueued': (a) => [{ sessionId: a[0], orderedIds: a[1] }],
  'agentSession:fork': (a) => [{ sessionId: a[0], uptoMessageId: a[1] }],
  'codex:listModels': (a) => [{ ...(typeof a[0] === 'string' ? { sessionId: a[0] } : { source: a[0] }), refresh: a[1] }]
};

/** 有打包器则打包，否则原样位置参数（与 preload 单参/无参通道一致） */
export function packInvokeArgs(channel: string, args: unknown[]): unknown[] {
  const pack = ARG_PACKERS[channel];
  return pack ? pack(args) : args;
}
