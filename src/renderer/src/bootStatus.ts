/**
 * 启动降级状态（X7-F01）：bootWait 15s 兜底超时后渲染层不再「当成功挂载了事」——
 * 以降级态挂载全量 UI 并在顶部横幅明示；主进程启动链真正收口（app:boot:ready 事件
 * 或 bootWait promise 迟到 resolve）后转 ready，并广播 BOOT_REHYDRATE_EVENT 让
 * StoreProvider 重拉初始数据补齐「No handler registered」期间失败的快照。
 *
 * 模块级 external store（同 store.tsx 的 hStripBusyStore 范式）：main.tsx 在
 * React 树外写入（超时/收口都发生在渲染周期之外），横幅组件经 useSyncExternalStore 订阅。
 */
import type { BootResult } from '../../shared/boot';

export type BootPhase = 'waiting' | 'degraded' | 'ready' | 'failed';

interface BootStatus {
  phase: BootPhase;
  /** phase='failed' 时携带启动链错误（与 BootFailure 同源文案） */
  error?: string;
}

let status: BootStatus = { phase: 'waiting' };
const listeners = new Set<() => void>();

/** degraded → ready 时广播：StoreProvider 收到后重拉初始数据 */
export const BOOT_REHYDRATE_EVENT = 'muster:boot-rehydrate';

export function bootStatusSnapshot(): BootStatus {
  return status;
}

export function subscribeBootStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** bootWait 兜底超时（或通道异常）后的降级挂载标记；只在 waiting 期生效 */
export function markBootDegraded(): void {
  if (status.phase !== 'waiting') return;
  status = { phase: 'degraded' };
  emit();
}

/**
 * 主进程启动链收口。来源两路（谁先到谁生效，幂等）：
 * - bootWait promise 迟到 resolve（桌面常态，覆盖事件与超时的同帧竞态）；
 * - app:boot:ready 事件（web 网关 invoke 有 30s 超时，长尾场景只有事件可达）。
 * result 为空（通道异常/网关超时 reject）时维持现状——横幅继续如实提示「仍在初始化」。
 */
export function settleBoot(result: BootResult | null | undefined): void {
  if (!result) return;
  if (status.phase === 'ready' || status.phase === 'failed') return;
  const wasDegraded = status.phase === 'degraded';
  status = result.ok ? { phase: 'ready' } : { phase: 'failed', error: result.error };
  emit();
  if (result.ok && wasDegraded) {
    window.dispatchEvent(new CustomEvent(BOOT_REHYDRATE_EVENT));
  }
}

/** 测试复位（生产不消费：boot 状态单次生命周期） */
export function resetBootStatusForTest(): void {
  status = { phase: 'waiting' };
  emit();
}
