// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
vi.stubGlobal('window', globalThis);

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => 'C:/Users/test/AppData'
  }
}));

import { removeDevSandboxDirectorySync } from '../../../src/main/devSandbox';

describe('dev sandbox directory cleanup', () => {
  it.skipIf(process.platform !== 'win32')('reports a real external Windows file lock and succeeds after its owner releases it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-sandbox-lock-'));
    const target = path.join(root, 'workspace'); fs.mkdirSync(target);
    const lockedFile = path.join(target, 'held.txt'); fs.writeFileSync(lockedFile, 'original');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$f=[System.IO.File]::Open($env:MUSTER_LOCK_FIXTURE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read);try{[Console]::WriteLine("LOCKED");[Console]::Out.Flush();[Console]::In.ReadLine()|Out-Null}finally{$f.Dispose()}'],
    { windowsHide: true, env: { ...globalThis.process.env, MUSTER_LOCK_FIXTURE: lockedFile }, stdio: ['pipe','pipe','pipe'] });
    const closed = new Promise<void>((resolve, reject) => { child.once('close', code => code === 0 ? resolve() : reject(new Error(`Lock fixture exited ${code}`))); });
    void closed.catch(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('File lock fixture did not start')), 5000);
        let output = '';
        child.stdout.on('data', data => { output += String(data); if (output.includes('LOCKED')) { clearTimeout(timeout); resolve(); } });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
      });
      let failure: NodeJS.ErrnoException | undefined;
      try { removeDevSandboxDirectorySync(target); } catch (error) { failure = error as NodeJS.ErrnoException; }
      if (failure) {
        expect(['EPERM', 'EBUSY', 'EACCES']).toContain(failure.code);
        expect(fs.existsSync(target)).toBe(true);
      } else {
        // Some Windows filesystems permit renaming the parent of a locked file.
        expect(fs.existsSync(target)).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('deferred locked directory cleanup:'), expect.stringContaining('.delete-'), expect.anything());
      }
      child.stdin.end('\n'); await closed;
      for (const name of fs.readdirSync(root)) removeDevSandboxDirectorySync(path.join(root, name));
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      child.stdin.end('\n');
      if (child.exitCode === null) child.kill();
      await closed.catch(() => {});
      warn.mockRestore(); fs.rmSync(root, {recursive:true, force:true});
    }
  }, 12_000);
  it('uses Windows retry options when removing a workspace directory', () => {
    const remove = vi.fn();

    removeDevSandboxDirectorySync('C:/sandbox/workspaces/demo', remove as never);

    expect(remove).toHaveBeenCalledWith('C:/sandbox/workspaces/demo', {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
  });

  it('renames a transiently locked directory before retrying removal', () => {
    const remove = vi.fn()
      .mockImplementationOnce(() => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); })
      .mockImplementationOnce(() => undefined);
    const rename = vi.fn();

    removeDevSandboxDirectorySync('C:/sandbox/workspaces/demo', remove as never, rename as never);

    expect(rename).toHaveBeenCalledWith(
      'C:/sandbox/workspaces/demo',
      expect.stringMatching(/^C:\/sandbox\/workspaces\/demo\.delete-\d+-\d+$/)
    );
    expect(remove).toHaveBeenNthCalledWith(2, expect.stringMatching(/\.delete-\d+-\d+$/), expect.objectContaining({
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    }));
  });
});
