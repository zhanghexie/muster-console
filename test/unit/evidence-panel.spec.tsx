/**
 * 证据页（T4.5/O10）组件单测：evidenceViewStore 驱动的全链路——
 * 打开拉取 → 时间线渲染（五类条目、倒序）→ 展开/缩略懒加载 → 关闭退场卸载。
 * window.api 走 helpers/api-mock（Override 三个 evidence 通道）。
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach } from 'vitest';
import { EvidencePanel } from '../../src/renderer/src/components/EvidencePanel';
import {
  closeEvidenceView,
  openEvidenceView,
  useEvidenceView
} from '../../src/renderer/src/panels/evidenceViewStore';
import { MOTION } from '../../src/renderer/src/components/motion';
import { currentApiMock } from './helpers/api-mock';
import type { EvidenceIndex } from '../../src/shared/evidence';

const T0 = Date.now();

function fixtureIndex(): EvidenceIndex {
  return {
    version: 1,
    sessionId: 'sess-1',
    createdAt: T0,
    updatedAt: T0,
    entries: [
      {
        id: 'p-1',
        kind: 'pty-slice',
        ts: T0 + 3000,
        phase: { from: 'working', to: 'waiting', source: 'model' },
        file: 'p-1.txt'
      },
      {
        id: 'b-1',
        kind: 'bgtask-summary',
        ts: T0 + 2000,
        bgTask: { taskId: 'bg-1', command: 'npm test', status: 'failed', exitCode: 1, summary: '3 failing' }
      },
      {
        id: 'p-0',
        kind: 'pty-slice',
        ts: T0 + 1000,
        phase: { to: 'working', source: 'model' },
        file: 'p-0.txt',
        afterTs: T0 + 46000
      }
    ]
  };
}

function renderPanel(): ReturnType<typeof render> {
  return render(
    <>
      <EvidencePanel />
      {/* 消费一次 store，保证打开/关闭边沿驱动重渲 */}
      <StoreProbe />
    </>
  );
}

function StoreProbe(): null {
  useEvidenceView();
  return null;
}

/** store 是模块级单例，且 setState 必须包 act（外部 store 同步更新要进 React 批处理） */
async function open(target: { sessionId: string; sessionName: string }): Promise<void> {
  await act(async () => {
    openEvidenceView(target);
  });
}

async function close(): Promise<void> {
  await act(async () => {
    closeEvidenceView();
  });
}

describe('证据页 EvidencePanel（组件级）', () => {
  beforeEach(() => {
    // store 是模块级单例：上一用例残留的打开状态会把面板在本用例首帧就挂出。
    // 同步 act（board-needs-read 同款范式；异步 act 不 await 会与用例内 render 交错吞更新）
    act(() => {
      closeEvidenceView();
    });
  });

  it('打开 → 拉取索引并倒序渲染时间线（最新在前）', async () => {
    const mock = currentApiMock();
    mock.override('evidence.getIndex', () => Promise.resolve(fixtureIndex()));
    renderPanel();

    expect(screen.queryByRole('dialog')).toBeNull();
    await open({ sessionId: 'sess-1', sessionName: 'Worker A' });

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('会话证据');
    expect(mock.mockOf('evidence.getIndex').mock.calls[0]).toEqual(['sess-1']);

    // 头部：会话名 + 条数（异步等待索引 resolve 后的重渲）
    expect(screen.getByText('证据 · Worker A')).toBeTruthy();
    await screen.findByText('3 条证据');
    // 倒序：第一条（列表首项）是 ts 最新的 p-1（working → 等待输入）
    const firstHead = document.querySelector('.ev-item-head');
    expect(firstHead?.textContent).toContain('等待输入');
    expect(firstHead?.textContent).toContain('工作中');
  });

  it('pty 条目点击展开 → 懒加载切片正文（entryText 一次）', async () => {
    const user = userEvent.setup();
    const mock = currentApiMock();
    mock.override('evidence.getIndex', () => Promise.resolve(fixtureIndex()));
    mock.override('evidence.entryText', () => Promise.resolve({ text: '[phase-flip] working -> waiting\n--- before ---\n$ npm run build' }));
    renderPanel();
    await open({ sessionId: 'sess-1', sessionName: 'Worker A' });
    await screen.findByRole('dialog');

    // 未展开不拉正文
    expect(mock.mockOf('evidence.entryText')).not.toHaveBeenCalled();

    const heads = await waitFor(() => {
      const hs = screen.getAllByRole('button').filter((b) => b.className.includes('ev-item-head'));
      expect(hs.length).toBe(3);
      return hs;
    });
    await user.click(heads[0]);
    expect(heads[0].getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByText(/\$ npm run build/)).toBeTruthy();
    expect(mock.mockOf('evidence.entryText').mock.calls[0]).toEqual(['sess-1', 'p-1']);

    // 收起再展开：已缓存，不重复拉
    await user.click(heads[0]);
    await user.click(heads[0]);
    expect(mock.mockOf('evidence.entryText')).toHaveBeenCalledTimes(1);
  });

  it('bgtask 条目：命令 + exit 徽标直出，展开显示摘要', async () => {
    const user = userEvent.setup();
    const mock = currentApiMock();
    mock.override('evidence.getIndex', () => Promise.resolve(fixtureIndex()));
    renderPanel();
    await open({ sessionId: 'sess-1', sessionName: 'Worker A' });
    await screen.findByRole('dialog');

    expect(await screen.findByText('npm test')).toBeTruthy();
    expect(await screen.findByText('失败 · exit 1')).toBeTruthy();

    // bgTask 条目是时间线第 2 项（ts 中间）
    const heads = await waitFor(() => {
      const hs = screen.getAllByRole('button').filter((b) => b.className.includes('ev-item-head'));
      expect(hs.length).toBe(3);
      return hs;
    });
    await user.click(heads[1]);
    expect(await screen.findByText('3 failing')).toBeTruthy();
  });

  it('browser 截图条目：缩略图懒加载，点击开大图，Esc 关大图不关面板', async () => {
    const user = userEvent.setup();
    const mock = currentApiMock();
    mock.override('evidence.getIndex', () =>
      Promise.resolve({
      version: 1,
      sessionId: 'sess-1',
      createdAt: T0,
      updatedAt: T0,
      entries: [
        {
          id: 's-1',
          kind: 'browser-shot',
          ts: T0,
          file: 's-1.png',
          sourcePath: 'C:/captures/x.png'
        }
      ]
      })
    );
    mock.override('evidence.entryImage', () =>
      Promise.resolve({ dataUrl: 'data:image/png;base64,AAAA' }));
    renderPanel();
    await open({ sessionId: 'sess-1', sessionName: 'Worker A' });

    // 缩略按钮的 accessible name 来自内部 img 的 alt
    const thumb = await screen.findByRole('button', { name: '浏览器截图' });
    expect(mock.mockOf('evidence.entryImage').mock.calls[0]).toEqual(['sess-1', 's-1']);

    await user.click(thumb);
    // ImageLightbox 大图（overlay role=dialog aria-label=图片查看）
    expect(await screen.findByRole('dialog', { name: '图片查看' })).toBeTruthy();
    // 面板本体仍在
    expect(screen.getByRole('dialog', { name: '会话证据' })).toBeTruthy();
  });

  it('无归档 → 空态提示；关闭 → 退场卸载；重开同会话重新拉取', async () => {
    const user = userEvent.setup();
    const mock = currentApiMock();
    mock.override('evidence.getIndex', () => Promise.resolve(null));
    renderPanel();

    await open({ sessionId: 'sess-x', sessionName: 'Worker B' });
    expect(await screen.findByText('暂无证据')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '关闭' }));
    await waitFor(
      () => {
        expect(screen.queryByRole('dialog')).toBeNull();
      },
      { timeout: MOTION.exitMs + 2000 }
    );

    // 关闭期间（退场后）重开：重新拉取
    await open({ sessionId: 'sess-x', sessionName: 'Worker B' });
    await screen.findByText('暂无证据');
    expect(mock.mockOf('evidence.getIndex')).toHaveBeenCalledTimes(2);

    await close();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('读取失败 → 错误态 + 重试', async () => {
    const user = userEvent.setup();
    const mock = currentApiMock();
    let fail = true;
    mock.override('evidence.getIndex', () => {
      if (fail) return Promise.reject(new Error('boom'));
      return Promise.resolve(fixtureIndex());
    });
    renderPanel();
    await open({ sessionId: 'sess-1', sessionName: 'Worker A' });

    expect(await screen.findByText('读取证据失败：boom')).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('3 条证据')).toBeTruthy();
  });

  it('未知 kind（未来新增/盘上脏数据）：中性兜底渲染 kind 原文，不当截图渲染、不调 IPC', async () => {
    const mock = currentApiMock();
    mock.override('evidence.getIndex', () =>
      Promise.resolve({
        version: 1,
        sessionId: 'sess-1',
        createdAt: T0,
        updatedAt: T0,
        entries: [
          {
            id: 'u-1',
            kind: 'weird-kind' as never,
            ts: T0 + 1500
          }
        ]
      })
    );
    renderPanel();
    await open({ sessionId: 'sess-1', sessionName: 'Worker A' });
    await screen.findByRole('dialog');

    expect(await screen.findByText('1 条证据')).toBeTruthy();

    // 中性兜底渲染 kind 原文；不出现截图兜底文案、不调 IPC
    expect(screen.getByText('未知条目类型：weird-kind')).toBeTruthy();
    expect(screen.queryByText('截图已清理或读取失败（证据保留 7 天）')).toBeNull();
    expect(mock.mockOf('evidence.entryImage')).not.toHaveBeenCalled();
  });

  it('回归：A 的慢响应在切换到 B 后到达 → 不得覆盖 B（代次守卫）', async () => {
    const mock = currentApiMock();
    const resolvers = new Map<string, Array<(v: EvidenceIndex | null) => void>>();
    mock.override('evidence.getIndex', (sessionId: string) => {
      return new Promise((resolve) => {
        const list = resolvers.get(sessionId) ?? [];
        list.push(resolve);
        resolvers.set(sessionId, list);
      });
    });
    renderPanel();

    await open({ sessionId: 'sess-a', sessionName: 'Worker A' });
    await screen.findByRole('dialog');
    // 退场期 A 未完成拉取（宿主保持挂载、左栏可继续操作）→ 立即打开 B
    await close();
    await open({ sessionId: 'sess-b', sessionName: 'Worker B' });
    expect(screen.getByText('证据 · Worker B')).toBeTruthy();

    // A 的慢响应后到：必须被丢弃，B 不得被 A 的索引污染
    await act(async () => {
      resolvers.get('sess-a')![0](fixtureIndex());
    });
    expect(screen.getByText('证据 · Worker B')).toBeTruthy();
    expect(screen.queryByText('3 条证据')).toBeNull();

    // B 自己的响应到达 → 正常渲染
    await act(async () => {
      resolvers.get('sess-b')![0](fixtureIndex());
    });
    await screen.findByText('3 条证据');
    expect(screen.getByText('证据 · Worker B')).toBeTruthy();
  });
});
