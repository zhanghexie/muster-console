import React from 'react';

export type WorkspaceSkeletonProps = {
  leftW: number;
  /** 开启横向虚拟屏时右侧多出 Git 露条 */
  virtualScreen: boolean;
  /** 虚拟屏下当前主态：影响露条在左还是右 */
  hDock?: 'terminal' | 'git';
  /** Target workspace split ratios. */
  termRatio: number;
  gitRatio: number;
  /** Target workspace resolved surfaces. */
  frameColor?: string;
  canvasColor?: string;
};

function SessionColumn({ leftW }: { leftW: number }): React.JSX.Element {
  if (leftW <= 0) return <></>;
  return (
    <div className="ws-skel-left" style={{ width: leftW }}>
      <div className="ws-skel-head">
        <div className="ws-skel-block ws-skel-pill" />
        <div className="ws-skel-block ws-skel-icon" />
      </div>
      <div className="ws-skel-tools-grid" aria-hidden>
        {Array.from({ length: 6 }, (_, index) => <div className="ws-skel-block ws-skel-tool-tile" key={index} />)}
      </div>
      <div className="ws-skel-section">
        <div className="ws-skel-block ws-skel-label" />
        <div className="ws-skel-block ws-skel-row" />
        <div className="ws-skel-block ws-skel-row short" />
        <div className="ws-skel-block ws-skel-row" />
      </div>
      <div className="ws-skel-section">
        <div className="ws-skel-block ws-skel-label" />
        <div className="ws-skel-block ws-skel-row short" />
        <div className="ws-skel-block ws-skel-row" />
      </div>
    </div>
  );
}

function TerminalPane(): React.JSX.Element {
  return (
    <div className="ws-skel-main">
      <div className="ws-skel-term">
        <div className="ws-skel-block ws-skel-content-block ws-skel-line w60" />
        <div className="ws-skel-block ws-skel-content-block ws-skel-line w40" />
        <div className="ws-skel-block ws-skel-content-block ws-skel-line w75" />
        <div className="ws-skel-block ws-skel-content-block ws-skel-line w55" />
        <div className="ws-skel-block ws-skel-content-block ws-skel-line w30" />
        <div className="ws-skel-block ws-skel-content-block ws-skel-line w70" />
        <div className="ws-skel-cursor" />
      </div>
      <div className="ws-skel-composer">
        <div className="ws-skel-block ws-skel-content-block ws-skel-composer-line" />
        <div className="ws-skel-composer-toolbar">
          <div className="ws-skel-composer-tools">
            <div className="ws-skel-block ws-skel-content-block ws-skel-composer-tool" />
            <div className="ws-skel-block ws-skel-content-block ws-skel-composer-tool short" />
          </div>
          <div className="ws-skel-block ws-skel-content-block ws-skel-composer-send" />
        </div>
      </div>
    </div>
  );
}

function GitPane({ peek }: { peek?: boolean }): React.JSX.Element {
  return (
    <div className={`ws-skel-git${peek ? ' is-peek' : ''}`}>
      <div className="ws-skel-git-head">
        <div className="ws-skel-block ws-skel-content-block ws-skel-label" />
        <div className="ws-skel-block ws-skel-icon" />
      </div>
      <div className="ws-skel-git-tabs">
        <div className="ws-skel-block ws-skel-content-block ws-skel-git-tab active" />
        <div className="ws-skel-block ws-skel-content-block ws-skel-git-tab" />
        <div className="ws-skel-block ws-skel-content-block ws-skel-git-tab short" />
      </div>
      {!peek && (
        <div className="ws-skel-git-body">
          <div className="ws-skel-git-item"><div className="ws-skel-block ws-skel-git-dot" /><div className="ws-skel-block ws-skel-content-block ws-skel-row" /></div>
          <div className="ws-skel-git-item"><div className="ws-skel-block ws-skel-git-dot" /><div className="ws-skel-block ws-skel-content-block ws-skel-row short" /></div>
          <div className="ws-skel-git-item"><div className="ws-skel-block ws-skel-git-dot" /><div className="ws-skel-block ws-skel-content-block ws-skel-row" /></div>
          <div className="ws-skel-git-item"><div className="ws-skel-block ws-skel-git-dot" /><div className="ws-skel-block ws-skel-content-block ws-skel-row short" /></div>
        </div>
      )}
      {peek && (
        <div className="ws-skel-git-body is-peek">
          <div className="ws-skel-block ws-skel-content-block ws-skel-git-bar" />
          <div className="ws-skel-block ws-skel-content-block ws-skel-git-bar short" />
          <div className="ws-skel-block ws-skel-content-block ws-skel-git-bar" />
        </div>
      )}
    </div>
  );
}

/** 工作区切换胶片用固定骨架：普通 / 虚拟屏（含 Git）两套 */
export function WorkspaceSkeleton({
  leftW,
  virtualScreen,
  hDock = 'terminal',
  termRatio,
  gitRatio,
  frameColor,
  canvasColor
}: WorkspaceSkeletonProps): React.JSX.Element {
  const style = {
    '--ws-skel-term-share': `${Math.max(0, Math.min(1, termRatio)) * 100}%`,
    '--ws-skel-git-share': `${Math.max(0, Math.min(1, gitRatio)) * 100}%`,
    ...(frameColor ? { '--ws-skel-frame-color': frameColor } : {}),
    ...(canvasColor ? { '--ws-skel-canvas-color': canvasColor } : {})
  } as React.CSSProperties;
  if (!virtualScreen) {
    return (
      <div className="ws-skeleton ws-skel-plain" style={style} aria-hidden>
        <SessionColumn leftW={leftW} />
        <TerminalPane />
      </div>
    );
  }

  // 虚拟屏：终端主态右侧露 Git；Git 主态左侧露工作页
  if (hDock === 'git') {
    return (
      <div className="ws-skeleton ws-skel-vs ws-skel-vs-git" style={style} aria-hidden>
        <div className="ws-skel-workspace-peek">
          <SessionColumn leftW={Math.min(leftW, 72)} />
          <div className="ws-skel-main is-peek" />
        </div>
        <GitPane />
      </div>
    );
  }

  return (
    <div className="ws-skeleton ws-skel-vs ws-skel-vs-terminal" style={style} aria-hidden>
      <div className="ws-skel-workspace">
        <SessionColumn leftW={leftW} />
        <TerminalPane />
      </div>
      <GitPane peek />
    </div>
  );
}
