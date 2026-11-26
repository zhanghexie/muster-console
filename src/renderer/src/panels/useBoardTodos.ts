import { useEffect, useState } from 'react';
import type { BoardTodo } from '../../../shared/boardTodo';

export function useBoardTodos(): { todos: BoardTodo[]; error: string; loaded: boolean } {
  const [todos, setTodos] = useState<BoardTodo[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = (): void => {
      const generation = ++request;
      void window.api.boardTodos.list().then(items => {
        if (active && generation === request) { setTodos(items); setError(''); setLoaded(true); }
      }).catch(error => {
        if (active && generation === request) setError((error as Error).message || String(error));
      });
    };
    const off = window.api.on('boardTodos:changed', refresh);
    refresh();
    return () => { active = false; off(); };
  }, []);
  return { todos, error, loaded };
}
