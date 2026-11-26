import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UiDialogItem, UiDialogRequest } from '../../../shared/uiDialog';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { usePresenceValue, type PresenceStage } from './motion';

interface Props {
  request: UiDialogRequest | null;
  onRespond: (requestId: string, cancelled: boolean, value?: string | string[]) => void;
}

/** presence 进出场属性（data-mp-stage），Body 根节点透传挂 mp-* 类 */
interface Mp {
  'data-mp-stage': PresenceStage;
}

/** 遮罩 mousedown 关闭（onClick 会在框内拖选文字、松开在遮罩时误关） */
function maskCloseProps(onCancel: () => void): {
  onMouseDown: (e: React.MouseEvent) => void;
} {
  return {
    onMouseDown: (e) => {
      if (e.target === e.currentTarget) onCancel();
    }
  };
}

/** request 可空驱动 presence 进出场（可打断）；队列切下一请求时直接换内容不过场 */
export function ExtensionUiDialog({ request, onRespond }: Props): React.JSX.Element | null {
  const { presence, value: req } = usePresenceValue(request);
  const respond: Props['onRespond'] = (requestId, cancelled, value) => {
    if (!request || presence.stage === 'out' || request.requestId !== requestId) return;
    onRespond(requestId, cancelled, value);
  };

  useOverlayDismiss(presence.mounted && presence.stage !== 'out', () => {
    if (req) respond(req.requestId, true);
  });

  if (!presence.mounted || !req) return null;
  const mp: Mp = { 'data-mp-stage': presence.stage };
  const cancel = (): void => respond(req.requestId, true);

  if (req.kind === 'prompt') {
    return <PromptBody request={req} onRespond={respond} onCancel={cancel} mp={mp} />;
  }
  if (req.kind === 'menu') {
    return <MenuBody request={req} onRespond={respond} onCancel={cancel} mp={mp} />;
  }
  // select | multiSelect：同一套列表样式
  return <PickListBody request={req} onRespond={respond} onCancel={cancel} mp={mp} />;
}

function PromptBody({
  request,
  onRespond,
  onCancel,
  mp
}: {
  request: Extract<UiDialogRequest, { kind: 'prompt' }>;
  onRespond: Props['onRespond'];
  onCancel: () => void;
  mp: Mp;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [value, setValue] = useState(request.defaultValue ?? '');
  useEffect(() => {
    setValue(request.defaultValue ?? '');
  }, [request.requestId, request.defaultValue]);

  const submit = (): void => onRespond(request.requestId, false, value);

  return (
    <div className="modal-mask app-confirm-mask mp-scrim" {...mp} {...maskCloseProps(onCancel)}>
      <div
        className="modal confirm-modal ext-ui-dialog mp-panel"
        {...mp}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ext-ui-dialog-title"
      >
        <h3 id="ext-ui-dialog-title">{request.title}</h3>
        {request.message ? <p className="ext-ui-dialog-msg">{request.message}</p> : null}
        {request.multiline ? (
          <textarea
            className="ext-ui-dialog-input"
            rows={5}
            autoFocus
            placeholder={request.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <input
            className="ext-ui-dialog-input"
            type="text"
            autoFocus
            placeholder={request.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {t('取消')}
          </button>
          <button type="button" className="btn primary" onClick={submit}>
            {t('确定')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 菜单：点一项即返回（可含 separator） */
function MenuBody({
  request,
  onRespond,
  onCancel,
  mp
}: {
  request: Extract<UiDialogRequest, { kind: 'menu' }>;
  onRespond: Props['onRespond'];
  onCancel: () => void;
  mp: Mp;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="modal-mask app-confirm-mask mp-scrim" {...mp} {...maskCloseProps(onCancel)}>
      <div
        className="modal confirm-modal ext-ui-dialog mp-panel"
        {...mp}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ext-ui-dialog-title"
      >
        <h3 id="ext-ui-dialog-title">{request.title || t('请选择')}</h3>
        <div className="ext-ui-dialog-list" role="menu">
          {request.items.map((item, i) =>
            item.separator ? (
              <div key={`sep-${i}`} className="ext-ui-dialog-sep" role="separator" />
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="ext-ui-dialog-row"
                onClick={() => onRespond(request.requestId, false, item.id)}
              >
                <RowText item={item} />
              </button>
            )
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {t('取消')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 单选 / 多选：同一行样式；点行切换选中，确定提交 */
function PickListBody({
  request,
  onRespond,
  onCancel,
  mp
}: {
  request: Extract<UiDialogRequest, { kind: 'select' | 'multiSelect' }>;
  onRespond: Props['onRespond'];
  onCancel: () => void;
  mp: Mp;
}): React.JSX.Element {
  const { t } = useTranslation();
  const multi = request.kind === 'multiSelect';
  const [picked, setPicked] = useState<Set<string>>(() => {
    if (multi) return new Set(request.selectedIds ?? []);
    return new Set<string>();
  });

  const initialIds =
    request.kind === 'multiSelect' ? (request.selectedIds ?? []).join('\0') : '';
  useEffect(() => {
    if (multi) setPicked(new Set(initialIds ? initialIds.split('\0') : []));
    else setPicked(new Set());
  }, [request.requestId, multi, initialIds]);

  const toggle = (id: string): void => {
    setPicked((prev) => {
      if (!multi) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = (): void => {
    if (multi) {
      onRespond(request.requestId, false, [...picked]);
      return;
    }
    const id = [...picked][0];
    if (!id) return;
    onRespond(request.requestId, false, id);
  };

  const canSubmit = multi || picked.size === 1;

  return (
    <div className="modal-mask app-confirm-mask mp-scrim" {...mp} {...maskCloseProps(onCancel)}>
      <div
        className="modal confirm-modal ext-ui-dialog mp-panel"
        {...mp}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ext-ui-dialog-title"
      >
        <h3 id="ext-ui-dialog-title">{request.title}</h3>
        {request.message ? <p className="ext-ui-dialog-msg">{request.message}</p> : null}
        <div
          className="ext-ui-dialog-list"
          role={multi ? 'group' : 'radiogroup'}
          aria-label={request.title}
        >
          {request.items.map((item) => {
            if (item.separator) return null;
            const on = picked.has(item.id);
            return (
              <button
                key={item.id}
                type="button"
                role={multi ? 'checkbox' : 'radio'}
                aria-checked={on}
                className={`ext-ui-dialog-row${on ? ' is-on' : ''}`}
                onClick={() => toggle(item.id)}
              >
                <span
                  className={`ext-ui-dialog-mark${on ? ' is-on' : ''}`}
                  aria-hidden
                >
                  {on ? (
                    <svg viewBox="0 0 12 12" width="10" height="10">
                      <path
                        d="M2.5 6.2 4.8 8.5 9.5 3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </span>
                <RowText item={item} />
              </button>
            );
          })}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {t('取消')}
          </button>
          <button type="button" className="btn primary" disabled={!canSubmit} onClick={submit}>
            {t('确定')}
          </button>
        </div>
      </div>
    </div>
  );
}

function RowText({ item }: { item: UiDialogItem }): React.JSX.Element {
  return (
    <span className="ext-ui-dialog-row-text">
      <span className="ext-ui-dialog-item-label">{item.label}</span>
      {item.detail ? <span className="ext-ui-dialog-item-detail">{item.detail}</span> : null}
    </span>
  );
}
