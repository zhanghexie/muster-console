/**
 * 后台任务 PTY 启动构造（纯函数，零运行时依赖；test/*.mjs 即时转译导入）。
 * 有意不用交互式 shell + 打字提交：那样命令结束无法判定，任务状态会永远 running。
 */
import type { BgShellMode, ResolvedLaunch, ShellProfile } from '../../shared/types';

/** 后台任务 PTY 键前缀（与注册表 sessionId 空间区分开） */
export function bgPtyId(taskId: string): string {
  return `bg-${taskId}`;
}

/** 按 Shell 配置档语义构造「跑一条命令然后退出」的 launch */
export function bgCommandLaunch(profile: ShellProfile, command: string): ResolvedLaunch {
  switch (profile.id) {
    case 'cmd':
      return { command: profile.command, args: ['/d', '/s', '/c', command] };
    case 'powershell':
    case 'pwsh':
      return {
        command: profile.command,
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          command
        ]
      };
    case 'git-bash':
      return { command: profile.command, args: ['-lc', command] };
    case 'zsh':
    case 'bash':
      return { command: profile.command, args: ['-l', '-c', command] };
    case 'wsl':
      return { command: profile.command, args: ['-e', 'sh', '-lc', command] };
  }
}

/**
 * 后台命令的 Shell 配置档选择（shellTask 专用；不改 profiles[0] 的终端默认语义）。
 *
 * auto（缺省）：有 git-bash 档优先用——Windows 探测序里 powershell 恒在前，
 * 取 profiles[0] 会永远落 PowerShell（&& 不支持、退出码歧义）；手工指定的 Git Bash
 * 路径已由探测层并入 git-bash 档，此处无需重复处理。无 git-bash 档（含 POSIX 平台、
 * 本机没装 Git）回落 profiles[0]：Windows 即 PowerShell，POSIX 即系统默认 shell。
 *
 * powershell：强制 powershell 档；缺了退 pwsh；再退 profiles[0] 兜底不空抛。
 */
export function pickBgShellProfile(
  profiles: ShellProfile[],
  mode: BgShellMode = 'auto'
): ShellProfile | null {
  const byId = (id: ShellProfile['id']): ShellProfile | null =>
    profiles.find((p) => p.id === id) ?? null;
  if (mode === 'powershell') {
    return byId('powershell') ?? byId('pwsh') ?? profiles[0] ?? null;
  }
  return byId('git-bash') ?? profiles[0] ?? null;
}
