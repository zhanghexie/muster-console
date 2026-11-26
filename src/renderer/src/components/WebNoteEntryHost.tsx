import React, { useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { updateFileNoteInSession, removeFileNoteFromSession } from '../agentChat/noteBridge';
import { closeWebNoteEdit, readWebNoteEdit, subscribeWebNoteEdit } from './webNoteEntry';
import { useUiStore } from '../store';
import { NoteCardShell } from './NoteCardShell';

/**
 * 网页批注二次编辑卡（App 根部常驻）：输入框胶囊点击（web 锚）弹出——
 * 元素截图 + 元素名/选择器 + 备注输入；保存/删除经 noteBridge editor 通道
 * 回写会话批注（与文件批注二次编辑同款交互）。
 */
export function WebNoteEntryHost(): React.JSX.Element | null {
  const state = useSyncExternalStore(subscribeWebNoteEdit, readWebNoteEdit);
  if (!state) return null;
  return createPortal(<WebNoteEditCard key={state.nonce} state={state} />, document.body);
}

function WebNoteEditCard({ state }: { state: NonNullable<ReturnType<typeof readWebNoteEdit>> }): React.JSX.Element {
  const { t } = useTranslation();
  const { flashTip } = useUiStore();
  const [text, setText] = useState(state.initialNote);


  const save = (value = text): void => {
    const note = value.trim();
    if (!note) return;
    const ok = updateFileNoteInSession(state.sessionId, state.noteId, note);
    flashTip(ok ? t('批注已更新') : t('目标会话已关闭，未保存'));
    closeWebNoteEdit();
  };

  const remove = (): void => {
    const ok = removeFileNoteFromSession(state.sessionId, state.noteId);
    flashTip(ok ? t('批注已删除') : t('目标会话已关闭，未删除'));
    closeWebNoteEdit();
  };

  return (
    <NoteCardShell
      shot={state.web.shot}
      label={state.web.label}
      selector={state.web.selector}
      value={text}
      onValueChange={setText}
      onConfirm={save}
      onDelete={remove}
      edit
      onCancel={closeWebNoteEdit}
      footer={state.web.url}
    />
  );
}
