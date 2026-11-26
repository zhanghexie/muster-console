/**
 * 测试跑多大范围：runner（test/run.mjs）与 vitest.config.ts 共用。
 *
 * 默认只跑受改动影响的用例；全量是显式动作。AI 编码代理「为了稳」会主动跑全量，
 * 多个 Worker 同时跑时互相抢 CPU、输出还灌满上下文，所以在 AI 环境里把
 * 未显式确认的「请求全量」降级为影响面；Git 钩子默认关闭，也不假定有定时任务。
 * `--full` / TEST_FULL=1 是确有必要时的显式全量开关。
 */

/**
 * AI 编码代理在自己的 shell 里注入的标记变量。
 * CURSOR_AGENT（Cursor 代理 shell）、CLAUDECODE（Claude Code Bash 工具）已实测；
 * MUSTER_RUNTIME 由工作台只注入给 Agent 会话的终端（人开的普通终端没有）；
 * GEMINI_CLI / OPENCODE 按各 CLI 文档加入，未实测。漏认的代理靠 AGENTS.md 规约兜。
 */
export const AGENT_ENV_MARKERS = ['CURSOR_AGENT', 'CLAUDECODE', 'MUSTER_RUNTIME', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'GEMINI_CLI', 'OPENCODE'];

/** @returns {string | null} 命中的标记变量名 */
export function detectAgent(env) {
  return AGENT_ENV_MARKERS.find((k) => env[k]) ?? null;
}

export function fullForced(argv, env) {
  return argv.includes('--full') || env.TEST_FULL === '1';
}

/**
 * runner 的范围判定（argv 为 run.mjs 自己的参数，不含 node 与脚本路径）。
 * @returns {{ scope: 'full' | 'changed' | 'changed-files' | 'filter', downgradedBy?: string }}
 */
export function resolveRunScope(argv, env, { hasFilters }) {
  if (argv.includes('--changed-files')) return { scope: 'changed-files' };
  if (fullForced(argv, env)) return { scope: 'full' };
  if (hasFilters) return { scope: 'filter' };
  if (argv.includes('--all')) {
    const agent = detectAgent(env);
    return agent ? { scope: 'changed', downgradedBy: agent } : { scope: 'full' };
  }
  return { scope: 'changed' };
}

const VITEST_COMMANDS = new Set(['run', 'watch', 'dev', 'related', 'bench', 'list', 'init']);

/**
 * Vitest 是否正被 AI 拿来跑整套（`vitest run` / `npx vitest` 不带任何 spec 过滤）。
 * argv 为 vitest 主进程的 process.argv。related / list、带 spec 过滤、--coverage 都放行。
 * @returns {string | null} 应降级时返回命中的标记变量名
 */
export function vitestWholeSuiteByAgent(argv, env) {
  const agent = detectAgent(env);
  if (!agent || env.TEST_FULL === '1') return null;
  const rest = argv.slice(2);
  const cmd = VITEST_COMMANDS.has(rest[0]) ? rest.shift() : 'run';
  if (cmd === 'related' || cmd === 'list' || cmd === 'init') return null;
  if (rest.some((a) => a === '--coverage' || a.startsWith('--coverage.') || a.startsWith('--coverage='))) {
    return null;
  }
  // 选项值（如 `--pool threads`）也会被当成过滤词而放行——宁可漏拦，不误拦
  if (rest.some((a) => !a.startsWith('-'))) return null;
  return agent;
}

export function downgradeNotice(agent, what) {
  return [
    `检测到 AI 编码环境（${agent}）：${what}已降级为只跑受当前改动影响的用例。`,
    '  日常档目标一分钟，宽泛改动使用有界冒烟；Git 钩子默认关闭，不自动升级全量。',
    '  确需全量：加 --full（npm run test:full -- --full），或设 TEST_FULL=1；全量上限一小时，超时失败退出。'
  ].join('\n');
}
