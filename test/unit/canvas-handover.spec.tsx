import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useCanvasCreate } from '../../src/renderer/src/panels/freeCanvas/useCanvasCreate';
import { currentApiMock } from './helpers/api-mock';
import { applyLocaleSetting } from '../../src/shared/i18n';

const point = { x: 500, y: 240 };
const requestCreate = vi.fn();
const flashTip = vi.fn();
const draft = { id: 'draft', sourceId: 'source', workspaceId: 'ws', sourceRoot: { rootId: 'root', path: 'E:/work' },
  name: '原任务 ·交接', documentPath: 'E:/data/history.md', lockedTask: '必须读取 E:/data/history.md' };

function Actions() {
  const create = useCanvasCreate({ posOf: () => ({ x: 0, y: 0 }), flashTip, onRequestCreate: requestCreate,
    setStickyEdit: vi.fn(), setSelNodes: vi.fn(), setSelEdges: vi.fn(), setSelGroups: vi.fn() });
  return <>
    <button onClick={() => create.requestLinkMenu({ from: 'source', fromPort: 'e', world: point, x: 10, y: 10 })}>拉线</button>
    {create.linkMenu && <button onClick={() => create.onLinkMenu('handover')}>交接</button>}
    {create.handoverJobs.source && <button onClick={() => create.cancelHandover(create.handoverJobs.source!)}>取消准备</button>}
  </>;
}

async function start() {
  fireEvent.click(screen.getByText('拉线'));
  const button = await screen.findByText('交接');
  await act(async () => { fireEvent.click(button); await Promise.resolve(); });
}

beforeEach(() => { requestCreate.mockReset(); flashTip.mockReset(); });

it('准备好文档后打开新建任务，不直接创建或发送新会话', async () => {
  const api = currentApiMock();
  api.override('sessions.canvasHandover', async () => draft);
  render(<Actions />); await start();
  await waitFor(() => expect(requestCreate).toHaveBeenCalledWith({ world: point, handover: { draft, fromPort: 'e' } }));
  expect(api.mockOf('sessions.canvasHandover')).toHaveBeenCalledWith('source');
  expect(api.mockOf('sessions.delegate')).not.toHaveBeenCalled();
});

it('准备中取消后清理迟到的草稿，不打开任务窗口', async () => {
  const api = currentApiMock(); let resolve!: (value: typeof draft) => void;
  api.override('sessions.canvasHandover', () => new Promise(done => { resolve = done; }));
  api.override('sessions.canvasHandoverCancel', async () => ({ ok: true }));
  render(<Actions />); await start();
  fireEvent.click(await screen.findByText('取消准备'));
  await act(async () => resolve(draft));
  await waitFor(() => expect(api.mockOf('sessions.canvasHandoverCancel')).toHaveBeenCalledWith('draft'));
  expect(requestCreate).not.toHaveBeenCalled();
});

it('英文界面重复准备时给出提示且不重复创建草稿', async () => {
  const api = currentApiMock(); let resolve!: (value: typeof draft) => void;
  api.override('sessions.canvasHandover', () => new Promise(done => { resolve = done; }));
  try {
    act(() => { applyLocaleSetting('en'); });
    render(<Actions />); await start(); await start();
    expect(flashTip).toHaveBeenCalledWith('Preparing the handover. Please wait.');
    expect(api.mockOf('sessions.canvasHandover')).toHaveBeenCalledTimes(1);
    await act(async () => resolve(draft));
  } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
});
