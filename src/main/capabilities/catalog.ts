/**
 * 能力目录对外垫片（2026-09-26 按工具组拆分）：实现体在 catalog/ 子目录，
 * 本文件只做再导出——仓库内既有 `capabilities/catalog` 引用路径不变，
 * 公开 API 面与拆分前完全一致（含类型）。
 */
export type { ToolDef, DynamicToolEntry } from './catalog/types';
export { CATALOG_VERSION, setDynamicToolSource, dynamicToolEntries } from './catalog/types';
export { TOOL_DEFS } from './catalog/registry';
export {
  toApiName,
  fromApiName,
  getToolDef,
  getCatalogInfo,
  SCHEDULER_HIDDEN_TOOL_NAMES,
  catalogSnippetFor,
  hasNamedParameters,
  catalogAppendixText,
  searchHostToolDirectory,
  resolveToolCallArgs,
  WORKER_TOOL_ALLOWLIST,
  isWorkerAllowedTool
} from './catalog/api';
export { EXTENSION_HOST_TOOLS, isExtensionHostTool } from '../../shared/extension';
