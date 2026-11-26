import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '../store';
import { IconLocate } from './icons';
import { useCliComposerPlacement } from './useCliComposerPlacement';
import { FloatingCapsuleDragHandle } from './FloatingCapsuleDragHandle';
import type { TerminalScanPoint } from './TerminalView';

/** 普通 Shell / 后台终端没有工作台输入胶囊，仍提供同样可拖动贴边的识屏入口。 */
export function TerminalScanCapsule({ sessionId, visible, active, viewRef, onScan }: {
  sessionId: string; visible: boolean; active: boolean;
  viewRef: React.RefObject<HTMLDivElement | null>;
  onScan: (point: TerminalScanPoint) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { flashTip } = useUiStore();
  const capsuleRef = useRef<HTMLDivElement>(null);
  const onPersistenceError = useCallback(() => flashTip(t('胶囊位置无法保存，重新打开后可能恢复默认')), [flashTip, t]);
  const placement = useCliComposerPlacement({ sessionId: `terminal-scan:${sessionId}`, visible, open: false,
    viewRef, capsuleRef, dialogRef: capsuleRef, onPersistenceError });
  return <div ref={capsuleRef} className={`cli-composer-capsule terminal-scan-capsule${placement.dragging ? ' is-dragging' : ''}`}
    style={placement.capsuleStyle}>
    <div className="cli-composer-capsule-shell">
      <button type="button" className="cli-composer-scan terminal-scan-button" aria-pressed={active}
        aria-label={active ? t('关闭识屏') : t('识屏')} title={active ? t('关闭识屏') : t('识屏')}
        onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          onScan({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
        }}><IconLocate /><span>{t('识屏')}</span></button>
      <FloatingCapsuleDragHandle label={t('拖动识屏胶囊')} handlers={placement}/>
    </div>
  </div>;
}
