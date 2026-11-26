/**
 * 「渐变与毛玻璃」开关（渲染层）：panelGlow 同款三段式，外加 localStorage 缓存防启动闪烁。
 * 1. 模块加载即按缓存给 <html> 挂/摘 no-frame-fx（缺省开 = 不挂）；
 * 2. main.tsx 启动时 initFrameFx()：config.get() 校正；
 * 3. 设置「外观」页切换走 setFrameFx()（本地立即生效 + config:update 落盘）。
 * 关闭时 base.css 把玻璃 token 退回实底 --bg-panel、--glass-blur 置 none，框去掉工作区染色渐变。
 */
const CACHE_KEY = 'muster.frameEffects.v1';
const OFF_CLASS = 'no-frame-fx';
const listeners = new Set<() => void>();

function readCache(): boolean {
  try {
    return localStorage.getItem(CACHE_KEY) !== '0';
  } catch {
    return true;
  }
}

let enabled = readCache();
document.documentElement.classList.toggle(OFF_CLASS, !enabled);

export function isFrameFxEnabled(): boolean {
  return enabled;
}

export function subscribeFrameFx(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function apply(on: boolean): void {
  document.documentElement.classList.toggle(OFF_CLASS, !on);
  try {
    localStorage.setItem(CACHE_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式等场景忽略 */
  }
  if (enabled === on) return;
  enabled = on;
  for (const fn of listeners) fn();
}

/** 设置「外观」页切换：本地立即生效 + 落盘（不随设置表单草稿回写） */
export function setFrameFx(on: boolean): void {
  apply(on);
  try {
    void window.api.config.update({ frameEffects: on }).catch(() => {
      /* ignore */
    });
  } catch {
    /* 单测 / 主进程不可达 */
  }
}

/** main.tsx 启动调用：主进程配置为准校正 */
export function initFrameFx(): void {
  try {
    void window.api.config
      .get()
      .then((cfg) => {
        apply(cfg.frameEffects !== false);
      })
      .catch(() => {
        /* 主进程不可达（如单测环境）保持缓存值 */
      });
  } catch {
    /* ignore */
  }
}

/** 测试用：只写内存态与类名，不落盘 */
export function resetFrameFxForTest(on = true): void {
  apply(on);
}
