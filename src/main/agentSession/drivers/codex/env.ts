/**
 * Codex GUI Worker 子进程 env：继承宿主 PATH/代理，由本机 Codex 确定 originator。
 */
import { utf8ChildEnv } from '../../../encoding/winUtf8';
const DROP = new Set(['CODEX_INTERNAL_ORIGINATOR_OVERRIDE']);

export function scrubCodexSpawnEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (DROP.has(k)) continue;
    out[k] = v;
  }
  return utf8ChildEnv(out);
}
