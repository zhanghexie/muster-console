/**
 * claude 子进程 env 清洗（T2.0 冒烟实证结论，docs/research/claude-agent-sdk-smoke-research.md §2）：
 * - 剥全部 ANTHROPIC*：防宿主进程环境里的 API key 把会话翻到按量 API（订阅/中转走
 *   claude 自己的鉴权解析链）；
 * - 剥全部 CLAUDE*（尤其 CLAUDE_CODE_CHILD_SESSION——嵌套会话标记会静默关 transcript
 *   持久化，杀死 resume 与 hooks，wmux 实证坑）；唯一例外 CLAUDE_CONFIG_DIR：用户
 *   显式指定的配置根是「共享用户配置」语义的一部分，保留（T2.0 probe：它是穿透
 *   settings.json env/hooks 的总开关）。
 * 纯函数（test/claude-driver-replay.mjs 锁行为）。
 */

/** 与冒烟脚本同源的剥离判定：^(ANTHROPIC|CLAUDE) 前缀 + 尾界 */
const SCRUB_RE = /^(ANTHROPIC|CLAUDE)[_A-Z0-9]*$/i;

/** 保留的 CLAUDE* 白名单（用户意图类变量） */
const KEEP = new Set(['CLAUDE_CONFIG_DIR']);

export function scrubClaudeSpawnEnv(env: Record<string, string | undefined>): Record<
  string,
  string | undefined
> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (SCRUB_RE.test(k) && !KEEP.has(k)) continue;
    out[k] = v;
  }
  return out;
}
