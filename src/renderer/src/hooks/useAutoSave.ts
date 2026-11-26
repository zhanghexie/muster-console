import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../../../shared/i18n';

export type AutoSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const DEBOUNCE_MS = 600;

/**
 * 防抖自动保存：输入后 600ms 写盘；flush 取消防抖并立即写入。
 */
export function useAutoSave({
  path,
  identity,
  getContent,
  write
}: {
  path: string | null;
  /** 稳定文件身份；相同相对路径在不同源根中必须不同。 */
  identity?: string | null;
  getContent: () => string;
  write: (path: string, content: string) => Promise<{ ok: boolean; error?: string }>;
}): {
  status: AutoSaveStatus;
  error: string | null;
  flush: () => Promise<void>;
  onChange: () => void;
  markPristine: () => void;
  /** 是否有未写盘的本地修改（外部修改监听用它决定静默刷新还是提示冲突） */
  isDirty: () => boolean;
  /** Includes the currently writing generation until its disk write has completed. */
  hasUnsavedChanges: () => boolean;
} {
  const [status, setStatus] = useState<AutoSaveStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const writingRef = useRef<Promise<void> | null>(null);
  const writingGenerationRef = useRef<number | null>(null);
  const pathRef = useRef(path);
  const getContentRef = useRef(getContent);
  const writeRef = useRef(write);
  const identityRef = useRef(identity ?? path);
  const generationRef = useRef(0);

  pathRef.current = path;
  getContentRef.current = getContent;
  writeRef.current = write;
  if (identityRef.current !== (identity ?? path)) generationRef.current += 1;
  identityRef.current = identity ?? path;

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const runWrite = useCallback(async (): Promise<void> => {
    const p = pathRef.current;
    if (!p || !dirtyRef.current) return;

    const content = getContentRef.current();
    const generation = generationRef.current;
    const writeAtStart = writeRef.current;
    dirtyRef.current = false;
    setStatus('saving');
    setError(null);

    const job = (async () => {
      let res: { ok: boolean; error?: string };
      try { res = await writeAtStart(p, content); }
      catch (err) { res = { ok: false, error: err instanceof Error ? err.message : String(err) }; }
      if (generationRef.current !== generation) return;
      // 写盘期间又有编辑则保持 dirty，由后续 debounce/flush 再写
      if (!res.ok) {
        dirtyRef.current = true;
        setStatus('error');
        setError(res.error ?? t('保存失败'));
        return;
      }
      if (dirtyRef.current) {
        setStatus('idle');
        return;
      }
      setStatus('saved');
    })();

    writingRef.current = job;
    writingGenerationRef.current = generation;
    try {
      await job;
    } finally {
      if (writingRef.current === job) { writingRef.current = null; writingGenerationRef.current = null; }
    }
  }, []);

  const flush = useCallback(async (): Promise<void> => {
    clearTimer();
    if (writingRef.current) await writingRef.current;
    if (dirtyRef.current) await runWrite();
  }, [clearTimer, runWrite]);

  const onChange = useCallback(() => {
    dirtyRef.current = true;
    setStatus('idle');
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void runWrite();
    }, DEBOUNCE_MS);
  }, [clearTimer, runWrite]);

  const markPristine = useCallback(() => {
    clearTimer();
    dirtyRef.current = false;
    setStatus('idle');
    setError(null);
  }, [clearTimer]);

  const isDirty = useCallback(() => dirtyRef.current, []);
  const hasUnsavedChanges = useCallback(() => dirtyRef.current ||
    (writingRef.current !== null && writingGenerationRef.current === generationRef.current), []);

  // 换文件时丢弃旧路径的待写定时器（调用方应先 flush）
  useEffect(() => {
    clearTimer();
    dirtyRef.current = false;
    setStatus('idle');
    setError(null);
  }, [identity ?? path, clearTimer]);

  useEffect(
    () => () => {
      clearTimer();
    },
    [clearTimer]
  );

  return { status, error, flush, onChange, markPristine, isDirty, hasUnsavedChanges };
}
