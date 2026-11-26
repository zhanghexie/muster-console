import React from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReadMailCards } from '../../src/renderer/src/components/ReadMailCards';
import { MailEnvelopeViewport } from '../../src/renderer/src/components/MailEnvelopeViewport';
import { MarkdownBody } from '../../src/renderer/src/components/MarkdownBody';
import { currentApiMock } from './helpers/api-mock';

const sample = '**真实证据（本工作区）**\n\n`inline`\n\n- 第一项\n- 第二项\n\n> 引用\n\n| 名称 | 状态 |\n| --- | --- |\n| UI | 完成 |\n\n```ts\nconst value = 1;';
const page = (text: string, key = 'one') => ({ key, text, offset: 0, nextOffset: 5000, sender: { sessionId: 'a', name: '代理' } });
function check(body: Element) {
  expect(body.querySelector('strong')?.textContent).toBe('真实证据（本工作区）');
  expect(body.querySelector('code')?.textContent).toBe('inline');
  expect(body.querySelectorAll('li')).toHaveLength(2);
  expect(body.querySelector('pre')?.textContent).toContain('const value = 1;');
  expect(body.querySelector('table')).not.toBeNull();
  expect(body.textContent).not.toContain('**真实');
}
describe('mail presentation-only Markdown', () => {
  it('renders each read page separately, including an unclosed fence without swallowing the following letter', () => {
    const { container } = render(<ReadMailCards pages={[page(sample), page('**后一封**', 'two')]} />);
    check(container.querySelector('.read-mail-letter-body')!);
    expect(container.querySelectorAll('strong')[1]?.textContent).toBe('后一封');
  });
  it('renders all envelope slices with the same Markdown and retains the excerpt footer', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { container, unmount } = render(<MailEnvelopeViewport mailboxId="b" />);
    act(() => currentApiMock().emit('messages:activity', { id: 'one', mailboxWorkspaceId: 'ws', from: 'a', to: 'b', fromName: 'A', toName: 'B', text: sample, totalChars: 5000, ts: Date.now() }));
    const bodies = container.querySelectorAll('.mail-letter-body');
    expect(bodies).toHaveLength(3); bodies.forEach(check);
    expect(container.querySelector('.mail-letter-footer')?.textContent).toContain('信件节选');
    unmount(); vi.restoreAllMocks();
  });
  it('does not activate local/remote links, images, raw HTML, UI artifacts or Mermaid even with interactive props', () => {
    const onFileLink = vi.fn();
    const { container } = render(<MarkdownBody displayOnly localImages onFileLink={onFileLink} text={'[local](file:///tmp/a) [web](https://example.com) [widget](/agent-sessions/s/ui/1-demo.inline.html)\n\n![alt](https://example.com/track.png)\n\n<script>alert(1)</script>\n\n```mermaid\ngraph TD; A-->B\n```\n\n$x^2$'} />);
    expect(container.querySelector('a, img, iframe, button, script, svg')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toContain('graph TD');
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(onFileLink).not.toHaveBeenCalled();
  });
});
