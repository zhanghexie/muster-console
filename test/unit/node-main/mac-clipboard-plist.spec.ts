import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn, default: { spawn } }));
import { convertMacClipboardPlist } from '../../../src/main/attachments/macClipboardPlist';

function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn()
  });
}

afterEach(() => { vi.useRealTimers(); spawn.mockReset(); });

describe('macOS clipboard plist conversion', () => {
  it('uses the built-in plutil without a shell and returns the complete XML result', async () => {
    const process = child(); spawn.mockReturnValue(process);
    const pending = convertMacClipboardPlist(Buffer.from('bplist00fixture'));
    expect(spawn).toHaveBeenCalledWith('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    process.stdout.write('<plist><array><string>/a</string><string>/b</string></array></plist>');
    process.emit('close', 0);
    expect((await pending).toString()).toContain('<string>/b</string>');
  });

  it('reports converter failure or timeout without returning a partial file list', async () => {
    const failed = child(); spawn.mockReturnValueOnce(failed);
    const first = convertMacClipboardPlist(Buffer.from('bplist00fixture'));
    failed.emit('close', 1);
    await expect(first).rejects.toThrow('请拖入或选择文件');
    vi.useFakeTimers();
    const slow = child(); spawn.mockReturnValueOnce(slow);
    const second = convertMacClipboardPlist(Buffer.from('bplist00fixture'));
    const rejected = expect(second).rejects.toThrow('超时');
    vi.advanceTimersByTime(3000);
    await rejected;
    expect(slow.kill).toHaveBeenCalledOnce();
  });
});
