/**
 * 桌面截图的唯一调用判定。
 *
 * 域壳化之后模型只能调 `host.desktop.run({action:'look'})`，但引擎侧看到的工具名
 * 仍是入口名；历史直调名（`desktop.look`）仍作为内部真源存在。截图图像块链路
 * （captureImageScope / Pi captureImages / 调度投递）必须同时认这两条路径，
 * 否则 run 形态的 look 拿不到 image 内容块。
 *
 * 名字形态各异：点号（`desktop.look`）、下划线（`desktop_look`）、
 * `host_` / `host.` 前缀、`mcp__<server>__` 前缀。统一归一化后再判定。
 */
export function isDesktopLookCall(name: string, args?: unknown): boolean {
  const bare = name
    .replace(/^mcp__[A-Za-z0-9_]+__/, '')
    .replace(/^host[._]/, '')
    .replace(/_/g, '.');
  if (bare === 'desktop.look') return true;
  if (bare !== 'desktop.run') return false;
  return !!args && typeof args === 'object' && !Array.isArray(args) &&
    (args as { action?: unknown }).action === 'look';
}
