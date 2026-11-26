import type { AppContext } from '../context';
import { t } from '../../shared/i18n';
import { resolveWorkspaceControlRoot } from './helpers';
import { handle } from './handle';
import { memoryForget, memoryGet, memoryRestore, memorySaveEntry } from '../memory/panelStore';
import { commitMemoryChanges } from '../git/memoryCommit';
import type {
  MemoryForgetResult,
  MemoryGetResult,
  MemoryPatchResult,
  MemorySaveEntryInput,
  MemorySaveEntryResult
} from '../../shared/memoryIpc';

/**
 * 记忆面板直连 IPC：读 / 保存条目 / 删除（落 recovery）/ 恢复。root 恒取当前活跃工作区。
 *
 * X4-F06 状态注记（2026-10-25）：registerMemoryIpc 当前**零接线**——全仓无调用者，
 * 对应渲染层死组件树（MemoryPanel/MemoryCenterTabs）与 preload memory 域死暴露
 * 已按 X4-F06 删除。本注册函数按用户裁定保留，待 D10「记忆主链」改造裁定
 * memory:saveEntry 等通道是接线复活还是彻底移除——裁定前不得凭 handle() 文本
 * grep 判断「已注册」。若 D10 决定移除，连带清理 memory/panelStore、git/memoryCommit
 * 与本文件。
 */
export function registerMemoryIpc(ctx: AppContext): void {
  const rootOf = (): string => resolveWorkspaceControlRoot(ctx, ctx.config.get().activeWorkspaceId);

  handle('memory:get', (): MemoryGetResult => memoryGet(rootOf()));

  handle(
    'memory:saveEntry',
    (_e, hash: unknown, input: unknown): MemorySaveEntryResult => {
      const baseHash = typeof hash === 'string' ? hash : '';
      const inp = (input ?? {}) as Partial<MemorySaveEntryInput>;
      const saved = memorySaveEntry(rootOf(), baseHash, {
        id: typeof inp.id === 'string' && inp.id ? inp.id : undefined,
        tags: Array.isArray(inp.tags) ? inp.tags.filter((x): x is string => typeof x === 'string') : [],
        links: Array.isArray(inp.links) ? inp.links.filter((x): x is string => typeof x === 'string') : [],
        text: typeof inp.text === 'string' ? inp.text : ''
      });
      if (!('stale' in saved && saved.stale)) void commitMemoryChanges(rootOf());
      return saved;
    }
  );

  handle(
    'memory:forget',
    (_e, hash: unknown, id: unknown): MemoryForgetResult => {
      if (typeof id !== 'string' || !id) throw new Error(t('id 不能为空'));
      const r = memoryForget(rootOf(), typeof hash === 'string' ? hash : '', id);
      if (!r.stale) void commitMemoryChanges(rootOf());
      return r;
    }
  );

  handle(
    'memory:restore',
    (_e, hash: unknown, recoveryId: unknown): MemoryPatchResult => {
      if (typeof recoveryId !== 'string' || !recoveryId) throw new Error(t('recoveryId 不能为空'));
      const r = memoryRestore(rootOf(), typeof hash === 'string' ? hash : '', recoveryId);
      if (!r.stale) void commitMemoryChanges(rootOf());
      return r;
    }
  );
}
