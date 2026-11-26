import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useSessionStore, useUiStore } from '../store';
import {
  deliverFileNote,
  removeFileNoteFromSession,
  updateFileNoteInSession
} from '../agentChat/noteBridge';
import { expandNoteToken } from '../../../shared/noteAnnotations';
import { getTerminalPaste } from '../terminalRegistry';
import { cancelFileNoteMark, confirmFileNoteMark, removeFileNoteMark } from './fileNoteMarks';
import {
  closeFileNoteEntry,
  getFileNoteRecord,
  putFileNoteRecord,
  readFileNoteEntry,
  removeFileNoteRecord,
  subscribeFileNoteEntry,
  type FileNoteEntryState
} from './fileNoteEntry';
import { usePresence, MOTION } from './motion';
import { NoteEditor } from './NoteEditor';

const CARD_W = 420;
const CARD_H = 260;
const EDGE = 8;
const GAP = 8;

/**
 * 文件批注录入框宿主（App 根部常驻，浮条收起后卡片独立存活）：
 * - create：贴划词浮条上方弹出（放不下翻下方、左右夹回视口），Ctrl+Enter/保存 存、Esc/点外取消；
 *   GUI 和 CLI Agent 会话写入工作台批注 token；普通 Shell 回退到终端粘贴。
 * - edit：点文件内计数角标弹出，预填原批注；保存回写记录与会话批注，🗑 删除
 *   连带会话批注 token 与文件内标记一并摘除。
 */
export function FileNoteEntryHost(): React.JSX.Element | null {
  const state = useSyncExternalStore(subscribeFileNoteEntry, readFileNoteEntry);
  if (!state) return null;
  return createPortal(
    <FileNoteEntryCard key={state.nonce} state={state} />,
    document.body
  );
}

function FileNoteEntryCard({ state }: { state: FileNoteEntryState }): React.JSX.Element {
  const { t } = useTranslation();
  const { flashTip } = useUiStore();
  const { sessions } = useSessionStore();
  const edit = state.mode === 'edit';
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const presence = usePresence(true, MOTION.menuMs);
  /** 已确认过的标记在卸载清理里不再撤销（仅 create 待定标记需要） */
  const settledRef = useRef(false);

  // 定位：create 优先浮条上方，放不下翻下方；edit 无锚点，屏幕居中偏上。左右夹回视口
  useLayoutEffect(() => {
    const place = (): void => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = cardRef.current?.offsetWidth || Math.min(CARD_W, vw - EDGE * 2);
      const h = cardRef.current?.offsetHeight || CARD_H;
      const a = state.anchor;
      let top = a ? a.top - h - GAP : Math.round(vh * 0.3);
      if (a && top < EDGE) top = a.bottom + GAP;
      setPos({ top: Math.max(EDGE, Math.min(top, vh - h - EDGE)),
        left: Math.max(EDGE, Math.min(a?.left ?? (vw - w) / 2, vw - w - EDGE)) });
    };
    place();
    const observer = new ResizeObserver(place);
    if (cardRef.current) observer.observe(cardRef.current);
    window.addEventListener('resize', place);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); };
  }, [state.anchor]);

  const cancel = (): void => closeFileNoteEntry();

  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest('[data-file-note-entry]')) return;
      // edit 卡片允许点其他角标换目标（角标自己的 click 会重开），不在此收场
      if (edit && t?.closest('.msg-note-badge')) return;
      cancel();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      // 未确认即收场（Esc/点外/换目标）：摘掉文件内待定标记
      if (!edit && !settledRef.current && state.capture.markKey) {
        cancelFileNoteMark(state.capture.markKey);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载/卸载时生效
  }, []);

  const submit = (text: string): void => {
    const note = text.trim();
    if (!note) return;
    const noteId =
      state.noteId ?? `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    if (edit) {
      const rec = state.noteId ? getFileNoteRecord(state.noteId) : undefined;
      if (rec) {
        rec.note = note;
        if (rec.sessionId) updateFileNoteInSession(rec.sessionId, rec.noteId, note);
        flashTip(t('批注已更新'));
      }
      settledRef.current = true;
      closeFileNoteEntry();
      return;
    }
    const { kind, id, name } = state.target!;
    const seq = deliverFileNote(id, { ...state.capture, note, noteId });
    const isShell = sessions.find(session => session.id === id)?.launchKind === 'shell';
    if (kind === 'chat' || !isShell || seq != null) {
      if (seq == null) {
        flashTip(t('该会话暂时无法接收批注'));
        return;
      }
      if (state.capture.markKey) confirmFileNoteMark(state.capture.markKey, noteId, seq);
      putFileNoteRecord({
        noteId,
        seq,
        quote: state.capture.quote,
        path: state.capture.path,
        ...(state.capture.fileRef ? { fileRef: state.capture.fileRef } : {}),
        line: state.capture.line,
        endLine: state.capture.endLine,
        note,
        sessionId: id
      });
      flashTip(t('批注{{seq}} 已加入会话「{{name}}」输入框', { seq, name }));
    } else {
      // 普通 Shell：展开成完整引用直接粘贴进终端输入（用户自行回车发送）
      const expanded = expandNoteToken({
        seq: 0,
        quote: state.capture.quote,
        note,
        file: {
          path: state.capture.path,
          ...(state.capture.fileRef ? { fileRef: state.capture.fileRef } : {}),
          ...(state.capture.line != null ? { line: state.capture.line } : {}),
          ...(state.capture.endLine != null ? { endLine: state.capture.endLine } : {})
        }
      });
      const paste = getTerminalPaste(id);
      if (!paste) {
        flashTip(t('终端输入未就绪，无法粘贴批注'));
        return;
      }
      paste.paste(expanded);
      if (state.capture.markKey) confirmFileNoteMark(state.capture.markKey, noteId);
      putFileNoteRecord({
        noteId,
        seq: 0,
        quote: state.capture.quote,
        path: state.capture.path,
        ...(state.capture.fileRef ? { fileRef: state.capture.fileRef } : {}),
        line: state.capture.line,
        endLine: state.capture.endLine,
        note
      });
      flashTip(t('批注已粘贴到「{{name}}」输入，回车发送', { name }));
    }
    settledRef.current = true;
    closeFileNoteEntry();
  };

  const remove = (): void => {
    if (state.noteId) {
      const rec = getFileNoteRecord(state.noteId);
      // 会话侧删除成功时已连带摘文件内标记；路由失败（会话重挂等批注已不在）
      // 则在文件侧兜底摘除，避免留下无主标记
      const routed = rec?.sessionId
        ? removeFileNoteFromSession(rec.sessionId, state.noteId)
        : false;
      if (!routed) removeFileNoteMark(state.noteId);
      removeFileNoteRecord(state.noteId);
    }
    settledRef.current = true;
    closeFileNoteEntry();
  };

  const loc =
    state.capture.line != null
      ? `${state.capture.path}:${state.capture.line}${
          state.capture.endLine != null ? `-${state.capture.endLine}` : ''
        }`
      : state.capture.path;

  return (
    <div
      ref={cardRef}
      className="msg-note-bubble is-fixed mp-pop"
      data-file-note-entry
      data-overlay-root
      data-mp-stage={presence.stage}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
    >
      <NoteEditor initial={state.initialNote ?? ''} edit={edit}
        source={<span title={loc}>{loc}</span>}
        onSave={submit} onCancel={cancel} onDelete={edit ? remove : undefined}/>

    </div>
  );
}
