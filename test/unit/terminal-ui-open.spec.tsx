/**
 * 终端划词/扫描 → 「在网页区打开」ma-ui 部件链接（智能界面 M4 CLI 呈现层，组件级）：
 * 1) 划词文本含部件链接 → buildSelectionItems 出「在网页区打开」，点击经
 *    window.api.browser.open 以 muster-ext://f/<encoded> 形态逐条打开；
 * 2) 多于 3 条只开前 3 条并 toast 截断；
 * 3) 普通 .html（非部件路径）不出该项（识别通道本身正常——「在文件区预览」仍在）；
 * 4) browser.open 拒绝 → toast 提示且不中断其余条目；
 * 5) 扫描命中判定纯函数：实体文本命中 / absPath 兜底 / 普通路径返回空；
 * 6) TerminalScanOverlay：部件 file 命中菜单出该动作且 kind 动作保留；普通 file 不出。
 * window.api 走 helpers/api-mock（AGENTS.md 测试规约）；theme/KeybindingHost 按
 * terminal-scan-appearance.spec 先例 mock（jsdom 无 canvas/overlay 栈）。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installApiMock, currentApiMock } from './helpers/api-mock';
import { scanLinesForEntities, filterEntitiesByStat } from '../../src/shared/terminalScan';
import { entitiesToHits, readViewportLines } from '../../src/renderer/src/terminal/scanBuffer';
import type { Terminal } from '@xterm/xterm';
import type { SelectionBar as SelectionBarComp, SelectionBarItem } from '../../src/renderer/src/components/SelectionBar';
import type { buildSelectionItems as buildSelectionItemsFn, SelectionMenuServices } from '../../src/renderer/src/components/selectionMenuAreas';
import type { TerminalScanOverlay as TerminalScanOverlayComp, ScanHitView } from '../../src/renderer/src/components/TerminalScanOverlay';
import type {
  MAX_UI_ARTIFACT_OPEN as MaxOpen,
  openUiArtifactsInBrowser as openFn,
  uiArtifactLinksInScanHit as scanHitFn
} from '../../src/renderer/src/terminal/uiArtifactOpen';

const state = vi.hoisted(() => ({ appearance: { cssVars: { '--scrim': 'rgba(12, 14, 20, 0.4)' } } }));
vi.mock('../../src/renderer/src/theme', () => ({
  getResolvedAppearance: () => state.appearance,
  subscribeAppearance: () => () => {}
}));
vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({ useOverlayDismiss: () => {} }));

let SelectionBar: typeof SelectionBarComp;
let buildSelectionItems: typeof buildSelectionItemsFn;
let TerminalScanOverlay: typeof TerminalScanOverlayComp;
let openUiArtifactsInBrowser: typeof openFn;
let uiArtifactLinksInScanHit: typeof scanHitFn;
let MAX_UI_ARTIFACT_OPEN: number;

const ART = 'E:\\ws\\agent-sessions\\s1\\ui\\1-table.browser.html';
const ART_NORM = 'E:/ws/agent-sessions/s1/ui/1-table.browser.html';
const PLAIN = 'E:\\ws\\pages\\index.html';

beforeAll(async () => {
  installApiMock();
  ({ SelectionBar } = await import('../../src/renderer/src/components/SelectionBar'));
  ({ buildSelectionItems } = await import('../../src/renderer/src/components/selectionMenuAreas'));
  ({ TerminalScanOverlay } = await import('../../src/renderer/src/components/TerminalScanOverlay'));
  ({ openUiArtifactsInBrowser, uiArtifactLinksInScanHit, MAX_UI_ARTIFACT_OPEN } = await import(
    '../../src/renderer/src/terminal/uiArtifactOpen'
  ));
  // TerminalScanOverlay 挂载即 new ResizeObserver（jsdom 没有）；useListKeyboardNav 活动项
  // 滚动用 scrollIntoView（jsdom 也没有）——文件级 stub 不还原（本文件专用 vm 上下文）
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  (Element.prototype as { scrollIntoView?: () => void }).scrollIntoView = () => {};
});

function makeServices(): SelectionMenuServices & { tip: ReturnType<typeof vi.fn> } {
  return { tip: vi.fn(), insertComposer: vi.fn(), openFile: vi.fn() };
}

function renderBar(items: SelectionBarItem[]): void {
  render(
    <SelectionBar
      text="fixture"
      anchor={{ x: 0, y: 0 }}
      items={items}
      dismiss={() => {}}
      clearSelection={() => {}}
    />
  );
}

function openUrls(): string[] {
  return currentApiMock()
    .mockOf('browser.open')
    .mock.calls.map((c) => (c[0] as { url: string }).url);
}

describe('划词浮条菜单「在网页区打开」', () => {
  it('文本含部件链接 → 出菜单项；点击逐条 browser.open，URL 为 muster-ext 形态', async () => {
    const services = makeServices();
    const items = buildSelectionItems('terminal', {
      text: `已生成部件 ${ART} 请在网页区查看`,
      services
    });
    expect(items.some((i) => i.id === 'open-ui-artifact')).toBe(true);

    renderBar(items);
    fireEvent.click(screen.getByRole('button', { name: '在网页区打开' }));

    await waitFor(() => {
      expect(currentApiMock().mockOf('browser.open').mock.calls).toHaveLength(1);
    });
    const urls = openUrls();
    expect(urls[0]!.startsWith('muster-ext://f/')).toBe(true);
    expect(decodeURIComponent(urls[0]!.slice('muster-ext://f/'.length))).toBe(ART_NORM);
    expect(services.tip).not.toHaveBeenCalled();
  });

  it('打开终端选区里的部件时使用来源会话，而非当前会话', async () => {
    const owner = { workspaceId: 'ws-origin', sessionId: 'chat-origin', scope: 'session' as const };
    renderBar(buildSelectionItems('terminal', { text: ART, services: makeServices(), context: { rightOwner: owner } }));
    fireEvent.click(screen.getByRole('button', { name: '在网页区打开' }));
    await waitFor(() => expect(currentApiMock().mockOf('browser.open')).toHaveBeenCalledWith(expect.objectContaining(owner)));
  });

  it('多条全部打开；超过 3 条只开前 3 条并 toast 截断', async () => {
    const services = makeServices();
    const text = [
      'E:\\ws\\agent-sessions\\s1\\ui\\1-a.browser.html',
      'E:\\ws\\agent-sessions\\s2\\ui\\2-b.inline.html',
      'E:\\ws\\agent-sessions\\s3\\ui\\3-c.browser.html',
      'E:\\ws\\agent-sessions\\s4\\ui\\4-d.inline.html',
      'E:\\ws\\agent-sessions\\s5\\ui\\5-e.browser.html'
    ].join(' ');
    const items = buildSelectionItems('terminal', { text, services });
    renderBar(items);
    fireEvent.click(screen.getByRole('button', { name: '在网页区打开' }));

    await waitFor(() => {
      expect(currentApiMock().mockOf('browser.open').mock.calls).toHaveLength(3);
    });
    const decoded = openUrls().map((u) => decodeURIComponent(u.slice('muster-ext://f/'.length)));
    expect(decoded[0]).toBe('E:/ws/agent-sessions/s1/ui/1-a.browser.html');
    expect(decoded[2]).toBe('E:/ws/agent-sessions/s3/ui/3-c.browser.html');
    expect(decoded.some((p) => p.includes('s4/'))).toBe(false);
    expect(services.tip).toHaveBeenCalledWith('部件较多，仅打开前 3 个');
    expect(MAX_UI_ARTIFACT_OPEN).toBe(3);
  });

  it('普通 .html（非部件路径）不出该项；「在文件区预览」识别通道不受影响', () => {
    const services = makeServices();
    const items = buildSelectionItems('terminal', { text: `看下 ${PLAIN}`, services });
    expect(items.some((i) => i.id === 'open-ui-artifact')).toBe(false);
    expect(items.some((i) => i.id === 'preview')).toBe(true);
  });

  it('browser.open 拒绝 → toast「在网页区打开失败」，不中断其余条目', async () => {
    currentApiMock().override('browser.open', () => Promise.reject(new Error('boom')));
    const tip = vi.fn();
    await openUiArtifactsInBrowser(
      [
        { path: ART_NORM, mode: 'browser' },
        { path: 'E:/ws/agent-sessions/s2/ui/2-b.inline.html', mode: 'inline' }
      ],
      tip
    );
    expect(currentApiMock().mockOf('browser.open').mock.calls).toHaveLength(2);
    expect(tip).toHaveBeenCalledWith('在网页区打开失败');
    expect(tip).not.toHaveBeenCalledWith('部件较多，仅打开前 3 个');
  });
});

describe('扫描命中判定（uiArtifactLinksInScanHit 纯函数）', () => {
  it('实体文本命中；absPath 兜底；普通路径返回空', () => {
    expect(uiArtifactLinksInScanHit({ text: ART, absPath: ART_NORM })).toEqual([
      { path: ART_NORM, mode: 'browser' }
    ]);
    // 文本形态不完整（回填/截断）时 absPath（stat 已确认）兜底
    expect(uiArtifactLinksInScanHit({ text: 'x', absPath: ART_NORM })).toEqual([
      { path: ART_NORM, mode: 'browser' }
    ]);
    expect(uiArtifactLinksInScanHit({ text: PLAIN, absPath: 'E:/ws/pages/index.html' })).toEqual([]);
    expect(uiArtifactLinksInScanHit({ text: '没有路径' })).toEqual([]);
  });
});

describe('终端识屏浮层「在网页区打开」', () => {
  it('软折行路径的两段均可点击，预览收到完整路径（含视口外上下文）', async () => {
    const path = 'release\\win-unpacked\\OpenConsole.exe';
    const rows = ['path=release\\win-unpacked\\Open', 'Console.exe'];
    const term = {
      rows: 1,
      buffer: { active: { viewportY: 1, length: 2, getLine: (i: number) => i < 2 ? {
        isWrapped: i === 1, length: rows[i]!.length,
        translateToString: () => rows[i]!,
        getCell: (col: number) => ({ getWidth: () => 1, getChars: () => rows[i]![col]! })
      } : undefined } }
    } as unknown as Terminal;
    const scan = (): ScanHitView[] => entitiesToHits(term,
      filterEntitiesByStat(scanLinesForEntities(readViewportLines(term), 'E:\\ws'), 'E:\\ws', {
        [`E:\\ws\\${path}`]: { exists: true, isFile: true }
      }), 8, 16, { x: 0, y: 0 }, 'E:\\ws');
    expect(scan()[0]?.text).toBe(path);
    expect(scan()[0]?.rects).toEqual([{ left: 0, top: 0, width: 88, height: 16 }]);
    Object.assign(term, { rows: 2 });
    Object.assign(term.buffer.active, { viewportY: 0 });
    const hits = scan();
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rects).toHaveLength(2);
    const preview = vi.fn();
    render(<TerminalScanOverlay hits={hits} snapshot={null} onClose={() => {}} onTip={() => {}} onPreviewFile={preview} />);
    const parts = document.querySelectorAll(`[data-hit-id="${hits[0]!.id}"]`);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      fireEvent.mouseDown(part);
      fireEvent.click(await screen.findByRole('button', { name: '在文件区预览' }));
      expect(preview).toHaveBeenLastCalledWith(`E:\\ws\\${path}`, undefined, undefined);
    }
  });

  function scanOverlay(hit: ScanHitView, linkOwner?: { workspaceId: string; sessionId: string; scope: 'session' }): void {
    render(
      <TerminalScanOverlay
        hits={[hit]}
        snapshot={null}
        onClose={() => {}}
        onTip={() => {}}
        onPreviewFile={() => {}}
        linkOwner={linkOwner}
      />
    );
  }

  it('部件 file 命中 → 点命中矩形出「在网页区打开」，点击打开且 kind 动作保留', async () => {
    const owner = { workspaceId: 'ws-origin', sessionId: 'chat-origin', scope: 'session' as const };
    scanOverlay({
      id: '0:0:0',
      kind: 'file',
      text: ART,
      absPath: ART_NORM,
      rects: [{ left: 10, top: 10, width: 120, height: 16 }]
    }, owner);
    const hitEl = document.querySelector('[data-hit-id="0:0:0"]');
    expect(hitEl).toBeTruthy();
    fireEvent.mouseDown(hitEl!);

    const btn = await screen.findByRole('button', { name: '在网页区打开' });
    expect(screen.getByRole('button', { name: '在文件区预览' })).toBeTruthy();
    fireEvent.click(btn);

    await waitFor(() => {
      expect(currentApiMock().mockOf('browser.open').mock.calls).toHaveLength(1);
    });
    const url = openUrls()[0]!;
    expect(currentApiMock().mockOf('browser.open')).toHaveBeenCalledWith(expect.objectContaining(owner));
    expect(url.startsWith('muster-ext://f/')).toBe(true);
    expect(decodeURIComponent(url.slice('muster-ext://f/'.length))).toBe(ART_NORM);
  });

  it('普通 file 命中不出该动作', async () => {
    const view = render(
      <TerminalScanOverlay
        hits={[
          {
            id: '0:1:0',
            kind: 'file',
            text: PLAIN,
            absPath: 'E:/ws/pages/index.html',
            rects: [{ left: 10, top: 10, width: 90, height: 16 }]
          }
        ]}
        snapshot={null}
        onClose={() => {}}
        onTip={() => {}}
        onPreviewFile={() => {}}
      />
    );
    fireEvent.mouseDown(document.querySelector('[data-hit-id="0:1:0"]')!);
    await screen.findByRole('button', { name: '在文件区预览' });
    expect(screen.queryByRole('button', { name: '在网页区打开' })).toBeNull();
    view.unmount();
  });
});
