/** 渲染层没有 Node 的 process；直接读会 ReferenceError 把整棵 React 打掉。 */
function ignorePathCase(): boolean {
  if (typeof process !== 'undefined' && process.platform === 'win32') return true;
  const nav = (globalThis as { navigator?: NavigatorLike }).navigator;
  if (nav) {
    const plat = nav.userAgentData?.platform ?? nav.platform ?? '';
    return /Win/i.test(plat);
  }
  return false;
}

type NavigatorLike = {
  platform?: string;
  userAgentData?: { platform?: string };
};

/** 路径比较键：统一分隔符；Windows 下忽略大小写。不 resolve。 */
export function pathKey(p: string): string {
  const n = p.replace(/[/\\]+/g, '/').replace(/\/+$/, '');
  return ignorePathCase() ? n.toLowerCase() : n;
}
