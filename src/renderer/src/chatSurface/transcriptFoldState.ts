import { useCallback, useLayoutEffect, useState, type SetStateAction } from 'react';

// Only explicit expansion choices survive virtual row unmounts. Never retain
// message bodies or tool results here. Closing a fold releases its entry.
const expanded = new Map<string, Set<string>>();
const SESSION_LIMIT = 64;
const TURN_LIMIT = 256;

function remember(session: string | undefined, message: string, open: boolean): void {
  if (!session) return;
  const turns = expanded.get(session) ?? new Set<string>();
  turns.delete(message);
  if (open) turns.add(message);
  while (turns.size > TURN_LIMIT) turns.delete(turns.values().next().value!);
  expanded.delete(session);
  if (turns.size) expanded.set(session, turns);
  while (expanded.size > SESSION_LIMIT) expanded.delete(expanded.keys().next().value!);
}

export function useTranscriptFoldState(session: string | undefined, message: string) {
  const [open, setOpen] = useState(() => !!session && !!expanded.get(session)?.has(message));
  useLayoutEffect(() => { setOpen(!!session && !!expanded.get(session)?.has(message)); }, [session, message]);
  const update = useCallback((value: SetStateAction<boolean>) => {
    setOpen(current => {
      const next = typeof value === 'function' ? value(current) : value;
      remember(session, message, next);
      return next;
    });
  }, [session, message]);
  return [open, update] as const;
}
