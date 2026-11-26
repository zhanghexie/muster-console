import React from 'react';
import { fileIconKindForPath, type FileIconKind } from '../../../shared/filePreview';

/**
 * 文件类型图标：圆角徽标（类型色底）+ 类型字形/缩写，颜色由 .fti-<kind> 类给。
 * 用于聊天里的文件链接、工具卡路径等——让「可预览的格式」一眼可辨。
 */

type IconProps = {
  /** 文件名或路径（取扩展名定类型） */
  name: string;
  size?: number;
  className?: string;
};

function glyph(kind: FileIconKind): React.JSX.Element {
  switch (kind) {
    case 'code':
      return <path d="M5.5 5 3 8l2.5 3M10.5 5 13 8l-2.5 3" />;
    case 'config':
      return (
        <>
          <path d="M6.5 3.5C5 3.5 4.6 4.2 4.6 5.4v1.2c0 .9-.5 1.4-1.4 1.4.9 0 1.4.5 1.4 1.4v1.2c0 1.2.4 1.9 1.9 1.9" />
          <path d="M9.5 3.5c1.5 0 1.9.7 1.9 1.9v1.2c0 .9.5 1.4 1.4 1.4-.9 0-1.4.5-1.4 1.4v1.2c0 1.2-.4 1.9-1.9 1.9" />
        </>
      );
    case 'markdown':
      return (
        <>
          <path d="M3 11V5l2.5 3L8 5v6" />
          <path d="M11 6.5V11M11 11l-1.8-1.8M11 11l1.8-1.8" />
        </>
      );
    case 'text':
      return (
        <>
          <path d="M4 2.5h5.5L12.5 5.5v8h-8.5z" />
          <path d="M6 8h4M6 10.2h4" />
        </>
      );
    case 'file':
      return <path d="M4 2.5h5.5L12.5 5.5v8h-8.5z" />;
    case 'image':
      return (
        <>
          <rect x="2.5" y="3.5" width="11" height="9" rx="1.2" />
          <circle cx="6" cy="6.6" r="1.1" />
          <path d="M3.5 11.5 7 8l2.5 2.5L11 9l1.5 1.7" />
        </>
      );
    case 'audio':
      return (
        <>
          <path d="M6.2 11.2V4l5-1v7" />
          <circle cx="4.8" cy="11.2" r="1.4" />
          <circle cx="9.8" cy="10" r="1.4" />
        </>
      );
    case 'video':
      return (
        <>
          <rect x="2.5" y="3.5" width="11" height="9" rx="1.2" />
          <path d="M7 6.2v3.6L10.2 8z" />
        </>
      );
    case 'pdf':
      return (
        <>
          <path d="M4 2.5h5.5L12.5 5.5v8h-8.5z" />
          <path d="M6 8h4M6 10.2h2.5" />
        </>
      );
    case 'word':
      return <text x="8" y="11.4" textAnchor="middle" fontSize="8.4" fontWeight="700" fill="currentColor" stroke="none" fontFamily="inherit">W</text>;
    case 'sheet':
      return <text x="8" y="11.4" textAnchor="middle" fontSize="8.4" fontWeight="700" fill="currentColor" stroke="none" fontFamily="inherit">X</text>;
    case 'slides':
      return <text x="8" y="11.4" textAnchor="middle" fontSize="8.4" fontWeight="700" fill="currentColor" stroke="none" fontFamily="inherit">P</text>;
    case 'archive':
      return (
        <>
          <path d="M3 5.5 8 3l5 2.5v5L8 13l-5-2.5z" />
          <path d="M8 3v4.5M8 9.2v.9" />
        </>
      );
    case 'font':
      return <text x="8" y="11.6" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor" stroke="none" fontFamily="inherit">A</text>;
  }
}

export function FileTypeIcon({ name, size = 14, className }: IconProps): React.JSX.Element {
  const kind = fileIconKindForPath(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`fti fti-${kind}${className ? ` ${className}` : ''}`}
      aria-hidden
    >
      <rect x="1" y="1" width="14" height="14" rx="3.5" fill="currentColor" opacity="0.13" stroke="none" />
      {glyph(kind)}
    </svg>
  );
}
