import React, { useMemo } from 'react';
import { spinnerPhaseDelayMs } from './motion';

/**
 * 细线 SVG 图标（stroke=currentColor，继承文本色）。
 * 替代 emoji：emoji 是彩色位图字体，在 clinical 单色体系里渲染风格/尺寸都不可控。
 */

type IconProps = {
  size?: number;
  className?: string;
};

export function IconGlobe(p: IconProps): React.JSX.Element { return <svg {...base(p)}><circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="2.5" ry="6"/><path d="M2 8h12"/></svg>; }
export function IconHome(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="M2 7 8 2l6 5M3.5 6v7.5h9V6M6.5 13.5V9h3v4.5"/></svg>; }
export function IconLayout(p: IconProps): React.JSX.Element { return <svg {...base(p)}><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M8 2.5v11"/></svg>; }
export function IconPin(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="m6 2 6 6-3 1-2 3-3-3-2-1 3-2zM6 10l-4 4"/></svg>; }
export function IconPencil(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="m3 10 8-8 3 3-8 8-4 1zM9 4l3 3"/></svg>; }
export function IconCheck(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="m3 8 3.3 3.3L13 4.7"/></svg>; }
export function IconCursor(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="M3.5 2.5 13 8l-4.4 1.1-2.2 4.3z"/></svg>; }
export function IconMouse(p: IconProps): React.JSX.Element { return <svg {...base(p)}><rect x="4" y="2" width="8" height="12" rx="4"/><path d="M8 4.5v2"/></svg>; }
export function IconUnlock(p: IconProps): React.JSX.Element { return <svg {...base(p)}><rect x="3.5" y="7" width="9" height="7" rx="1.5"/><path d="M5.5 7V4.7a3 3 0 0 1 5.8-1M8 10v1.4"/></svg>; }
export function IconScissors(p: IconProps): React.JSX.Element { return <svg {...base(p)}><circle cx="4" cy="4" r="1.7"/><circle cx="4" cy="12" r="1.7"/><path d="m5.3 5.1 7.7 7.4M5.3 10.9 13 3.5"/></svg>; }
export function IconClipboard(p: IconProps): React.JSX.Element { return <svg {...base(p)}><rect x="3" y="3.5" width="10" height="11" rx="1.2"/><path d="M6 3.5V2h4v1.5M5.5 7h5M5.5 10h5"/></svg>; }
export function IconFolderPlus(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="M2 4.5a1 1 0 0 1 1-1h3l1.4 1.5H13a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zM8 7v4M6 9h4"/></svg>; }
export function IconBookmark(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="M4 13.5V4a1.5 1.5 0 0 1 1.5-1.5h5A1.5 1.5 0 0 1 12 4v9.5L8 11z"/></svg>; }
export function IconBookmarkPlus(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="M4 2.5h8v11l-4-2.2-4 2.2zM8 5v4M6 7h4"/></svg>; }
export function IconImage(p: IconProps): React.JSX.Element { return <svg {...base(p)}><rect x="2" y="2" width="12" height="12" rx="1.5"/><circle cx="5.5" cy="5.5" r="1"/><path d="m2 12 4-4 3 3 2-3 3 4"/></svg>; }
export function IconDiff(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="M9 1H3v14h10V5zM9 1v4h4M5 8h5M5 11h5M7.5 9v4"/></svg>; }

export function IconSave(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="M2 2h10l2 2v10H2zM5 2v4h6V2M5 10h6v4H5z"/></svg>; }
export function IconExternalLink(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="M9 2h5v5M14 2 7 9M6 3H2v11h11v-4"/></svg>; }
export function IconUnlink(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="m10 6 1-1a2.1 2.1 0 0 0-3-3L6 4M6 10l-1 1a2.1 2.1 0 0 0 3 3l2-2M2 2l12 12"/></svg>; }
export function IconDownload(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="M8 2v9m-4-4 4 4 4-4M2 11v3h12v-3"/></svg>; }
export function IconUpload(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="M8 11V2m-4 4 4-4 4 4M2 11v3h12v-3"/></svg>; }
export function IconStar(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="m8 1.5 2 4.2 4.6.7-3.3 3.2.8 4.6L8 12l-4.1 2.2.8-4.6L1.4 6.4 6 5.7z"/></svg>; }

export function IconFetch(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="M3 5a5.5 5.5 0 0 1 10 0M2 2v4h4M8 7v7m-3-3 3 3 3-3"/></svg>; }

/** 悬浮输入区展开/收缩与拖动把手。 */
export function IconExpand(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="M6 2.5H2.5V6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>; }
export function IconShrink(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="M2.5 6H6V2.5M10 2.5V6h3.5M13.5 10H10v3.5M6 13.5V10H2.5"/></svg>; }
export function IconDragHandle(p: IconProps): React.JSX.Element { return <svg {...base(p)}><path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" strokeWidth="2"/></svg>; }

/** AI 悬浮（画中画）：外框 + 右下实心小窗。 */
export function IconFloat(p: IconProps): React.JSX.Element { return <svg {...base(p)}><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><rect x="7.5" y="7" width="5.5" height="4.5" rx="1" fill="currentColor" stroke="none"/></svg>; }

function base(props: IconProps): {
  width: number;
  height: number;
  viewBox: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: 'round';
  strokeLinejoin: 'round';
  className?: string;
  'aria-hidden': true;
} {
  const size = props.size ?? 13;
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: props.className,
    'aria-hidden': true
  };
}

/** 复制 */
export function IconCopy(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
    </svg>
  );
}

/** 会话分叉（fork） */
export function IconFork(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M2 8h3c3.5 0 2.5-4.5 6-4.5h2.5M5 8c3.5 0 2.5 4.5 6 4.5h2.5" />
      <path d="m11 1 2.5 2.5L11 6m0 4 2.5 2.5L11 15" />
    </svg>
  );
}

/** 加号（Composer 附件菜单） */
export function IconPlus(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

/** 计划/清单 */
export function IconPlan(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="3.5" y="2.5" width="9" height="11" rx="1.5" />
      <path d="M6 2.5a2 2 0 0 1 4 0" />
      <path d="M5.8 7h4.4M5.8 9.6h4.4" />
    </svg>
  );
}

/** 勾选框（已完成） */
export function IconCheckSquare(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.2 8.2 7.2 10.2 10.8 6" />
    </svg>
  );
}

/** 空框（未完成） */
export function IconSquare(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
    </svg>
  );
}

/** 执行/播放 */
export function IconPlay(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M5 3.5v9l7-4.5z" />
    </svg>
  );
}

/** 排队/等待 */
export function IconHourglass(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4.5 2.5h7M4.5 13.5h7M5.5 2.5v2.6L8 8l2.5-2.9V2.5M5.5 13.5v-2.6L8 8l2.5 2.9v2.6" />
    </svg>
  );
}

/** 警告 */
export function IconWarn(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M8 2.8 14 13H2z" />
      <path d="M8 6.6v3.2" />
      <circle cx="8" cy="11.4" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 文件夹 */
export function IconFolder(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5H13a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  );
}

/** 打开的文件夹（与 IconFolder 同风格）：树行合并指示器后，展开态由它表达 */
export function IconFolderOpen(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5H13a1 1 0 0 1 1 1V7" />
      <path d="M3.1 7h9.9l1.5 4.4a1 1 0 0 1-.94 1.35H4.2a1 1 0 0 1-.94-.66L3.1 7Z" />
    </svg>
  );
}

/** 定位（十字准星）：在文件树中定位当前文件 */
export function IconLocate(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="4.2" />
      <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8" />
      <circle cx="8" cy="8" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 搜索（放大镜） */
export function IconSearch(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2L13.5 13.5" />
    </svg>
  );
}

/** 设置（滑杆） */
export function IconSliders(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
      <circle cx="10" cy="4.5" r="1.5" />
      <circle cx="6" cy="11.5" r="1.5" />
    </svg>
  );
}

/** 过滤（漏斗） */
export function IconFilter(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M2.5 3.5h11L9.5 8v4.5l-3 1V8z" />
    </svg>
  );
}

/** 看板（三列） */
export function IconBoard(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="2.5" y="3" width="11" height="10" rx="2" />
      <path d="M6.2 3v10M9.8 3v10" />
    </svg>
  );
}

/** 文件 */
export function IconFile(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4 2.5h5L12 5.5v8H4z" />
      <path d="M9 2.5v3h3" />
    </svg>
  );
}

/** 工具调用 */
export function IconWrench(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M10.3 2.6a3.2 3.2 0 0 0-4.1 4L2.5 10.3a1.6 1.6 0 0 0 2.3 2.3l3.7-3.7a3.2 3.2 0 0 0 4-4.1L10.2 7 8.9 5.7z" />
    </svg>
  );
}

/** 扩展通用回退图标；有内置 icon ID 时由 ExtensionIcon 渲染对应资源。 */
export function IconPuzzle(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4.5 4H5.5A1.5 1.5 0 0 1 8.5 4H11.5A1 1 0 0 1 12.5 5V6.5A1.5 1.5 0 0 1 12.5 9.5V12A1 1 0 0 1 11.5 13H4.5A1 1 0 0 1 3.5 12V9.5A1.5 1.5 0 0 0 3.5 6.5V5A1 1 0 0 1 4.5 4Z" />
    </svg>
  );
}

/** 下拉箭头（自定义下拉触发器/折叠行共用，细线风） */
export function IconChevronDown(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/** 面板折叠/展开开关（2026-10-07 报单④ 统一）：面板轮廓 + 分隔线 + 方向 chevron 两形态。
 *  与顶栏右侧栏开合钮同源；取代 10-06 的裸 chevron（▸/▾ 读作「翻页/前进」不像折叠）。
 *  placement='side'：右侧栏镜像，分隔线在右；open 显 ›（点击折叠）、fold 显 ‹（点击展开）。
 *  placement='top'：顶部列表条（文件树/仓库列表/浏览器标签栏），分隔线在上；
 *  open 显 ˄（点击折叠）、fold 显 ˅（点击展开）。data-* 供组件测试断言统一性。 */
export function IconPanelToggle(
  props: IconProps & { placement?: 'side' | 'top'; open?: boolean }
): React.JSX.Element {
  const { placement = 'side', open = false, ...rest } = props;
  return (
    <svg
      {...base(rest)}
      className={`icon-panel-toggle${props.className ? ` ${props.className}` : ''}`}
      data-placement={placement}
      data-open={open ? 'true' : 'false'}
    >
      {placement === 'side' ? (
        <>
          <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.5" strokeWidth="1.2" />
          <line x1="10.25" y1="3.25" x2="10.25" y2="12.75" strokeWidth="1.2" />
          {open ? (
            <path d="M6.2 6.2 L8.1 8 L6.2 9.8" strokeWidth="1.2" />
          ) : (
            <path d="M8.1 6.2 L6.2 8 L8.1 9.8" strokeWidth="1.2" />
          )}
        </>
      ) : (
        <>
          <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.5" strokeWidth="1.2" />
          <line x1="3.25" y1="6.75" x2="12.75" y2="6.75" strokeWidth="1.2" />
          {open ? (
            <path d="M6.2 11 L8 9.2 L9.8 11" strokeWidth="1.2" />
          ) : (
            <path d="M6.2 9.2 L8 11 L9.8 9.2" strokeWidth="1.2" />
          )}
        </>
      )}
    </svg>
  );
}

/** 上箭头（查找上一个） */
export function IconChevronUp(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4 10l4-4 4 4" />
    </svg>
  );
}

/** 多层平面（查找范围：全部会话 / 运行监视器） */
export function IconLayers(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M2.5 4.6 8 1.6l5.5 3-5.5 3z" />
      <path d="M2.5 7.4 8 4.4l5.5 3-5.5 3z" />
      <path d="M2.5 10.2 8 7.2l5.5 3-5.5 3z" />
    </svg>
  );
}

/** 思考 */
export function IconThinking(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M5.5 12.5a3.5 3.5 0 1 1 .6-6.9 4 4 0 0 1 7.4 1.4 2.8 2.8 0 0 1-1 5.5z" />
    </svg>
  );
}

/** 终端提示符（会话空闲待命） */
export function IconTerminal(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 6.5 7 8l-2 1.5M8.5 10.5h3" />
    </svg>
  );
}

/** 对话气泡（普通会话） */
export function IconChat(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M3 4.5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5v-2.5A1.5 1.5 0 0 1 3 9.5z" />
    </svg>
  );
}

/** 时钟（定时任务） */
export function IconClock(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5.2V8l2 1.6" />
    </svg>
  );
}

/** 减号 */
export function IconMinus(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M3.5 8h9" />
    </svg>
  );
}

/** 关闭 */
export function IconClose(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/** 刷新 */
export function IconRefresh(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <path d="M13 2.6v2.6h-2.6" />
    </svg>
  );
}

/** 排序（上下双箭头） */
export function IconSort(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M5.5 3.5v9M5.5 12.5L3 10M5.5 12.5L8 10" />
      <path d="M10.5 12.5v-9M10.5 3.5L8 6M10.5 3.5L13 6" />
    </svg>
  );
}

/** 更多（横向三点） */
export function IconMore(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 分支（worktree 隔离标记） */
export function IconBranch(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="3.5" r="1.6" />
      <path d="M4.5 5.1v5.8" />
      <path d="M11.5 5.1v.9c0 2.6-2.2 3.5-5 3.5" />
    </svg>
  );
}

export function IconPullRequest(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="3.5" cy="3.5" r="1.5" />
      <circle cx="3.5" cy="12.5" r="1.5" />
      <circle cx="12.5" cy="12.5" r="1.5" />
      <path d="M3.5 5v6m9 0V7a3 3 0 0 0-3-3h-2m2-2-2 2 2 2" />
    </svg>
  );
}

/** 权限档：默认（盾） */
export function IconShield(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M8 1.8 13.2 3.6v4.1c0 3-2.2 5.5-5.2 6.5-3-1-5.2-3.5-5.2-6.5V3.6Z" />
    </svg>
  );
}

/** 权限档：只读（眼） */
export function IconEye(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M1.9 8s2.3-4.1 6.1-4.1S14.1 8 14.1 8s-2.3 4.1-6.1 4.1S1.9 8 1.9 8Z" />
      <circle cx="8" cy="8" r="1.9" />
    </svg>
  );
}

/** 权限档：全自动（闪电） */
export function IconBolt(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M8.9 1.6 3.6 9.1h3.3l-.8 5.3 5.3-7.5H8.1Z" />
    </svg>
  );
}

/** 模型（立方体）：窄屏图标化时替代模型名文字 */
export function IconCube(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M8 1.9 13.8 5v6L8 14.1 2.2 11V5Z" />
      <path d="M2.4 5.1 8 8.1l5.6-3" />
      <path d="M8 8.1v6" />
    </svg>
  );
}

/** 删除（垃圾桶）：后台任务行 / 排队面板行内（size 11）、AgentFloat 历史会话行（缺省 13） */
export function IconTrash(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M2.4 4.3h11.2M6.1 4.3V2.7h3.7v1.6M4 4.3l.7 9.3h6.7l.7-9.3M6.7 7.2v4M9.3 7.2v4" />
    </svg>
  );
}

/* ===== 会话状态图标（环形家族，16×16 / stroke 1.4；状态色与动画类由 StatusIcon.tsx 统一挂） ===== */

function withClass(props: IconProps, extra: string): IconProps {
  return { ...props, className: props.className ? `${extra} ${props.className}` : extra };
}

/**
 * 运行态 spinner 唯一点：正圆 + pathLength=100，缺口/线宽走 base.css `--spinner-*`。
 * 新的「转圈」必须用本组件，禁止再写 border 环 / 另一套弧路径。
 * 相位：挂载时按全局时钟写负 animation-delay（spinnerPhaseDelayMs），多枚缺口朝向一致。
 */
export function IconSpinner(props: IconProps): React.JSX.Element {
  const delayMs = useMemo(() => spinnerPhaseDelayMs(), []);
  return (
    <svg {...base(withClass(props, 'ui-spinner'))} style={{ animationDelay: `${delayMs}ms` }}>
      <circle cx="8" cy="8" r="6.2" pathLength="100" />
    </svg>
  );
}

/** 工作中：统一 spinner（外层挂旋转/状态色） */
export function IconStatusWorking(props: IconProps): React.JSX.Element {
  return <IconSpinner {...props} />;
}

/** 空闲：月牙 */
export function IconStatusIdle(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M14 8.53A6 6 0 1 1 7.47 2a4.67 4.67 0 0 0 6.53 6.53z" />
    </svg>
  );
}

/** 需要你：圆底感叹号（外层挂轻呼吸动画类） */
export function IconStatusNeedsYou(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.7v3.7" />
      <path d="M8 11.3v.01" />
    </svg>
  );
}

/** 已完成：圆底对勾 */
export function IconStatusDone(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="m5.2 8.3 1.9 1.9 3.7-4.1" />
    </svg>
  );
}

/** 返回（左箭头） */
export function IconChevronLeft(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </svg>
  );
}

export function IconChevronRight(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

/** 外观（调色板） */
export function IconPalette(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M8 2.2a5.8 5.8 0 1 0 0 11.6c.9 0 1.3-.6 1.1-1.3-.3-.9.2-1.7 1.2-1.7h1.2a2.3 2.3 0 0 0 2.3-2.3A6 6 0 0 0 8 2.2Z" />
      <circle cx="5.2" cy="7" r=".6" fill="currentColor" stroke="none" />
      <circle cx="7.6" cy="4.9" r=".6" fill="currentColor" stroke="none" />
      <circle cx="10.4" cy="6" r=".6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 模型（四角星） */
export function IconSparkle(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M8 2.2 9.3 6.7 13.8 8 9.3 9.3 8 13.8 6.7 9.3 2.2 8l4.5-1.3Z" />
    </svg>
  );
}

/** 通知（铃铛） */
export function IconBell(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <path d="M4.2 11.2V7.4a3.8 3.8 0 0 1 7.6 0v3.8l1 1.1H3.2Z" />
      <path d="M6.6 13.8a1.5 1.5 0 0 0 2.8 0" />
    </svg>
  );
}

/** 远程访问（手机） */
export function IconPhone(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="4.5" y="1.8" width="7" height="12.4" rx="1.8" />
      <path d="M7.2 12h1.6" />
    </svg>
  );
}

/** 快捷键（键盘） */
export function IconKeyboard(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <rect x="1.8" y="4" width="12.4" height="8" rx="1.6" />
      <path d="M4.5 6.6h.01M6.8 6.6h.01M9.2 6.6h.01M11.5 6.6h.01M5.4 9.4h5.2" />
    </svg>
  );
}

/** 关于（圆内 i） */
export function IconInfo(props: IconProps): React.JSX.Element {
  return (
    <svg {...base(props)}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.4v3.6" />
      <path d="M8 5.1v.01" />
    </svg>
  );
}
