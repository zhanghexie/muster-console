import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { SettingsSection, SettingRow } from '../../src/renderer/src/components/settings/shared';
import { AttachmentProcessingSettings } from '../../src/renderer/src/components/settings/AttachmentProcessingSettings';
import { SettingsPathField } from '../../src/renderer/src/components/settings/SettingsPathField';
import { SettingsDetailSection } from '../../src/renderer/src/components/settings/SettingsResource';

it('renders path and other setting labels as peer third-level headings, with separate help', () => {
  render(<SettingsSection title="任务与工作区">
    <SettingsPathField label="worktree 存储目录" path="/worktrees" tip="仅用于新建隔离任务" onChange={() => {}}/>
    <SettingRow title="任务运行时阻止休眠" desc="运行时保持唤醒"/>
  </SettingsSection>);
  expect(screen.getByRole('heading', { name: 'worktree 存储目录', level: 3 })).toBeTruthy();
  expect(screen.getByRole('heading', { name: '任务运行时阻止休眠', level: 3 })).toBeTruthy();
  expect(screen.getByText('仅用于新建隔离任务').closest('h3')).toBeNull();
});

it('keeps an action-only row free of empty headings after its annotation is removed', () => {
  render(<SettingRow title={null} divided><button>保存参数配置</button></SettingRow>);
  expect(screen.queryByRole('heading')).toBeNull();
  expect(screen.getByRole('button', { name: '保存参数配置' })).toBeTruthy();
});

it('keeps section help with the heading and associates it with the entire section', () => {
  render(<SettingsSection title="滚动与动效" desc="鼠标滚轮与界面动画" side={<button>恢复</button>}>
    <SettingRow title="滚动手感" desc="设置项自己的说明"/>
  </SettingsSection>);
  const section = screen.getByRole('region', { name: '滚动与动效' });
  const heading = within(section).getByRole('heading', { name: '滚动与动效' });
  const help = within(section).getByText('鼠标滚轮与界面动画');
  expect(heading.parentElement).toBe(help.parentElement);
  expect(section.getAttribute('aria-describedby')).toBe(help.id);
  expect(within(heading.parentElement!).queryByText('设置项自己的说明')).toBeNull();
});

it('groups all settings under one body while leaving the heading and its action outside', () => {
  render(<SettingsSection title="主题" side={<button>打开主题文件夹</button>}>
    <div>主题列表</div><SettingRow title="工作区主题"/>
  </SettingsSection>);
  const section = screen.getByRole('region', { name: '主题' });
  const body = section.querySelector('.settings-group-body');
  expect(body).toBeTruthy();
  expect(body?.contains(screen.getByText('主题列表'))).toBe(true);
  expect(body?.contains(screen.getByRole('heading', { name: '工作区主题' }))).toBe(true);
  expect(body?.contains(screen.getByRole('heading', { name: '主题' }))).toBe(false);
  expect(body?.contains(screen.getByRole('button', { name: '打开主题文件夹' }))).toBe(false);
});

it('keeps resource detail actions outside the shared group body', () => {
  render(<SettingsDetailSection title="连接配置" actions={<button>连接测试</button>}><div>地址和密钥</div></SettingsDetailSection>);
  const section = screen.getByRole('region', { name: '连接配置' });
  const body = section.querySelector('.settings-group-body');
  expect(body?.contains(screen.getByText('地址和密钥'))).toBe(true);
  expect(body?.contains(screen.getByRole('button', { name: '连接测试' }))).toBe(false);
});

it('uses third-level headings and associated help for file-processing groups', () => {
  render(<AttachmentProcessingSettings onChange={() => {}}/>);
  for (const name of ['文件限制', '文档预览', '视频画面']) {
    const section = screen.getByRole('region', { name });
    const help = section.querySelector('.s-sec-desc')!;
    expect(within(section).getByRole('heading', { name, level: 3 }).parentElement).toBe(help.parentElement);
    expect(section.getAttribute('aria-describedby')).toBe(help.id);
    expect(help.closest('.s-row')).toBeNull();
  }
});
