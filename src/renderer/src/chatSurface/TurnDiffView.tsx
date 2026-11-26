import { BrandLoading } from '../components/BrandLoader';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TurnChangeTarget } from '../../../shared/turnChanges';
import { turnChangeDisplayText } from '../turnChangeDisplay';

const FileDiffView = lazy(() => import('../panels/FileDiffView').then(m => ({ default: m.FileDiffView })));

/** Mounted on demand; stale responses never replace a newly selected file. */
export function TurnDiffView({ target, file, onError }: { target: TurnChangeTarget; file: string; onError?: () => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState({ diff: '', error: '', loading: true });
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  useEffect(() => {
    let live = true;
    setState({ diff: '', error: '', loading: true });
    window.api.turnChanges.diff(target, file).then(result => {
      if (live) {
        setState({ diff: result.diff ?? '', error: result.ok ? '' : result.error ?? t('无法读取本轮 Diff'), loading: false });
        if (!result.ok) onErrorRef.current?.();
      }
    }).catch(error => { if (live) { setState({ diff: '', error: String(error), loading: false }); onErrorRef.current?.(); } });
    return () => { live = false; };
  }, [target.kind, target.id, target.messageId, file, t]);
  return state.error ? <p className="turn-changes-note" role="alert">{turnChangeDisplayText(state.error, t)}</p> : state.loading ? <p className="turn-changes-note" role="status"><BrandLoading>{t('正在读取 Diff…')}</BrandLoading></p> :
    <Suspense fallback={<p role="status"><BrandLoading>{t('正在读取 Diff…')}</BrandLoading></p>}><FileDiffView diffText={state.diff}/></Suspense>;
}
