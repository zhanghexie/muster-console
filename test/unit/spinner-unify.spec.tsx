/**
 * 运行态 spinner 收敛 + 相位同步：
 * 1. 几何：两枚工作中状态图标同源（ui-spinner + pathLength=100 正圆），禁 border 环；
 * 2. 相位：CSS 动画各自起表会让后挂载的缺口永久错开；IconSpinner 按全局时钟写负 delay。
 * 自查：IconStatusWorking 改回旧 path、结果卡改回 tt-card-spin、或 delay 恒为 0，本文件应转红。
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { IconSpinner } from '../../src/renderer/src/components/icons';
import { MOTION, spinnerPhaseDelayMs } from '../../src/renderer/src/components/motion';
import { SessionStatusIcon } from '../../src/renderer/src/components/StatusIcon';

const here = dirname(fileURLToPath(import.meta.url));

function spinnerCircle(root: ParentNode): Element {
  const el = root.querySelector('svg.ui-spinner circle');
  if (!el) throw new Error('missing svg.ui-spinner circle');
  return el;
}

function geometry(el: Element): { r: string | null; pathLength: string | null; tag: string } {
  return {
    r: el.getAttribute('r'),
    pathLength: el.getAttribute('pathLength'),
    tag: el.tagName.toLowerCase()
  };
}

describe('运行态 spinner 收敛', () => {
  it('两枚工作中图标几何一致，且与 IconSpinner 同源', () => {
    const a = render(<SessionStatusIcon status="working" />);
    const b = render(<SessionStatusIcon status="working" />);
    const raw = render(<IconSpinner size={14} />);
    const ga = geometry(spinnerCircle(a.container));
    const gb = geometry(spinnerCircle(b.container));
    const g0 = geometry(spinnerCircle(raw.container));
    expect(ga).toEqual({ r: '6.2', pathLength: '100', tag: 'circle' });
    expect(gb).toEqual(ga);
    expect(g0).toEqual(ga);
    expect(a.container.querySelector('svg.ui-spinner path')).toBeNull();
    expect(b.container.querySelector('.tt-card-spin')).toBeNull();
  });

  it('文本工具结果卡走 IconSpinner，不再出现 border 环 class', () => {
    const src = readFileSync(
      resolve(here, '../../src/renderer/src/components/TextToolResultCard.tsx'),
      'utf8'
    );
    expect(src).toContain('IconSpinner');
    expect(src).not.toContain('tt-card-spin');
  });

  it('样式侧只留一套 session-state-spin keyframes，无 tt-spin / tt-card-spin', () => {
    const base = readFileSync(resolve(here, '../../src/renderer/src/styles/base.css'), 'utf8');
    const left = readFileSync(resolve(here, '../../src/renderer/src/styles/left.css'), 'utf8');
    const selection = readFileSync(
      resolve(here, '../../src/renderer/src/styles/selection.css'),
      'utf8'
    );
    const keyframes = base.match(/@keyframes session-state-spin/g) ?? [];
    expect(keyframes).toHaveLength(1);
    expect(left).not.toContain('@keyframes session-state-spin');
    expect(selection).not.toContain('tt-card-spin');
    expect(selection).not.toContain('@keyframes tt-spin');
  });
});

describe('运行态 spinner 相位同步', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('负 delay 使任意挂载时刻在之后任意墙钟对齐到同一相位', () => {
    const period = MOTION.loopMs;
    const mounts = [0, 1, 100, 449.5, 899, 900, 1350, 10_000];
    const walls = [0, 50, 899, 900, 1800, 12_345.25];
    for (const mount of mounts) {
      const delay = spinnerPhaseDelayMs(mount, period);
      for (const wall of walls) {
        if (wall < mount) continue;
        const progress = (wall - mount - delay) % period;
        expect(progress).toBeCloseTo(wall % period, 8);
      }
    }
  });

  it('后挂载的 IconSpinner 按全局时钟写负 animation-delay', () => {
    const spy = vi.spyOn(performance, 'now').mockReturnValue(1350);
    const a = render(<IconSpinner />);
    spy.mockReturnValue(2250);
    const b = render(<IconSpinner />);
    spy.mockReturnValue(100);
    const c = render(<IconSpinner />);
    const delayOf = (root: HTMLElement) =>
      (root.querySelector('svg.ui-spinner') as HTMLElement).style.animationDelay;
    expect(delayOf(a.container)).toBe('-450ms');
    expect(delayOf(b.container)).toBe('-450ms');
    expect(delayOf(c.container)).toBe('-100ms');
  });

  it('左栏工作中 SessionStatusIcon 同样挂相位 delay', () => {
    vi.spyOn(performance, 'now').mockReturnValue(300);
    const { container } = render(<SessionStatusIcon status="working" />);
    const svg = container.querySelector('svg.ui-spinner') as HTMLElement;
    expect(svg.style.animationDelay).toBe('-300ms');
  });
});
