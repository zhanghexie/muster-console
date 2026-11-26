/**
 * 记忆服务类型合同（B5 抽出）：inject 的输入输出类型独立成模块，避免
 * injection/trigger/lane2 等纯模块与 service.ts 互相 import 形成环（service 再
 * re-export 保持 B1–B4 的 `from './service'` 导入面不变）。
 */

/** 会话种类（§5 会话种类门：heartbeat/auto/headless 不注入根记忆、不产生晋升候选） */
export type MemorySessionKind = 'scheduler' | 'worker' | 'chat' | 'headless' | 'heartbeat' | 'auto';

/** 注入预算画像（字符）：策展核心 / 情景 journal 尾部 / USER.md 画像各自独立小预算（§7） */
export interface MemoryBudgetProfile {
  coreChars: number;
  journalChars: number;
  profileChars: number;
}

export type MemoryInjectionSectionKind = 'core' | 'journal' | 'profile';

export interface MemoryInjectionSection {
  kind: MemoryInjectionSectionKind;
  budgetChars: number;
  /** 实际注入字符数（超出预算=0 表示整节被省略） */
  chars: number;
  entryCount: number;
}

export interface MemoryInjection {
  /** 组装好的注入文本；空串=调用方整节省略 */
  text: string;
  /** 分节明细（预算用量；面板/诊断用） */
  sections: MemoryInjectionSection[];
  /** 召回回路防护（§5）：本次注入涉及的 chunk id——写入路径据此永不将其再提取为 staging 候选 */
  injectedChunkIds: number[];
  /** 参与注入的文件版本 token（mtime+size）：同 token 结果字节不动，保前缀缓存（§7 Lane1） */
  versionToken: string;
}
