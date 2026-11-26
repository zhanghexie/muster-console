import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { HarnessModelSelections } from '../../../shared/harnessModelSelection';

/** Only reads saved preferences. It never starts model discovery. */
export function useHarnessModelSelections(active = true): {
  selections: HarnessModelSelections;
  setSelections: (value: HarnessModelSelections) => void;
  error: string;
  ready: boolean;
  revision: MutableRefObject<number>;
} {
  const [selections, setSelections] = useState<HarnessModelSelections>({});
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const revisionRef = useRef(0);
  useEffect(() => {
    if (!active) { setReady(false); return; }
    let live = true, revision = 0;
    setReady(false);
    const off = window.api.on('agentSession:harnessModelSelectionsChanged', ({ selections: value }) => {
      revision++;
      revisionRef.current++;
      setSelections(value);
      setError('');
      setReady(true);
    });
    const captured = revision;
    void window.api.agentSession.getHarnessModelSelections().then(value => {
      if (live && revision === captured) { setSelections(value); setError(''); setReady(true); }
    }).catch(cause => { if (live && revision === captured) setError((cause as Error).message || String(cause)); });
    return () => { live = false; off(); };
  }, [active]);
  return { selections, setSelections, error, ready, revision: revisionRef };
}
