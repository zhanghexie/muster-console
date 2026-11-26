import { useEffect, useRef, useState } from 'react';
import type { ClearReplySuggestionsResult, ComposerReplySuggestions } from '../../../../shared/replySuggestions';
import { notifyComposerError } from './composerNotice';
import { t } from '../../../../shared/i18n';

/** Hide immediately, restoring only the clicked snapshot if the host rejects the request. */
export function useReplySuggestions(scope: string, suggestions: ComposerReplySuggestions | null | undefined,
  onClear: ((snapshot: ComposerReplySuggestions) => Promise<ClearReplySuggestionsResult>) | undefined,
  onError: (message: string) => void): {
    visible: ComposerReplySuggestions | null;
    clearing: boolean;
    clear: (snapshot: ComposerReplySuggestions) => Promise<void>;
  } {
  const [hidden, setHidden] = useState<{ scope: string; key: string } | null>(null);
  const [clearing, setClearing] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const keyFor = (value: ComposerReplySuggestions): string => JSON.stringify([value.messageId, value.replies]);
  const visible = suggestions && !(hidden?.scope === scope && hidden.key === keyFor(suggestions)) ? suggestions : null;
  const clear = async (snapshot: ComposerReplySuggestions): Promise<void> => {
    if (!onClear || inFlight.current) return;
    const key = keyFor(snapshot), originalScope = scope;
    inFlight.current = true;
    setClearing(true);
    setHidden({ scope: originalScope, key });
    try {
      const result = await onClear(snapshot);
      if (!result?.ok) throw new Error(result?.error || t('请稍后重试'));
    } catch (error) {
      if (mounted.current) setHidden(previous => previous?.scope === originalScope && previous.key === key ? null : previous);
      const message = t('清除建议失败：{{error}}', { error: error instanceof Error ? error.message : String(error) });
      if (mounted.current && scopeRef.current === originalScope) onError(message);
      else notifyComposerError(message);
    } finally {
      inFlight.current = false;
      if (mounted.current) setClearing(false);
    }
  };
  return { visible, clearing, clear };
}
