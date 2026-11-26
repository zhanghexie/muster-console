import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProcessMonitorPanel } from '../../src/renderer/src/panels/ProcessMonitorPanel';
import { currentApiMock } from './helpers/api-mock';

vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({
  useChordLabel: () => 'Ctrl+Shift+R',
  useOverlayDismiss: () => {}
}));

const snapshot = {
  capturedAt: 100,
  rootPid: 10,
  processCount: 3,
  historySize: 2,
  historyCapacity: 45,
  nodes: [{
    key: '10:1', pid: 10, parentPid: null, type: 'Browser', name: 'Muster', businessLabel: 'Muster 主进程',
    creationTime: 1, cpuPercent: 3.2, workingSetKb: 1024, children: [{
      key: '11:2', pid: 11, parentPid: 10, type: 'Tab', name: 'Renderer', title: '主窗口',
      creationTime: 2, cpuPercent: 8.4, workingSetKb: 2048, businessLabel: 'Pi 会话引擎', role: 'AI 会话工作进程', workspaceName: 'Demo 工作区', sessionName: '研究会话', taskId: 'task-7', children: []
    }]
  }]
};

beforeEach(() => {
  currentApiMock().override('processMonitor.snapshot', () => Promise.resolve(snapshot));
  currentApiMock().override('processMonitor.capture', () => Promise.resolve(snapshot));
  currentApiMock().override('processMonitor.cpuProfile', () => Promise.resolve({ ok: true, kind: 'cpu-profile', pid: 11, path: 'C:/tmp/11.cpuprofile', sizeBytes: 10, capturedAt: 100, durationMs: 3000 }));
  currentApiMock().override('processMonitor.cpuStart', () => Promise.resolve({ ok: true, pid: 11, startedAt: 100, maxDurationMs: 600000 }));
  currentApiMock().override('processMonitor.cpuStop', () => Promise.resolve({ ok: true, kind: 'cpu-profile', pid: 11, path: 'C:/tmp/11.cpuprofile', sizeBytes: 10, capturedAt: 100, durationMs: 3000 }));
  currentApiMock().override('processMonitor.heapSnapshot', () => Promise.resolve({ ok: true, kind: 'heap-snapshot', pid: 11, path: 'C:/tmp/11.heapsnapshot', sizeBytes: 10, capturedAt: 100 }));
  currentApiMock().override('processMonitor.openArtifact', () => Promise.resolve({ ok: true }));
});

it('展示父子进程树并在点击后更新详情，刷新按钮重新采样', async () => {
  const onClose = vi.fn();
  render(<ProcessMonitorPanel open onClose={onClose} />);
  expect(await screen.findByRole('dialog', { name: '运行监视器' })).toBeTruthy();
  expect(screen.getByText('Pi 会话引擎')).toBeTruthy();
  expect(screen.getByText('Demo 工作区')).toBeTruthy();
  expect(screen.getByText('研究会话')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(currentApiMock().mockOf('processMonitor.snapshot')).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getAllByText('Pi 会话引擎')[0]);
  expect(screen.getByText('父进程 PID 10')).toBeTruthy();
  expect(screen.getAllByText('8.4%').length).toBeGreaterThanOrEqual(2);
  expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
  fireEvent.pointerDown(document.querySelector('.process-monitor-overlay')!);
  expect(onClose).toHaveBeenCalledOnce();
});

it('顶部不再显示采集快照按钮', async () => {
  render(<ProcessMonitorPanel open onClose={() => {}} />);
  await screen.findByRole('dialog', { name: '运行监视器' });
  expect(screen.queryByRole('button', { name: '采集快照' })).toBeNull();
});

it('运行监视器点击空白收起，面板和磨砂各自退场，重开沿用原节点', async () => {
  function Harness(): React.JSX.Element {
    const [open, setOpen] = React.useState(true);
    return <>
      <button type="button" onClick={() => setOpen(true)}>打开运行监视器</button>
      <ProcessMonitorPanel open={open} onClose={() => setOpen(false)} />
    </>;
  }
  render(<Harness />);
  const sheet = await screen.findByRole('dialog', { name: '运行监视器' });
  const overlay = sheet.parentElement!;
  const scrim = overlay.querySelector<HTMLElement>(':scope > .backdrop-blur-overlay.mp-scrim');
  expect(scrim).toBeTruthy();
  expect(overlay.classList.contains('mp-scrim')).toBe(false);
  expect(sheet.classList.contains('mp-panel-fly')).toBe(true);
  fireEvent.pointerDown(overlay);
  expect(scrim?.dataset.mpStage).toBe('out');
  expect(sheet.dataset.mpStage).toBe('out');
  expect(overlay.hasAttribute('inert')).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: '打开运行监视器' }));
  expect(screen.getByRole('dialog', { name: '运行监视器' })).toBe(sheet);
  expect(overlay.querySelector('.mp-scrim')).toBe(scrim);
  expect(overlay.hasAttribute('inert')).toBe(false);
  expect(scrim?.dataset.mpStage).toBe('in');
  expect(sheet.dataset.mpStage).toBe('in');
  await waitFor(() => expect(currentApiMock().mockOf('processMonitor.snapshot')).toHaveBeenCalledTimes(2));
});

it('选中 Electron 进程后可以开始停止 CPU 采集并打开结果目录', async () => {
  render(<ProcessMonitorPanel open onClose={() => {}} />);
  await screen.findByRole('dialog', { name: '运行监视器' });
  fireEvent.click(screen.getAllByText('Pi 会话引擎')[0]);
  fireEvent.click(screen.getByRole('button', { name: /开始 CPU 采集/ }));
  await waitFor(() => expect(currentApiMock().mockOf('processMonitor.cpuStart')).toHaveBeenCalledWith(11));
  fireEvent.click(screen.getByRole('button', { name: /停止采集/ }));
  await waitFor(() => expect(currentApiMock().mockOf('processMonitor.cpuStop')).toHaveBeenCalledWith(11));
  expect(await screen.findByText(/CPU profile：C:\/tmp\/11\.cpuprofile/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '在资源管理器中打开' }));
  await waitFor(() => expect(currentApiMock().mockOf('processMonitor.openArtifact')).toHaveBeenCalledWith('C:/tmp/11.cpuprofile'));
  fireEvent.click(screen.getByRole('button', { name: '生成堆快照' }));
  await waitFor(() => expect(currentApiMock().mockOf('processMonitor.heapSnapshot')).toHaveBeenCalledWith(11));
});

