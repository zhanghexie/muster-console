/**
 * 二阶阻尼弹簧（流式揭示 / 滚动跟随共用的数值内核，2026-10-30）：
 * 半隐式欧拉积分 + 固定子步（h ≤ 1/120s），单帧 dt 上限 0.1s——掉帧或后台切回
 * 不会发散；收敛阈值内吸附到目标，避免长尾微颤。
 *
 * 参数以 ζ≈1（临界阻尼附近）为默认，稳定时间约 4/(ζω)，ω=√k、ζ=c/(2√k)：
 * - 文本揭示 SPRING_TEXT（k=160, c=26，ζ≈1.03）≈0.31s 收敛：突发大块在 ~0.3s
 *   内匀速铺开，观感「轻快」；长文换 SPRING_TEXT_LONG（k=144, c=24，ζ=1）稍缓。
 * - 滚动跟随 SPRING_SCROLL（k=320, c=40，ζ≈1.12 稍过阻尼）≈0.20s 收敛：跟手
 *   不抢戏、无回弹过冲。
 *
 * 这些是物理常量（刚度/阻尼），不是动画时长 token——JS 计时类时长仍一律读
 * MOTION（见 docs/features/animation-system.md）；本模块不得派生毫秒常量。
 */

/** 单帧最大 dt（秒）：后台切回 / 长卡顿后只前进 0.1s，防止积分发散 */
const MAX_FRAME_DT = 0.1;
/** 子步上限（秒）：k=320 时显式积分稳定域 h < 2/ω ≈ 0.112s，1/120 留足余量 */
const MAX_SUBSTEP = 1 / 120;
/** 收敛吸附阈值：|target-pos| 与 |vel| 同时小于阈值时 pos=target、vel=0 */
const SETTLE_POS = 0.01;
const SETTLE_VEL = 0.01;

export interface SpringTuning {
  k: number;
  c: number;
}

/** 文本揭示：k=160, c=26（ζ≈1.03，轻快） */
export const SPRING_TEXT: SpringTuning = { k: 160, c: 26 };
/** 长文本揭示：k=144, c=24（ζ=1，稍缓；收敛 0.31s→0.33s，量级供参考） */
export const SPRING_TEXT_LONG: SpringTuning = { k: 144, c: 24 };
/** 滚动跟随：k=320, c=40（ζ≈1.12 稍过阻尼，跟手不抢戏） */
export const SPRING_SCROLL: SpringTuning = { k: 320, c: 40 };

export class Spring {
  /** 当前位置（揭示=已显示字符数；滚动=scrollTop） */
  pos: number;
  /** 当前速度（单位/秒） */
  vel = 0;
  /** 目标位置；滚动跟随等场景每帧重设（活目标） */
  target: number;

  private k: number;
  private c: number;

  constructor(tuning: SpringTuning, initial = 0) {
    this.k = tuning.k;
    this.c = tuning.c;
    this.pos = initial;
    this.target = initial;
  }

  /** 中途换参（长文降档）：只影响后续积分，不重置状态 */
  setTuning(tuning: SpringTuning): void {
    this.k = tuning.k;
    this.c = tuning.c;
  }

  /** 立即对齐：pos=vel→0、target=value（流结束/切会话/用户编辑时用） */
  snap(value: number): void {
    this.pos = value;
    this.vel = 0;
    this.target = value;
  }

  /** 已收敛到目标（吸附后恒真；目标再变化则失效） */
  get settled(): boolean {
    return this.vel === 0 && this.pos === this.target;
  }

  /**
   * 推进一帧并返回新 pos。dt 先钳到 [0, 0.1]（非有限值按上限 0.1s），再按
   * ≤1/120s 子步积分；积分后 pos/vel 一旦非有限（理论上的数值发散）直接
   * 吸附到目标，不产生假动画。
   */
  update(dt: number): number {
    if (!Number.isFinite(dt)) dt = MAX_FRAME_DT;
    let remaining = Math.min(Math.max(dt, 0), MAX_FRAME_DT);
    while (remaining > 1e-6) {
      const h = Math.min(remaining, MAX_SUBSTEP);
      const acc = (this.target - this.pos) * this.k - this.vel * this.c;
      this.vel += acc * h;
      this.pos += this.vel * h;
      remaining -= h;
    }
    if (
      !Number.isFinite(this.pos) ||
      !Number.isFinite(this.vel)
    ) {
      this.snap(this.target);
      return this.pos;
    }
    if (
      Math.abs(this.target - this.pos) < SETTLE_POS &&
      Math.abs(this.vel) < SETTLE_VEL
    ) {
      this.pos = this.target;
      this.vel = 0;
    }
    return this.pos;
  }
}
