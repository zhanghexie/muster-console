/**
 * Electron 31 内嵌 Node 20，缺少 worker_threads.markAsUncloneable；
 * Pi → undici@8 在模块加载时会调用它，导致：
 *   TypeError: webidl.util.markAsUncloneable is not a function
 * 必须在 import Pi / undici 之前打补丁。
 */
export function patchElectronForPi(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const wt = require('node:worker_threads') as {
    markAsUncloneable?: (value: object) => void;
  };
  if (typeof wt.markAsUncloneable !== 'function') {
    wt.markAsUncloneable = function markAsUncloneable(_value: object): void {
      // Electron Node 20：无结构化克隆标记能力，降级为 no-op
    };
  }
}
