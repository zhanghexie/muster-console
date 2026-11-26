/**
 * MemoryService 单例引用（B5 从 runtime.ts 抽出）：宿主工具/驱动层只需要「取服务」
 * 时 import 本模块——runtime.ts 还聚合了 config 解析（electron 依赖链），把纯引用面
 * 与重装配面分开，hosts/driver 的测试编译图（shared-compile 无 electron stub）不再
 * 被拖进 electron。set 仍以 runtime/index.ts 装配为唯一写者。
 */
import type { MemoryService } from './service';

let memoryService: MemoryService | null = null;

/** index.ts boot 链建立服务后绑定（before-quit 前不解除；重复 set 以最后一次为准） */
export function setMemoryService(s: MemoryService | null): void {
  memoryService = s;
}

export function getMemoryService(): MemoryService | null {
  return memoryService;
}
