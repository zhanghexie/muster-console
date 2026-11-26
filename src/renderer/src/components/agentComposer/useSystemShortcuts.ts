import { useEffect, useRef, useState } from 'react';
import { t } from '../../../../shared/i18n';
import { normalizeSystemShortcuts, type SystemShortcut } from '../../../../shared/systemShortcuts';
import { MOTION } from '../motion';

export function useSystemShortcuts(open: boolean, close: () => void) {
  const [items, setItems] = useState<SystemShortcut[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void window.api.config.get().then(config => {
      if (alive) setItems(normalizeSystemShortcuts(config.systemShortcuts));
    }).catch(e => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [open]);
  const run = async (id: string): Promise<void> => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); close();
    try {
      // Let the existing menu exit transition finish before a screenshot can be taken.
      await new Promise<void>(resolve => setTimeout(resolve, MOTION.exitMs + MOTION.microMs));
      const result = await window.api.app.runSystemShortcut(id);
      if (!result.ok) setError(result.error || t('系统快捷键发送失败'));
    } catch (e) { setError(String(e)); }
    finally { lock.current = false; setBusy(false); }
  };
  return { items, error, busy, run };
}
