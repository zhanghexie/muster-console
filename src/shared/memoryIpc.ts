/**
 * 记忆 IPC DTO（preload/renderer/main 三方共享的类型；面板存储层实现在 main/memory/panelStore.ts——B8 自 metaAgent/memoryStore.ts 迁入）。
 * MemoryEntry/DuplicatePair 等纯格式类型在 memoryFormat.ts，这里只放传输层形状。
 */
import type { DuplicatePair, MemoryEntry } from './memoryFormat';

export interface MemoryRecoveryItem {
  id: string;
  createdAt: string;
  /** 被删条目正文末行预览（回收站列表用；超长带省略号） */
  preview: string;
}

/** 注入命中信息（面板标注用；选择算法见 memoryFormat.selectEntriesForInjection） */
export interface MemoryInjectionInfo {
  /** MEMORY 注入预算（字符） */
  budgetChars: number;
  /** 装入预算的条目 id */
  includedIds: string[];
  /** 被挤出预算的条目 id */
  droppedIds: string[];
}

export interface MemoryGetResult {
  exists: boolean;
  /** 全文 hash（stale 防护基准；文件不存在时为空串） */
  hash: string;
  entries: MemoryEntry[];
  duplicates: DuplicatePair[];
  conflicts: DuplicatePair[];
  recovery: MemoryRecoveryItem[];
  injection: MemoryInjectionInfo;
}

/**
 * 整写类操作结果：stale=true 表示文件已被并发修改（返回最新 entries/hash 供刷新）。
 * 全部携带重算后的派生数据（duplicates/conflicts/recovery/injection），
 * 面板 patch 后无需整页 get 即可自洽刷新。
 */
export type MemoryPatchResult =
  | ({
      stale: false;
      hash: string;
      entries: MemoryEntry[];
    } & MemoryDerived)
  | ({ stale: true; hash: string; entries: MemoryEntry[] } & MemoryDerived);

/** 派生数据：与 MemoryGetResult 同源重算 */
export interface MemoryDerived {
  duplicates: DuplicatePair[];
  conflicts: DuplicatePair[];
  recovery: MemoryRecoveryItem[];
  injection: MemoryInjectionInfo;
}

export interface MemorySaveEntryInput {
  /** 空 = 新增条目（自动盖时间戳注释）；有值 = 原位替换该条正文 */
  id?: string;
  tags: string[];
  links: string[];
  text: string;
}

/** 保存条目（新增/原位编辑） */
export type MemorySaveEntryResult = MemoryPatchResult;

/** 删除条目：成功态必带 recoveryId（recovery 备份），stale 态无 */
export type MemoryForgetResult =
  | ({ stale: false; hash: string; entries: MemoryEntry[]; recoveryId: string } & MemoryDerived)
  | ({ stale: true; hash: string; entries: MemoryEntry[] } & MemoryDerived);

/** memory.list 工具条目（正文截断预览，防宿主工具结果超限） */
export interface MemoryListItem {
  id: string;
  ts: string;
  sessionId: string;
  tags: string[];
  links: string[];
  /** 正文预览（剥行首标记，超长带省略号） */
  text: string;
}

export interface MemoryListResult {
  total: number;
  entries: MemoryListItem[];
}
