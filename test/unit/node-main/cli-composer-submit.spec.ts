import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppContext } from '../../../src/main/context';
import { writeComposerInputFile } from '../../../src/main/pty/injectFile';

vi.mock('../../../src/main/pty/submit', () => ({ sleep: async () => {} }));
import { createCliComposerSubmitter } from '../../../src/main/pty/composerSubmit';
import { desktopTurnGrants } from '../../../src/main/desktop/turnGrant';

function fixture(paste: boolean) {
  const session = { id: 's1', name: 'CLI', type: 'terminal', launchKind: 'agent', runtime: 'cli',
    cliSuggestedReplies: { messageId: 'old', replies: ['next'] } };
  const write = vi.fn((_id: string, _data: string) => true);
  const ctx = { sessions: { get: vi.fn(() => session), isChatRuntime: vi.fn(() => false),
    pasteInput: vi.fn(async () => paste), clearCliSuggestedReplies: vi.fn(), touchUsed: vi.fn() },
    pty: { isRunning: vi.fn(() => true), captureWriter: vi.fn(() => ({ write })) },
    usage: { recordSessionActivity: vi.fn() } } as unknown as AppContext;
  return { ctx, session, write };
}

describe('CLI 工作台提交', () => {
  it('临时文件逐字保留换行、空白、Unicode 和批注', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cli-composer-test-'));
    try {
      const text = ' 第一行\r\n第二行\n[批注] 引用\n  内容  ';
      const result = writeComposerInputFile(text, dir);
      expect(readFileSync(result.file, 'utf8')).toBe(text);
      expect(result.promptArg).toContain(result.file);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('支持粘贴的运行时保留多行并只提交一次', async () => {
    const { ctx, write } = fixture(true);
    const send = createCliComposerSubmitter(ctx);
    const oldTurn = await desktopTurnGrants.authorize('s1', () => true, async () => true, () => {});
    expect(await send('s1', '一\n二')).toEqual({ ok: true, viaFile: false });
    expect(oldTurn()).toBe(false);
    expect(write.mock.calls).toEqual([['s1', '\x1b[200~一\n二\x1b[201~'], ['s1', '\r']]);
    expect(ctx.sessions.clearCliSuggestedReplies).toHaveBeenCalledWith('s1', 'old');
  });

  it('仅附件也先转换成完整文本，再按 CLI 的粘贴能力提交', async () => {
    const { ctx, write } = fixture(true);
    const images = [{ id: 'one', name: '截图.png', data: 'aW1hZ2U=', mimeType: 'image/png' }];
    const prepare = vi.fn(async () => '[Attachment metadata]\n{"sourcePath":"/managed/截图.png","processing":"path-only"}');
    const send = createCliComposerSubmitter(ctx, prepare);
    expect(await send('s1', '', images)).toEqual({ ok: true, viaFile: false });
    expect(prepare).toHaveBeenCalledWith('s1', '', images);
    expect(write.mock.calls[0][1]).toContain('/managed/截图.png');
    expect(write.mock.calls[1]).toEqual(['s1', '\r']);
  });

  it('附件转换失败或转换期间会话移除都不会写入终端', async () => {
    const { ctx, write } = fixture(true);
    const image = [{ id: 'one', data: 'aQ==', mimeType: 'image/png' }];
    const failing = createCliComposerSubmitter(ctx, async () => { throw new Error('source unavailable'); });
    expect(await failing('s1', '', image)).toMatchObject({ ok: false, error: 'Error: source unavailable' });
    expect(write).not.toHaveBeenCalled();
    const removed = createCliComposerSubmitter(ctx, async () => {
      (ctx.sessions.get as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      return 'prepared';
    });
    expect(await removed('s1', '', image)).toMatchObject({ ok: false, error: expect.stringContaining('删除') });
    expect(write).not.toHaveBeenCalled();
  });

  it('附件转换期间会话归档或运行时变更时不写入终端', async () => {
    for (const change of [{ archived: true }, { runtime: 'other-cli' }]) {
      const { ctx, session, write } = fixture(true);
      const image = [{ id: 'one', data: 'aQ==', mimeType: 'image/png' }];
      const send = createCliComposerSubmitter(ctx, async () => {
        (ctx.sessions.get as ReturnType<typeof vi.fn>).mockReturnValue({ ...session, ...change });
        return 'prepared';
      });
      expect(await send('s1', '', image)).toMatchObject({ ok: false, error: expect.stringContaining('不可用') });
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('不支持多行粘贴时发送文件指令，文件内容完整', async () => {
    const { ctx, write } = fixture(false);
    const send = createCliComposerSubmitter(ctx);
    expect(await send('s1', '一\n二')).toEqual({ ok: true, viaFile: true });
    const prompt = write.mock.calls[0][1] as string;
    const file = prompt.match(/`([^`]+)`/)?.[1];
    expect(file).toBeTruthy();
    try { expect(readFileSync(file!, 'utf8')).toBe('一\n二'); }
    finally { if (file) rmSync(file, { force: true }); }
  });

  it('提交失败、终端确认和进程更换均不清理建议，提示用户检查', async () => {
    const { ctx, write } = fixture(true);
    write.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const send = createCliComposerSubmitter(ctx);
    expect(await send('s1', '正文')).toMatchObject({ ok: false, error: expect.stringContaining('检查终端') });
    expect(ctx.sessions.clearCliSuggestedReplies).not.toHaveBeenCalled();
    (ctx.sessions.get as ReturnType<typeof vi.fn>).mockReturnValue({ id: 's1', type: 'terminal', launchKind: 'agent', activity: { kind: 'blocked' } });
    expect(await send('s1', '正文')).toMatchObject({ ok: false, error: expect.stringContaining('确认') });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('发送期间出现新建议时只请求清理发送前的版本', async () => {
    const { ctx, session } = fixture(false);
    (ctx.sessions.pasteInput as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      session.cliSuggestedReplies = { messageId: 'new', replies: ['new'] };
      return false;
    });
    await createCliComposerSubmitter(ctx)('s1', '单行');
    expect(ctx.sessions.clearCliSuggestedReplies).toHaveBeenCalledWith('s1', 'old');
  });

  it('旧建议不存在时不清除发送期间新出现的建议', async () => {
    const { ctx } = fixture(false);
    (ctx.sessions.get as ReturnType<typeof vi.fn>).mockReturnValue({ id: 's1', type: 'terminal', launchKind: 'agent', runtime: 'cli' });
    await createCliComposerSubmitter(ctx)('s1', '单行');
    expect(ctx.sessions.clearCliSuggestedReplies).not.toHaveBeenCalled();
  });

  it('正文和回车已发出后会话状态更新失败时不误报提交失败', async () => {
    const { ctx } = fixture(false);
    (ctx.sessions.touchUsed as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('storage error'); });
    const result = await createCliComposerSubmitter(ctx)('s1', '单行');
    expect(result).toMatchObject({ ok: true, warning: expect.stringContaining('已写入终端并发送回车') });
  });
});
