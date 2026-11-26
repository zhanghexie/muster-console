import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context';
import { formatNotifyText } from '../../shared/types';
import { t } from '../../shared/i18n';
import { ensureMetaAgentScaffold } from './scaffold';
import { registerPendingPhaseOne } from '../agent/declarationTrustSources';
import { pathKey } from '../pathKey';
import { controlRootFor } from '../workspacePaths';

function resolveWorkspaceId(ctx: AppContext, root: string): string {
  const cfg = ctx.config.get();
  const key = pathKey(root);
  const found = cfg.workspaces.find((w) => !w.rootsError && pathKey(controlRootFor(w)) === key);
  return found?.id || cfg.activeWorkspaceId;
}

/**
 * S2.1 一期接线：scaffold 落盘后把 registry 和 CLI 首条简报登记进
 * digest 信任账本（首见 pending_trust；内容变不落账，有效态 stale_digest）。
 * 账本未注入 userData 时静默跳过（测试/非宿主环境不挡 scaffold）。
 */
function syncDeclarationTrust(ctx: AppContext, root: string): void {
  try {
    // identity 与账本文件名同用 pathKey 归一（大小写/分隔符一致的访问路径命中同一身份，
    // 不因混用写法产生重复 pending 记录）
    registerPendingPhaseOne(pathKey(root), pathKey(root), ctx.config.get().agentRules);
  } catch {
    /* 信任同步是审计/注入门的软路径，不挡 scaffold */
  }
}

/** Soft-gate: ensure public workspace guidance, notify once when first created. */
export function ensureWorkspaceMetaAgent(
  ctx: AppContext,
  root: string
): void {
  const resolved = path.resolve(root);
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return;
  } catch {
    return;
  }

  try {
    const { created } = ensureMetaAgentScaffold(resolved);
    syncDeclarationTrust(ctx, resolved);
    if (created) {
      ctx.notify.push({
        workspaceId: resolveWorkspaceId(ctx, resolved),
        sessionId: 'app',
        sessionName: t('工作台'),
        text: formatNotifyText(t('工作台'), t('已初始化 .muster')),
        toast: true
      });
    }
  } catch (err) {
    console.error('[metaAgent] ensure failed', resolved, err);
    ctx.notify.push({
      workspaceId: resolveWorkspaceId(ctx, resolved),
      sessionId: 'app',
      sessionName: t('工作台'),
      text: formatNotifyText(t('工作台'), t('初始化 .muster 失败：{{err}}', { err: String(err) })),
      toast: true
    });
  }
}

/** Startup: ensure every configured workspace that still exists on disk. */
export function ensureAllWorkspacesMetaAgent(ctx: AppContext): void {
  for (const w of ctx.config.get().workspaces) {
    if (w.rootsError) {
      console.error('[metaAgent] invalid workspace registration:', w.id, w.rootsError);
      ctx.notify.push({ workspaceId: w.id, sessionId: 'app', sessionName: t('工作台'),
        text: formatNotifyText(t('工作台'), w.rootsError), toast: true });
      continue;
    }
    ensureWorkspaceMetaAgent(ctx, controlRootFor(w));
  }
}
