/** CDP 类型改写代理（测试侧）——cdp-type-proxy.mjs 的最小类型声明 */
export declare function startCdpTypeProxy(
  upstreamPort: number,
  listenPort?: number
): Promise<{
  port: number;
  url: string;
  stats: { frames: number; rewritten: number };
  close(): Promise<void>;
}>;
