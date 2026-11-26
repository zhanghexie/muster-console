/**
 * 会话批注编排（壳侧宿主逻辑）：对 AI 回复划词批注 → 待定锚点 + 录入气泡；
 * 确认后 token（批注N）进输入框草稿，发送时由 expandForSend 展开成原文+批注；
 * 删除（气泡或输入框 token 对账）双向同步摘锚点与文件标记。
 * 文件批注（file-editor 区划词）锚在工作区文件上，展开带路径+行号+所选内容。
 * GUI = AgentChatView（draftKey 缺省 agent-session:<id>）；
 * 调度 = AgentFloat（必须传 caps.draftKey = workspaceId）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  expandNoteTokens,
  makeNoteToken,
  noteTokensInText,
  replaceNoteTokens,
  nextNoteSeq,
  stripNoteToken,
  stripOrphanNoteTokens,
  type QueuedNoteDraft,
  type NoteAnnotationCore
} from '../../../shared/noteAnnotations';
import { getDraft, appendDraft, replaceDraft } from '../composerDrafts';
import {
  PENDING_NOTE_ID,
  promoteNoteAnchor,
  unwrapNoteAnchor,
  wrapNoteAnchor
} from '../agentChat/noteAnchors';
import {
  registerChatNoteHandler,
  registerFileNoteEditor,
  registerFileNoteTarget,
  registerWebNoteTarget,
  type ChatNoteRequest,
  type FileNoteDelivery,
  type WebNoteDelivery
} from '../agentChat/noteBridge';
import { removeFileNoteMark } from '../components/fileNoteMarks';
import { openFileNoteEdit, putFileNoteRecord, removeFileNoteRecord } from '../components/fileNoteEntry';
import { openWebNoteEdit } from '../components/webNoteEntry';
import type { TranscriptNote } from './ChatTranscript';
import { revealNoteInView } from './noteEntries';

/** 会话批注：messageId 锚 AI 回复；文件批注锚在工作区文件上 */
interface ChatNote {
  id: string;
  seq: number;
  quote: string;
  note: string;
  /** 会话批注的消息锚点；文件批注为空串 */
  messageId: string;
  /** 文件批注：来源路径与显式根身份（行号在 md/html 预览态拿不到时缺省） */
  file?: NoteAnnotationCore['file'];
  /** 网页批注：锚点=内置浏览器拾取的元素（quote=label；shot=元素区域截图） */
  web?: { label: string; selector: string; url: string; shot?: string };
}

const CLI_NOTE_KEY = 'muster.cli-notes.v1:';
const CLI_TERMINAL_MESSAGE = 'cli-terminal-selection';

function loadCliNotes(sessionId: string): ChatNote[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CLI_NOTE_KEY + sessionId) || '[]');
    return Array.isArray(value) ? value.filter((n): n is ChatNote =>
      !!n && typeof n.id === 'string' && typeof n.seq === 'number' &&
      typeof n.quote === 'string' && typeof n.note === 'string' && typeof n.messageId === 'string') : [];
  } catch { return []; }
}

export interface SessionNotesHost {
  notes: TranscriptNote[];
  pendingNote: { quote: string; messageId: string; span: HTMLElement } | null;
  onNoteUpdate: (id: string, note: string) => void;
  onNoteDelete: (id: string) => void;
  onPendingConfirm: (note: string) => void;
  onPendingCancel: () => void;
  /** 输入框批注 token（批注N）：渲染成可点药丸 */
  tokens: Array<{ id: string; token: string; title: string; label?: string }>;
  onTokenClick: (id: string) => void;
  onTokenDelete: (id: string) => void;
  /** 与转写角标/操作行共用的打开态（输入框药丸也走这里） */
  openNoteId: string | null;
  onOpenNote: (id: string | null) => void;
  /** 输入框全文对账（token 删除联动） */
  onValueChange: (text: string) => void;
  /** 发送前展开 token（批注N → 原文+批注） */
  expandForSend: (text: string) => string;
  prepareManualDraft?: (text: string) => { text: string; noteDraft?: QueuedNoteDraft };
  restoreManualDraft?: (draft: QueuedNoteDraft) => string;
  addTerminalNote?: (quote: string, note: string) => void;
}

export function useSessionNotes(args: {
  sessionId: string;
  /**
   * 草稿桶。缺省 `agent-session:${sessionId}`（GUI）。
   * 调度面必须传 caps.draftKey（工作区 id），否则 token 写进错误桶、输入框看不见。
   */
  draftKey?: string;
  /** CLI 草稿在视图卸载/重启后仍能恢复批注及其引用。 */
  persistDraftNotes?: boolean;
  /** 消息角色查询（批注只允许 AI 回复；壳经 surface 快照提供） */
  getMessageRole: (messageId: string) => 'user' | 'assistant' | undefined;
  /** 会话视图容器（批注跳转按锚点查询） */
  viewRef: React.RefObject<HTMLElement | null>;
  flashTip: (text: string) => void;
  /** 打开工作区文件（文件批注药丸回跳文件面板） */
  requestOpenWorkspaceFile: (args: { path: string; fileRef?: import('../../../shared/types').WorkspaceFileRef; line?: number; col?: number }) => void;
}): SessionNotesHost {
  const { sessionId, viewRef, flashTip, requestOpenWorkspaceFile } = args;
  const { t } = useTranslation();
  const [chatNotes, setChatNotes] = useState<ChatNote[]>(() => args.persistDraftNotes ? loadCliNotes(sessionId) : []);
  const chatNotesRef = useRef(chatNotes);
  chatNotesRef.current = chatNotes;
  /** 三入口共用：打开了哪条批注的查看/编辑气泡 */
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  /** 录入中的批注：span=已包裹的待定锚点（转正或撤销）；卡片由转写层贴着文字渲染 */
  const [noteDraft, setNoteDraft] = useState<{
    quote: string;
    messageId: string;
    span: HTMLElement;
  } | null>(null);
  const noteDraftRef = useRef(noteDraft);
  noteDraftRef.current = noteDraft;
  const noteDraftBucket = args.draftKey ?? (sessionId ? `agent-session:${sessionId}` : '');

  useEffect(() => {
    if (!args.persistDraftNotes || !sessionId) return;
    try {
      if (chatNotes.length) localStorage.setItem(CLI_NOTE_KEY + sessionId, JSON.stringify(chatNotes));
      else localStorage.removeItem(CLI_NOTE_KEY + sessionId);
    } catch { flashTip(t('批注无法保存到本地，请检查存储空间')); }
  }, [args.persistDraftNotes, chatNotes, flashTip, sessionId, t]);

  useEffect(() => {
    if (!args.persistDraftNotes) return;
    for (const n of chatNotesRef.current) {
      if (n.file) putFileNoteRecord({ noteId: n.id, seq: n.seq, quote: n.quote, note: n.note,
        path: n.file.path, fileRef: n.file.fileRef, line: n.file.line ?? null, endLine: n.file.endLine ?? null, sessionId });
    }
  }, [args.persistDraftNotes, sessionId]);

  const cancelNote = useCallback((): void => {
    if (noteDraftRef.current) unwrapNoteAnchor(PENDING_NOTE_ID);
    setNoteDraft(null);
  }, []);

  // ── 划词「批注」→ 待定锚点 + 文字旁录入卡片；确认后 token 进输入框；
  // 发送时展开，删除（卡片或输入框里删 token）双向同步摘锚点 ──
  const handleNoteRequest = useCallback(
    (req: ChatNoteRequest): void => {
      // role 双源：消息快照（snap.messages）查不到时回落 DOM 的 data-role——
      // 快照与转写渲染偶发失配时批注不至于整体失灵（提示还会被 flashTip 静默吞掉）
      const domRole = (() => {
        const el =
          req.range.startContainer instanceof Element
            ? req.range.startContainer
            : req.range.startContainer.parentElement;
        const role = el?.closest<HTMLElement>('[data-mid]')?.getAttribute('data-role');
        return role === 'assistant' || role === 'user' ? role : undefined;
      })();
      const role = args.getMessageRole(req.messageId) ?? domRole;
      if (role !== 'assistant') {
        flashTip(t('只能批注 AI 的回复'));
        return;
      }
      if (noteDraftRef.current) cancelNote();
      const span = wrapNoteAnchor(req.range, PENDING_NOTE_ID);
      if (!span) {
        flashTip(t('该选区无法批注（选区内没有文本）'));
        return;
      }
      setNoteDraft({ quote: req.quote, messageId: req.messageId, span });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getMessageRole 由壳保证引用稳定
    [sessionId, cancelNote, flashTip, t]
  );


  const confirmNote = useCallback(
    (note: string): void => {
      const draft = noteDraftRef.current;
      if (!draft || !note) return;
      const seq = nextNoteSeq(chatNotesRef.current.map((n) => n.seq));
      const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      // 跨块选区会产生多个同 id 片段，转正按待定 id 全量回填
      promoteNoteAnchor(PENDING_NOTE_ID, id);
      // 先提交批注表再 appendDraft：草稿事件会同步 rebuild，表若还是旧的，
      // 新「批注N」会落成纯文本（汇总条最后一颗点不动）。
      flushSync(() => {
        setChatNotes((prev) => [
          ...prev,
          { id, seq, quote: draft.quote, note, messageId: draft.messageId }
        ]);
      });
      const token = makeNoteToken(seq);
      const cur = getDraft(noteDraftBucket);
      // 原子胶囊（composer contenteditable 改造）自带 margin，单空格分隔即可
      appendDraft(noteDraftBucket, cur.trim().length ? ` ${token}` : token);
      setNoteDraft(null);
    },
    [noteDraftBucket]
  );

  const addTerminalNote = useCallback((quote: string, note: string): void => {
    if (!quote.trim() || !note.trim()) return;
    const seq = nextNoteSeq(chatNotesRef.current.map(n => n.seq));
    const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    flushSync(() => setChatNotes(prev => [...prev, { id, seq, quote, note, messageId: CLI_TERMINAL_MESSAGE }]));
    const token = makeNoteToken(seq);
    const cur = getDraft(noteDraftBucket);
    appendDraft(noteDraftBucket, cur.trim().length ? ` ${token}` : token);
  }, [noteDraftBucket]);

  const updateNote = useCallback((id: string, note: string): void => {
    setChatNotes((prev) => prev.map((n) => (n.id === id ? { ...n, note } : n)));
  }, []);

  const deleteNote = useCallback(
    (id: string) => {
      const note = chatNotesRef.current.find((n) => n.id === id);
      if (!note) return;
      unwrapNoteAnchor(id);
      removeFileNoteMark(id);
      removeFileNoteRecord(id);
      setChatNotes((prev) => prev.filter((n) => n.id !== id));
      const token = makeNoteToken(note.seq);
      const cur = getDraft(noteDraftBucket);
      if (cur.includes(token)) replaceDraft(noteDraftBucket, stripNoteToken(cur, token));
    },
    [noteDraftBucket]
  );

  /** 待定锚点被清（消息重渲/会话清空）时自动收场 */
  useEffect(() => {
    if (!noteDraft) return;
    let raf = 0;
    const tick = (): void => {
      if (!noteDraft.span.isConnected) {
        cancelNote();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [noteDraft, cancelNote]);

  /** 输入框全文对账：token 被手动删掉（或随发送清空）→ 批注与锚点一并摘除
   *  （token 是原子胶囊，backspace 整颗删；文本对账仍按 token 是否还在全文里判定） */
  const reconcileNotes = useCallback(
    (text: string): void => {
      const tokens = new Set(noteTokensInText(text));
      const dead = chatNotesRef.current.filter((n) => !tokens.has(makeNoteToken(n.seq)));
      if (dead.length === 0) return;
      setChatNotes((prev) => prev.filter((n) => !dead.some((d) => d.id === n.id)));
      for (const d of dead) {
        unwrapNoteAnchor(d.id);
        removeFileNoteMark(d.id);
        removeFileNoteRecord(d.id);
      }
    },
    []
  );

  const jumpToNote = useCallback(
    (id: string): void => {
      const note = chatNotesRef.current.find((n) => n.id === id);
      if (note?.file) {
        // 文件批注：药丸点击回跳文件面板对应行
        requestOpenWorkspaceFile({
          path: note.file.path,
          ...(note.file.fileRef ? { fileRef: note.file.fileRef } : {}),
          line: note.file.line ?? undefined
        });
        openFileNoteEdit(note.id);
        return;
      }
      if (note?.web) {
        // 网页批注：药丸点击弹二次编辑卡（元素截图+改/删）
        openWebNoteEdit({
          sessionId,
          noteId: note.id,
          web: { label: note.web.label, selector: note.web.selector, url: note.web.url, shot: note.web.shot ?? '' },
          initialNote: note.note
        });
        return;
      }
      setOpenNoteId(id);
      revealNoteInView(viewRef.current, { noteId: id, messageId: note?.messageId });
    },
    [viewRef, requestOpenWorkspaceFile, sessionId]
  );

  const noteTokens = useMemo(
    () =>
      chatNotes.map((n) => ({
        id: n.id,
        token: makeNoteToken(n.seq),
        label: `${t('批注')} · ${n.note}`,
        title: n.file
          ? `${n.file.path}${n.file.line != null ? `:${n.file.line}` : ''}\n“${n.quote}”${
              n.note ? `\n${n.note}` : ''
            }`
          : n.web
            ? `${n.web.label}\n${n.web.selector}${n.note ? `\n${n.note}` : ''}`
            : `“${n.quote}”\n${n.note}`
      })),
    [chatNotes, t]
  );

  // 划词桥注册：handler 经 ref 转发，拿到每渲染的最新状态
  const noteRequestRef = useRef<(req: ChatNoteRequest) => void>(() => {});
  noteRequestRef.current = handleNoteRequest;
  useEffect(() => {
    if (!sessionId) return;
    registerChatNoteHandler(sessionId, (req) => noteRequestRef.current(req));
    return () => registerChatNoteHandler(sessionId, null);
  }, [sessionId]);

  // 文件批注接收端：file-editor 区划词「批注」经录入框确认后投递（带批注文字与
  // 批注 id，id 供文件内标记回填）；返回分配的序号给录入框做提示；同经 ref 转发
  const fileNoteRef = useRef<(p: FileNoteDelivery) => number>(() => 0);
  fileNoteRef.current = (p) => {
    const seq = nextNoteSeq(chatNotesRef.current.map((n) => n.seq));
    flushSync(() => {
      setChatNotes((prev) => [
        ...prev,
        {
          id: p.noteId,
          seq,
          quote: p.quote,
          note: p.note,
          messageId: '',
          file: {
            path: p.path,
            ...(p.fileRef ? { fileRef: p.fileRef } : {}),
            ...(p.line != null ? { line: p.line } : {}),
            ...(p.endLine != null ? { endLine: p.endLine } : {})
          }
        }
      ]);
    });
    const token = makeNoteToken(seq);
    const cur = getDraft(noteDraftBucket);
    // 原子胶囊（composer contenteditable 改造）自带 margin，单空格分隔即可
    appendDraft(noteDraftBucket, cur.trim().length ? ` ${token}` : token);
    return seq;
  };
  useEffect(() => {
    if (!sessionId) return;
    registerFileNoteTarget(sessionId, (p) => fileNoteRef.current(p));
    return () => registerFileNoteTarget(sessionId, null);
  }, [sessionId]);

  // 网页批注接收端（内置浏览器元素备注）：同款 token/药丸，锚在网页元素
  const webNoteRef = useRef<(p: WebNoteDelivery) => number>(() => 0);
  webNoteRef.current = (p) => {
    const seq = nextNoteSeq(chatNotesRef.current.map((n) => n.seq));
    flushSync(() => {
      setChatNotes((prev) => [
        ...prev,
        {
          id: p.noteId,
          seq,
          quote: p.label,
          note: p.note,
          messageId: '',
          web: { label: p.label, selector: p.selector, url: p.url, ...(p.shot ? { shot: p.shot } : {}) }
        }
      ]);
    });
    const token = makeNoteToken(seq);
    const cur = getDraft(noteDraftBucket);
    // 原子胶囊（composer contenteditable 改造）自带 margin，单空格分隔即可
    appendDraft(noteDraftBucket, cur.trim().length ? ` ${token}` : token);
    return seq;
  };
  useEffect(() => {
    if (!sessionId) return;
    registerWebNoteTarget(sessionId, (p) => webNoteRef.current(p));
    return () => registerWebNoteTarget(sessionId, null);
  }, [sessionId]);

  // 文件批注角标的二次编辑路由：更新正文 / 删除批注（连带 token 与文件内标记）
  useEffect(() => {
    if (!sessionId) return;
    registerFileNoteEditor(sessionId, {
      update: (id, note) => {
        if (!chatNotesRef.current.some((n) => n.id === id)) return false;
        updateNote(id, note);
        return true;
      },
      remove: (id) => {
        if (!chatNotesRef.current.some((n) => n.id === id)) return false;
        deleteNote(id);
        return true;
      }
    });
    return () => registerFileNoteEditor(sessionId, null);
  }, [sessionId, updateNote, deleteNote]);

  // 已删批注：收起它的气泡（输入框 token 对账 / 🗑 都会走这里）
  useEffect(() => {
    if (openNoteId && !chatNotes.some((n) => n.id === openNoteId)) {
      setOpenNoteId(null);
    }
  }, [chatNotes, openNoteId]);

  // 切换会话：未完成的录入卡片收场，待定锚点还原；孤儿批注 token 摘除
  // （批注是内存态，草稿桶持久化——重启后 token 指向的批注已不存在）
  useEffect(() => {
    if (!sessionId) return;
    if (noteDraftRef.current) unwrapNoteAnchor(PENDING_NOTE_ID);
    setNoteDraft(null);
    setOpenNoteId(null);
    const cur = getDraft(noteDraftBucket);
    const cleaned = stripOrphanNoteTokens(cur, args.persistDraftNotes ? chatNotesRef.current.map(n => n.seq) : []);
    if (cleaned !== cur) replaceDraft(noteDraftBucket, cleaned);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 切会话时按当时空批注表清孤儿
  }, [sessionId]);
  useEffect(() => () => unwrapNoteAnchor(PENDING_NOTE_ID), []);

  const expandForSend = useCallback(
    (text: string): string =>
      expandNoteTokens(
        text,
        chatNotesRef.current.map((n) => ({
          seq: n.seq,
          quote: n.quote,
          note: n.note,
          file: n.file,
          web: n.web
        }))
      ),
    []
  );

  const prepareManualDraft = useCallback((text: string) => {
    const tokens = new Set(noteTokensInText(text));
    const notes = chatNotesRef.current.filter(n => tokens.has(makeNoteToken(n.seq)));
    return {
      text: expandNoteTokens(text, notes),
      ...(notes.length ? { noteDraft: structuredClone({ text, notes }) } : {})
    };
  }, []);

  const restoreManualDraft = useCallback((draft: QueuedNoteDraft): string => {
    // 输入框可能已有新批注；重新编号并分配 id，不能让旧「批注1」指向新批注。
    let seq = nextNoteSeq(chatNotesRef.current.map(n => n.seq));
    const remap = new Map<string, string>();
    const restored = draft.notes.map(n => {
      const next = { ...structuredClone(n), seq: seq++,
        id: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}` };
      remap.set(makeNoteToken(n.seq), makeNoteToken(next.seq));
      return next;
    });
    // 表先就位，再由 composer 合并草稿：token 镜像与全文对账均需读到新记录。
    flushSync(() => setChatNotes(prev => [...prev, ...restored]));
    for (const n of restored) {
      if (n.file) putFileNoteRecord({
        noteId: n.id, seq: n.seq, quote: n.quote, note: n.note,
        path: n.file.path, fileRef: n.file.fileRef, line: n.file.line ?? null, endLine: n.file.endLine ?? null, sessionId
      });
    }
    return replaceNoteTokens(draft.text, token => remap.get(token) ?? token);
  }, [sessionId]);

  return useMemo(
    () => ({
      notes: chatNotes,
      pendingNote: noteDraft,
      onNoteUpdate: updateNote,
      onNoteDelete: deleteNote,
      onPendingConfirm: confirmNote,
      onPendingCancel: cancelNote,
      tokens: noteTokens,
      onTokenClick: jumpToNote,
      onTokenDelete: deleteNote,
      openNoteId,
      onOpenNote: setOpenNoteId,
      onValueChange: reconcileNotes,
      expandForSend,
      prepareManualDraft,
      restoreManualDraft,
      addTerminalNote
    }),
    [
      chatNotes,
      noteDraft,
      updateNote,
      deleteNote,
      confirmNote,
      cancelNote,
      noteTokens,
      jumpToNote,
      openNoteId,
      reconcileNotes,
      expandForSend,
      prepareManualDraft,
      restoreManualDraft,
      addTerminalNote
    ]
  );
}
