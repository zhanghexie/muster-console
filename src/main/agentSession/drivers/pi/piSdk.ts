/**
 * Pi SDK 动态加载（GUI Worker 用）：与调度侧同一补丁，但独立入口避免耦合调度 provider。
 * Pi 是 ESM-only，主 bundle 是 CJS：必须走 native dynamic import。
 */
import { patchElectronForPi } from '../../../agent/piElectronCompat';

export type PiModule = typeof import('@earendil-works/pi-coding-agent');

let cached: PiModule | null = null;

export async function loadPiSdk(): Promise<PiModule> {
  if (cached) return cached;
  patchElectronForPi();
  cached = (await import('@earendil-works/pi-coding-agent')) as PiModule;
  return cached;
}

/** 测试注入口（离线回放，test/pi-driver-replay.mjs）：注入假 PiModule；null=恢复真加载 */
export function __setPiSdkForTests(mod: PiModule | null): void {
  cached = mod;
}
