/**
 * FileDiffView 评论模式 + DiffCommentPanel（T1.7）：
 * - 评论模式点击 diff 行 → onPickLine(file, line, original)
 * - 清单编辑正文、「发送给 Worker」拼简报并调用 sessions.sendMessage
 * - 发送成功后条目标记已发送
 */
import React, { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FileDiffView } from '../../src/renderer/src/panels/FileDiffView';
import { DiffCommentPanel } from '../../src/renderer/src/panels/DiffCommentPanel';
import { buildPrReviewBrief, type PrReviewComment } from '../../src/shared/prReviewBrief';
import { currentApiMock } from './helpers/api-mock';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' keep',
  '-old',
  '+new'
].join('\n');

describe('FileDiffView 评论模式（T1.7）', () => {
  it('评论模式点击含行号的行 → onPickLine 带 file/line/原文', async () => {
    const user = userEvent.setup();
    const picks: Array<{ file: string; line: number; original: string }> = [];
    render(
      <FileDiffView
        diffText={DIFF}
        commentMode
        onPickLine={(p) => picks.push(p)}
      />
    );
    const newLine = screen.getByText('new');
    await user.click(newLine);
    expect(picks.length).toBeGreaterThanOrEqual(1);
    const last = picks[picks.length - 1]!;
    expect(last.file).toBe('src/a.ts');
    expect(last.line).toBeGreaterThan(0);
    expect(last.original).toMatch(/new/);
  });

  it('非评论模式点击不回调', async () => {
    const user = userEvent.setup();
    const picks: unknown[] = [];
    render(<FileDiffView diffText={DIFF} onPickLine={(p) => picks.push(p)} />);
    await user.click(screen.getByText('new'));
    expect(picks.length).toBe(0);
  });

  it('短 Diff 已显示全部行，不出现无效的展开剩余按钮', () => {
    const { container } = render(<FileDiffView diffText={DIFF} />);
    expect(container.querySelectorAll('.diff-line').length).toBe(3);
    expect(screen.queryByRole('button', { name: /展开剩余/ })).toBeNull();
  });

  it('行号合并后，删除行使用旧行号、上下文和新增行使用新行号', () => {
    const shifted = DIFF.replace('@@ -1,3 +1,3 @@', '@@ -10,3 +20,3 @@');
    const { container } = render(<FileDiffView diffText={shifted} />);
    const rows = [...container.querySelectorAll('.diff-line')];
    expect(rows.map(row => row.querySelector('.diff-gutter:first-child')?.textContent)).toEqual(['', '', '']);
    expect(rows.map(row => row.querySelector('.diff-gutter:nth-child(2)')?.textContent)).toEqual(['20', '11', '21']);
  });

  it('真正超过预算的 Diff 展开后行数增加，展开按钮消失', async () => {
    const user = userEvent.setup();
    const largeFile = [
      'diff --git a/src/large.ts b/src/large.ts',
      'index 111..222 100644',
      '--- a/src/large.ts',
      '+++ b/src/large.ts',
      '@@ -1,1500 +1,1500 @@',
      ...Array.from({ length: 1500 }, (_, i) => ` context ${i + 1}`)
    ].join('\n');
    const hiddenFile = [
      'diff --git a/src/hidden.ts b/src/hidden.ts',
      'index 333..444 100644',
      '--- a/src/hidden.ts',
      '+++ b/src/hidden.ts',
      '@@ -1,7 +1,7 @@',
      ...Array.from({ length: 7 }, (_, i) => ` context ${i + 1}`)
    ].join('\n');
    const { container } = render(<FileDiffView diffText={`${largeFile}\n${hiddenFile}`} />);
    const before = container.querySelectorAll('.diff-line').length;
    expect(before).toBe(1500);
    expect(screen.getByRole('button', { name: '展开剩余 7 行' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '展开剩余 7 行' }));

    expect(container.querySelectorAll('.diff-line').length).toBe(1507);
    expect(screen.queryByRole('button', { name: /展开剩余/ })).toBeNull();
  });
});

function Harness(): React.JSX.Element {
  const [comments, setComments] = useState<PrReviewComment[]>([
    {
      id: 'c1',
      file: 'src/a.ts',
      line: 3,
      original: '+new',
      body: '',
      status: 'draft'
    }
  ]);
  const [sending, setSending] = useState(false);
  return (
    <DiffCommentPanel
      comments={comments}
      workerName="T1.7"
      sending={sending}
      onChangeBody={(id, body) =>
        setComments((prev) => prev.map((c) => (c.id === id ? { ...c, body } : c)))
      }
      onRemove={(id) => setComments((prev) => prev.filter((c) => c.id !== id))}
      onSend={() => {
        const pending = comments.filter((c) => c.status === 'draft' && c.body.trim());
        const task = buildPrReviewBrief(pending);
        setSending(true);
        void window.api.sessions.sendMessage({ sessionId: 'sess-1', text: task }).then((res) => {
          setSending(false);
          if (res && typeof res === 'object' && 'ok' in res && res.ok) {
            const ids = new Set(pending.map((c) => c.id));
            setComments((prev) =>
              prev.map((c) => (ids.has(c.id) ? { ...c, status: 'sent' } : c))
            );
          }
        });
      }}
    />
  );
}

describe('DiffCommentPanel 发送给 Worker（T1.7）', () => {
  it('填写评论后发送 → sendMessage 简报含 [PR 评论] file:line，清单标已发送', async () => {
    const user = userEvent.setup();
    currentApiMock().override('sessions.sendMessage', () =>
      Promise.resolve({ ok: true, stored: true, sessionId: 'sess-1' })
    );
    render(<Harness />);
    const sendBtn = screen.getByRole('button', { name: '发送给 Worker' }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    await user.type(screen.getByPlaceholderText('写评论…'), '这里应改成 2');
    const send = screen.getByRole('button', { name: '发送给 Worker' }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await user.click(send);
    await waitFor(() => {
      expect(screen.getByText('已发送')).toBeTruthy();
    });
    const fn = currentApiMock().mockOf('sessions.sendMessage');
    expect(fn).toHaveBeenCalledTimes(1);
    const arg = fn.mock.calls[0]![0] as { sessionId: string; text: string };
    expect(arg.sessionId).toBe('sess-1');
    expect(arg.text).toMatch(/\[PR 评论\] src\/a\.ts:3 原文\/评论/);
    expect(arg.text).toMatch(/评论: 这里应改成 2/);
  });

  it('无 Worker 时发送按钮禁用', () => {
    render(
      <DiffCommentPanel
        comments={[
          {
            id: 'c1',
            file: 'a.ts',
            line: 1,
            original: 'x',
            body: 'hi',
            status: 'draft'
          }
        ]}
        workerName={null}
        sending={false}
        onChangeBody={() => {}}
        onRemove={() => {}}
        onSend={() => {}}
      />
    );
    expect((screen.getByRole('button', { name: '发送给 Worker' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(screen.getByText('没有对应 Worker 会话')).toBeTruthy();
  });
});
