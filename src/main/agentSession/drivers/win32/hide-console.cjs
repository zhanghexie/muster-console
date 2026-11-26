/**
 * DSH harness / windows-acl runner 的 NODE_OPTIONS --require 预加载。
 *
 * Windows 上 Electron（GUI 子系统）没有控制台。dsh-sandbox-windows-acl 用
 * CreateProcessAsUserW 拉起 pwsh/cmd/bash 时故意不加 CREATE_NO_WINDOW
 * （WRITE_RESTRICTED token 下该标志会让子进程 STATUS_DLL_INIT_FAILED），
 * 于是控制台子系统子进程会新建一个可见黑框。
 *
 * 本脚本只在「当前进程还没有控制台」时 AllocConsole，并立刻 SW_HIDE。
 * 已有控制台（交互终端、已附着父进程隐藏控制台）一律不动，避免把宿主
 * 终端藏掉。失败必须吞掉：预加载抛错会让整个 DSH 子进程起不来。
 */
'use strict';

if (process.platform !== 'win32') {
  process.env.MUSTER_DSH_CONSOLE_STATE = 'skipped';
} else {
  hideNewConsole();
}

function hideNewConsole() {
  try {
    const koffi = loadKoffi();
    if (!koffi) {
      process.env.MUSTER_DSH_CONSOLE_STATE = 'no-koffi';
      return;
    }
    const kernel32 = koffi.load('kernel32.dll');
    const user32 = koffi.load('user32.dll');
    const GetConsoleWindow = kernel32.func('__stdcall', 'GetConsoleWindow', 'void *', []);
    // 判断「有没有控制台」必须用 GetConsoleCP（无控制台时返回 0）而不是 GetConsoleWindow：
    // ConPTY 伪控制台没有窗口，GetConsoleWindow 恒为 NULL，据此会误判成无控制台并
    // 去 AllocConsole——已附着控制台时该调用必然失败。
    const GetConsoleCP = kernel32.func('__stdcall', 'GetConsoleCP', 'uint32', []);
    const AllocConsole = kernel32.func('__stdcall', 'AllocConsole', 'int', []);
    const AttachConsole = kernel32.func('__stdcall', 'AttachConsole', 'int', ['uint32']);
    const GetStdHandle = kernel32.func('__stdcall', 'GetStdHandle', 'void *', ['int32']);
    const SetStdHandle = kernel32.func('__stdcall', 'SetStdHandle', 'int', ['int32', 'void *']);
    const ShowWindow = user32.func('__stdcall', 'ShowWindow', 'int', ['void *', 'int']);
    const isNull = (hwnd) => hwnd === null || hwnd === undefined || hwnd === 0 || hwnd === 0n;
    const ATTACH_PARENT_PROCESS = 0xffffffff;
    const SW_HIDE = 0;
    const STD_INPUT_HANDLE = -10;
    const STD_OUTPUT_HANDLE = -11;
    const STD_ERROR_HANDLE = -12;
    // AllocConsole/AttachConsole 可能改标准句柄；JSON-RPC 走已重定向的 pipe，必须还原。
    const stdin = GetStdHandle(STD_INPUT_HANDLE);
    const stdout = GetStdHandle(STD_OUTPUT_HANDLE);
    const stderr = GetStdHandle(STD_ERROR_HANDLE);
    const restoreStdio = () => {
      SetStdHandle(STD_INPUT_HANDLE, stdin);
      SetStdHandle(STD_OUTPUT_HANDLE, stdout);
      SetStdHandle(STD_ERROR_HANDLE, stderr);
    };

    // 已有控制台（交互终端 / ConPTY / 父进程的隐藏控制台）一律不动
    if (GetConsoleCP() !== 0 || !isNull(GetConsoleWindow())) {
      process.env.MUSTER_DSH_CONSOLE_STATE = 'kept';
      return;
    }
    if (AttachConsole(ATTACH_PARENT_PROCESS) && GetConsoleCP() !== 0) {
      restoreStdio();
      process.env.MUSTER_DSH_CONSOLE_STATE = 'attached';
      return;
    }
    if (!AllocConsole()) {
      process.env.MUSTER_DSH_CONSOLE_STATE = 'alloc-failed';
      return;
    }
    const hwnd = GetConsoleWindow();
    if (!isNull(hwnd)) ShowWindow(hwnd, SW_HIDE);
    restoreStdio();
    process.env.MUSTER_DSH_CONSOLE_STATE = 'allocated-hidden';
  } catch {
    process.env.MUSTER_DSH_CONSOLE_STATE = 'error';
  }
}

function loadKoffi() {
  const explicit = process.env.MUSTER_DSH_KOFFI;
  if (explicit) {
    try {
      return require(explicit);
    } catch {
      /* fall through */
    }
  }
  try {
    return require('koffi');
  } catch {
    return null;
  }
}
