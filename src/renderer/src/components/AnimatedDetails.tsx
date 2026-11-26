/**
 * 可动画折叠 details（2026-10-31）：保留 <details>/<summary> 原生语义与键盘/无障碍
 * 行为，接管原生开合——展开/收起经 acc 骨架（grid 0fr↔1fr + opacity 纯 transition，
 * `--dur-panel` 展开 / 退场档收起，可中途反向打断回弹）。
 * 稳态收起内容不渲染（同原生 closed details 的零渲染成本）；收起瞬态由 usePresence
 * 延迟卸载（exitMs+80ms 兜底）播完退场再卸内容。减少动态档即时开合不播动画。
 * 用法：工具卡 tool-lite / 思考卡 / harness 标注抽屉等会话内全部 details 展开。
 */
import React from 'react';
import { MOTION, usePresence } from './motion';

export function AnimatedDetails(props: {
  className?: string;
  /** summary 内容（不含 <summary> 壳；壳统一由本组件渲染） */
  summary: React.ReactNode;
  /** 折叠体内容（仅展开/退场窗口挂载） */
  children: React.ReactNode;
  /** 受控开合（缺省内控） */
  open?: boolean;
  /** 用户点击 summary 翻转时回调（受控模式由此更新状态） */
  onToggle?: (open: boolean) => void;
}): React.JSX.Element {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const controlled = props.open != null;
  const expanded = controlled ? props.open === true : internalOpen;
  const presence = usePresence(expanded, MOTION.exitMs);
  return (
    <details className={props.className} open={presence.mounted}>
      <summary
        onClick={(e) => {
          // summary 内嵌的交互元素（工具摘要行的文件链接等）自带行为，
          // 点击不翻转折叠（原生 details 下由 preventDefault 天然挡住，接管后需显式放行）
          if (
            e.target !== e.currentTarget &&
            (e.target as Element).closest?.('a, button, input, select, textarea, [role="button"], [contenteditable]')
          ) {
            return;
          }
          // 接管原生开合：preventDefault 后由状态驱动 open，动画才有起止两态
          e.preventDefault();
          const next = !expanded;
          if (!controlled) setInternalOpen(next);
          props.onToggle?.(next);
        }}
      >
        {props.summary}
      </summary>
      {presence.mounted ? (
        <div
          className={`acc details-anim-body${expanded && presence.stage === 'in' ? ' is-open' : ''}`}
          {...presence.spread}
        >
          <div className="acc-body">{props.children}</div>
        </div>
      ) : null}
    </details>
  );
}
