import { app } from 'electron';
import path from 'node:path';
import type { AppContext } from '../context';
import type { SessionMeta } from '../../shared/types';
import { t } from '../../shared/i18n';
import { prepareAttachments } from './service';
import { resolveLlmConfig } from '../config';
import { getChatCapabilities } from '../../shared/agentRuntimeCapabilities';
import { readPiMode } from '../agentSession/drivers/pi/modes';

export async function prepareGuiInput(ctx: AppContext, session: SessionMeta, text: string,
  attachments: Parameters<typeof prepareAttachments>[0]['attachments']) {
  const isPi = session.runtime === 'pi';
  const resolveModel = () => resolveLlmConfig(ctx.config.get(), ctx.sessions.get(session.id)?.modelOverride ??
    (session.piModeId ? readPiMode(app.getPath('userData'), session.piModeId)?.model : undefined));
  const resolved = isPi ? resolveModel() : undefined;
  const prepared = await prepareAttachments({ userData: app.getPath('userData'), scope: `gui:${session.id}`,
    tools: ctx.config.get().attachmentTools,
    processing: ctx.config.get().attachmentProcessing,
    workerFile: path.join(app.getAppPath(), 'out/main/attachments/worker.mjs'),
    text, attachments, model: resolved?.model, api: resolved?.provider.api || (isPi ? 'openai-completions' : undefined),
    ...(isPi ? {} : { supportsImages: !!getChatCapabilities(session.runtime || '').images }) });
  if (!ctx.sessions.get(session.id)) throw new Error(t('会话已删除'));
  if (resolved && JSON.stringify(resolveModel()) !== JSON.stringify(resolved)) throw new Error(t('附件处理期间模型配置已变化，请重新发送'));
  return prepared;
}
