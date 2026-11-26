/**
 * useGitPrefs 水合竞态回归（A2-6-1）：水合 effect deps 收窄为 [ready, historyWsId]
 * （cfgRef 稳定），并发 patch 换来的新 gitCfg 引用不再触发重新水合——否则用户
 * 会话内已改的 prefs（hiddenView/pinned/selectedPath…）会被别的 surface 的旧值
 * 成批回写。水合时机本身（ready 翻转 / 切工作区）保留：effect 经 cfgRef 读当次值。
 * 还原即红：deps 加回 gitCfg（或恢复旧 [ready, gitCfg, historyWsId]）时，
 * 「并发 patch 后状态不被回写」断言转红。
 * 运行: npx vitest run test/unit/use-git-prefs-race.spec.tsx
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGitPrefs } from '../../src/renderer/src/panels/gitpanel/useGitPrefs';
import type { WorkspaceFileConfig } from '../../src/shared/metaAgent';

const patch = vi.fn(async (partial: Partial<WorkspaceFileConfig>) => {
  return { ok: true, config: { ...partial, ...({ id: 'ws1' } as object) } as WorkspaceFileConfig };
});

describe('useGitPrefs 水合竞态（A2-6-1）', () => {
  it('并发 patch 换新 gitCfg 引用：不重新水合，会话内状态保持', () => {
    const cfgRef: React.MutableRefObject<WorkspaceFileConfig> = {
      current: { git: { selectedRepo: 'R1' } } as WorkspaceFileConfig
    };
    const { result, rerender } = renderHook(
      ({ gitCfg, ready }: { gitCfg: WorkspaceFileConfig['git']; ready: boolean }) =>
        useGitPrefs({ ready, gitCfg, cfgRef, patch, historyWsId: 'ws1' }),
      { initialProps: { gitCfg: { selectedRepo: 'R1' } as WorkspaceFileConfig['git'], ready: true } }
    );
    // 首次水合：selectedPath=R1
    expect(result.current.selectedPath).toBe('R1');
    // 用户会话内选中别的 repo
    act(() => result.current.setSelectedPath('R2'));
    expect(result.current.selectedPath).toBe('R2');
    // 并发 patch 落地：父组件以新 gitCfg 引用重渲（内容仍是盘上的旧选中 R1）
    rerender({ gitCfg: { selectedRepo: 'R1' }, ready: true });
    // A2-6-1：不得重新水合回写
    expect(result.current.selectedPath).toBe('R2');
  });

  it('水合时机保留：ready 翻转后经 cfgRef 重新水合当次值', () => {
    const cfgRef: React.MutableRefObject<WorkspaceFileConfig> = {
      current: { git: {} } as WorkspaceFileConfig
    };
    const { result, rerender } = renderHook(
      ({ gitCfg, ready }: { gitCfg: WorkspaceFileConfig['git']; ready: boolean }) =>
        useGitPrefs({ ready, gitCfg, cfgRef, patch, historyWsId: 'ws1' }),
      { initialProps: { gitCfg: {} as WorkspaceFileConfig['git'], ready: true } }
    );
    expect(result.current.pinned).toEqual([]);
    // 切工作区：ready 翻 false 再 true，cfgRef 已是新区当次值
    rerender({ gitCfg: {}, ready: false });
    cfgRef.current = { git: { pinnedRepos: ['R9'], selectedRepo: 'R1' } } as WorkspaceFileConfig;
    rerender({ gitCfg: {}, ready: true });
    expect(result.current.pinned).toEqual(['R9']);
    expect(result.current.selectedPath).toBe('R1');
  });
});
