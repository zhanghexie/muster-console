/**
 * QuickOpen 文件枚举的跨开合缓存 + 空闲预热（2026-10-14 性能专项）契约：
 * 1) 模块级缓存：同 scope（workspaceId+rootsRevision）再次挂载立即出旧结果
 *    （loading=false），后台 revalidate 到达后覆盖；
 * 2) 已完成但在卸载后提交的结果仍可入缓存；取消后的晚到结果不能覆盖缓存；
 * 3) prewarmQuickOpenFiles 把枚举结果垫进缓存，且同 scope 不重复拉；
 * 4) 取消的查询结果不进缓存。
 * window.api.fs 以可控 mock 替身（helpers 口径）。
 * 还原即红：去掉模块缓存时，「挂载即有结果」断言转红。
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import {
  useQuickOpenFiles,
  prewarmQuickOpenFiles
} from '../../src/renderer/src/components/useQuickOpenQueries';
import type { WorkspaceListedFile, WorkspaceQueryResult } from '../../src/shared/types';

type ListFilesCall = { max?: number; requestId: string };

function makeResult(items: string[], revision = 7, cancelled = false): WorkspaceQueryResult<WorkspaceListedFile> {
  return {
    items: items.map((path, i) => ({ fileRef: { workspaceId: 'ws-1', rootId: 'r1', relativePath: path }, absolutePath: `X:/${path}`, kind: 'file', size: 10 + i })),
    roots: [],
    rootsRevision: revision,
    cancelled,
    truncated: false
  } as unknown as WorkspaceQueryResult<WorkspaceListedFile>;
}

const state = vi.hoisted(() => ({
  listFiles: vi.fn(),
  cancelQuery: vi.fn(),
  seq: 0
}));

// window.api：setup.ts 每测试重装 Proxy mock（未知通道 resolve undefined），
// 本 spec 在自己的 beforeEach（晚于 setup 的）里覆盖 fs 面
const installFsMock = (): void => {
  (window as unknown as { api: unknown }).api = {
    fs: {
      listFiles: (...args: unknown[]) => state.listFiles(...(args as [string, Record<string, unknown>])),
      cancelQuery: (...args: unknown[]) => state.cancelQuery(...(args as [string, string]))
    }
  };
};

function Probe(props: {
  wsId: string;
  enabled: boolean;
  onState: (s: { loading: boolean; count: number }) => void;
}): React.JSX.Element {
  const q = useQuickOpenFiles(props.wsId, 7, props.enabled);
  props.onState({ loading: q.loading, count: q.result?.items.length ?? 0 });
  return <div data-probe />;
}

describe('QuickOpen 文件枚举跨开合缓存', () => {
  beforeEach(() => {
    installFsMock();
    state.listFiles.mockReset();
    state.cancelQuery.mockReset();
    state.seq = 0;
    state.listFiles.mockImplementation(async () => {
      state.seq += 1;
      return makeResult(state.seq === 1 ? ['a.md', 'b.md'] : ['a.md', 'b.md', `new-${state.seq}.md`]);
    });
  });

  it('首次打开拉取；关掉再开：立即出缓存结果，后台刷新到达后覆盖', async () => {
    let latest = { loading: true, count: 0 };
    const { unmount } = render(<Probe wsId="ws-reopen" enabled onState={(s) => (latest = s)} />);
    await waitFor(() => expect(latest.count).toBe(2)); // 首次：新结果
    expect(state.listFiles).toHaveBeenCalledTimes(1);
    unmount();

    // 再开：缓存的 2 条先到（loading=false、无等待），revalidate 拉到 3 条后覆盖
    let reopened = { loading: true, count: -1 };
    const second = render(<Probe wsId="ws-reopen" enabled onState={(s) => (reopened = s)} />);
    await waitFor(() => expect(reopened.count).toBe(2));
    expect(reopened.loading).toBe(false); // 旧结果即出，无枚举等待
    await waitFor(() => expect(reopened.count).toBe(3)); // revalidate 覆盖
    expect(state.listFiles).toHaveBeenCalledTimes(2);
    second.unmount();
  });

  it('预热仍持有查询时卸载，结果仍可供下次打开使用', async () => {
    let resolveFirst: (v: WorkspaceQueryResult<WorkspaceListedFile>) => void = () => {};
    state.listFiles.mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }))
      .mockImplementationOnce(() => new Promise(() => {}));
    prewarmQuickOpenFiles('ws-late', 7);
    const first = render(<Probe wsId="ws-late" enabled onState={() => {}} />);
    await act(async () => { first.unmount(); });
    expect(state.cancelQuery).not.toHaveBeenCalled();
    await act(async () => { resolveFirst(makeResult(['late.md'])); });
    // 预热持有的结果仍可落缓存，下次打开时立即显示。
    let reopened = { loading: true, count: -1 };
    render(<Probe wsId="ws-late" enabled onState={(s) => (reopened = s)} />);
    await waitFor(() => expect(reopened.count).toBe(1));
  });

  it('最后一个消费者关闭并取消后，晚到结果不进入缓存', async () => {
    let resolveFirst: (v: WorkspaceQueryResult<WorkspaceListedFile>) => void = () => {};
    let resolveSecond: (v: WorkspaceQueryResult<WorkspaceListedFile>) => void = () => {};
    state.listFiles.mockImplementationOnce(() => new Promise(res => { resolveFirst = res; }))
      .mockImplementationOnce(() => new Promise(res => { resolveSecond = res; }));
    const first = render(<Probe wsId="ws-cancel-late" enabled onState={() => {}} />);
    await act(async () => { first.unmount(); });
    await waitFor(() => expect(state.cancelQuery).toHaveBeenCalledTimes(1));
    await act(async () => { resolveFirst(makeResult(['stale.md'])); });
    let reopened = { loading: false, count: -1 };
    render(<Probe wsId="ws-cancel-late" enabled onState={s => { reopened = s; }} />);
    await waitFor(() => expect(state.listFiles).toHaveBeenCalledTimes(2));
    expect(reopened).toEqual({ loading: true, count: 0 });
    await act(async () => { resolveSecond(makeResult(['fresh.md', 'second.md'])); });
    await waitFor(() => expect(reopened.count).toBe(2));
  });

  it('根版本不匹配的结果不会被下一次打开复用', async () => {
    state.listFiles.mockImplementationOnce(async () => makeResult(['wrong-revision.md'], 6))
      .mockImplementationOnce(() => new Promise(() => {}));
    let firstState = { loading: true, count: 0 };
    const first = render(<Probe wsId="ws-wrong-revision" enabled onState={s => { firstState = s; }} />);
    await waitFor(() => expect(firstState.loading).toBe(false));
    expect(firstState.count).toBe(0);
    first.unmount();
    let reopened = { loading: false, count: -1 };
    render(<Probe wsId="ws-wrong-revision" enabled onState={s => { reopened = s; }} />);
    await waitFor(() => expect(state.listFiles).toHaveBeenCalledTimes(2));
    expect(reopened).toEqual({ loading: true, count: 0 });
  });

  it('prewarm 预热垫缓存；同 scope 不重复拉', async () => {
    prewarmQuickOpenFiles('ws-prewarm', 7);
    await waitFor(() => expect(state.listFiles).toHaveBeenCalledTimes(1));
    prewarmQuickOpenFiles('ws-prewarm', 7); // 已缓存：不再拉
    expect(state.listFiles).toHaveBeenCalledTimes(1);
    let s = { loading: true, count: 0 };
    render(<Probe wsId="ws-prewarm" enabled onState={(v) => (s = v)} />);
    await waitFor(() => expect(s.count).toBe(2)); // 打开即命中预热缓存
  });
});
