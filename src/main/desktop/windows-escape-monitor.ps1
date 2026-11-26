$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

public static class MetaAgentEscapeMonitor {
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_QUIT = 0x0012, WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
    private const uint VK_ESCAPE = 0x1b, LLKHF_INJECTED = 0x10;
    private delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] private struct KeyboardEvent {
        public uint vkCode, scanCode, flags, time;
        public UIntPtr extraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] private struct Message {
        public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public Point pt; public uint lPrivate;
    }
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint threadId);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll", SetLastError=true)] private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string module);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    private static readonly AutoResetEvent Pending = new AutoResetEvent(false);
    private static readonly HookProc Callback = OnKeyboard;
    private static IntPtr hook;
    private static int escapeDown;
    public static bool IsNonInjectedEscapeDown(uint key, uint flags, int kind) {
        if (key != VK_ESCAPE || (flags & LLKHF_INJECTED) != 0) return false;
        if (kind == WM_KEYDOWN || kind == WM_SYSKEYDOWN) return Interlocked.Exchange(ref escapeDown, 1) == 0;
        if (kind == WM_KEYUP || kind == WM_SYSKEYUP) Interlocked.Exchange(ref escapeDown, 0);
        return false;
    }
    private static IntPtr OnKeyboard(int code, IntPtr message, IntPtr data) {
        if (code >= 0) {
            KeyboardEvent key = (KeyboardEvent)Marshal.PtrToStructure(data, typeof(KeyboardEvent));
            if (IsNonInjectedEscapeDown(key.vkCode, key.flags, message.ToInt32())) Pending.Set();
        }
        return CallNextHookEx(hook, code, message, data);
    }
    public static void Run() {
        hook = SetWindowsHookEx(WH_KEYBOARD_LL, Callback, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot install desktop Escape monitor");
        // Create this thread's message queue before starting the watcher, so an
        // early stdin EOF can always ask the hook's own loop to exit.
        Message initial;
        PeekMessage(out initial, IntPtr.Zero, 0, 0, 0);
        uint hookThread = GetCurrentThreadId();
        Thread parentWatcher = new Thread(() => {
            try { while (Console.In.Read() >= 0) { } }
            catch { /* a broken parent pipe is equivalent to EOF */ }
            finally {
                if (!PostThreadMessage(hookThread, WM_QUIT, UIntPtr.Zero, IntPtr.Zero)) Environment.Exit(1);
            }
        });
        parentWatcher.IsBackground = true;
        parentWatcher.Start();
        Thread sender = new Thread(() => { while (true) { Pending.WaitOne(); Console.Out.WriteLine("ESC"); Console.Out.Flush(); } });
        sender.IsBackground = true;
        sender.Start();
        Console.Out.WriteLine("READY"); Console.Out.Flush();
        try {
            Message message;
            int result;
            while ((result = GetMessage(out message, IntPtr.Zero, 0, 0)) > 0) { }
            if (result < 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "Desktop Escape message loop failed");
        } finally { UnhookWindowsHookEx(hook); }
    }
}
'@
[MetaAgentEscapeMonitor]::Run()
