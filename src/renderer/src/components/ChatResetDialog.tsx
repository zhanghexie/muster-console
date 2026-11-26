import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { ChatSurface } from '../../../shared/chatSurface';
import { useChatSurfaceSnapshot } from '../chatSurface/ChatSurfaceView';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { usePresenceValue } from './motion';
import { appendDraft, getDraft } from '../composerDrafts';

// Registered as chat.reset-memory-request; only fills a draft, never sends it.
export const RESET_MEMORY_PROMPT = '我准备重置当前会话。请先回顾本次对话，用当前可用的记忆能力记录有依据、今后仍有价值的信息，例如已确认的偏好、重要决策、持续约束和可复用经验；避免重复保存、临时流水和未经确认的推测。请实际完成记录后说明保存了什么；如果没有值得保存的信息，或记录失败，请如实说明。不要重置或清空会话，等我自行确认。';

export type ChatResetTarget = { workspaceId: string; purpose: 'dispatch' | 'memory' | 'safety'; surface: ChatSurface };

export function ChatResetDialog({ target, onClose, onReset }: { target: ChatResetTarget | null; onClose: () => void; onReset?: () => void }): React.JSX.Element | null {
  const { t } = useTranslation();
  const { presence, value: request } = usePresenceValue(target);
  const snapshot = useChatSurfaceSnapshot(target?.surface ?? null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef(target); latest.current = target;
  const inFlight = useRef<ChatResetTarget | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setError(''); setPending(false);
    if (!target) return;
    const previous = document.activeElement;
    cancelRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, [target]);
  const cancel = () => { if (target && inFlight.current !== target) onClose(); };
  useOverlayDismiss(Boolean(target), cancel);
  const execute = async (action: 'remember' | 'reset') => {
    const selected = target;
    if (!selected || inFlight.current === selected || (selected.purpose !== 'safety' && selected.surface.getSnapshot().busy)) return;
    inFlight.current = selected; setPending(true); setError('');
    try {
      if (action === 'remember') {
        const draftKey = selected.surface.caps.draftKey;
        appendDraft(draftKey, `${getDraft(draftKey) ? '\n\n' : ''}${RESET_MEMORY_PROMPT}`);
      } else {
        await selected.surface.actions.clear();
        if (latest.current === selected) onReset?.();
      }
      if (latest.current === selected) onClose();
    } catch (reason) {
      if (latest.current === selected) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (inFlight.current === selected) inFlight.current = null;
      if (latest.current === selected) setPending(false);
    }
  };
  if (!presence.mounted || !request) return null;
  const safety = request.purpose === 'safety';
  const disabled = !target || pending || (!safety && snapshot.busy);
  return createPortal(<div className="modal-mask app-confirm-mask mp-scrim" data-overlay-root {...presence.spread}>
    <div className="modal confirm-modal chat-reset-modal mp-panel" {...presence.spread} role="dialog" aria-modal="true"
      aria-labelledby="chat-reset-title" aria-describedby="chat-reset-description" aria-busy={pending}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        if (!buttons.length) { event.preventDefault(); return; }
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <div className="modal-head"><h3 id="chat-reset-title">{safety ? t('重置审批会话？') : request.purpose === 'memory' ? t('重置记忆会话？') : t('重置调度会话？')}</h3></div>
      <div className="confirm-body" id="chat-reset-description">
        {safety ? <>
          <p>{t('重置会停止当前工作区的审批处理，取消尚未完成的审批，清空对话并开始新会话。')}</p>
          <p>{t('保留放行规则和审批事项记录。需要继续的事项须从原操作入口重新提交。')}</p>
        </> : <>
        <p>{t('重置会清空当前对话并开始新会话，不会删除已保存的记忆。')}</p>
        <p>{t('重置前，可以先让模型把本次对话中有价值的信息记录到记忆里。点击“填入记忆提示词”只会把提示词放入输入框，保留已有草稿，由你检查后发送。不会自动重置。')}</p>
        {snapshot.busy && <p role="status">{t('模型正在处理，请等待完成后再操作。')}</p>}
        </>}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="modal-actions">
        <button ref={cancelRef} type="button" className="btn" disabled={!target || pending} onClick={cancel}>{t('取消')}</button>
        {!safety && <button type="button" className="btn" disabled={disabled} onClick={() => { void execute('remember'); }}>{t('填入记忆提示词')}</button>}
        <button type="button" className="btn danger" disabled={disabled} onClick={() => { void execute('reset'); }}>{t('确认重置')}</button>
      </div>
    </div>
  </div>, document.body);
}
