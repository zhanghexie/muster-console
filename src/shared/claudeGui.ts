/**
 * Claude（GUI）设置页 / driver 共用的鉴权探测与配置目录决议（纯函数）。
 * 文件系统与可执行文件解析在主进程 status.ts / claudeSdk.ts。
 */

/** userData 下隔离配置根（相对路径段，主进程 path.join） */
export const CLAUDE_GUI_ISOLATED_SEGMENTS = ['agents', 'claude-gui'] as const;

/** File-presence hints only: none does not mean logged out, and neither kind proves validity. */
export type ClaudeGuiAuthKind = 'none' | 'relay' | 'login';

export interface ClaudeGuiStatus {
  packaged: boolean;
  /** 用户本机 claude 可执行文件；dev 回落 SDK 内建时为 null 仍 canLaunch */
  executable: string | null;
  canLaunch: boolean;
  isolateConfig: boolean;
  configDir: string;
  auth: ClaudeGuiAuthKind;
  /** settings.json env.ANTHROPIC_MODEL 或顶层 model */
  model: string | null;
}

export function isolatedClaudeConfigDir(userDataDir: string, join: (...p: string[]) => string): string {
  return join(userDataDir, ...CLAUDE_GUI_ISOLATED_SEGMENTS);
}

export function defaultClaudeConfigDir(homedir: string, join: (...p: string[]) => string): string {
  return join(homedir, '.claude');
}

/**
 * 非隔离：尊重进程已有 CLAUDE_CONFIG_DIR，否则 ~/.claude。
 * 隔离：强制 userData/agents/claude-gui（忽略进程 env）。
 */
export function resolveClaudeConfigDir(opts: {
  isolate: boolean;
  userDataDir: string;
  homedir: string;
  envConfigDir?: string;
  isolatedConfigDir?: string;
  join: (...p: string[]) => string;
}): string {
  if (opts.isolate) return opts.isolatedConfigDir ?? isolatedClaudeConfigDir(opts.userDataDir, opts.join);
  const env = opts.envConfigDir?.trim();
  if (env) return env;
  return defaultClaudeConfigDir(opts.homedir, opts.join);
}

export function applyClaudeConfigDir(
  env: Record<string, string | undefined>,
  configDir: string
): Record<string, string | undefined> {
  return { ...env, CLAUDE_CONFIG_DIR: configDir };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 从 settings.json + 是否存在凭据文件推断鉴权形态与模型档 */
export function inferClaudeGuiAuth(
  settingsJson: unknown,
  hasCredentials: boolean
): { auth: ClaudeGuiAuthKind; model: string | null } {
  const obj = settingsJson && typeof settingsJson === 'object' && !Array.isArray(settingsJson)
    ? (settingsJson as Record<string, unknown>)
    : null;
  const env =
    obj?.env && typeof obj.env === 'object' && !Array.isArray(obj.env)
      ? (obj.env as Record<string, unknown>)
      : null;
  const model =
    str(env?.ANTHROPIC_MODEL) ||
    str(env?.ANTHROPIC_DEFAULT_SONNET_MODEL) ||
    str(obj?.model) ||
    null;
  const relayToken = str(env?.ANTHROPIC_AUTH_TOKEN) || str(env?.ANTHROPIC_API_KEY);
  if (relayToken) return { auth: 'relay', model };
  if (hasCredentials) return { auth: 'login', model };
  return { auth: 'none', model };
}
