/**
 * 全局面板灯带开关（渲染层）：locale / theme 同款三段式。
 * 1. 模块态默认开（与 AppConfig.globalPanelGlow 缺省一致）；
 * 2. main.tsx 启动时 initGlobalPanelGlow()：config.get() 校正；
 * 3. 设置页切换走 setGlobalPanelGlow()（本地立即生效 + config:update 落盘）。
 * 关闭后 GlobalBoard 不挂灯带节点，CSS 动画不进渲染树。
 */
const listeners = new Set<() => void>();
let enabled = true;

export function isGlobalPanelGlowEnabled(): boolean {
  return enabled;
}

export function subscribeGlobalPanelGlow(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function apply(on: boolean): void {
  if (enabled === on) return;
  enabled = on;
  for (const fn of listeners) fn();
}

/** 设置「外观」页切换：本地立即生效 + 落盘（不随设置表单草稿回写） */
export function setGlobalPanelGlow(on: boolean): void {
  apply(on);
  try {
    void window.api.config.update({ globalPanelGlow: on }).catch(() => {
      /* ignore */
    });
  } catch {
    /* 单测 / 主进程不可达 */
  }
}

/**
 * 光效是否挂到 DOM：开关开 + 有未读「需要你」+ 探出停稳（peek）。
 * 展开态不挂：面板铺满大半窗口，反光扫过内容干扰阅读，且「需要你」列已直接可见。
 */
export function shouldRenderGlobalPanelGlow(
  glowOn: boolean,
  unreadCount: number,
  phase: string
): boolean {
  if (!glowOn || unreadCount <= 0) return false;
  return phase === 'peek';
}

/** main.tsx 启动调用：主进程配置为准校正 */
export function initGlobalPanelGlow(): void {
  try {
    void window.api.config
      .get()
      .then((cfg) => {
        apply(cfg.globalPanelGlow !== false);
      })
      .catch(() => {
        /* 主进程不可达（如单测环境）保持默认开 */
      });
  } catch {
    /* ignore */
  }
}

/** 测试用：只写内存态，不落盘 */
export function resetGlobalPanelGlowForTest(on = true): void {
  apply(on);
}
