import { runOutsideAgentScope } from '../agent/agentScope';
import { authorizeSafetyOperation } from '../safety/bindings';
import { isConfirmed } from '../../shared/confirmDialog';
import { t } from '../../shared/i18n';
import { localizeSafetyReason } from '../../shared/safetyReason';
import type { AppContext } from '../context';
import type { ExtensionReviewDecision, ExtensionReviewRequest } from './extensionReview';

/** Complete package review on discovery/submission, with an explicit human fallback. */
export function createExtensionSafetyReviewer(ctx: AppContext): (request: ExtensionReviewRequest) => Promise<ExtensionReviewDecision> {
  return request => runOutsideAgentScope(async (): Promise<ExtensionReviewDecision> => {
    const { manifest, candidate, snapshot } = request;
    const warning = manifest.permissions.includes('native') ? t('包含 Electron 原生主进程入口，具有本机完整权限。') : (manifest.domain || manifest.commandEntry || manifest.agent?.mcp.length) ? t('包含 Node 后台代码，独立进程不是操作系统权限沙箱。') : '';
    const humanConfirm = async (reason: string, signal?: AbortSignal): Promise<boolean> => {
      const displayedReason = localizeSafetyReason(reason);
      return isConfirmed(await ctx.ui.confirm(t('审核扩展：{{name}}', { name: manifest.name }), t('{{reason}}\n\n范围：{{scope}}\n源码：{{directory}}\n整包指纹：{{fingerprint}}\n{{warning}}', { reason: displayedReason, scope: manifest.scope, directory: candidate.directory, fingerprint: snapshot.fingerprint, warning }), { dangerous: true, signal, confirmNote: displayedReason }));
    };
    if (request.evidenceError) {
      const accepted = await humanConfirm(t('无法自动完整审查：{{error}}。请先检查该目录的全部代码与资源。', { error: request.evidenceError }), request.signal);
      return accepted ? { approved: true } : { approved: false, reason: '人工审核未通过' };
    }
    const result = await authorizeSafetyOperation(ctx, {
      workspaceId: candidate.workspaceId, source: 'catalog', action: 'extensions.trust',
      args: { extensionId: manifest.id, scope: manifest.scope, project: manifest.project, permissions: manifest.permissions },
      dangerous: true, targetFingerprint: snapshot.fingerprint, evidence: request.evidence, humanConfirm, signal: request.signal
    });
    return result.allowed ? { approved: true } : { approved: false, reason: result.reason || '安全审核未通过' };
  });
}
