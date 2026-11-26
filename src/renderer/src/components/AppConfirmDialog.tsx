import React, { useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { usePresence } from './motion';

/** 应用内确认框（portal 到 body，避开虚拟屏 transform）。
 *  open 驱动 presence 进出场（mp-panel/mp-scrim，可打断）；关闭瞬间起内容
 *  冻结为最后一次 open=true 的快照，退场动画期间不闪空。 */
export function AppConfirmDialog({
  open = true,
  title,
  detail,
  confirmLabel,
  cancelLabel,
  hideCancel = false,
  danger = false,
  className = '',
  focusCancel = false,
  alternate,
  content,
  formId,
  confirmDisabled = false,
  busy = false,
  onConfirm,
  onCancel
}: {
  /** false 时播退场后卸载；缺省 true（老调用方语义不变） */
  open?: boolean;
  title: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  hideCancel?: boolean;
  danger?: boolean;
  /** Optional mask class for a caller's layout constraints. */
  className?: string;
  focusCancel?: boolean;
  alternate?: { label: string; onClick: () => void };
  content?: React.ReactNode;
  formId?: string;
  confirmDisabled?: boolean;
  busy?: boolean;
  onConfirm?: () => void;
  onCancel: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const titleId = useId();
  // 缺省按钮文案在渲染时翻译（参数缺省值不随语言切换重算，故移到组件体内取值）
  const effConfirmLabel = confirmLabel ?? t('确认');
  const effCancelLabel = cancelLabel ?? t('取消');
  const presence = usePresence(open);
  const cancelButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (open && presence.mounted && focusCancel) cancelButton.current?.focus({ preventScroll: true });
  }, [open, presence.mounted, focusCancel]);
  useLayoutEffect(() => {
    if (!formId || !open || !presence.mounted) return;
    const trigger = document.activeElement;
    const workbench = document.getElementById('root');
    const previousInert = workbench?.inert ?? false;
    if (workbench) workbench.inert = true;
    return () => {
      if (workbench) workbench.inert = previousInert;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [formId, open, presence.mounted]);
  const snapRef = useRef({
    title,
    detail,
    confirmLabel: effConfirmLabel,
    cancelLabel: effCancelLabel,
    hideCancel,
    danger,
    alternate,
    content,
    formId,
    confirmDisabled,
    busy,
    onConfirm,
    onCancel
  });
  if (open) {
    snapRef.current = {
      title,
      detail,
      confirmLabel: effConfirmLabel,
      cancelLabel: effCancelLabel,
      hideCancel,
      danger,
      alternate,
      content,
      formId,
      confirmDisabled,
      busy,
      onConfirm,
      onCancel
    };
  }
  const p = snapRef.current;

  useOverlayDismiss(presence.mounted && presence.stage !== 'out' && !p.busy, p.onCancel);

  if (!presence.mounted) return null;
  return createPortal(
    <div
      className={`modal-mask app-confirm-mask mp-scrim${className ? ` ${className}` : ''}`}
      data-overlay-root
      data-mp-stage={presence.stage}
      {...(p.formId && !open ? { 'aria-hidden': true, inert: '' } : {})}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !p.busy) p.onCancel();
      }}
    >
      <div
        className="modal confirm-modal mp-panel"
        data-mp-stage={presence.stage}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={p.formId ? event => {
          if (event.key !== 'Tab') return;
          const fields = event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href]'
          );
          const first = fields[0], last = fields[fields.length - 1];
          const target = event.shiftKey && event.target === first ? last : !event.shiftKey && event.target === last ? first : null;
          if (target) { event.preventDefault(); target.focus(); }
        } : undefined}
      >
        <div className="modal-head">
          <h3 id={titleId}>{p.title}</h3>
          <button type="button" className="modal-close" aria-label={t('关闭')} disabled={p.busy} onClick={p.onCancel}>
            ×
          </button>
        </div>
        {p.detail ? <pre className="confirm-detail">{p.detail}</pre> : null}
        {p.content}
        <div className="modal-actions">
          {!p.hideCancel && <button type="button" className="btn" disabled={p.busy} ref={cancelButton} onClick={p.onCancel}>
            {p.cancelLabel}
          </button>}
          {p.alternate && <button type="button" className="btn" disabled={p.busy} onClick={p.alternate.onClick}>{p.alternate.label}</button>}
          <button
            type={p.formId ? 'submit' : 'button'}
            form={p.formId}
            className={`btn${p.danger ? ' danger' : ' primary'}`}
            disabled={p.confirmDisabled || p.busy}
            onClick={p.formId ? undefined : p.onConfirm}
          >
            {p.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
