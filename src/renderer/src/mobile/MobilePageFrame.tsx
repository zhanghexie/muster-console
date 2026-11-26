/**
 * 手机端单页框架：presence 转场容器（mobile-remote-interaction-plan）。
 * 入栈自右滑入 / 出栈滑回右侧由 mobile.css 的 .mpage + data-mp-stage 完成；
 * 「左缘右滑返回」不在此实现——移动浏览器（Android Chrome / iOS Safari）的
 * 边滑与返回键是浏览器级历史导航，页面侧抢手势只会互相打架，正确做法是
 * MobileApp 接 History API（pushState/popstate），让原生返回手势弹页面栈。
 */
import React, { useEffect, useRef } from 'react';
import { usePresence } from '../components/motion';

/** 单页框架：presence 转场 + 非栈顶层禁交互 */
export function MobilePageFrame(props: {
  active: boolean;
  /** 是否栈顶层（可交互） */
  top: boolean;
  /** 退场动画播完，宿主把它从 closing 队列移除 */
  onExited: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const { active, top, onExited, children } = props;
  const presence = usePresence(active);
  const ref = useRef<HTMLDivElement>(null);
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  useEffect(() => {
    if (!presence.mounted) onExitedRef.current();
  }, [presence.mounted]);

  return (
    <div
      ref={ref}
      className={`mp-panel mpage${top ? ' is-top' : ''}`}
      data-mp-stage={presence.stage}
      aria-hidden={!top}
    >
      {presence.mounted ? children : null}
    </div>
  );
}
