import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  eventToChord,
  findConflicts,
  formatChordSerialized,
  getKeybindingAction,
  resolveAllBindings,
  resolveBinding,
  serializeChord,
  type KeybindingOverrides,
  type KeybindingSearchRow
} from '../../../shared/keybindings';
import { closeTopOverlay, getSetupInteractionLock, overlayDepth, popOverlay, pushOverlay } from './overlayStack';
import { t } from '../../../shared/i18n';
import { resolveCtrlFSurface } from './findSurface';

type Handler = () => void;

interface KeybindingContextValue {
  overrides: KeybindingOverrides;
  rows: KeybindingSearchRow[];
  conflicts: Map<string, string[]>;
  recording: boolean;
  setRecording: (v: boolean) => void;
  resolvedChord: (id: string) => string | null;
  register: (id: string, handler: Handler) => () => void;
  /** handler 注册/注销计数：命令面板用来刷新灰色态 */
  handlerEpoch: number;
  isActionRegistered: (id: string) => boolean;
  runAction: (id: string) => boolean;
  setOverride: (id: string, serialized: string | null) => Promise<void>;
  resetOverride: (id: string) => Promise<void>;
}

const KeybindingContext = createContext<KeybindingContextValue | null>(null);

export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  if (target.closest('.cm-editor, [contenteditable="true"]')) return true;
  return false;
}

export function isTerminalTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('.xterm, .terminal-wrap, .xterm-helper-textarea'));
}

/** 把焦点从 xterm 挪到 sink，之后 notTyping 快捷键不再被终端吃掉。点终端可再激活。 */
export function releaseTerminalFocus(sink?: HTMLElement | null): boolean {
  const el = document.activeElement;
  const inTerm = el instanceof HTMLElement && isTerminalTarget(el);
  if (inTerm) el.blur();
  sink?.focus();
  return inTerm;
}

function shouldFire(
  when: string,
  target: EventTarget | null,
  registered: boolean
): boolean {
  if (!registered) return false;
  if (when === 'always') return true;
  const typing = isTextEntryTarget(target);
  const terminal = isTerminalTarget(target);
  if (when === 'filesPanel') {
    return resolveCtrlFSurface(target) === 'files';
  }
  if (when === 'chatFind') {
    if (target instanceof HTMLElement && target.closest('.chat-find-bar, .find-float-bar')) {
      return true;
    }
    if (typing || terminal) return false;
    return resolveCtrlFSurface(target) === 'chat';
  }
  if (when === 'sideTools') return !typing;
  // notTyping
  if (typing || terminal) return false;
  return true;
}

export function KeybindingProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [overrides, setOverrides] = useState<KeybindingOverrides>({});
  const [recording, setRecording] = useState(false);
  const [handlerEpoch, setHandlerEpoch] = useState(0);
  const handlersRef = useRef(new Map<string, Handler>());
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;

  useEffect(() => {
    void window.api.config.get().then((c) => {
      setOverrides(c.keybindings ?? {});
    });
  }, []);

  const persist = useCallback(async (next: KeybindingOverrides): Promise<void> => {
    const prev = overridesRef.current;
    setOverrides(next);
    try {
      await window.api.config.update({ keybindings: next });
    } catch (e) {
      // keybindings F-03：落盘失败回滚 UI 状态——避免「界面显示新绑定、磁盘仍旧值」
      // 的静默漂移（重启回退旧绑定无解释）；错误上抛由设置页内联提示
      setOverrides(prev);
      throw e;
    }
  }, []);

  const register = useCallback((id: string, handler: Handler): (() => void) => {
    handlersRef.current.set(id, handler);
    setHandlerEpoch((n) => n + 1);
    return () => {
      if (handlersRef.current.get(id) === handler) {
        handlersRef.current.delete(id);
        setHandlerEpoch((n) => n + 1);
      }
    };
  }, []);

  const isActionRegistered = useCallback(
    (id: string): boolean => handlersRef.current.has(id),
    [handlerEpoch]
  );

  const runAction = useCallback((id: string): boolean => {
    const handler = handlersRef.current.get(id);
    if (!handler) return false;
    handler();
    return true;
  }, []);

  const setOverride = useCallback(
    async (id: string, serialized: string | null): Promise<void> => {
      const action = getKeybindingAction(id);
      if (!action) return;
      const next: KeybindingOverrides = { ...overridesRef.current };
      if (serialized === action.defaultChord) delete next[id];
      else next[id] = serialized;
      await persist(next);
    },
    [persist]
  );

  const resetOverride = useCallback(
    async (id: string): Promise<void> => {
      const next: KeybindingOverrides = { ...overridesRef.current };
      delete next[id];
      await persist(next);
    },
    [persist]
  );

  const rows = useMemo(() => resolveAllBindings(overrides), [overrides]);
  const conflicts = useMemo(() => findConflicts(overrides), [overrides]);

  const resolvedChord = useCallback(
    (id: string): string | null => resolveBinding(id, overrides),
    [overrides]
  );

  const value = useMemo(
    (): KeybindingContextValue => ({
      overrides,
      rows,
      conflicts,
      recording,
      setRecording,
      resolvedChord,
      register,
      handlerEpoch,
      isActionRegistered,
      runAction,
      setOverride,
      resetOverride
    }),
    [
      overrides,
      rows,
      conflicts,
      recording,
      resolvedChord,
      register,
      handlerEpoch,
      isActionRegistered,
      runAction,
      setOverride,
      resetOverride
    ]
  );

  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (recordingRef.current) return;
      if (ev.defaultPrevented) return;
      const chord = eventToChord(ev);
      if (!chord) return;
      const serialized = serializeChord(chord);
      const ov = overridesRef.current;
      const setupLock = getSetupInteractionLock();

      const overlayChord = resolveBinding('overlay.close', ov);
      if (overlayChord === serialized) {
        if (setupLock) return;
        // The UA must consume Escape in a customizable picker before our parent
        // overlay. Preventing its default here would leave the picker open.
        if (typeof CSS !== 'undefined' && CSS.supports('appearance', 'base-select')
          && document.querySelector('select.c-select-native:open')) return;
        if (overlayDepth() === 0) return;
        // IME 合成期 Esc 是取消候选，不能关浮层（查找条/输入框主场景）
        if (ev.isComposing || ev.keyCode === 229) return;
        ev.preventDefault();
        ev.stopPropagation();
        closeTopOverlay();
        return;
      }

      for (const row of resolveAllBindings(ov)) {
        if (row.id === 'overlay.close') continue;
        if (row.chord !== serialized) continue;
        const action = getKeybindingAction(row.id);
        if (!action) continue;
        const handler = handlersRef.current.get(row.id);
        if (!shouldFire(action.when, ev.target, !!handler)) continue;
        ev.preventDefault();
        ev.stopPropagation();
        if (setupLock && (row.id !== 'globalBoard.toggle' || setupLock.dataset.setupAllowBoard !== 'true')) return;
        handler!();
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return <KeybindingContext.Provider value={value}>{children}</KeybindingContext.Provider>;
}

export function useKeybindings(): KeybindingContextValue {
  const ctx = useContext(KeybindingContext);
  if (!ctx) throw new Error(t('useKeybindings 需在 KeybindingProvider 内'));
  return ctx;
}

/** 可选：未挂 Provider 时（测试/孤立渲染）当 no-op */
export function useKeybindingsOptional(): KeybindingContextValue | null {
  return useContext(KeybindingContext);
}

export function useKeybinding(id: string, handler: Handler, enabled = true): void {
  const ctx = useContext(KeybindingContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const register = ctx?.register;
  useEffect(() => {
    if (!enabled || !register) return;
    return register(id, () => handlerRef.current());
  }, [register, id, enabled]);
}

export function useOverlayDismiss(open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const id = pushOverlay(() => closeRef.current());
    return () => popOverlay(id);
  }, [open]);
}

export function KeyChordHint({
  actionId,
  className
}: {
  actionId: string;
  className?: string;
}): React.JSX.Element | null {
  const ctx = useContext(KeybindingContext);
  const chord = ctx ? ctx.resolvedChord(actionId) : resolveBinding(actionId);
  const label = formatChordSerialized(chord, navigator.platform);
  if (!label) return null;
  return <span className={className ? `kbd-hint ${className}` : 'kbd-hint'}>{label}</span>;
}

export function useChordLabel(actionId: string): string {
  const ctx = useContext(KeybindingContext);
  return formatChordSerialized(
    ctx ? ctx.resolvedChord(actionId) : resolveBinding(actionId),
    navigator.platform
  );
}
