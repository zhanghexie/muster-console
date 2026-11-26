import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsResourceItem, SettingsDetailSection } from '../../src/renderer/src/components/settings/SettingsResource';
import { SettingsDetailHeader } from '../../src/renderer/src/components/settings/SettingsDetailHeader';

it('resource rows retain native button selection, keyboard activation and the complete name', async () => {
  const choose = vi.fn();
  const longName = 'company-gitlab-merge-request-review';
  const view = render(<SettingsResourceItem name={longName} selected={false} icon={<span>Icon</span>} meta="已发现" onClick={choose}/>);
  const row = screen.getByRole('button', { name: new RegExp(longName) });
  expect(row.title).toBe(longName);
  expect(row.getAttribute('aria-pressed')).toBe('false');
  row.focus();
  await userEvent.keyboard('{Enter}');
  expect(choose).toHaveBeenCalledTimes(1);
  view.rerender(<SettingsResourceItem name={longName} selected icon={<span>Icon</span>} meta="已发现" onClick={choose}/>);
  expect(row.classList.contains('is-selected')).toBe(true);
  expect(row.querySelector('.settings-resource-icon')?.getAttribute('aria-hidden')).toBe('true');
});

it('detail headers separate identity, metadata, description and actions; section help belongs to the section title', () => {
  const edit = vi.fn();
  render(<><SettingsDetailHeader title="Example" meta="全局 · 只读" description="用途" actions={<button onClick={edit}>编辑</button>}/>
    <SettingsDetailSection title="连接配置" desc="连接到这个服务商"><input aria-label="URL"/></SettingsDetailSection></>);
  const header = screen.getByRole('heading', { name: 'Example' }).closest('header')!;
  expect(header.querySelector('.settings-detail-identity')?.contains(screen.getByText('全局 · 只读'))).toBe(false);
  expect(within(header).getByRole('button', { name: '编辑' }).closest('.settings-detail-actions')).toBeTruthy();
  const group = screen.getByRole('region', { name: '连接配置' });
  expect(within(group).getByRole('heading', { name: '连接配置', level: 3 }).parentElement).toBe(screen.getByText('连接到这个服务商').parentElement);
  expect(within(group).getByLabelText('URL').closest('.settings-detail-section-body')).toBeTruthy();
});
