import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TextToolsPane } from '../../src/renderer/src/components/settings/TextToolsPane';
import { installApiMock, currentApiMock } from './helpers/api-mock';
import type { AppConfig } from '../../src/shared/types';

const cfg = (textTools: AppConfig['textTools']): AppConfig =>
  ({
    openai: { baseUrl: '', apiKey: '', model: '' },
    llm: {
      providers: [{ id: 'deepseek', name: 'DeepSeek', baseUrl: '', apiKey: '', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] }],
      activeProviderId: 'deepseek',
      activeModelId: 'deepseek-chat'
    },
    textTools
  }) as AppConfig;

describe('TextToolsPane（功能列表与编辑区）', () => {
  beforeEach(() => {
    installApiMock();
  });

  it('选择功能后编辑名称，修改随改随入草稿', async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    render(<TextToolsPane cfg={cfg({ functions: [{ id: 'translate', name: '翻译', prompt: '把输入文字翻译成中文' }] })} set={set} />);

    // 选择列表项后在独立编辑区修改。
    expect(screen.getByTestId('tt-item-translate')).toBeTruthy();
    expect(screen.queryByLabelText('名称 翻译')).toBeNull();
    await user.click(within(screen.getByRole('navigation', { name: '文本功能' })).getByRole('button', { name: '翻译' }));
    const input = within(screen.getByTestId('tt-item-translate')).getByDisplayValue('翻译') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    void user;
    await waitFor(() => {
      const last = set.mock.calls.at(-1)?.[0] as AppConfig;
      expect(last.textTools?.functions[0].name).toBe('abc');
    });
  });

  it('删除功能走行内危险钮并写入草稿；停用开关即改 enabled', async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    render(
      <TextToolsPane
        cfg={cfg({
          functions: [
            { id: 'translate', name: '翻译', prompt: '把输入文字翻译成中文' },
            { id: 'polish', name: '润色', prompt: '润色这段文字', enabled: false }
          ]
        })}
        set={set}
      />
    );

    await user.click(within(screen.getByRole('navigation', { name: '文本功能' })).getByRole('button', { name: '润色' }));
    await within(screen.getByTestId('tt-item-polish')).findByDisplayValue('润色');
    await user.click(within(screen.getByTestId('tt-item-polish')).getByRole('checkbox', { name: '在浮条显示' }));
    await waitFor(() => {
      const last = set.mock.calls.at(-1)?.[0] as AppConfig;
      expect(last.textTools?.functions.find((f) => f.id === 'polish')?.enabled).toBe(true);
    });

    await user.click(within(screen.getByTestId('tt-item-polish')).getByRole('button', { name: '删除功能' }));
    await waitFor(() => {
      const last = set.mock.calls.at(-1)?.[0] as AppConfig;
      expect(last.textTools?.functions.map((f) => f.id)).toEqual(['translate']);
    });
    void currentApiMock;
  });
});


it('功能切换保留未保存的名称和提示词，并让隐藏编辑区退出交互', async () => {
  const user = userEvent.setup();
  function Harness() {
    const [draft, setDraft] = React.useState(cfg({ functions: [{ id: 'a', name: '翻译', prompt: '翻译文本' }, { id: 'b', name: '摘要', prompt: '提取要点' }] }));
    return <TextToolsPane cfg={draft} set={patch => setDraft(previous => ({ ...previous, ...patch }))}/>;
  }
  render(<Harness/>);
  const nav = screen.getByRole('navigation', { name: '文本功能' });
  await user.type(within(screen.getByTestId('tt-item-a')).getByDisplayValue('翻译文本'), '，保留术语');
  await user.click(within(nav).getByRole('button', { name: '摘要' }));
  expect(screen.getByTestId('tt-item-a').closest('[aria-hidden]')?.getAttribute('aria-hidden')).toBe('true');
  await user.click(within(nav).getByRole('button', { name: '翻译' }));
  expect(within(screen.getByTestId('tt-item-a')).getByDisplayValue('翻译文本，保留术语')).toBeTruthy();
});
