import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { DRAFT_CHANGE_EVENT, getDraft, setDraft } from '../../composerDrafts';
import type { ComposerEditableHandle } from '../ComposerEditable';

interface Params {
  draftBucket: string | null;
  initialText?: string;
  editableRef: MutableRefObject<ComposerEditableHandle | null>;
  onValueChange?: (text: string) => void;
}

/** 草稿持久化：挂载/切区时读入；外部（拖拽）改动经事件同步；
 *  echoValue（=applyValue）是所有「外部写入输入框」的统一回灌口。 */
export function useComposerDraft({
  draftBucket, initialText,
  editableRef,
  onValueChange
}: Params): {
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  valueRef: MutableRefObject<string>;
  hasText: boolean;
  setHasText: Dispatch<SetStateAction<boolean>>;
  onValueChangeRef: MutableRefObject<Params['onValueChange']>;
  echoValue: (next: string) => void;
  applyValue: (next: string) => void;
} {
  const [value, setValue] = useState('');
  /** 当前草稿的实时读口：按键不回写 value state，避免整棵 Composer 每击重渲 */
  const valueRef = useRef('');
  const [hasText, setHasText] = useState(false);
  const onValueChangeRef = useRef(onValueChange);
  onValueChangeRef.current = onValueChange;

  const echoValue = useCallback(
    (next: string): void => {
      valueRef.current = next;
      setValue(next);
      setHasText(next.trim().length > 0);
      if (draftBucket) setDraft(draftBucket, next);
      onValueChangeRef.current?.(next);
      // value state 可能已是 next（按键不回写），React bail 不会触发重建——命令式对齐 DOM
      editableRef.current?.setText(next);
    },
    [draftBucket]
  );

  const seed = useRef(initialText);
  useEffect(() => {
    echoValue(draftBucket ? getDraft(draftBucket) : seed.current ?? '');
  }, [draftBucket, echoValue]);

  useEffect(() => {
    const onDraftChange = (e: Event): void => {
      const detail = (e as CustomEvent<{ workspaceId: string; text: string }>).detail;
      if (!detail || detail.workspaceId !== draftBucket) return;
      echoValue(detail.text);
    };
    window.addEventListener(DRAFT_CHANGE_EVENT, onDraftChange);
    return () => window.removeEventListener(DRAFT_CHANGE_EVENT, onDraftChange);
  }, [draftBucket, echoValue]);

  const applyValue = echoValue;
  return { value, setValue, valueRef, hasText, setHasText, onValueChangeRef, echoValue, applyValue };
}
