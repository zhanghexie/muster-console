/**
 * 命令面板「内容」档：跨文件搜索并进全局搜索框（不是当前文件浮条）。
 */
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoreProvider, useUiStore } from '../../src/renderer/src/store';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { QuickOpen } from '../../src/renderer/src/components/QuickOpen';
import { currentApiMock } from './helpers/api-mock';
import type { PaletteMode } from '../../src/shared/commandPalette';
import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';

beforeEach(() => dismissTip());

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];
const fileRef = (relativePath: string) => ({ workspaceId: 'ws-a', rootId: 'root-ws-a', relativePath });
const result = (items: unknown[], error?: string) => ({ items, roots: [], rootsRevision: 0, cancelled: false, truncated: false, ...(error ? { error } : {}) });
const files = (paths: string[]) => result(paths.map(path => ({ path, fileRef: fileRef(path), absolutePath: `E:/demo/a/${path}` })));

function seed(): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
  );
  mock.override('sessions.list', () => Promise.resolve({ sessions: [], activeId: null }));
}

function Harness({ mode }: { mode: PaletteMode }): React.JSX.Element {
  const { openWorkspaceFile, closeCommandPalette } = useUiStore();
  return (
    <>
      <QuickOpen
        workspaceId="ws-a"
        mode={mode}
        seq={0}
        onRequestMode={() => {}}
        onOpenSettings={() => {}}
        onClose={closeCommandPalette}
      />
      {openWorkspaceFile ? (
        <div data-testid="opened">
          {openWorkspaceFile.path}:{openWorkspaceFile.line ?? ''}
        </div>
      ) : null}
    </>
  );
}

function renderPalette(mode: PaletteMode = 'content'): void {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  seed();
  render(
    <StoreProvider>
      <KeybindingProvider>
        <Harness mode={mode} />
      </KeybindingProvider>
    </StoreProvider>
  );
}

describe('QuickOpen 内容档（跨文件搜索）', () => {
  it('内容档空查询提示输入，不调 searchFiles', async () => {
    const mock = currentApiMock();
    renderPalette('content');
    const tab = await screen.findByRole('tab', { name: '内容' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('输入关键字开始搜索')).toBeTruthy();
    expect(mock.mockOf('fs.searchFiles')).not.toHaveBeenCalled();
  });

  it('输入后防抖 searchFiles，回车打开命中行', async () => {
    const mock = currentApiMock();
    mock.override('fs.searchFiles', () => Promise.resolve(result([
      { path: 'src/app.ts', fileRef: fileRef('src/app.ts'), line: 12, preview: 'export const Foo = 1' }
    ])));
    const user = userEvent.setup();
    renderPalette('content');
    const input = await screen.findByRole('combobox');
    await user.type(input, 'Foo');
    expect(await screen.findByText('src/app.ts:12')).toBeTruthy();
    expect(screen.getByText('app.ts')).toBeTruthy();
    expect(screen.getByText('Foo')).toBeTruthy();
    await waitFor(() => {
      expect(mock.mockOf('fs.searchFiles')).toHaveBeenCalled();
    });
    await user.keyboard('{Enter}');
    const opened = await screen.findByTestId('opened');
    expect(opened.textContent).toMatch(/src[/\\]app\.ts:12/);
  });

  it('全部档有字也不搜正文', async () => {
    const mock = currentApiMock();
    mock.override('fs.listFiles', () => Promise.resolve(files(['src/app.ts'])));
    const user = userEvent.setup();
    renderPalette('goto');
    const input = await screen.findByRole('combobox');
    await user.type(input, 'Foo');
    await waitFor(() => {
      expect(mock.mockOf('fs.listFiles')).toHaveBeenCalled();
    });
    expect(mock.mockOf('fs.searchFiles')).not.toHaveBeenCalled();
  });
});

// ---------- 文件档在途去重（P2-3①）----------
// 契约：并发同工作区/根版本 listFiles 复用同一 Promise（不再双份 8000 路径 IPC）；
// reject 清在途记录，失败后重开允许重试；loadedFor 组件语义不变。
// 还原即红：恢复 effect 内直调 listFiles 后，「IPC 只发一次」断言转红（=2）。
describe('QuickOpen 文件档在途去重（P2-3①）', () => {
  it('并发同工作区 listFiles 复用同一 Promise：IPC 只发一次，两实例都拿到路径', async () => {
    const mock = currentApiMock();
    let calls = 0;
    let resolveList: (v: ReturnType<typeof files>) => void = () => {};
    mock.override('fs.listFiles', () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveList = resolve;
      });
    });
    seed();
    render(
      <StoreProvider>
        <KeybindingProvider>
          <Harness mode="file" />
          <Harness mode="file" />
        </KeybindingProvider>
      </StoreProvider>
    );
    await waitFor(() => expect(calls).toBe(1));
    resolveList(files(['src/a.ts', 'src/b.ts']));
    await waitFor(() => {
      expect(screen.getAllByText(/src\/a\.ts/).length).toBe(2);
    });
  });

  it('reject 清在途记录：失败提示后重开允许重试成功', async () => {
    const mock = currentApiMock();
    let calls = 0;
    mock.override('fs.listFiles', () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(result([], 'boom'))
        : Promise.resolve(files(['src/ok.ts']));
    });
    const view = renderPalette('file');
    await waitFor(() => expect(getTipSnapshot()?.text).toContain('boom'));
    // 卸载重开（新实例 loadedFor=null）：在途已清，允许重试且成功
    cleanup();
    renderPalette('file');
    expect(await screen.findByText(/src\/ok\.ts/)).toBeTruthy();
  });
});
