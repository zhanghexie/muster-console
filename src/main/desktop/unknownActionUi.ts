import { createHash } from 'node:crypto';
import { t } from '../../shared/i18n';
import type { UiBridge, ConfirmReceipt } from '../uiBridge';
import type { DesktopAuditEntry } from './auditStore';

export function confirmationRefusalReason(result: ConfirmReceipt): NonNullable<DesktopAuditEntry['refusalReason']> {
  if (result.failureReason) return result.failureReason;
  return result.decision.confirmed === false && result.decision.kind === 'deny' ? 'user-declined' : 'invalid-response';
}
import type { UnknownActionBoundary } from './unknownActionChain';

/** Evidence must be obtained from the host's authorized capture, not model input. */
export function makeUnknownActionConfirmation(ui: Pick<UiBridge, 'confirmWithReceipt'>,
  evidenceFor: (boundary: Readonly<UnknownActionBoundary>) => Promise<{
    png: Buffer; captureId: string; appId: string; processInstance: string; surfaceId: string; surfaceGeneration: string; geometryRevision: string;
    region: { x: number; y: number; width: number; height: number };
  }>, signal?: AbortSignal, onReceipt?: (result: ConfirmReceipt) => void) {
  return async (boundary: Readonly<UnknownActionBoundary>): Promise<boolean> => {
    signal?.throwIfAborted();
    const safe = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160);
    const app = safe(boundary.appId), action = safe(boundary.actionClass);
    if (!app || !action || !/^[a-f0-9]{64}$/.test(boundary.evidenceSha256)) throw new Error('Invalid desktop action confirmation');
    const evidence = await evidenceFor(boundary);
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(evidence?.png) || createHash('sha256').update(evidence.png).digest('hex') !== boundary.evidenceSha256 ||
        evidence.captureId !== boundary.captureId || evidence.appId !== boundary.appId || evidence.processInstance !== boundary.processInstance || evidence.surfaceId !== boundary.surfaceId ||
        evidence.surfaceGeneration !== boundary.surfaceGeneration || evidence.geometryRevision !== boundary.geometryRevision ||
        !evidence.region || !boundary.region || (['x', 'y', 'width', 'height'] as const).some(key => evidence.region[key] !== boundary.region[key])) {
      throw new Error('Desktop action evidence changed');
    }
    const result = await ui.confirmWithReceipt(t('允许桌面操作？'),
      t('允许本回合使用电脑。本回合内后续桌面操作不再询问。当前应用“{{app}}”，动作“{{action}}”；请检查下方操作区域截图。', { app, action }),
      { dangerous: true, localOnly: true, confirmLabel: t('允许'), cancelLabel: t('拒绝'), signal,
        desktopEvidence: { png: evidence.png, sha256: boundary.evidenceSha256, region: evidence.region } });
    if (signal?.aborted) {
      if (!onReceipt) { signal.throwIfAborted(); return false; }
      onReceipt({ decision: { confirmed: false, cancelledBy: 'timeout' }, failureReason: 'confirmation-interrupted' });
      return false;
    }
    onReceipt?.(result);
    return !!result.approvalId && result.decision.confirmed === true && !result.decision.cancelledBy &&
      (result.decision.kind === 'allowOnce' || result.decision.kind === 'allowAlways');
  };
}
