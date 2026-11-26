/**
 * 全局行为规约「添加/取消」回归（P3 agent-rules F-02）：
 * ① 新建规则点「取消」直接移除空行——旧实现回填空文本，提交前残留「（空规则）」卡；
 * ② 同毫秒连点「添加规则」产出的 id 不再碰撞（rule-${Date.now()} → 加随机后缀）。
 * 还原即红：去掉随机后缀 / 取消改回无条件 map 回填，两条断言分别失败。
 */
import React, { useState } from 'react';
import { act, render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CapabilitiesPane } from '../../src/renderer/src/components/settings/CapabilitiesPane';
import type { CapabilitiesView } from '../../src/shared/types';
import type { AgentRule } from '../../src/shared/agentConduct';
import { applyLocaleSetting } from '../../src/shared/i18n';
import { frag as injectionNotes } from '../../src/shared/i18n/locales/fragments/injections';

const CAP_VIEW = {
  dispatcher: {
    body: 'default body',
    defaultBody: 'default body',
    customBody: '',
    catalogAppendix: '',
    initNotes: []
  },
  injections: [],
   workerToolAllowlist: []
} as unknown as CapabilitiesView;

function Harness({ initialRules = [] as AgentRule[] }: { initialRules?: AgentRule[] }) {
  const [rules, setRules] = useState(initialRules);
  return (
    <CapabilitiesPane
      capView={CAP_VIEW}
      promptDraft=""
      promptUsingDefault
      onPromptChange={() => undefined}
      onPromptReset={() => undefined}
      rules={rules}
      onRulesChange={setRules}
    />
  );
}

describe('CapabilitiesPane 全局行为规约添加/取消（F-02）', () => {
  it('新建规则点「取消」整行移除，不留「（空规则）」卡', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: '添加规则' }));
    // 新建即进入编辑态
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '取消' }));
    // 行被移除：回到空态提示，不再出现「（空规则）」
    expect(screen.getByText('暂无规则。规则删空 = 关闭注入，各 Agent 面不再出现该节。')).toBeTruthy();
    expect(screen.queryByText('（空规则）')).toBeNull();
  });

  it('同毫秒连点两次「添加规则」产出互不相同的 id（随机后缀防碰撞）', () => {
    // 锁死时钟：旧实现 rule-${Date.now()} 在同毫秒两次点击产出相同 id（React key 冲突）
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      let latest: AgentRule[] = [];
      function SpyHarness(): React.JSX.Element {
        const [rules, setRules] = useState<AgentRule[]>([]);
        return (
          <CapabilitiesPane
            capView={CAP_VIEW}
            promptDraft=""
            promptUsingDefault
            onPromptChange={() => undefined}
            onPromptReset={() => undefined}
            rules={rules}
            onRulesChange={(next) => {
              latest = next;
              setRules(next);
            }}
          />
        );
      }
      render(<SpyHarness />);
      const add = screen.getByRole('button', { name: '添加规则' });
      fireEvent.click(add);
      fireEvent.click(add);
      expect(latest).toHaveLength(2);
      // 还原即红：去掉随机后缀后两个 id 同为 rule-1700000000000
      expect(latest[0]!.id).not.toBe(latest[1]!.id);
      // 两张卡都渲染出来（key 冲突时 React 会丢一张）
      expect(document.querySelectorAll('.cap-rule-row')).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('编辑已有规则取消时回填原文而不是移除', async () => {
    const user = userEvent.setup();
    render(<Harness initialRules={[{ id: 'rule-existing', text: '保持简洁', enabled: true }]} />);
    // 「调度提示词」区也有「编辑」按钮，按行内取规则卡自己的
    const row = document.querySelector('.cap-rule-row') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: '编辑' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(document.querySelectorAll('.cap-rule-row')).toHaveLength(1);
    expect(screen.getByText('保持简洁')).toBeTruthy();
  });
});


it('运行参考独立展示，切换回来保留未完成的规则编辑', async () => {
  const user = userEvent.setup();
  render(<Harness/>);
  await user.click(screen.getByRole('button', { name: '添加规则' }));
  const editor = screen.getByRole('textbox');
  await user.type(editor, '保留草稿');
  await user.click(screen.getByRole('button', { name: '运行信息' }));
  expect(screen.getByRole('heading', { name: '注入清单' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Worker 白名单' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '提示词与规则' }));
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('保留草稿');
});

it('only translates the displayed registry note when the entire original text matches', async () => {
  const original = Object.keys(injectionNotes)[0];
  const changed = `${original} changed`;
  const view = { ...CAP_VIEW, injections: [
    { id: 'known', target: 'worker', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false, note: original },
    { id: 'changed', target: 'worker', channel: 'turn-prefix', mode: 'conditional', survivesCompact: false, note: changed }
  ] } as CapabilitiesView;
  const snapshot = JSON.stringify(view.injections);
  render(<CapabilitiesPane capView={view} promptDraft="" promptUsingDefault onPromptChange={() => {}} onPromptReset={() => {}} rules={[]} onRulesChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '运行信息' }));
  expect(screen.getAllByText(original, { exact: false })).toHaveLength(2);
  try {
    act(() => { applyLocaleSetting('en'); });
    expect(screen.getByText(injectionNotes[original], { exact: false })).toBeTruthy();
    expect(screen.getByText(changed, { exact: false })).toBeTruthy();
    expect(JSON.stringify(view.injections)).toBe(snapshot);
  } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
});
