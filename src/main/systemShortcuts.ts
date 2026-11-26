import { execFile } from 'node:child_process';
import { systemShortcutKeys } from '../shared/systemShortcuts';
import { t } from '../shared/i18n';
import { unixShortcutCommand, type ShortcutCommand } from './systemShortcutCommand';

export function shortcutScript(keys: number[]): string {
  if (!keys.length || keys.some(key => !Number.isInteger(key) || key < 1 || key > 255)) throw new Error('Invalid virtual key');
  return `$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ShortcutInput {
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION {
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public MOUSEINPUT mi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int x,y; public uint data,flags,time; public UIntPtr extra; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  static INPUT Event(int key, bool up) {
    var e = new INPUT(); e.type=1; e.u.ki.vk=(ushort)key;
    e.u.ki.flags=(uint)((up?2:0) | ((key>=0x21 && key<=0x2e || key==0x5b)?1:0)); return e;
  }
  public static void Send(int[] keys) {
    foreach(var key in new int[]{0x10,0x11,0x12,0x5b,0x5c})
      if ((GetAsyncKeyState(key) & 0x8000)!=0) throw new Exception(${JSON.stringify(t('请松开修饰键后重试'))});
    var events=new INPUT[keys.Length*2];
    for(int i=0;i<keys.Length;i++){ events[i]=Event(keys[i],false); events[events.Length-1-i]=Event(keys[i],true); }
    if(SendInput((uint)events.Length,events,Marshal.SizeOf(typeof(INPUT)))!=events.Length){
      var release=new INPUT[keys.Length];
      for(int i=0;i<keys.Length;i++) release[i]=Event(keys[keys.Length-1-i],true);
      SendInput((uint)release.Length,release,Marshal.SizeOf(typeof(INPUT)));
      throw new Exception(${JSON.stringify(t('系统未接受按键，请检查目标应用权限'))});
    }
  }
}
'@
[ShortcutInput]::Send([int[]]@(${keys.join(',')}))`;
}

export function createSystemShortcutSender(platform: string, env: NodeJS.ProcessEnv,
  run: (command: ShortcutCommand) => Promise<void>) {
  let sending = false;
  return async (chord: string): Promise<{ ok: boolean; error?: string }> => {
    const keys = systemShortcutKeys(chord);
    if (!keys) return { ok: false, error: t('不支持的系统快捷键') };
    if (sending) return { ok: false, error: t('正在发送快捷键，请稍后重试') };
    sending = true;
    try {
      const command = platform === 'win32' ? {
        file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand',
          Buffer.from(shortcutScript(keys), 'utf16le').toString('base64')],
        help: t('请松开修饰键，并检查目标应用权限')
      } : unixShortcutCommand(chord, platform, env);
      try { await run(command); }
      catch (error) { throw new Error(t('{{help}}。{{detail}}', { help: command.help, detail: error instanceof Error ? error.message : String(error) })); }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally { sending = false; }
  };
}

export const sendSystemShortcut = createSystemShortcutSender(process.platform, process.env, command =>
  new Promise<void>((resolve, reject) => {
    execFile(command.file, command.args, { windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 }, (error, _stdout, stderr) =>
      error ? reject(new Error(stderr.trim().slice(0, 600) || (error.code === 'ENOENT' ? t('未找到 {{file}}', { file: command.file }) : t('系统快捷键发送失败或超时')))) : resolve());
  }));
