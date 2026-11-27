import { desktopTurnGrants } from '../desktop/turnGrant';
import fs from 'node:fs';
import type { AppContext } from '../context';
import { t } from '../../shared/i18n';
import { writeComposerInputFile } from './injectFile';
import { sleep } from './submit';
import type { ChatImageAttachment } from '../../shared/types';
import { hasWorkerModelMentions } from '../../shared/workerModelMention';
import { prepareWorkerModelMentions } from '../tasks/workerRouting';

type PrepareInput = (sessionId: string, text: string, attachments: ChatImageAttachment[]) => Promise<string>;

/** Submit to the captured PTY generation, never to a replacement process. */
export function createCliComposerSubmitter(ctx: AppContext, prepareInput?: PrepareInput): (sessionId: string, text: string, attachments?: ChatImageAttachment[]) => Promise<{ ok: boolean; error?: string; warning?: string; viaFile?: boolean }> {
  const inFlight = new Set<string>();
  return async (sessionId, text, attachments = []) => {
    if (inFlight.has(sessionId)) return { ok: false, error: t('正在发送，请稍候') };
    const session = ctx.sessions.get(sessionId);
    if (!session || session.type !== 'terminal' || session.launchKind === 'shell' ||
        session.archived || ctx.sessions.isChatRuntime(session.runtime)) return { ok: false, error: t('CLI 会话不可用') };
    if (typeof text !== 'string' || !Array.isArray(attachments) || (!text.trim() && !attachments.length)) return { ok: false, error: t('写入内容为空') };
    if (attachments.length && !prepareInput) return { ok: false, error: t('附件处理未就绪') };
    if (session.activity?.kind === 'blocked') return { ok: false, error: t('请先在终端处理当前确认操作') };
    if (!ctx.pty.isRunning(sessionId)) return { ok: false, error: t('终端进程未在运行，可先 sessions.select 拉起') };
    const runtime = session.runtime;
    const suggestionId = session.cliSuggestedReplies?.messageId;
    const writer = ctx.pty.captureWriter(sessionId);
    const sessionCanReceive = () => {
      const current = ctx.sessions.get(sessionId);
      return !!current && current.type === 'terminal' && current.launchKind !== 'shell' && !current.archived &&
        current.runtime === runtime && !ctx.sessions.isChatRuntime(current.runtime) && ctx.pty.isRunning(sessionId);
    };
    inFlight.add(sessionId);
    let written = false;
    let submitted = false;
    let useFile = false;
    try {
      let preparedText = attachments.length ? await prepareInput!(sessionId, text, attachments) : text;
      if (!ctx.sessions.get(sessionId)) return { ok: false, error: t('会话已删除') };
      if (!sessionCanReceive()) return { ok: false, error: t('CLI 会话不可用') };
      const paste = await ctx.sessions.pasteInput(runtime);
      if (hasWorkerModelMentions(text)) {
        const binding = ctx.sessions.getCliWorkspaceContext(sessionId);
        const context = binding?.workspaceContext;
        const workspaceId = context?.workspaceId ?? session.workspaceId;
        if (!workspaceId) return { ok: false, error: 'Worker model reference: the terminal has no bound workspace source.' };
        const checked = await prepareWorkerModelMentions(ctx, { workspaceId, rootId: context?.sourceRootId ?? session.sourceRoot?.rootId,
          rootsRevision: context?.rootsRevision, cwd: session.sourceRoot?.cwd ?? context?.cwd ?? session.cwd,
          capturedSource: session.sourceRoot }, text);
        if (ctx.sessions.getCliWorkspaceContext(sessionId) !== binding)
          return { ok: false, error: 'Worker model reference: the terminal source changed; resend to validate the current source.' };
        // Attachment preparation appends host notes to the original text.
        preparedText = checked + preparedText.slice(text.length);
      }
      if (!sessionCanReceive()) return { ok: false, error: t('CLI 会话不可用') };
      if (ctx.sessions.get(sessionId)?.activity?.kind === 'blocked') return { ok: false, error: t('请先在终端处理当前确认操作') };
      useFile = /[\x00-\x09\x0b-\x1f\x7f]/.test(preparedText) || (!paste && /[\r\n]/.test(preparedText));
      let content = preparedText;
      if (useFile) {
        const prepared = writeComposerInputFile(preparedText);
        content = prepared.promptArg;
        const timer = setTimeout(() => { try { fs.unlinkSync(prepared.file); } catch { /* startup sweep retries */ } }, 24 * 60 * 60_000);
        timer.unref?.();
      }
      const payload = paste ? `\x1b[200~${content}\x1b[201~` : content;
      if (!writer.write(sessionId, payload)) return { ok: false, error: t('写入终端失败：进程未在运行') };
      written = true;
      await sleep(paste ? 500 : 350);
      if (!sessionCanReceive() || ctx.sessions.get(sessionId)?.activity?.kind === 'blocked') return { ok: false, error: t('内容已写入终端，但提交失败；请检查终端后再重试') };
      desktopTurnGrants.nextUserMessage(sessionId);
      if (!writer.write(sessionId, '\r')) return { ok: false, error: t('内容已写入终端，但提交失败；请检查终端后再重试') };
      submitted = true;
      if (suggestionId) ctx.sessions.clearCliSuggestedReplies(sessionId, suggestionId);
      ctx.sessions.touchUsed(sessionId);
      ctx.usage.recordSessionActivity(sessionId, { name: session.name || sessionId, runtime: session.runtime || 'shell', workspaceId: session.workspaceId || '' });
      return { ok: true, viaFile: useFile };
    } catch (error) {
      if (submitted) {
        console.error('CLI composer post-submit bookkeeping failed:', error);
        return { ok: true, viaFile: useFile, warning: t('内容已写入终端并发送回车，但会话状态更新失败') };
      }
      return { ok: false, error: written ? t('内容已写入终端，但提交失败；请检查终端后再重试') : String(error) };
    } finally {
      inFlight.delete(sessionId);
    }
  };
}
