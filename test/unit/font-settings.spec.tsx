/**
 * 设置「外观 → 字体」组件单测：
 * 字体族四档切换（写 :root 内联变量 + config.update 落盘）、字号三档 toggle、
 * 预览样本跟随所选字体；默认档回落 CSS 默认（removeProperty）。
 */
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { FontSettings } from '../../src/renderer/src/components/settings/FontSettings';
import { currentApiMock } from './helpers/api-mock';
import { resetUiFontForTest } from '../../src/renderer/src/uiFont';

afterEach(() => {
  act(() => resetUiFontForTest());
});

describe('FontSettings', () => {
  it('默认渲染 OPPO Sans + 标准档，预览样本带字体栈', () => {
    render(<FontSettings />);
    expect(screen.getByText('OPPO Sans')).toBeTruthy();
    expect(screen.getByRole('group', { name: '字号' })).toBeTruthy();
    const standard = screen.getByRole('button', { name: '标准' });
    expect(standard.className).toContain('is-on');
    const preview = document.querySelector('.font-preview') as HTMLElement;
    expect(preview).toBeTruthy();
    expect(preview.style.fontFamily).toContain('OPPO Sans');
    // 默认档：不写内联变量（回落 base.css 默认）
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toBe('');
  });

  it('切到 MiSans：config.update 落盘 + :root 内联变量生效', async () => {
    const mock = currentApiMock();
    render(<FontSettings />);
    fireEvent.click(screen.getByText('OPPO Sans'));
    const option = await screen.findByRole('option', { name: 'MiSans' });
    fireEvent.click(option);
    expect(mock.mockOf('config.update').mock.calls[0][0]).toEqual({
      uiFont: 'misans',
      uiFontScale: 'standard'
    });
    expect(document.documentElement.style.getPropertyValue('--font-sans')).toContain('MiSans');
    expect(document.documentElement.style.getPropertyValue('--font-mono')).toContain('MiSans');
    const preview = document.querySelector('.font-preview') as HTMLElement;
    expect(preview.style.fontFamily).toContain('MiSans');
  });

  it('字号切宽松档：字阶 token 内联 +1；切回标准移除内联', () => {
    const mock = currentApiMock();
    render(<FontSettings />);
    fireEvent.click(screen.getByRole('button', { name: '宽松' }));
    expect(mock.mockOf('config.update').mock.calls[0][0]).toEqual({
      uiFont: 'oppo',
      uiFontScale: 'comfortable'
    });
    expect(document.documentElement.style.getPropertyValue('--font-body')).toBe('16px');
    expect(document.documentElement.style.getPropertyValue('--font-head')).toBe('21px');
    fireEvent.click(screen.getByRole('button', { name: '标准' }));
    expect(document.documentElement.style.getPropertyValue('--font-body')).toBe('');
  });

  it('跟随系统：sans/mono 栈均不含三方字体', async () => {
    render(<FontSettings />);
    fireEvent.click(screen.getByText('OPPO Sans'));
    const option = await screen.findByRole('option', { name: '跟随系统' });
    fireEvent.click(option);
    expect(document.documentElement.style.getPropertyValue('--font-sans')).not.toContain('OPPO Sans');
    expect(document.documentElement.style.getPropertyValue('--font-mono')).not.toContain('OPPO Sans');
  });
});
