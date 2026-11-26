import React, { useRef } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { useSessionNotes, type SessionNotesHost } from '../../src/renderer/src/chatSurface/useSessionNotes';
import { deliverFileNote, updateFileNoteInSession } from '../../src/renderer/src/agentChat/noteBridge';
import { readFileNoteEntry } from '../../src/renderer/src/components/fileNoteEntry';
import { getDraft, replaceDraft } from '../../src/renderer/src/composerDrafts';
import { parseTosendList } from '../../src/shared/composerTools';
import { expandNoteTokens } from '../../src/shared/noteAnnotations';
import { StoreProvider } from '../../src/renderer/src/store';
import type { ChatSurface } from '../../src/shared/chatSurface';
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const bucket = 'queued-note-regression';
const key = `muster.tosend.v1:${bucket}`;
let host: SessionNotesHost;
const openFile = vi.fn();
function Harness({ surface }: { surface: ChatSurface }) {
  const viewRef = useRef<HTMLDivElement>(null);
  host = useSessionNotes({ sessionId: bucket, draftKey: bucket, viewRef,
    getMessageRole: () => 'assistant', flashTip: () => {}, requestOpenWorkspaceFile: openFile });
  return <div ref={viewRef}><ChatSurfaceView surface={surface} workspaceId={bucket} notesHost={host}/></div>;
}
function setup(busy = false) {
  const send = vi.fn(async (_text: string) => true);
  const sendNow = vi.fn(async (_text: string) => 'sent' as const);
  const snap = { messages: [], busy, queuedCount: 0, queuedItems: [], status: null, mode: null, preset: null };
  const surface: ChatSurface = { sessionId: bucket,
    caps: { surfaceKind: 'dispatch', draftKey: bucket, notes: true, images: false },
    subscribe: () => () => {}, getSnapshot: () => snap,
    actions: { send, sendNow, stop: () => {}, clear: async () => {}, retry: () => {}, cancelQueued: () => {} } };
  const mount = () => render(<StoreProvider><Harness surface={surface}/></StoreProvider>);
  return { send, sendNow, mount };
}
function addNote(note: string, quote = '选中原文', id = 'file-original') {
  act(() => { deliverFileNote(bucket, { noteId: id, note, quote,
    path: 'src/app.ts', fileRef: { workspaceId: bucket, rootId: 'source-b', relativePath: 'src/app.ts' }, line: 7, endLine: 9, markKey: null }); });
}
const saved = () => parseTosendList(localStorage.getItem(key));
beforeEach(() => {
  localStorage.clear(); replaceDraft(bucket, '');
  openFile.mockClear();
  Element.prototype.scrollIntoView ??= () => {};
  document.execCommand ??= () => false;
});

describe('批注与队列：真实 host + composer', () => {
  it('手动入队保存完整引文/批注，重挂后取回恢复胶囊，避让新编号并可二次编辑', async () => {
    const app = setup(); const view = app.mount();
    const quote = '长引文'.repeat(800);
    addNote('请修改末尾的命名', quote);
    await waitFor(() => expect((screen.getByRole('button', { name: '留待确认' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '留待确认' }));
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0].text).toBe(`[文件批注 src/app.ts:7-9] 原文：“${quote}”；用户批注：请修改末尾的命名`);
    expect(host.tokens).toHaveLength(0);
    expect(getDraft(bucket)).toBe('');
    view.unmount(); app.mount();
    addNote('新草稿批注', '另一段', 'new-note');
    act(() => replaceDraft(bucket, `已有草稿 ${getDraft(bucket)}`));
    fireEvent.click(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: '取回输入框编辑' }));
    await waitFor(() => expect(host.tokens).toHaveLength(2));
    expect(getDraft(bucket)).toBe('已有草稿 批注1\n批注2');
    expect(document.querySelectorAll('.composer-token[data-note-id]')).toHaveLength(2);
    const restored = host.notes.find(n => n.note === '请修改末尾的命名')!;
    expect(restored.seq).toBe(2);
    act(() => host.onTokenClick(restored.id));
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ fileRef: { workspaceId: bucket, rootId: 'source-b', relativePath: 'src/app.ts' } }));
    expect(readFileNoteEntry()?.capture.fileRef).toEqual({ workspaceId: bucket, rootId: 'source-b', relativePath: 'src/app.ts' });
    expect(readFileNoteEntry()?.initialNote).toBe('请修改末尾的命名');
    act(() => { expect(updateFileNoteInSession(bucket, restored.id, '改成清楚的命名')).toBe(true); });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(app.send).toHaveBeenCalledOnce());
    expect(app.send.mock.calls[0][0]).toContain('用户批注：改成清楚的命名');
    expect(app.send.mock.calls[0][0]).toContain('用户批注：新草稿批注');
    expect(app.send.mock.calls[0][0]).not.toContain('批注2');
  });

  it('忙时 Enter 默认入手动队列也固化批注；发送队列不被当前新批注二次展开', async () => {
    localStorage.setItem(key, JSON.stringify([{ id: 'seed', text: '先确认', ts: 1 }]));
    const app = setup(true); app.mount();
    addNote('这里的“批注1”是正文', '旧原文');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(saved()).toHaveLength(2));
    const original = saved()[1].text;
    expect(original).toContain('用户批注：这里的“批注1”是正文');
    expect(app.send).not.toHaveBeenCalled();
    addNote('新的批注不能替换旧正文', '新原文', 'new-note');
    const row = screen.getAllByRole('listitem')[1];
    fireEvent.click(within(row).getByRole('button', { name: '立即发送' }));
    await waitFor(() => expect(app.sendNow).toHaveBeenCalledWith(original));
    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(getDraft(bucket)).toBe('批注1');
  });

  it('编号 1 / 10 独立展开，批注正文里提到其他编号不会被递归替换', () => {
    const notes = [{ seq: 1, quote: '一', note: '请看批注10' }, { seq: 10, quote: '十', note: '十的说明' }];
    expect(expandNoteTokens('批注10 批注1', notes)).toBe(
      '[会话批注] 原文：“十”；用户批注：十的说明 [会话批注] 原文：“一”；用户批注：请看批注10');
  });

  it('输入仅剩批注10时，删除批注1的记录，不能把编号前缀当成同一胶囊', async () => {
    await act(async () => { setup().mount(); });
    for (let i = 1; i <= 10; i++) addNote(`说明${i}`, `原文${i}`, `file-${i}`);
    act(() => replaceDraft(bucket, '批注10'));
    expect(host.notes.map(n => n.seq)).toEqual([10]);
    expect(host.prepareManualDraft?.('批注10').text).toContain('用户批注：说明10');
  });
});
