import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CapabilityRegistry } from '../runtimeKernel/capabilityRegistry';
import type { LifecycleScope } from '../runtimeKernel/lifecycleScope';
import { randomUUID } from 'node:crypto';
import { PermissionGate, type RunContext } from '../runtimeKernel/kernelContracts';
import { isWebIpcAllowed } from './accessPolicy';
import type { IpcEventChannel, IpcEventMap } from '../../shared/ipcEvents';

const registrationScope = new AsyncLocalStorage<{ source: string; scope: LifecycleScope }>();
export function registerScopedIpc(source: string, scope: LifecycleScope, register: () => void): void {
  ipcOwnerFor(scope);
  registrationScope.run({ source, scope }, register);
}

/** Resources created by an IPC module share its domain's shutdown barrier. */
export function ownIpcResource(dispose: () => void | Promise<void>): void {
  registrationScope.getStore()?.scope.add(dispose);
}

export interface IpcCaller {
  id: string;
  kind?: RunContext['caller']['kind'];
  isAlive(): boolean;
  permissions?: readonly string[];
  sendEvent?<K extends IpcEventChannel>(channel: K, payload: IpcEventMap[K]): void;
}
const callerScope = new AsyncLocalStorage<IpcCaller>();
const runScope = new AsyncLocalStorage<RunContext>();
export const ipcPermissions = new PermissionGate();
const permissionUsers = new Map<string, number>();
type IpcOwner = { scope: LifecycleScope; revoke: Array<() => void>; pending: Set<Promise<unknown>> };
const scopedOwners = new WeakMap<LifecycleScope, IpcOwner>();
const channelOwners = new Map<string, IpcOwner>();
let admissionClosed = false;
/** Called before service cancellation, so desktop clients cannot create new work during shutdown. */
export function stopIpcAdmission(): void { admissionClosed = true; }
function ipcOwnerFor(scope: LifecycleScope): IpcOwner {
  if (scope.isDisposed) throw new Error(`IPC domain is disposed: ${scope.id}`);
  let group = scopedOwners.get(scope);
  if (!group) {
    group = { scope, revoke: [], pending: new Set() };
    scopedOwners.set(scope, group);
    const owned = group;
    // Register first: later resource disposers cancel jobs before this final drain.
    scope.add(async () => {
      for (const remove of owned.revoke) remove();
      while (owned.pending.size) await Promise.allSettled([...owned.pending]);
    });
  }
  return group;
}
export type IpcAuditRecord = {
  channel: string; auditTag: string; correlationId: string; callerId: string;
  callerKind: RunContext['caller']['kind']; status: 'ok' | 'denied' | 'failed'; durationMs: number;
};
const audit: IpcAuditRecord[] = [];
export function listIpcAudit(): readonly IpcAuditRecord[] { return audit.map(record => ({ ...record })); }
export function ipcRunContext(): RunContext | undefined { return runScope.getStore(); }

/** Server-authenticated transport identity, never supplied in renderer arguments. */
export function ipcCaller(event: IpcMainInvokeEvent): IpcCaller {
  const caller = callerScope.getStore();
  if (caller) return caller;
  const sender = event?.sender;
  if (!sender) throw new Error('IPC requires a connected client');
  return {
    id: `desktop:${sender.id}`,
    isAlive: () => !sender.isDestroyed(),
    sendEvent(channel, payload) {
      if (!sender.isDestroyed()) sender.send(channel, payload);
    }
  };
}

/**
 * ipcMain.handle 的统一入口。
 *
 * 直接用 ipcMain.handle 时，handler 抛错只会变成渲染层的 rejected promise；
 * 渲染层大量调用点是 `void window.api.x()`，于是主进程侧既没有日志、渲染层
 * 也只有一条被 Electron 包装过的 unhandled rejection——问题现场全丢。
 * 这里在重抛前统一记一条带通道名的日志，保持原有 reject 语义不变。
 *
 * 同时维护通道注册表，重复注册会立即抛错（Electron 本身也会抛，但错误信息
 * 里没有「哪个域重复了」这层信息）。
 */

/** 通道 → 核心函数（web 网关复用同一批 handler，见 webAccess/server.ts） */
export const ipcCapabilities = new CapabilityRegistry<IpcHandler>();
const capabilities = ipcCapabilities;

export type IpcHandler = (event: IpcMainInvokeEvent, ...args: never[]) => unknown;

export type IpcCapabilityOptions = {
  permission?: string;
  auditTag?: string;
};

export function handle<T extends IpcHandler>(channel: string, fn: T, options?: IpcCapabilityOptions): void {
  if (admissionClosed) throw new Error('IPC service is stopping');
  const owner = registrationScope.getStore();
  if (owner?.scope.isDisposed) throw new Error(`IPC domain is disposed: ${owner.source}`);
  const permission = options?.permission ?? `ipc:${channel}`;
  try {
    capabilities.register({
      id: channel,
      handler: fn as IpcHandler,
      source: owner?.source ?? 'ipc',
      permission,
      auditTag: options?.auditTag ?? `${owner?.source ?? 'ipc'}:${channel}`
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Capability already registered:')) {
      throw new Error(`[ipc] 通道重复注册: ${channel}`);
    }
    throw error;
  }
  try { ipcMain.handle(channel, async (event, ...args) => {
    try {
      // 桌面 IPC 与 Web 网关共用注册表里的同一个 handler，避免两条传输路径
      // 各自持有闭包导致能力枚举、权限和审计元数据与实际执行体脱节。
      const caller: IpcCaller = { ...ipcCaller(event), kind: 'desktop' };
      return await dispatch(channel, args, event, caller);
    } catch (err) {
      console.error(`[ipc] ${channel} failed:`, err);
      throw err;
    }
  }); } catch (error) { capabilities.unregister(channel); throw error; }
  permissionUsers.set(permission, (permissionUsers.get(permission) ?? 0) + 1);
  ipcPermissions.grant(permission);
  const revoke = () => {
    capabilities.unregister(channel);
    channelOwners.delete(channel);
    ipcMain.removeHandler(channel);
    const remaining = (permissionUsers.get(permission) ?? 1) - 1;
    if (remaining) permissionUsers.set(permission, remaining);
    else { permissionUsers.delete(permission); ipcPermissions.revoke(permission); }
  };
  if (owner) {
    const group = ipcOwnerFor(owner.scope);
    group.revoke.push(revoke);
    channelOwners.set(channel, group);
  }
}

export function hasIpcChannel(channel: string): boolean {
  return capabilities.has(channel);
}

export function listIpcCapabilities(): ReturnType<typeof capabilities.list> {
  return capabilities.list();
}

/**
 * 供 web 网关以合成 event 并行调用已注册 handler（ipcMain.handle 之外的传输）。
 * 网关不伪造 Electron sender；有客户端归属的处理器通过 ipcCaller 获取
 * 宿主生成的连接身份，其他处理器仍可忽略 null event。
 */
export async function invokeIpcChannel(channel: string, args: unknown[], caller?: IpcCaller): Promise<unknown> {
  // Only trusted main-process code can enter here. A nested call inherits the
  // transport identity; it must not become an unrestricted internal call.
  const identity = caller ?? callerScope.getStore() ?? { id: 'main', kind: 'internal' as const, isAlive: () => true };
  return dispatch(channel, args, null as never, identity);
}

async function dispatch(channel: string, args: unknown[], event: IpcMainInvokeEvent, caller: IpcCaller): Promise<unknown> {
  const capability = capabilities.get(channel);
  if (!capability) {
    throw new Error(`[ipc] 无此通道: ${channel}`);
  }
  const owner = channelOwners.get(channel);
  // Register before even a synchronous handler can trigger its own domain's disposal.
  const task = Promise.resolve().then(() => dispatchRegistered(channel, capability, owner, args, event, caller));
  owner?.pending.add(task);
  void task.then(() => owner?.pending.delete(task), () => owner?.pending.delete(task));
  return task;
}

async function dispatchRegistered(channel: string, capability: NonNullable<ReturnType<typeof capabilities.get>>,
  owner: IpcOwner | undefined, args: unknown[], event: IpcMainInvokeEvent, caller: IpcCaller): Promise<unknown> {
  const kind = caller.kind ?? 'web';
  const required = capability.permission!;
  const parent = runScope.getStore();
  const context: RunContext = {
    correlationId: parent?.correlationId ?? randomUUID(),
    caller: { id: caller.id, kind, isAlive: caller.isAlive },
    permissions: caller.permissions ?? [required],
    createdAt: Date.now()
  };
  let status: IpcAuditRecord['status'] = 'denied';
  try {
    if (admissionClosed || owner?.scope.isDisposed || capabilities.get(channel) !== capability) throw new Error('IPC service or domain is stopping');
    if (!caller.id || !caller.isAlive()) throw new Error('IPC caller is no longer connected');
    if (kind === 'web' && !isWebIpcAllowed(channel, args)) throw new Error(`Web IPC permission denied: ${channel}`);
    ipcPermissions.assert(context, required);
    status = 'failed';
    const value = await callerScope.run(caller, () => runScope.run(context, () => capability.handler(event, ...(args as never[]))));
    status = 'ok';
    return value;
  } finally {
    audit.push({ channel, auditTag: capability.auditTag!, correlationId: context.correlationId,
      callerId: caller.id, callerKind: kind, status, durationMs: Date.now() - context.createdAt });
    if (audit.length > 200) audit.splice(0, audit.length - 200);
  }
}
