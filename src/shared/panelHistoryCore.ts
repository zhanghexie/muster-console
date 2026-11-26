/**
 * 面板历史状态机（纯逻辑，渲染层 panelHistory.tsx 的核）：
 * back/forward 双栈、浏览器语义——返回把当前倒进 forward、前进反之；
 * 新导航（push）清空 forward；栈深上限裁剪。
 * 抽成 shared 纯函数便于 node 单测（test/panel-history.mjs）。
 *
 * 条目用 keyOf 抽取比较键（渲染层条目是每次新建的对象，按值去重必须显式给键；
 * 字符串条目传 (e) => e 即可）。
 */

export const PANEL_HISTORY_LIMIT = 20;

export class PanelHistoryCore<T> {
  back: T[] = [];
  forward: T[] = [];
  private keyOf: (entry: T) => string;

  constructor(keyOf: (entry: T) => string) {
    this.keyOf = keyOf;
  }

  /**
   * 新导航入栈（记录切走前的面板）。
   * 返回是否发生变化（back 追加或 forward 被清空）——调用方据此决定是否刷新。
   * back 栈顶与 entry 同键则不重复追加，但 forward 仍要清（回到该面板即历史分叉）。
   */
  push(entry: T): boolean {
    let changed = false;
    const top = this.back[this.back.length - 1];
    if (top === undefined || this.keyOf(top) !== this.keyOf(entry)) {
      this.back = [...this.back, entry].slice(-PANEL_HISTORY_LIMIT);
      changed = true;
    }
    if (this.forward.length > 0) {
      this.forward = [];
      changed = true;
    }
    return changed;
  }

  /** 返回：current 入 forward、弹 back 栈顶；back 空（无可返回）返回 undefined */
  goBack(current: T): T | undefined {
    if (this.back.length === 0) return undefined;
    const target = this.back[this.back.length - 1];
    this.back = this.back.slice(0, -1);
    this.forward = [...this.forward, current].slice(-PANEL_HISTORY_LIMIT);
    return target;
  }

  /** 前进：current 入 back、弹 forward 栈顶；forward 空（无可前进）返回 undefined */
  goForward(current: T): T | undefined {
    if (this.forward.length === 0) return undefined;
    const target = this.forward[this.forward.length - 1];
    this.forward = this.forward.slice(0, -1);
    this.back = [...this.back, current].slice(-PANEL_HISTORY_LIMIT);
    return target;
  }

  get backDepth(): number {
    return this.back.length;
  }

  get forwardDepth(): number {
    return this.forward.length;
  }
}
