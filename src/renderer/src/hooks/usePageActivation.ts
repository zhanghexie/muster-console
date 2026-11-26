import { useEffect, useRef } from 'react';
import { hPageOf, setPeekPointerHandler, type PeekPage } from '../browserPointer';

/**
 * 虚拟屏切页的唯一入口：点击 / 悬停另一屏即激活它。
 *
 * 只按真实 DOM 判定手势落在哪一屏（页根带 `data-h-page`）：内容可能经 portal 渲染在另一屏
 * （固定到右侧的会话 / 工具、右侧扩展标签），React 合成事件按组件树冒泡、enter/leave 按组件树
 * 计算，都会把它算到原组件所在的屏。因此在 `.h-strip` 上挂原生监听，面板无需任何接线。
 * 当前屏上的点击与悬停天然无效（alreadyThere），不需要排除控件。
 *
 * iframe / webview 会吞掉宿主指针事件，露条态由覆盖层经 dispatchPeekPointer 转入同一入口，
 * 覆盖层所在屏同样按 DOM 解析（见 browserPointer.ts）。
 */

export interface PageActivationOptions {
  hDock: PeekPage;
  narrow: boolean;
  /** 程序化切页后的静默截止时间（跳转瞬间的跟随 click 不算切页手势） */
  suppressUntil: { readonly current: number };
  clickHSwitch: (alreadyThere: boolean, apply: () => void) => void;
  armHSwitch: (alreadyThere: boolean, apply: () => void) => void;
  clearHTimer: () => void;
  show: Record<PeekPage, () => void>;
}

export function usePageActivation(strip: HTMLElement | null, options: PageActivationOptions): void {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const activate = (page: PeekPage): void => {
      const o = latest.current;
      o.clearHTimer();
      o.clickHSwitch(o.hDock === page, o.show[page]);
    };
    const hover = (page: PeekPage): void => {
      const o = latest.current;
      o.armHSwitch(o.hDock === page, o.show[page]);
    };
    setPeekPointerHandler((type, page) => {
      // 窄屏两屏是抽屉，没有露条
      if (latest.current.narrow) return;
      // 覆盖层的 pointerdown 来自一次新的手势，可在程序化切页后立即激活。
      if (type === 'down') activate(page); else hover(page);
    });
    if (!strip) return () => setPeekPointerHandler(null);
    const onClick = (event: MouseEvent): void => {
      if (Date.now() < latest.current.suppressUntil.current) return;
      const page = hPageOf(event.target);
      if (page) activate(page);
    };
    const onOver = (event: PointerEvent): void => {
      const page = hPageOf(event.target);
      if (page !== hPageOf(event.relatedTarget)) { if (page) hover(page); else latest.current.clearHTimer(); }
    };
    const onOut = (event: PointerEvent): void => {
      if (!hPageOf(event.relatedTarget)) latest.current.clearHTimer();
    };
    strip.addEventListener('click', onClick);
    strip.addEventListener('pointerover', onOver);
    strip.addEventListener('pointerout', onOut);
    return () => {
      setPeekPointerHandler(null);
      strip.removeEventListener('click', onClick);
      strip.removeEventListener('pointerover', onOver);
      strip.removeEventListener('pointerout', onOut);
    };
  }, [strip]);
}
