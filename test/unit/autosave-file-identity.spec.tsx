import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAutoSave } from '../../src/renderer/src/hooks/useAutoSave';

describe('自动保存文件身份与迟到响应', () => {
  it('同名路径跨根切换时清除旧待写，写请求保持原身份且不污染新状态', async () => {
    let finish!: (value: { ok: boolean; error?: string }) => void;
    const writeA = vi.fn(() => new Promise<{ ok: boolean; error?: string }>((resolve) => { finish = resolve; }));
    const writeB = vi.fn(async () => ({ ok: true }));
    let content = 'A edit';
    const { result, rerender } = renderHook(({ identity, write }) => useAutoSave({ path: 'src/index.ts', identity, getContent: () => content, write }),
      { initialProps: { identity: 'root-a/src/index.ts', write: writeA as (path: string, content: string) => Promise<{ ok: boolean; error?: string }> } });
    let flushing!: Promise<void>;
    act(() => { result.current.onChange(); flushing = result.current.flush(); });
    expect(writeA).toHaveBeenCalledWith('src/index.ts', 'A edit');
    expect(result.current.hasUnsavedChanges()).toBe(true);
    content = 'B edit';
    rerender({ identity: 'root-b/src/index.ts', write: writeB });
    expect(result.current.isDirty()).toBe(false);
    expect(result.current.hasUnsavedChanges()).toBe(false);
    await act(async () => { finish({ ok: false, error: 'A failed late' }); await flushing; });
    expect(result.current.status).toBe('idle'); expect(result.current.error).toBeNull();
    await act(async () => { result.current.onChange(); await result.current.flush(); });
    expect(writeB).toHaveBeenCalledWith('src/index.ts', 'B edit');
    expect(result.current.status).toBe('saved');
  });

  it('A→B→A 后原 A 请求的迟到失败不能把新 A 标为 dirty', async () => {
    let finish!: (value: { ok: boolean; error?: string }) => void;
    const write = vi.fn(() => new Promise<{ ok: boolean; error?: string }>((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ identity }) => useAutoSave({ path: 'same.ts', identity, getContent: () => 'edit', write }), { initialProps: { identity: 'a' } });
    let flushing!: Promise<void>;
    act(() => { result.current.onChange(); flushing = result.current.flush(); });
    rerender({ identity: 'b' }); rerender({ identity: 'a' });
    await act(async () => { finish({ ok: false, error: 'stale' }); await flushing; });
    expect(result.current.isDirty()).toBe(false); expect(result.current.error).toBeNull();
  });
});
