/**
 * 文本工具配置缓存（渲染层）：浮条打开时刷新。
 * 设置保存后无需重启——下一次划词即拿到新列表；cache 仅本模块内部使用。
 */
import type { TextToolsConfig } from '../../../shared/types';

let cache: TextToolsConfig = { functions: [] };
let pending: Promise<TextToolsConfig> | null = null;

export function refreshTextTools(): Promise<TextToolsConfig> {
  if (!pending) {
    pending = window.api.config
      .get()
      .then((c) => {
        cache = c.textTools ?? { functions: [] };
        return cache;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}
