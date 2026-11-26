import { it, expect, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BrandBootLoader, BrandLoader } from '../../src/renderer/src/components/BrandLoader';
import { ComposerSendButtons } from '../../src/renderer/src/components/agentComposer/ComposerSendButtons';
import { applyLocaleSetting } from '../../src/shared/i18n';

it('保活页面隐藏时暂停加载动画，显示和嵌套切页后正确恢复', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/brand-loading.css'), 'utf8');
  const view = (outer: boolean, inner: boolean) => <><style>{css}</style>
    <div className={`xfade${outer ? ' is-shown' : ''}`}><div className={`xfade${inner ? ' is-shown' : ''}`}>
      <BrandLoader />
    </div></div></>;
  const { container, rerender } = render(view(false, true));
  const paused = () => [...container.querySelectorAll('.brand-loader-core, .brand-loader-orbit')]
    .map(node => getComputedStyle(node).animationPlayState);
  expect(paused()).toEqual(['paused', 'paused']);
  rerender(view(true, true));
  expect(paused().every(state => state !== 'paused')).toBe(true);
  rerender(view(true, false));
  expect(paused()).toEqual(['paused', 'paused']);
});

it('启动显示可访问状态与三卫星品牌图形', () => {
  const { container } = render(<BrandBootLoader />);
  expect(screen.getByRole('status').getAttribute('aria-label')).toContain('正在启动');
  expect(container.querySelectorAll('.brand-loader-orbit circle')).toHaveLength(3);
});

it('英文语言下启动标记读屏走词条而非中文残留（P3 brand-loading F-01）', () => {
  applyLocaleSetting('en', 'en-US');
  try {
    render(<BrandBootLoader />);
    // 还原即红：把 key 改回硬编码中文字面串、或删掉 en 词条 '集序 正在启动'，这里都会拿到中文/回落的 aria-label
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Muster Console is starting');
  } finally {
    applyLocaleSetting('zh-CN', 'zh-CN');
  }
});

it('发送→运行→停止→空闲：运行图形保留停止行为，结束后恢复发送', () => {
  const onSubmit = vi.fn(); const onStop = vi.fn();
  const props = { busy: false, inputLocked: false, hasText: true, imagesCount: 0, onSubmit, onStop };
  const { container, rerender } = render(<ComposerSendButtons {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  rerender(<ComposerSendButtons {...props} busy />);
  expect(container.querySelector('.brand-loader-orbit')).toBeNull();
  expect(container.querySelector('.stop-btn rect')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '停止' }));
  expect(onStop).toHaveBeenCalledTimes(1);
  rerender(<ComposerSendButtons {...props} hasText={false} />);
  expect(container.querySelector('.brand-loader')).toBeNull();
  expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
});

it('没有停止能力时保留忙碌排队入口', () => {
  const onSubmit = vi.fn();
  render(<ComposerSendButtons busy inputLocked={false} hasText imagesCount={0} onSubmit={onSubmit} />);
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
});
