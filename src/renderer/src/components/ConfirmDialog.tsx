import React, { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '../store';
import type { ConfirmRequest } from '../../../shared/types';
import type { ConfirmCancelledBy } from '../../../shared/confirmDialog';
import type { PermissionDecision, PermissionScope } from '../../../shared/permissionOption';
import { decisionConfirmed } from '../../../shared/permissionOption';
import { InboundMcpReviewBody } from './InboundMcpReviewBody';
import { PermissionOptionBody, useFreeTextFill } from './PermissionOptionBody';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { usePresenceValue } from './motion';

/** 壳层确认请求框：request 可空驱动 presence 进出场（可打断），
 *  队列切到下一请求时（非空→非空）直接换内容不过场。 */
export function ConfirmDialog({ request }: { request: ConfirmRequest | null }): React.JSX.Element | null {
  const { respondConfirm } = useUiStore();
  const { t } = useTranslation();
  const { presence, value: req } = usePresenceValue(request);
  const safeActionRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const requestId = request?.requestId;
  useLayoutEffect(() => {
    if (presence.mounted && requestId) {
      (safeActionRef.current ?? closeRef.current)?.focus({ preventScroll: true });
    }
  }, [presence.mounted, requestId]);
  const perm = req?.permission;
  const [freeText, setFreeText] = useFreeTextFill(req?.requestId, perm?.freeText);
  const [scope, setScope] = useState<PermissionScope>(perm?.defaultScope ?? 'project');
  const [evidenceStatus, setEvidenceStatus] = useState<{ requestId: string; loaded: boolean; failed: boolean } | null>(null);
  const scopeInitFor = useRef<string | null>(null);
  if (req && scopeInitFor.current !== req.requestId) {
    scopeInitFor.current = req.requestId;
    const next = perm?.defaultScope ?? 'project';
    if (next !== scope) setScope(next);
  }

  const reject = (by: ConfirmCancelledBy) => {
    const r = req;
    if (!r || request?.requestId !== r.requestId) return;
    if (r.permission) respondConfirm(r.requestId, false, by, { kind: 'deny' });
    else respondConfirm(r.requestId, false, by);
  };

  /** 四态处置：allowOnce/allowAlways 放行；deny/custom 否决（custom 带 freeText 回灌） */
  const decide = (kind: PermissionDecision['kind']) => {
    const r = req;
    if (!r || request?.requestId !== r.requestId) return;
    if ((kind === 'allowOnce' || kind === 'allowAlways') && r.desktopEvidence &&
        (evidenceStatus?.requestId !== r.requestId || !evidenceStatus.loaded)) return;
    const decision: PermissionDecision = {
      kind,
      ...(kind === 'allowAlways' ? { scope } : {}),
      ...(freeText.trim() ? { freeText: freeText.trim() } : {})
    };
    const ok = decisionConfirmed(decision);
    respondConfirm(r.requestId, ok, ok ? undefined : 'button', decision);
    setFreeText('');
  };

  // Esc（overlay.close）仍关闭危险确认：P13 只禁遮罩误点；Esc/×/取消是显式否决，cancelledBy=esc|close|button。
  useOverlayDismiss(presence.mounted && presence.stage !== 'out', () => reject('esc'));

  if (!presence.mounted || !req) return null;
  const mcpReview = req.inboundMcpReview;
  const dangerous = !!req.dangerous;
  const kinds = perm
    ? (perm.kinds ?? ['allowOnce', 'allowAlways', 'deny', 'custom'])
    : undefined;
  const confirmLabel =
    req.confirmLabel || (mcpReview ? t('确认写入') : t('确认执行'));
  const cancelLabel = req.cancelLabel || t('取消');
  const rich = !!(req.intent || req.summary || req.confirmNote || req.toolDescription);
  const evidenceReady = !req.desktopEvidence || (evidenceStatus?.requestId === req.requestId && evidenceStatus.loaded);

  return (
    <div
      className="modal-mask app-confirm-mask mp-scrim"
      data-overlay-root
      data-mp-stage={presence.stage}
      data-testid="confirm-mask"
      onMouseDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (dangerous) return;
        reject('backdrop');
      }}
    >
      <div
        className={`modal confirm-modal${perm ? ' perm-confirm-modal' : ''}${req.desktopEvidence ? ' confirm-desktop-modal' : ''} mp-panel`}
        data-mp-stage={presence.stage}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <div className="modal-head">
          <div className="confirm-head-text">
            <h3 id="confirm-dialog-title">{req.title}</h3>
            {req.subtitle ? <p className="confirm-subtitle">{req.subtitle}</p> : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="modal-close"
            aria-label={t('关闭')}
            onClick={() => reject('close')}
          >
            ×
          </button>
        </div>
        {mcpReview ? (
          <InboundMcpReviewBody review={mcpReview} />
        ) : rich || perm ? (
          <div className="confirm-body">
            {req.intent ? <p className="confirm-intent">{req.intent}</p> : null}
            {req.summary ? <pre className="confirm-summary">{req.summary}</pre> : null}
            {req.confirmNote ? <p className="confirm-note">{req.confirmNote}</p> : null}
            {perm ? (
              <PermissionOptionBody
                options={perm}
                freeText={freeText}
                onFreeTextChange={setFreeText}
                scope={scope}
                onScopeChange={setScope}
              />
            ) : null}
            {req.toolDescription || req.detail ? (
              <details className="confirm-more">
                <summary>{t('模型向说明与原始参数')}</summary>
                {req.toolDescription ? (
                  <p className="confirm-tool-desc">{req.toolDescription}</p>
                ) : null}
                {req.detail ? <pre className="confirm-detail">{req.detail}</pre> : null}
              </details>
            ) : null}
          </div>
        ) : (
          <pre className="confirm-detail">{req.detail}</pre>
        )}
        {req.desktopEvidence ? (
          <div className="confirm-desktop-evidence">
            <span>{t('操作区域截图')} · {req.desktopEvidence.region.x}, {req.desktopEvidence.region.y} · {req.desktopEvidence.region.width} × {req.desktopEvidence.region.height}</span>
            <img key={req.requestId} src={req.desktopEvidence.dataUrl} alt={t('操作区域截图')}
              onLoad={() => setEvidenceStatus({ requestId: req.requestId, loaded: true, failed: false })}
              onError={() => setEvidenceStatus({ requestId: req.requestId, loaded: false, failed: true })} />
            {!evidenceReady ? <span role="status">{evidenceStatus?.requestId === req.requestId && evidenceStatus.failed ? t('截图无法显示，无法批准') : t('正在加载截图')}</span> : null}
          </div>
        ) : null}
        <div className="modal-actions">
          {kinds ? (
            <>
              {kinds.includes('deny') ? (
                <button
                  ref={safeActionRef}
                  className="btn"
                  data-testid="permission-deny"
                  onClick={() => decide('deny')}
                >
                  {t('拒绝')}
                </button>
              ) : null}
              {kinds.includes('custom') ? (
                <button className="btn" data-testid="permission-custom" onClick={() => decide('custom')}>
                  {t('自定义')}
                </button>
              ) : null}
              {kinds.includes('allowAlways') ? (
                <button
                  className="btn"
                  data-testid="permission-allow-always"
                  disabled={!evidenceReady}
                  onClick={() => decide('allowAlways')}
                >
                  {t('总是允许')}
                </button>
              ) : null}
              {kinds.includes('allowOnce') ? (
                <button
                  className="btn danger"
                  data-testid="permission-allow-once"
                  disabled={!evidenceReady}
                  onClick={() => decide('allowOnce')}
                >
                  {confirmLabel}
                </button>
              ) : null}
            </>
          ) : (
            <>
              <button ref={safeActionRef} className="btn" onClick={() => reject('button')}>
                {cancelLabel}
              </button>
              <button
                className="btn danger"
                disabled={!evidenceReady}
                onClick={() => {
                  if (evidenceReady && request?.requestId === req.requestId) respondConfirm(req.requestId, true);
                }}
              >
                {confirmLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
