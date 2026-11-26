import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  encodeWorkerModelMention, hasWorkerModelMentions, workerModelMentions
} from '../../../../shared/workerModelMention';
import type { WorkerRoutingScope, WorkerTargetReference } from '../../../../shared/workerRouting';
import { WORKER_ROUTING_LIMITS } from '../../../../shared/workerRouting';
import type { ComposerEditableHandle } from '../ComposerEditable';
import type { WorkerTargetDialogRequest } from '../workerRouting/WorkerTargetDialog';
import { workerRoutingScopeKey } from '../workerRouting/workerRoutingScope';

interface Edit {
  request: WorkerTargetDialogRequest;
  start: number;
  text: string;
  returnCaret?: number;
  loading?: boolean;
}

/** Shared draft interaction and pre-send check. The transport keeps the original token through host queues. */
export function useComposerModelMention({
  scope, bucket, editableRef, active = true
}: {
  scope?: WorkerRoutingScope;
  bucket?: string | null;
  editableRef: MutableRefObject<ComposerEditableHandle | null>;
  active?: boolean;
}) {
  const { t } = useTranslation();
  const scopeKey = workerRoutingScopeKey(scope);
  const identity = JSON.stringify([scopeKey, bucket, active]);
  const context = useRef(identity);
  context.current = identity;
  const [editor, setEditor] = useState<Edit | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const pending = useRef(false);
  const available = !!scope && active && typeof window.api?.workerRouting?.reference === 'function';

  useEffect(() => {
    generation.current++;
    pending.current = false;
    setEditor(null);
    setError('');
  }, [identity]);

  const close = () => {
    generation.current++;
    setEditor(null);
    editableRef.current?.focus();
    if (editor) editableRef.current?.setCaret(editor.returnCaret ?? editor.start + editor.text.length);
  };

  const open = (start: number, text: string): boolean => {
    if (!scope || !available) return false;
    setError('');
    const existing = workerModelMentions(text)[0]?.mention;
    const operation = ++generation.current;
    const request: WorkerTargetDialogRequest = { scope, ...(existing ? {
      currentRef: existing.targetRef, currentLabel: existing.label, editing: true
    } : {}) };
    if (!existing) {
      setEditor({ request, start, text, returnCaret: editableRef.current?.getCaret() });
      return true;
    }
    setEditor({ request, start, text, loading: true });
    void Promise.resolve().then(() => window.api.workerRouting.validate({ scope, targetRef: existing.targetRef })).then(reference => {
      if (operation !== generation.current || context.current !== identity) return;
      setEditor({ request: { ...request, initial: reference.config }, start, text });
    }).catch(() => {
      if (operation !== generation.current || context.current !== identity) return;
      setEditor({ request: { ...request, stale: true }, start, text });
    });
    return true;
  };

  const apply = (reference: WorkerTargetReference, label: string) => {
    const editable = editableRef.current;
    if (!editable || !editor || context.current !== identity ||
      workerRoutingScopeKey(editor.request.scope) !== scopeKey) return;
    const end = editor.start + editor.text.length;
    if (editable.getText().slice(editor.start, end) !== editor.text) {
      setEditor(null);
      setError(t('草稿已更改，请在当前位置重新插入模型引用。'));
      return;
    }
    editable.replaceRange(editor.start, end, { type: 'model', label,
      serializedText: encodeWorkerModelMention({ targetRef: reference.targetRef, label }), appendSpace: !editor.request.editing });
    setEditor(null);
    setError('');
  };

  const validate = async (text: string): Promise<boolean> => {
    if (!hasWorkerModelMentions(text)) return true;
    if (pending.current) return false;
    const occurrences = workerModelMentions(text);
    if (occurrences.length > WORKER_ROUTING_LIMITS.mentionsPerMessage) {
      setError(t('每条消息最多可包含 {{count}} 个模型引用。', { count: WORKER_ROUTING_LIMITS.mentionsPerMessage }));
      return false;
    }
    pending.current = true;
    setError('');
    try {
      for (const { mention } of new Map(occurrences.map(item => [item.mention.targetRef, item])).values()) {
        try {
          if (!scope) throw new Error(t('工作区源目录不可用'));
          await window.api.workerRouting.validate({ scope, targetRef: mention.targetRef });
        } catch {
          if (context.current === identity) setError(t('模型引用「{{label}}」已失效或无法校验，请点击引用重新选择。', { label: mention.label }));
          return false;
        }
        if (context.current !== identity) return false;
      }
      return true;
    } finally {
      if (context.current === identity) pending.current = false;
    }
  };

  return { available, open, close, apply, validate, error,
    onDraftChange: (text: string) => { if (error && !hasWorkerModelMentions(text)) setError(''); },
    request: active && editor && workerRoutingScopeKey(editor.request.scope) === scopeKey
      ? { ...editor.request, restoring: editor.loading } : null };
}
