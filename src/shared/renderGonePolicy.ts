/**
 * 渲染进程死亡后的自动恢复决策（纯函数，离线自测共用）。
 *
 * 策略：滑动窗口限频 reload——窗口内前 N 次死亡自动重载界面（黑屏自愈），
 * 超限后停手（大概率是稳定复现的崩溃，反复 reload 只是空转），改走
 * 原生系统通知提示用户重启。调用方持有 recent 时间戳数组并在每次死亡时
 * 回存返回的 recent（决策函数负责清理窗外旧戳）。
 */

export interface RenderGoneReloadDecision {
  reload: boolean;
  /** 决策说明（进日志，如 reload 1/2 in 60s window） */
  note: string;
  /** 决策后的时间戳数组（调用方回存） */
  recent: number[];
}

export interface RenderGonePolicyOptions {
  /** 滑动窗口长度（毫秒），默认 60s */
  windowMs?: number;
  /** 窗口内允许的 reload 次数上限，默认 2 */
  maxReloads?: number;
}

export function decideRenderGoneReload(
  recent: readonly number[],
  now: number,
  opts?: RenderGonePolicyOptions
): RenderGoneReloadDecision {
  const windowMs = opts?.windowMs ?? 60_000;
  const maxReloads = opts?.maxReloads ?? 2;
  const inWindow = recent.filter((t) => now - t < windowMs);
  if (inWindow.length < maxReloads) {
    return {
      reload: true,
      note: `reload ${inWindow.length + 1}/${maxReloads} in ${Math.round(windowMs / 1000)}s window`,
      recent: [...inWindow, now]
    };
  }
  return {
    reload: false,
    note: `auto-reload limit reached (${maxReloads} in ${Math.round(windowMs / 1000)}s), waiting for manual restart`,
    recent: inWindow
  };
}
