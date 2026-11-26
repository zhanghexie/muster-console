/**
 * 后台任务上弹面板：四角圆角由外壳统一裁剪（禁止按角特判）。
 * 回归：子层（列表/详情）是直角填满盒，外壳若不 overflow 裁进 --radius-modal，
 * 底角会露直角并盖住邻近的窗口圆角。
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BgTasksPanel } from '../../src/renderer/src/agentChat/BgTasksPanel';
import type { BgTaskRecord } from '../../src/shared/backgroundTasks';
import { currentApiMock } from './helpers/api-mock';

const here = dirname(fileURLToPath(import.meta.url));

const TIMER: BgTaskRecord = {
  id: 'bg-timer-1',
  parentSessionId: 'sess-1',
  kind: 'timer',
  label: '十分钟后再看',
  detail: '检查部署',
  wakeAt: Date.now() + 60_000,
  status: 'running',
  createdAt: Date.now() - 5_000,
  unread: false,
  pendingDigest: false,
  wake: true
};

function renderPanel(onClose = () => undefined) {
  return render(
    <BgTasksPanel
      sessionId="sess-1"
      tasks={[TIMER]}
      messagesByTask={{}}
      open
      stage="in"
      onClose={onClose}
    />
  );
}

describe('后台任务面板圆角裁剪', () => {
  it('打开面板后点「关闭面板」走 onClose', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPanel(onClose);
    const dialog = screen.getByRole('dialog', { name: '后台任务' });
    expect(dialog.className).toMatch(/\bbg-tasks-pop\b/);
    // 列表行 + 详情头各一份
    expect(screen.getAllByText('十分钟后再看').length).toBe(2);

    await user.click(screen.getByRole('button', { name: '关闭面板' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('运行中任务点取消走 bgTasks.kill，不按角特判圆角', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(currentApiMock().mockOf('bgTasks.kill')).toHaveBeenCalledWith('bg-timer-1');
  });

  it('外壳四角同一 --radius-modal 且 overflow 裁子层，阴影走 token', () => {
    const css = readFileSync(resolve(here, '../../src/renderer/src/styles/bgTasks.css'), 'utf8');
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const block = stripped.match(/\.bg-tasks-pop\s*\{([^}]+)\}/)?.[1];
    expect(block).toBeTruthy();
    expect(block).toMatch(/border-radius:\s*var\(--radius-modal\)\s*;/);
    expect(block).toMatch(/overflow:\s*hidden\s*;/);
    expect(block).toMatch(/box-shadow:\s*var\(--shadow-pop\)\s*;/);
    // 禁止四值拆角（如 modal modal 0 0）或单角覆盖——那会再把某一角修成直角
    expect(block).not.toMatch(/border-radius:\s*var\(--radius-modal\)\s+var\(--radius-modal\)/);
    expect(stripped).not.toMatch(/\.bg-tasks-pop[^{]*\{[^}]*border-(top|bottom)-(left|right)-radius/);
  });
});
