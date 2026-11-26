/** Preserve the engine's own environment and permission configuration. */
export function acpLaunchEnvironment(agentId: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...inherited };
  // Devin's CLI must select its own ACP backend for this product entry.
  if (agentId === 'devin') delete env.ACP_BACKEND;
  return env;
}

/** Historical DeepSeek tokens encoded the old host's sandbox and native ID. */
export function decodeAcpResumeToken(agentId: string, token: string): string {
  if (agentId !== 'deepseek' || !token.startsWith('dsh-v1:')) return token;
  const match = /^dsh-v1:(read-only|workspace-write):([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) throw new Error('DeepSeek 原生会话标识格式无效');
  const nativeId = Buffer.from(match[2], 'base64url').toString('utf8');
  if (!nativeId || /[\u0000-\u001f]/.test(nativeId)) throw new Error('DeepSeek 会话标识无效');
  return nativeId;
}
