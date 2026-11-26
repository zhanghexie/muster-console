import { PRODUCT_INSTANCE_DIR_NAME } from './productIdentity';

/** 本机并行 app 实例心跳（P14）：落盘各实例 userData，并在共享目录登记便于调度查询。 */

export type AppInstanceKind = 'user' | 'sandbox' | 'e2e';

export type AppInstanceInfo = {
  id: string;
  pid: number;
  startedAt: number;
  updatedAt: number;
  aumid: string;
  userData: string;
  kind: AppInstanceKind;
  shellApiPort?: number;
  webAccessPort?: number;
};

export const INSTANCES_DIR_NAME = PRODUCT_INSTANCE_DIR_NAME;

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function pruneDeadInstances(list: AppInstanceInfo[]): AppInstanceInfo[] {
  return list.filter((x) => isPidAlive(x.pid));
}
