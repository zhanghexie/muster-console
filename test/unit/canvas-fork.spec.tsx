import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useCanvasCreate } from '../../src/renderer/src/panels/freeCanvas/useCanvasCreate';
import { emptyFreeViewLayout } from '../../src/renderer/src/panels/freeViewGeom';
import { getFreeViewLayout, setFreeViewLayout } from '../../src/renderer/src/panels/freeViewStore';
import { currentApiMock } from './helpers/api-mock';

const point = { x: 500, y: 240 };
const flashTip = vi.fn();

function CanvasActions() {
  const create = useCanvasCreate({ posOf: () => ({ x: 0, y: 0 }), flashTip,
    setStickyEdit: vi.fn(), setSelNodes: vi.fn(), setSelEdges: vi.fn(), setSelGroups: vi.fn() });
  return <>
    <button onClick={() => create.requestLinkMenu({ from: 'source', fromPort: 'e', world: point, x: 100, y: 100 })}>拉线</button>
    {create.linkMenu && <button onClick={() => create.onLinkMenu('fork')}>Fork</button>}
  </>;
}

async function clickFork() {
  fireEvent.click(screen.getByText('拉线'));
  const action = await screen.findByText('Fork');
  await act(async () => { fireEvent.click(action); await Promise.resolve(); });
}

beforeEach(() => {
  flashTip.mockReset();
  setFreeViewLayout({ ...emptyFreeViewLayout(), nodes: { source: { x: 0, y: 0 } } });
});

it('选择 Fork 后在拖线落点创建节点与 fork 类型连线', async () => {
  const mock = currentApiMock();
  mock.override('sessions.canvasFork', async () => ({ session: { id: 'child' } }));
  render(<CanvasActions />);
  await clickFork();
  await waitFor(() => expect(getFreeViewLayout().nodes.child).toEqual(point));
  expect(mock.mockOf('sessions.canvasFork')).toHaveBeenCalledWith('source');
  expect(getFreeViewLayout().edges).toEqual([expect.objectContaining({ from: 'source', to: 'child', kind: 'fork' })]);
});

it('主进程拒绝 fork 时显示错误，不添加节点或连线', async () => {
  const mock = currentApiMock();
  mock.override('sessions.canvasFork', async () => { throw new Error('当前回合进行中'); });
  render(<CanvasActions />);
  await clickFork();
  await waitFor(() => expect(flashTip).toHaveBeenCalledWith('当前回合进行中'));
  expect(getFreeViewLayout().edges).toEqual([]);
  expect(Object.keys(getFreeViewLayout().nodes)).toEqual(['source']);
});
