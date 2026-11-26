/**
 * 手机端 pty 会话处置面（T5.6）：无终端、无审批卡，只有回复框 → sendMessage 存信。
 * 审批仍在桌面（pty 确认框走 ui:confirm 全局弹层，本组件不承接工具审批）。
 */
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppLogo } from '../components/AppLogo';

export function MobilePtyReply(props: { sessionId: string }): React.JSX.Element {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const submit = useCallback(async (): Promise<void> => {
    const task = text.trim();
    if (!task || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await window.api.sessions.sendMessage({ sessionId: props.sessionId, text: task });
      if (!res.ok) {
        setNote(res.message);
        return;
      }
      setText('');
      setNote(t('已保存到会话信箱，空闲后读取'));
    } catch (e) {
      setNote((e as Error).message || t('发送失败'));
    } finally {
      setBusy(false);
    }
  }, [busy, props.sessionId, t, text]);

  return (
    <div className="ma-pty-reply">
      <div className="empty-hint chat-welcome">
        <div className="empty-logo" aria-hidden>
          <AppLogo size={40} />
        </div>
        {t('终端会话请在电脑端看输出；这里可以回复 Worker（存信后等空闲读取）。审批请在电脑端操作。')}
      </div>
      {note ? (
        <div className="ma-pty-reply-note" role="status">
          {note}
        </div>
      ) : null}
      <div className="ma-pty-reply-bar">
        <textarea
          className="ma-pty-reply-input"
          rows={3}
          value={text}
          disabled={busy}
          placeholder={t('回复 Worker…')}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          className="ma-pty-reply-send"
          disabled={busy || !text.trim()}
          onClick={() => void submit()}
        >
          {busy ? t('发送中…') : t('发送')}
        </button>
      </div>
    </div>
  );
}
