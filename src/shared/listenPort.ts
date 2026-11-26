/** 网页访问网关历史默认端口。用户实例优先绑它，避免已有手机书签失效。 */
export const DEFAULT_WEB_ACCESS_PORT = 7950;

/**
 * 解析本次应尝试绑定的端口。
 *
 * 保守默认（P14 产品决策）：
 * 1. `MUSTER_WEB_PORT` / 显式 env 优先（含 0=系统分配）
 * 2. 本实例 userData 已落盘的端口（重启稳定）
 * 3. 否则产品默认 7950
 *
 * 绑定冲突时由调用方 listen(0) 再落盘，不改这里。
 */
export function resolvePreferredPort(opts: {
  envPort?: string | undefined;
  persisted?: number | undefined;
  defaultPort: number;
}): number {
  const env = opts.envPort?.trim();
  if (env) {
    const n = Number(env);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
  }
  if (typeof opts.persisted === 'number' && Number.isInteger(opts.persisted) && opts.persisted >= 0 && opts.persisted <= 65535) {
    return opts.persisted;
  }
  return opts.defaultPort;
}
