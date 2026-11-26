/**
 * 设置 → 通用页「任务运行时阻止休眠」开关（T3.4；原在 Worker 页，重设计后移到通用页）
 * 与「会话结束自动写日志」开关：都是表单项，拨动只写草稿（set），随「保存」生效。
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GeneralPane } from '../../src/renderer/src/components/settings/GeneralPane';
import type { AppConfig } from '../../src/shared/types';

function makeCfg(patch?: Partial<AppConfig>): AppConfig {
  return { tasksKeepAwake: true, ...patch } as AppConfig;
}

describe('GeneralPane keep-awake（T3.4）', () => {
  it('默认开；关掉写 tasksKeepAwake:false', async () => {
    const set = vi.fn();
    render(<GeneralPane cfg={makeCfg()} set={set} />);
    const cb = screen.getByRole('checkbox', { name: '任务运行时阻止休眠' }) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    await userEvent.click(cb);
    expect(set).toHaveBeenCalledWith({ tasksKeepAwake: false });
  });

  it('显式 false 时为关', () => {
    render(<GeneralPane cfg={makeCfg({ tasksKeepAwake: false })} set={vi.fn()} />);
    const cb = screen.getByRole('checkbox', { name: '任务运行时阻止休眠' }) as HTMLInputElement;
    expect(cb.checked).toBe(false);
  });

  it('自动写日志默认关；打开写 journalExitSummaryEnabled:true', async () => {
    const set = vi.fn();
    render(<GeneralPane cfg={makeCfg()} set={set} />);
    const cb = screen.getByRole('checkbox', { name: '会话结束自动写日志' }) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    await userEvent.click(cb);
    expect(set).toHaveBeenCalledWith({ journalExitSummaryEnabled: true });
  });
});
