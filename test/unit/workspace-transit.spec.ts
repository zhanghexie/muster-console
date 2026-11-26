/**
 * 工作区切换过场编排（workspaceTransit）：
 * - 切区 IPC 只在骨架盖满（滑动结束）后才发——主进程切区即广播 workspaces:changed 与主题，
 *   滑动途中发出会在仍可见的实况半屏上闪出新区；
 * - 防重入「以最后一次为准」：滑动/切区期间的新请求不另起滑动；淡出期到达的另起一次完整过场；
 * - 失败撤掉过场、不淡出；减弱动态不 sleep 直接切。
 * 桌面切区入口（QuickOpen/BoardPanel/AgentFloat）一律经 useWorkspaceTransitSwitch。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { renderHook } from '@testing-library/react';
import {
  createWorkspaceTransit,
  useWorkspaceTransitSwitch,
  WorkspaceTransitContext,
  type SwitchResult,
  type TransitPhase
} from '../../src/renderer/src/workspaceTransit';
import { MOTION } from '../../src/renderer/src/components/motion';

type Log = string[];

function setup(opts: { reduced?: boolean; switchImpl?: (id: string) => Promise<SwitchResult> } = {}) {
  const log: Log = [];
  const doSwitch = vi.fn(
    opts.switchImpl ??
      (async (id: string): Promise<SwitchResult> => {
        log.push(`switch:${id}`);
        return { ok: true };
      })
  );
  const transit = createWorkspaceTransit({
    setPhase: (phase: TransitPhase | null, toId: string) => log.push(`${phase ?? 'null'}:${toId}`),
    doSwitch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    nextFrame: () => Promise.resolve(),
    reducedMotion: () => opts.reduced === true
  });
  return { log, doSwitch, transit };
}

describe('workspaceTransit 过场编排', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('滑到骨架（workspaceMs）结束前不发切区；切完淡出骨架（workspacefadeMs）后撤场', async () => {
    const { log, doSwitch, transit } = setup();
    const p = transit.run('b');
    await vi.advanceTimersByTimeAsync(MOTION.workspaceMs - 1);
    expect(doSwitch).not.toHaveBeenCalled();
    expect(log).toEqual(['arm:b', 'to-skel:b']);

    await vi.advanceTimersByTimeAsync(1);
    expect(doSwitch).toHaveBeenCalledWith('b');
    expect(log.at(-1)).toBe('fade:b');

    await vi.advanceTimersByTimeAsync(MOTION.workspacefadeMs);
    await expect(p).resolves.toEqual({ ok: true });
    expect(log).toEqual(['arm:b', 'to-skel:b', 'switch:b', 'fade:b', 'null:b']);
    expect(transit.isRunning()).toBe(false);
  });

  it('滑动中再点别的区：不重滑，只切最后一次的目标', async () => {
    const { log, doSwitch, transit } = setup();
    const p1 = transit.run('b');
    await vi.advanceTimersByTimeAsync(100);
    const p2 = transit.run('c');
    const p3 = transit.run('d');
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
    await vi.advanceTimersByTimeAsync(MOTION.workspaceMs + MOTION.workspacefadeMs);
    await p1;
    expect(doSwitch).toHaveBeenCalledTimes(1);
    expect(doSwitch).toHaveBeenCalledWith('d');
    expect(log.filter((l) => l.startsWith('arm:'))).toHaveLength(1);
  });

  it('切区 IPC 在途时的新请求：骨架下直接续切，不另起滑动', async () => {
    let release!: () => void;
    const calls: string[] = [];
    const { log, transit } = setup({
      switchImpl: (id) => {
        calls.push(id);
        if (id === 'b') return new Promise((r) => (release = () => r({ ok: true })));
        return Promise.resolve({ ok: true });
      }
    });
    const p = transit.run('b');
    await vi.advanceTimersByTimeAsync(MOTION.workspaceMs);
    expect(calls).toEqual(['b']);
    transit.run('c');
    release();
    await vi.advanceTimersByTimeAsync(MOTION.workspacefadeMs);
    await p;
    expect(calls).toEqual(['b', 'c']);
    expect(log.filter((l) => l.startsWith('arm:'))).toHaveLength(1);
  });

  it('淡出期到达的请求：本次撤场后另起一次完整过场', async () => {
    const { log, doSwitch, transit } = setup();
    const p = transit.run('b');
    await vi.advanceTimersByTimeAsync(MOTION.workspaceMs);
    expect(log.at(-1)).toBe('fade:b');
    transit.run('c');
    await vi.advanceTimersByTimeAsync(MOTION.workspacefadeMs + MOTION.workspaceMs + MOTION.workspacefadeMs);
    await p;
    expect(doSwitch.mock.calls.map((c) => c[0])).toEqual(['b', 'c']);
    expect(log.filter((l) => l.startsWith('arm:'))).toEqual(['arm:b', 'arm:c']);
  });

  it('切区失败：撤掉过场、不播淡出，返回失败', async () => {
    const { log, transit } = setup({
      switchImpl: async () => ({ ok: false, message: 'boom' })
    });
    const p = transit.run('b');
    await vi.advanceTimersByTimeAsync(MOTION.workspaceMs);
    await expect(p).resolves.toEqual({ ok: false, message: 'boom' });
    expect(log).toEqual(['arm:b', 'to-skel:b', 'null:b']);
    expect(transit.isRunning()).toBe(false);
  });

  it('减弱动态：不滑不淡、不 sleep，直接切区', async () => {
    const { log, doSwitch, transit } = setup({ reduced: true });
    await transit.run('b');
    expect(doSwitch).toHaveBeenCalledWith('b');
    expect(log).toEqual(['switch:b', 'null:b']);
  });

  it('目标工作区可见后才开始淡出骨架', async () => {
    let releaseVisible!: () => void;
    const visible = new Promise<void>(resolve => { releaseVisible = resolve; });
    const { log, doSwitch } = setup();
    const transit = createWorkspaceTransit({
      setPhase: (phase, toId) => log.push(`${phase ?? 'null'}:${toId}`),
      doSwitch,
      sleep: (ms) => new Promise(r => setTimeout(r, ms)),
      nextFrame: () => Promise.resolve(),
      reducedMotion: () => false,
      waitForVisible: () => visible
    });
    const p = transit.run('b');
    await vi.advanceTimersByTimeAsync(MOTION.workspaceMs);
    expect(log).toEqual(['arm:b', 'to-skel:b', 'switch:b']);
    releaseVisible();
    await Promise.resolve();
    expect(log.at(-1)).toBe('fade:b');
    await vi.advanceTimersByTimeAsync(MOTION.workspacefadeMs);
    await expect(p).resolves.toEqual({ ok: true });
  });

});

describe('useWorkspaceTransitSwitch 与桌面入口', () => {
  it('有 Provider 用带过场切区，无 Provider（手机端/单测）回落直切', () => {
    const direct = vi.fn(async () => ({ ok: true }));
    const transit = vi.fn(async () => ({ ok: true }));
    const bare = renderHook(() => useWorkspaceTransitSwitch(direct));
    expect(bare.result.current).toBe(direct);
    const wrapped = renderHook(() => useWorkspaceTransitSwitch(direct), {
      wrapper: ({ children }) =>
        React.createElement(WorkspaceTransitContext.Provider, { value: transit }, children)
    });
    expect(wrapped.result.current).toBe(transit);
  });

  it('桌面切区入口一律经 useWorkspaceTransitSwitch，不直调 store 切区', () => {
    const files = [
      // ChromeBar 原经此切区（顶栏工作区菜单），2026-10-10 菜单撤出顶栏后不再消费
      'components/QuickOpen.tsx',
      'panels/BoardPanel.tsx',
      'panels/AgentFloat.tsx'
    ];
    for (const rel of files) {
      const src = readFileSync(resolve(__dirname, '../../src/renderer/src', rel), 'utf8');
      expect(src, rel).toMatch(/useWorkspaceTransitSwitch\(/);
    }
    const usage = readFileSync(resolve(__dirname, '../../src/renderer/src/components/UsageStatsPanel.tsx'), 'utf8');
    expect(usage).not.toMatch(/switchWorkspace|workspaces\.switch/);
    const app = readFileSync(resolve(__dirname, '../../src/renderer/src/App.tsx'), 'utf8');
    expect(app).toMatch(/<WorkspaceTransitContext\.Provider value=\{transitSwitch\}>/);
    expect(app).not.toMatch(/runWorkspaceSwitch/);
  });
});
