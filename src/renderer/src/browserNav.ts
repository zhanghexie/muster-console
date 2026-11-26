/**
 * 浏览器页激活信号：BrowserPage 挂载/激活时写入。
 * 全局左侧历史快捷键不再按此信号改为右侧或网页历史。
 * 模块级单值（非 React state）：键盘分派是命令式路径，不值得为此扩 store。
 */
let active = false;

export function setBrowserNavActive(v: boolean): void {
  active = v;
}

export function isBrowserNavActive(): boolean {
  return active;
}
