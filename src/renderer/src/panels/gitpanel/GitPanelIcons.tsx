/**
 * GitPanel 仓库行内联 SVG 图标（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，原样迁出）。
 */
import React from 'react';

export const iconSvgProps = {
  width: 13,
  height: 13,
  viewBox: '0 0 16 16',
  fill: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
  'aria-hidden': true as const,
  focusable: false as const
};

/** 睁眼：表示「当前隐藏，点此显示」或工具栏「显示已隐藏」 */
export function IconEye(): React.JSX.Element {
  return (
    <svg {...iconSvgProps}>
      <path
        d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** 划掉的眼：表示「当前可见，点此隐藏」 */
export function IconEyeOff(): React.JSX.Element {
  return (
    <svg {...iconSvgProps}>
      <path
        d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 13.5 13 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** 线框图钉（pushpin），currentColor */
export function IconPin(): React.JSX.Element {
  return (
    <svg {...iconSvgProps}>
      <path
        d="M6.25 2.5h3.5c.4 0 .75.35.75.75v.6c1.35.45 2.25 1.7 2.25 3.15v.5H3.25v-.5c0-1.45.9-2.7 2.25-3.15v-.6c0-.4.35-.75.75-.75Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M8 7.5v6.25" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
