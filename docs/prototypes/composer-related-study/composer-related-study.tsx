/** Real question/phrase views, with in-memory demo state and prototype-only styling. */
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { UserQuestionCard } from '../../../src/renderer/src/chatSurface/guiApprovalCards';
import { ComposerQuickInputPanel, type QipEdit } from '../../../src/renderer/src/components/agentComposer/ComposerQuickInputPanel';
import { MOTION, usePresence } from '../../../src/renderer/src/components/motion';
import { filterQuickPhrases, upsertQuickPhrase, type QuickPhrase } from '../../../src/shared/composerTools';
import type { ChatUserQuestionView } from '../../../src/shared/types';

const studyI18n = createInstance();
void studyI18n.init({ lng: 'zh-CN', fallbackLng: false, resources: {}, initAsync: false, interpolation: { escapeValue: false } });
export type StudyQuestionKind = 'single' | 'multi' | 'pages';
export interface StudyNote { quote: string; note: string }

export function StudyAnnotationEditor({ open, value, onSave, onClose, onDelete }: {
  open: boolean; value: StudyNote; onSave: (note: string) => void;
  onClose: () => void; onDelete: () => void;
}) {
  const presence = usePresence(open, MOTION.microMs);
  const shown = useRef(value);
  if (open) shown.current = value;
  const [text, setText] = useState(value.note);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) { setText(value.note); requestAnimationFrame(() => input.current?.focus()); } }, [open, value.note]);
  if (!presence.mounted) return null;
  const save = () => { if (text.trim()) onSave(text.trim()); };
  return <section className="cq-note-study mp-pop" {...presence.spread} aria-label="编辑批注" aria-hidden={presence.stage === 'out'} {...(presence.stage === 'out' ? { inert: '' } : {})}>
    <header><b>批注</b><button aria-label="关闭批注" onClick={onClose}>×</button></header>
    <blockquote>{shown.current.quote}</blockquote>
    <textarea ref={input} aria-label="批注内容" placeholder="写下需要修改的地方…" value={text} onChange={e => setText(e.target.value)} onKeyDown={e => {
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    }}/>
    <footer><button onClick={onDelete}>删除批注</button><span/><button onClick={onClose}>取消</button><button className="cq-note-save" disabled={!text.trim()} onClick={save}>保存批注</button></footer>
  </section>;
}

const appearance = {
  id: 'style', question: '选中项目使用哪种样式？',
  options: [
    { label: '中性纯色', description: '用浅一档的底色区分选中项，保持正文清晰。' },
    { label: '细描边', description: '底色保持一致，只用轮廓标识选中项。' }
  ]
};
const scope = {
  id: 'scope', question: '这次需要检查哪些界面？', multiSelect: true,
  options: [
    { label: '聊天与输入', description: '输入区、建议和排队消息。' },
    { label: '文件阅读', description: '文件预览、文本对比度和选中项。' },
    { label: '侧边导航', description: '工作会话、工作区和实用功能。' }
  ]
};

export function StudyQuestionCard({ kind, onNotice }: { kind: StudyQuestionKind; onNotice: (text: string) => void }) {
  const [card, setCard] = useState<ChatUserQuestionView>(() => ({
    questionId: `study-${kind}`, status: 'pending',
    questions: kind === 'multi' ? [scope] : kind === 'pages' ? [appearance, scope] : [appearance]
  }));
  return <I18nextProvider i18n={studyI18n}><div className="cq-question-study">
    <UserQuestionCard sessionId="design-study" card={card} onRespond={async args => {
      setCard(current => ({ ...current, status: args.action === 'answer' ? 'answered' : 'aborted', answers: args.answers }));
      onNotice(args.action === 'answer' ? '已模拟提交回答，卡片保留回答摘要。' : '已模拟取消作答。');
      return { ok: true };
    }}/>
  </div></I18nextProvider>;
}

const initialPhrases: QuickPhrase[] = [
  { id: 'check', key: '检查效果', value: '检查深浅色主题与窄面板效果，确认没有文字溢出。', ts: 1 },
  { id: 'continue', key: '继续处理', value: '按已确认的方案继续处理，完成后告诉我结果。', ts: 2 },
  { id: 'review', key: '复查改动', value: '复查本轮改动，说明验证结果和仍需确认的问题。', ts: 3 }
];
export interface StudyQuickPhrasesHandle { onKeyDown: (event: React.KeyboardEvent) => void }
interface PhraseProps {
  open: boolean; query: string;
  onInsert: (value: string) => void;
  onClose: () => void;
  focusEditor: () => void;
}

export const StudyQuickPhrases = forwardRef<StudyQuickPhrasesHandle, PhraseProps>(function StudyQuickPhrases({ open, query, onInsert, onClose, focusEditor }, ref) {
  const [phrases, setPhrases] = useState(initialPhrases);
  const [edit, setEdit] = useState<QipEdit | null>(null);
  const [active, setActive] = useState(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const valueRef = useRef<HTMLTextAreaElement | null>(null);
  const presence = usePresence(open, MOTION.microMs);
  const filtered = filterQuickPhrases(phrases, query);
  useEffect(() => { setActive(0); }, [query, open]);
  useEffect(() => { if (!open) setEdit(null); }, [open]);
  useEffect(() => { setActive(index => Math.min(index, Math.max(0, filtered.length - 1))); }, [filtered.length]);
  const save = () => {
    if (!edit || (!edit.key.trim() && !edit.value.trim())) return;
    setPhrases(current => upsertQuickPhrase(current, edit.id, edit.key, edit.value).list);
    setEdit(null); focusEditor();
  };
  const insert = (phrase: QuickPhrase) => onInsert(phrase.value.trim() ? phrase.value : phrase.key);
  useImperativeHandle(ref, () => ({ onKeyDown(event) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (edit) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (filtered.length) setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length);
    } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault(); if (filtered[active]) insert(filtered[active]);
    }
  } }));
  return <I18nextProvider i18n={studyI18n}><div className="cq-phrases-study">
    <ComposerQuickInputPanel presence={presence} qipRef={panelRef} qipEdit={edit} setQipEdit={setEdit}
      qipFiltered={filtered} phrasesCount={phrases.length} qipActive={active} setActive={setActive}
      qipKeyRef={nameRef} qipValueRef={valueRef} onInsert={insert} onSave={save}
      onDelete={id => setPhrases(current => current.filter(phrase => phrase.id !== id))}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEdit(null); focusEditor(); }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
      }}/>
  </div></I18nextProvider>;
});
