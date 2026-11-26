import React, { useState } from 'react';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsViews } from '../../src/renderer/src/components/settings/SettingsViews';

function Draft(): React.JSX.Element {
  const [value, setValue] = useState('');
  return <input aria-label="草稿" value={value} onChange={e => setValue(e.target.value)}/>;
}

it('分类切换保留草稿，隐藏视图不可交互，并支持方向键和外部定位', async () => {
  const user = userEvent.setup();
  const views = [{ id: 'models', label: '模型', content: <Draft/> }, { id: 'inputs', label: '输入', content: <p>文件限制</p> }];
  const { rerender } = render(<SettingsViews label="分类" views={views}/>);
  await user.type(screen.getByLabelText('草稿'), '保留此值');
  const navigation = screen.getByRole('group', { name: '分类' });
  const models = within(navigation).getByRole('button', { name: '模型' });
  models.focus();
  await user.keyboard('{ArrowRight}');
  const inputs = within(navigation).getByRole('button', { name: '输入' });
  expect(document.activeElement).toBe(inputs);
  expect(inputs.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByLabelText('草稿').closest('[role=region]')!.getAttribute('aria-hidden')).toBe('true');
  expect((screen.getByLabelText('草稿').closest('[role=region]')! as HTMLElement).inert).toBe(true);
  await user.keyboard('{Home}');
  expect((screen.getByLabelText('草稿') as HTMLInputElement).value).toBe('保留此值');
  rerender(<SettingsViews label="分类" views={views} requestedView="inputs"/>);
  await waitFor(() => expect(inputs.getAttribute('aria-pressed')).toBe('true'));
  await user.click(models);
  rerender(<SettingsViews label="分类" views={views} requestedView="inputs" requestKey={1}/>);
  await waitFor(() => expect(inputs.getAttribute('aria-pressed')).toBe('true'));
});
