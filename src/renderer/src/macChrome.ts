/**
 * macOS 顶栏适配（仅桌面/mac 浏览器调用，Linux 原生标题栏无需处理）：
 * - `is-mac`：hiddenInset 红绿灯与自绘顶栏同排，chrome.css 给左上让位；
 * - `is-native-fullscreen`：原生全屏时系统红绿灯隐藏，让位同步收回，
 *   悬停顶部时菜单栏由系统层叠加显示，不占应用栏空间。
 */
export function installMacChrome(): void {
  const root = document.documentElement;
  root.classList.add('is-mac');
  window.api?.on?.('window:fullscreen', (fullscreen) => {
    root.classList.toggle('is-native-fullscreen', fullscreen);
  });
}
