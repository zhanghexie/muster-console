/**
 * 手机端底部抽屉（mobile-remote-interaction-plan）：scrim + 自底向上面板，
 * mp-panel 骨架 + msheet 覆盖位移方向（base.css token 驱动，可打断）。
 * 点 scrim 关闭；L2 新建会话、L3 操作菜单、全局「需要你」列表共用。
 */
import React from 'react';
import { usePresence } from '../components/motion';

export function MobileSheet(props: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const presence = usePresence(props.open);
  if (!presence.mounted) return null;
  return (
    <div className="ma-sheet-layer" onClick={props.onClose}>
      <div className="mp-scrim ma-sheet-scrim" data-mp-stage={presence.stage} aria-hidden />
      <div
        className="mp-panel msheet"
        data-mp-stage={presence.stage}
        role="dialog"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        {props.title ? <div className="ma-sheet-title">{props.title}</div> : null}
        {props.children}
      </div>
    </div>
  );
}
