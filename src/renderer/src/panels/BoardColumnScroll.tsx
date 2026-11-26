import React from 'react';

/** 隐藏滚动条，保留原生滚轮、触控和键盘滚动。 */
export function BoardColumnScroll({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <div className="board-column-scroll">
    <div className="board-column-body" role="region" aria-label={label} tabIndex={0}>
      <div className="board-column-content">{children}</div>
    </div>
  </div>;
}
