import { randomUuid } from '../../../../shared/randomUuid';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ChatImageAttachment } from '../../../../shared/types';
import { composerAttachmentDraft, isCurrentAttachmentDraft, notifyAttachmentDraft } from '../../composerAttachmentDrafts';
import type { Translate } from './composerHelpers';

/** 图片附件（待发条 + 隐藏 file input 共用）：读文件→dataURL→base64 附件项 */
export function useComposerImages(t: Translate, scope?: string | null, onError?: (message: string) => void, remember = false, seed?: ChatImageAttachment[]): {
  loading: boolean;
  pasteNativeFiles: (requireFiles?: boolean) => void;
  images: ChatImageAttachment[];
  getImages: () => ChatImageAttachment[];
  setImages: Dispatch<SetStateAction<ChatImageAttachment[]>>;
  addImageFiles: (fileList: File[] | FileList) => void;
  removeImage: (id: string) => void;
} {
  const initial = useRef(seed);
  const [images, setImagesState] = useState<ChatImageAttachment[]>(() => remember && scope ? composerAttachmentDraft(scope).images : initial.current ?? []);
  const imagesRef = useRef(images);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const setImages = useCallback<Dispatch<SetStateAction<ChatImageAttachment[]>>>((update) => {
    const draft = remember && scope ? composerAttachmentDraft(scope) : undefined;
    const next = typeof update === 'function' ? update(draft?.images ?? imagesRef.current) : update;
    if (next.length > 32) { onErrorRef.current?.(t('一次最多发送 32 个附件')); return; }
    imagesRef.current = next;
    setImagesState(next);
    if (draft) { draft.images = next; notifyAttachmentDraft(draft); }
  }, [remember, scope, t]);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const pending = useRef(0);
  useEffect(() => {
    generation.current++; pending.current = 0;
    const draft = remember && scope ? composerAttachmentDraft(scope) : undefined;
    const sync = (): void => {
      const next = draft?.images ?? initial.current ?? [];
      imagesRef.current = next; setImagesState(next); setLoading((draft?.pending ?? 0) > 0);
      if (draft?.error) { const error = draft.error; draft.error = undefined; onErrorRef.current?.(error); }
    };
    draft?.listeners.add(sync);
    sync();
    return () => { generation.current++; draft?.listeners.delete(sync); };
  }, [scope, remember]);

  const addImageFiles = useCallback(
    (fileList: File[] | FileList) => {
      const filesArr = Array.from(fileList);
      const gen = generation.current;
      const draft = remember && scope ? composerAttachmentDraft(scope) : undefined;
      const active = (): boolean => draft && scope ? isCurrentAttachmentDraft(scope, draft) : generation.current === gen;
      const report = (message: string): void => {
        if (!active()) return;
        if (draft) { draft.error = message; notifyAttachmentDraft(draft); }
        else onErrorRef.current?.(message);
      };
      const setPending = (change: number): void => {
        if (!active()) return;
        if (draft) { draft.pending += change; notifyAttachmentDraft(draft); }
        else { pending.current += change; setLoading(pending.current > 0); }
      };
      const append = (attachment: ChatImageAttachment): void => {
        if (!active()) return;
        if (draft) { draft.images = [...draft.images, attachment]; notifyAttachmentDraft(draft); }
        else setImages(previous => [...previous, attachment]);
      };
      if (filesArr.length + (draft?.images.length ?? imagesRef.current.length) + (draft?.pending ?? pending.current) > 32) {
        report(t('一次最多发送 32 个附件')); return;
      }
      for (const file of filesArr) {
        if (file.size > 256 * 1024 * 1024) {
          report(`${file.name}: ${t('文件超过 256 MiB')}`);
          continue;
        }
        let sourcePath: string | undefined;
        try { const candidate = window.api?.shell?.pathForFile?.(file); sourcePath = typeof candidate === 'string' && candidate ? candidate : undefined; } catch { /* Web uploads have no native path. */ }
        if (sourcePath && !file.type.startsWith('image/')) {
          append({ id: `file-${randomUuid()}`, sourcePath, data: '',
            mimeType: file.type || 'application/octet-stream', name: file.name || t('文件'), size: file.size });
          continue;
        }
        setPending(1);
        let reader: FileReader;
        try { reader = new FileReader(); }
        catch { setPending(-1); report(`${file.name}: ${t('文件读取失败')}`); continue; }
        reader.onloadend = () => setPending(-1);
        reader.onerror = () => report(`${file.name}: ${t('文件读取失败')}`);
        reader.onload = () => {
          if (!active()) return;
          const result = reader.result as string;
          if (!result) { report(`${file.name}: ${t('文件读取失败')}`); return; }
          const comma = result.indexOf(',');
          const rawBase64 = comma >= 0 ? result.slice(comma + 1) : result;
          const mimeType = file.type || 'application/octet-stream';
          const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          append({
            id,
            data: rawBase64,
            mimeType,
            sourcePath,
            url: mimeType.startsWith('image/') ? result : undefined,
            name: file.name || t('文件'),
            size: file.size
          });
        };
        try { reader.readAsDataURL(file); }
        catch { setPending(-1); report(`${file.name}: ${t('文件读取失败')}`); }
      }
    },
    [t, setImages, remember, scope]
  );

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, [setImages]);
  const pasteNativeFiles = useCallback((requireFiles = false) => {
    const gen = generation.current;
    const draft = remember && scope ? composerAttachmentDraft(scope) : undefined;
    const active = (): boolean => draft && scope ? isCurrentAttachmentDraft(scope, draft) : generation.current === gen;
    const report = (message: string): void => {
      if (!active()) return;
      if (draft) { draft.error = message; notifyAttachmentDraft(draft); }
      else onErrorRef.current?.(message);
    };
    if (draft) { draft.pending++; notifyAttachmentDraft(draft); }
    else { pending.current++; setLoading(true); }
    void Promise.resolve().then(() => window.api.shell.clipboardFiles()).then(files => {
      if (!active()) return;
      if (requireFiles && !files.length) report(t('未能读取系统文件剪贴板，请拖入或选择文件'));
      else if (files.length + (draft?.images.length ?? imagesRef.current.length) + Math.max(0, (draft?.pending ?? pending.current) - 1) > 32)
        report(t('一次最多发送 32 个附件'));
      else if (draft) { draft.images = [...draft.images, ...files]; notifyAttachmentDraft(draft); }
      else setImages(previous => [...previous, ...files]);
    }).catch(error => report((error as Error).message))
      .finally(() => {
        if (!active()) return;
        if (draft) { draft.pending--; notifyAttachmentDraft(draft); }
        else { pending.current--; setLoading(pending.current > 0); }
      });
  }, [remember, scope, setImages, t]);

  return { images, getImages: () => imagesRef.current, setImages, addImageFiles, removeImage, loading, pasteNativeFiles };
}
