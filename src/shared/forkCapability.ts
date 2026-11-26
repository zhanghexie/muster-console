/**
 * 画布 fork / 交接的能力矩阵。
 * 自包含、零导入——test/*.mjs 用 typescript.transpileModule 直接转译。
 *
 * claude-code 原生 fork 已核实：
 *   claude --resume <源id> --fork-session --session-id <新uuid>
 * （--session-id 与 --resume 并用时必须带 --fork-session；新 id 不得等于源 id。）
 */

export type ForkSupport = 'gui' | 'claude' | 'none';

/** 运行时 surface：chat = 内置 GUI 会话（pi/cursor 等） */
export type ForkSurface = 'chat' | 'pty';

/** 该常量随 CLI 核验结果；若 flag 组合不可用则改为 false，claude-code 整档降级灰置 */
export const CLAUDE_FORK_SESSION_SUPPORTED = true;

export function forkSupportOf(
  runtime: string | undefined,
  surface?: ForkSurface
): ForkSupport {
  if (surface === 'chat') return 'gui';
  const id = (runtime ?? '').trim();
  if (id === 'pi' || id === 'cursor') return 'gui';
  if (id === 'claude-code' && CLAUDE_FORK_SESSION_SUPPORTED) return 'claude';
  return 'none';
}

export function canForkOrHandover(runtime: string | undefined, surface?: ForkSurface): boolean {
  return forkSupportOf(runtime, surface) !== 'none';
}

/** claude CLI argv（未经 wrapWinCmd）；测试与脚本共用同一组 flag 顺序 */
export function claudeForkArgv(sourceSessionId: string, newSessionId: string): string[] {
  return ['claude', '--resume', sourceSessionId, '--fork-session', '--session-id', newSessionId];
}
