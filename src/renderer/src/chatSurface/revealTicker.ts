/**
 * 全局唯一 rAF ticker（流式揭示 / 滚动跟随共用，2026-10-30）：
 * 所有面板的揭示引擎与滚动弹簧注册到这里，一个 requestAnimationFrame 驱动；
 * 每帧固定三相，禁止在循环里交替读写造成 layout thrashing：
 *   1. measure —— 只读（offsetParent / scrollHeight / clientHeight）
 *   2. update  —— 弹簧积分 + 文本增量渲染（setState / 写 DOM）
 *   3. write   —— 统一写 scrollTop（单一入口）
 * dt = (now-last)/1000 以秒计并钳到 0.1s；页面隐藏时跳过推进（rAF 本就
 * 停摆，防的是切回瞬间的巨帧），任务清空即停 rAF，不空转。
 */

export interface RevealTickerTask {
  /** 只读测量：读几何，不得写任何 DOM */
  measure?(now: number): void;
  /** 弹簧推进与文本渲染（计算与写 DOM） */
  update(dt: number, now: number): void;
  /** 统一 scrollTop 写入（滚动跟随任务实现） */
  write?(now: number): void;
}

/** 单帧 dt 上限（秒），与 Spring.update 内部钳制同源 */
const MAX_FRAME_DT = 0.1;

const tasks = new Set<RevealTickerTask>();
let rafId: number | null = null;
let last = 0;

function loop(now: number): void {
  rafId = null;
  if (tasks.size === 0) return;
  const dt = Math.min(Math.max((now - last) / 1000, 0), MAX_FRAME_DT);
  last = now;
  if (!document.hidden) {
    for (const task of tasks) task.measure?.(now);
    for (const task of tasks) task.update(dt, now);
    for (const task of tasks) task.write?.(now);
  }
  if (tasks.size > 0) rafId = requestAnimationFrame(loop);
}

/** 注册一个帧任务，返回注销函数；首个任务到来才起 rAF，清空即停 */
export function registerRevealTask(task: RevealTickerTask): () => void {
  tasks.add(task);
  if (rafId == null) {
    last = performance.now();
    rafId = requestAnimationFrame(loop);
  }
  return () => {
    tasks.delete(task);
    if (tasks.size === 0 && rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };
}

/** 仅供测试：确认 ticker 当前空转（无任务、无 rAF 残留） */
export function revealTickerIdle(): boolean {
  return tasks.size === 0 && rafId == null;
}

/** 仅供测试：清空任务与 rAF 残留（spec 的 rAF 桩在用例间重挂，旧 id 会悬空） */
export function resetRevealTickerForTest(): void {
  if (rafId != null) cancelAnimationFrame(rafId);
  tasks.clear();
  rafId = null;
  last = 0;
}
