/**
 * 设置 → 通知页（NotifyPane，T1.4）组件测试：
 * - needs_you 锁定开（disabled + checked，产品规则不可关）；
 * - done/error 开关默认开，拨动写 prefs；
 * - 免打扰：默认收起，启用展开（acc 手风琴）并写 dnd；时间草稿实时同步、
 *   起止相同（无效窗口）不同步；关闭写 dnd:null（真实 state harness 验证开合流转）；
 * - 已退役飞书专属通知开关不再展示。
 * window.api 由 setup.ts 的 api-mock 提供（NotifyPane 走 cfg/set 草稿，不直连 api）。
 */
import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotifyPane } from '../../src/renderer/src/components/settings/NotifyPane';
import { currentApiMock } from './helpers/api-mock';
import { MOTION } from '../../src/renderer/src/components/motion';
import type { AppConfig } from '../../src/shared/types';
import type { NotifyPrefs } from '../../src/shared/notifyDecision';

function makeCfg(notify?: NotifyPrefs): AppConfig {
  return { notify } as AppConfig;
}

/** 参数断言用：set 为 mock（cfg 不回填，单次交互精确断言 patch） */
function renderPane(notify?: NotifyPrefs) {
  const set = vi.fn();
  render(<NotifyPane cfg={makeCfg(notify)} set={set} />);
  return { set };
}

/** 开合流转用：set 真正回写 state（模拟 SettingsModal 的 cfg/set 管线） */
function renderStateful(initial?: NotifyPrefs) {
  const calls: Partial<AppConfig>[] = [];
  const Holder = (): React.JSX.Element => {
    const [cfg, setCfg] = useState(makeCfg(initial));
    const set = (patch: Partial<AppConfig>): void => {
      calls.push(patch);
      setCfg((prev) => ({ ...prev, ...patch }));
    };
    return <NotifyPane cfg={cfg} set={set} />;
  };
  render(<Holder />);
  return { calls };
}

describe('NotifyPane 通知偏好（T1.4）', () => {
  it('needs_you 开关锁定开：checked 且 disabled', () => {
    renderPane();
    const cb = screen.getByRole('checkbox', {
      name: '需要你'
    }) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    expect(cb.disabled).toBe(true);
  });

  it('done/error 默认开；拨 done 写 notify.done=false（其余字段透传保留）', async () => {
    const user = userEvent.setup();
    const { set } = renderPane({ error: false });

    const done = screen.getByRole('checkbox', { name: '已完成' }) as HTMLInputElement;
    const error = screen.getByRole('checkbox', { name: '出错' }) as HTMLInputElement;
    expect(done.checked).toBe(true);
    expect(error.checked).toBe(false);

    await user.click(done);
    expect(set).toHaveBeenCalledWith({ notify: { error: false, done: false } });
  });

  it('免打扰默认收起；启用展开时间输入并写默认窗口（acc 手风琴）', async () => {
    const { calls } = renderStateful();

    // 收起态：presence 未挂载，时间输入不在文档中
    expect(screen.queryByLabelText('免打扰开始')).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: '免打扰' }));
    const start = (await screen.findByLabelText('免打扰开始')) as HTMLInputElement;
    const end = screen.getByLabelText('免打扰结束') as HTMLInputElement;
    expect(start.value).toBe('22:00');
    expect(end.value).toBe('08:00');
    expect(calls).toContainEqual({ notify: { dnd: { start: '22:00', end: '08:00' } } });
  });

  it('启用→关闭写 dnd:null（checkbox 复原、手风琴退场卸载）→再启用恢复', async () => {
    const { calls } = renderStateful();
    const user = userEvent.setup();
    const toggle = (): HTMLInputElement =>
      screen.getByRole('checkbox', { name: '免打扰' }) as HTMLInputElement;

    await user.click(toggle());
    expect(toggle().checked).toBe(true);

    await user.click(toggle());
    expect(toggle().checked).toBe(false);
    expect(calls).toContainEqual({ notify: { dnd: null } });
    // presence 退场（exitMs+80ms 兜底）后时间输入卸载
    await waitFor(
      () => {
        expect(screen.queryByLabelText('免打扰开始')).toBeNull();
      },
      { timeout: MOTION.exitMs + 500 }
    );

    await user.click(toggle());
    expect((await screen.findByLabelText('免打扰开始') as HTMLInputElement).value).toBe('22:00');
  });

  it('已配置窗口初始态正确；改时间实时同步，起止相同（无效）不同步', () => {
    const { set } = renderPane({ dnd: { start: '23:00', end: '06:30' } });

    const start = screen.getByLabelText('免打扰开始') as HTMLInputElement;
    const end = screen.getByLabelText('免打扰结束') as HTMLInputElement;
    expect(start.value).toBe('23:00');
    expect(end.value).toBe('06:30');
    expect((screen.getByRole('checkbox', { name: '免打扰' }) as HTMLInputElement).checked).toBe(true);

    // 合法变更：同步进 prefs（spread 覆盖同名 dnd 键）
    fireEvent.change(start, { target: { value: '22:30' } });
    expect(set).toHaveBeenCalledWith({
      notify: { dnd: { start: '22:30', end: '06:30' } }
    });

    // 改成与 end 相同 → 无效窗口，只留草稿不同步
    set.mockClear();
    fireEvent.change(start, { target: { value: '06:30' } });
    expect((screen.getByLabelText('免打扰开始') as HTMLInputElement).value).toBe('06:30');
    expect(set).not.toHaveBeenCalled();
  });

  it('关闭时草稿已无效（起止相同）：再启用回退默认夜间窗口，不写无效窗口', async () => {
    const { calls } = renderStateful();
    const user = userEvent.setup();
    const toggle = (): HTMLInputElement =>
      screen.getByRole('checkbox', { name: '免打扰' }) as HTMLInputElement;

    await user.click(toggle());
    // 把 end 改成与 start 相同 → 草稿 22:00–22:00（无效，不写 prefs）
    fireEvent.change(screen.getByLabelText('免打扰结束'), { target: { value: '22:00' } });
    expect(calls).not.toContainEqual({ notify: { dnd: { start: '22:00', end: '22:00' } } });

    await user.click(toggle()); // 关闭（dnd:null）
    await user.click(toggle()); // 再启用：回退默认
    expect((await screen.findByLabelText('免打扰开始') as HTMLInputElement).value).toBe('22:00');
    expect((screen.getByLabelText('免打扰结束') as HTMLInputElement).value).toBe('08:00');
    const last = calls[calls.length - 1];
    expect(last).toEqual({ notify: { dnd: { start: '22:00', end: '08:00' } } });
  });

  it('不再提供旧桥专属飞书通知设置', () => {
    renderPane();
    expect(screen.queryByRole('checkbox', { name: '只推送绑定到飞书的会话' })).toBeNull();
    expect(document.querySelector('[data-settings-item="notify-feishu"]')).toBeNull();
  });

  // notification F-01 应用内兜底：本机无系统通知能力时顶部提示一次
  it('无系统通知能力（notify.capability=false）时顶部显示兜底提示条；有能力时不显示', async () => {
    const banner = '本机无系统通知能力，桌面通知无法显示；「需要你」提醒请依赖左栏胶囊与看板列。';
    const incapable = currentApiMock();
    incapable.override('notify.capability', async () => false);
    const first = render(<NotifyPane cfg={makeCfg()} set={vi.fn()} />);
    expect(await screen.findByText(banner)).toBeTruthy();
    first.unmount();

    const capable = currentApiMock();
    capable.override('notify.capability', async () => true);
    render(<NotifyPane cfg={makeCfg()} set={vi.fn()} />);
    await screen.findByText('什么时候提醒');
    // 有能力时（默认）不出现兜底条
    expect(screen.queryByText(banner)).toBeNull();
  });
});
