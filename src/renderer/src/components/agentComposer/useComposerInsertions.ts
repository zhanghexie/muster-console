import { useCallback, useEffect } from 'react';
import type { Dispatch, DragEvent as ReactDragEvent, MutableRefObject, SetStateAction } from 'react';
import type { ChatImageAttachment } from '../../../../shared/types';
import { dataTransferHasPaths, agentInsertFromDataTransfer, pathsFromDataTransfer } from '../../../../shared/fileDropPaths';
import { useUiStore } from '../../store';
import { setDraft } from '../../composerDrafts';
import type { ComposerEditableHandle, ComposerEditReplay } from '../ComposerEditable';

interface Params {
  allowImages: boolean;
  requireTarget?: boolean;
  onTargetedInsert?: () => void;
  formatPathReferences?: (paths: string[]) => string;
  disabled?: boolean;
  /** 拖到头像/气泡后打开面板时注入的路径文本 */
  pendingInsert?: string | null;
  onPendingInsertConsumed?: () => void;
  draftBucket: string | null;
  valueRef: MutableRefObject<string>;
  applyValue: (next: string) => void;
  setValue: (next: string) => void;
  setHasText: (update: (prev: boolean) => boolean) => void;
  onValueChangeRef: MutableRefObject<((text: string) => void) | undefined>;
  cmdMode: null | 'quickInput';
  refreshMenuFromCaret: (next: string, cursor: number) => void;
  editableRef: MutableRefObject<ComposerEditableHandle | null>;
  addImageFiles: (fileList: File[] | FileList) => void;
  setImages?: Dispatch<SetStateAction<ChatImageAttachment[]>>;
  insertAtCaret: (chunk: string) => void;
  /** 加号面板：插入触发符后顺手收起 */
  setShowPlusMenu: (v: boolean) => void;
}

/** 外部文本进入输入框的全部通道：composerInsert 定向投递（replace/追加）、
 *  pendingInsert 光标处插入、拖放（图片→附件 / 路径→插入）、加号菜单触发符、
 *  以及编辑器 onChange/onCaretMove（触发词菜单刷新、按键不回写的热路径）。 */
export function useComposerInsertions({
  allowImages,
  requireTarget = false,
  onTargetedInsert,
  formatPathReferences,
  disabled,
  pendingInsert,
  onPendingInsertConsumed,
  draftBucket,
  valueRef,
  applyValue,
  setValue,
  setHasText,
  onValueChangeRef,
  cmdMode,
  refreshMenuFromCaret,
  editableRef,
  addImageFiles,
  setImages,
  insertAtCaret,
  setShowPlusMenu
}: Params): {
  insertTriggerChar: (ch: string) => void;
  onEditorChange: (text: string, caret: number, replay?: ComposerEditReplay) => void;
  onEditorCaretMove: (text: string, caret: number) => void;
  onDragOver: (e: ReactDragEvent) => void;
  onDrop: (e: ReactDragEvent) => void;
} {
  const { composerInsert, clearComposerInsert } = useUiStore();

  /** 在光标处插入触发符（自动补空格，保证 findTrigger 认账并弹出候选面板） */
  const insertTriggerChar = useCallback(
    (ch: string): void => {
      const ed = editableRef.current;
      if (!ed) return;
      const pos = ed.getCaret();
      const before = ed.getText().slice(0, pos);
      const needsSpace = before.length > 0 && !/\s$/.test(before);
      ed.focus();
      ed.insertText(`${needsSpace ? ' ' : ''}${ch}`);
      setShowPlusMenu(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  useEffect(() => {
    if (!composerInsert) return;
    // 定向投递（target=会话草稿桶）：只由目标 composer 消费，其余挂载实例跳过不清槽
    if ((requireTarget && !composerInsert.target) || (composerInsert.target && composerInsert.target !== draftBucket)) return;
    if (composerInsert.target) onTargetedInsert?.();
    const chunk = composerInsert.text;
    const prev = valueRef.current;
    // replace（R-20 建议回复点击）：整框替换草稿；缺省仍是追加（划词插入原行为）
    if (chunk || composerInsert.replace) {
      const next =
        composerInsert.replace || !prev.trim().length
          ? chunk
          : `${prev.replace(/\s+$/, '')}\n${chunk}`;
      applyValue(next);
    }
    if (composerInsert.images?.length && setImages) {
      const nextImgs = composerInsert.images.map((im, i) => ({
        ...im,
        id: im.id || `img-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        data: im.data,
        mimeType: im.mimeType,
        ...(im.name ? { name: im.name } : {}),
        ...(typeof im.size === 'number' ? { size: im.size } : {}),
        url: im.url || `data:${im.mimeType};base64,${im.data}`
      }));
      setImages((previous) => [
        ...previous,
        ...nextImgs.filter((image) => !previous.some((old) => old.id === image.id))
      ]);
    }
    clearComposerInsert();
    requestAnimationFrame(() => {
      const ed = editableRef.current;
      if (!ed) return;
      ed.focus();
      ed.setCaret(ed.getText().length);
    });
  }, [composerInsert, clearComposerInsert, draftBucket, applyValue, setImages, requireTarget, onTargetedInsert]);

  useEffect(() => {
    if (!pendingInsert || disabled) return;
    insertAtCaret(pendingInsert);
    onPendingInsertConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingInsert, disabled]);

  const onDragOver = (e: ReactDragEvent): void => {
    if (!dataTransferHasPaths(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (e: ReactDragEvent): void => {
    if (disabled) { e.preventDefault(); return; }
    if (allowImages) {
      const rawFiles = Array.from(e.dataTransfer.files || []);
      const imgFiles = rawFiles;
      if (imgFiles.length > 0) {
        e.preventDefault();
        addImageFiles(imgFiles);
        return;
      }
    }
    if (!dataTransferHasPaths(e.dataTransfer)) return;
    e.preventDefault();
    const getPath = window.api?.shell?.pathForFile;
    const readPath = typeof getPath === 'function' ? (f: File) => getPath(f) : () => '';
    const paths = formatPathReferences ? pathsFromDataTransfer(e.dataTransfer, readPath) : [];
    const insert = paths.length && formatPathReferences ? formatPathReferences(paths)
      : agentInsertFromDataTransfer(e.dataTransfer, readPath);
    if (!insert) return;
    insertAtCaret(insert);
  };

  const onEditorChange = useCallback(
    (text: string, caret: number, replay?: ComposerEditReplay): void => {
      valueRef.current = text;
      if (draftBucket) setDraft(draftBucket, text);
      setHasText((prev) => {
        const next = text.trim().length > 0;
        return prev === next ? prev : next;
      });
      // 命令态搜索框依赖 value 过滤；普通打字不回写，避免整棵 Composer 每击重渲
      if (cmdMode) setValue(text);
      onValueChangeRef.current?.(text);
      if (!cmdMode && replay !== 'composition') refreshMenuFromCaret(text, caret);
    },
    [draftBucket, cmdMode, refreshMenuFromCaret]
  );

  /** 点击/方向键移动光标：刷新触发词菜单（对齐旧 textarea 的 onSelect） */
  const onEditorCaretMove = useCallback(
    (text: string, caret: number): void => {
      if (!cmdMode) refreshMenuFromCaret(text, caret);
    },
    [cmdMode, refreshMenuFromCaret]
  );

  return { insertTriggerChar, onEditorChange, onEditorCaretMove, onDragOver, onDrop };
}
