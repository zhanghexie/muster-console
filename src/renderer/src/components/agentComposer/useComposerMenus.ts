import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { usePresence, MOTION } from '../motion';
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick';
import { useOverlayDismiss } from '../../keybindings/KeybindingHost';
import type { ComposerPreset, ComposerPresetItem } from './composerTypes';

/** 底部栏弹出菜单群（加号/模型/参数/模式/用量）的开关状态、presence、外部点击关闭
 *  与 preset roster 现拉。打开即拉最新 roster（创造模式随时可能落盘新模式，不做缓存）。 */
export function useComposerMenus(preset: ComposerPreset | undefined, separatePreset = false): {
  showModelMenu: boolean;
  setShowModelMenu: (v: boolean) => void;
  toggleModelMenu: () => void;
  modelMenuPresence: ReturnType<typeof usePresence>;
  modelMenuRef: MutableRefObject<HTMLDivElement | null>;
  modelPopupRef: MutableRefObject<HTMLDivElement | null>;
  showPlusMenu: boolean;
  setShowPlusMenu: Dispatch<SetStateAction<boolean>>;
  plusMenuPresence: ReturnType<typeof usePresence>;
  plusMenuRef: MutableRefObject<HTMLDivElement | null>;
  plusPopupRef: MutableRefObject<HTMLDivElement | null>;
  showModeMenu: boolean;
  setShowModeMenu: Dispatch<SetStateAction<boolean>>;
  modeMenuPresence: ReturnType<typeof usePresence>;
  modeMenuRef: MutableRefObject<HTMLDivElement | null>;
  modePopupRef: MutableRefObject<HTMLDivElement | null>;
  showPresetMenu: boolean;
  setShowPresetMenu: Dispatch<SetStateAction<boolean>>;
  presetMenuPresence: ReturnType<typeof usePresence>;
  presetMenuRef: MutableRefObject<HTMLDivElement | null>;
  showCtxMenu: boolean;
  setShowCtxMenu: Dispatch<SetStateAction<boolean>>;
  ctxMenuPresence: ReturnType<typeof usePresence>;
  ctxMenuRef: MutableRefObject<HTMLDivElement | null>;
  presetRoster: ComposerPresetItem[] | null;
  presetError: boolean;
} {
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [showPresetMenu, setShowPresetMenu] = useState(false);
  const [showCtxMenu, setShowCtxMenu] = useState(false);
  const [presetRoster, setPresetRoster] = useState<ComposerPresetItem[] | null>(null);
  const [presetError, setPresetError] = useState(false);
  const modelMenuPresence = usePresence(showModelMenu, MOTION.menuMs);
  const plusMenuPresence = usePresence(showPlusMenu, MOTION.menuMs);
  const modeMenuPresence = usePresence(showModeMenu, MOTION.menuMs);
  const presetMenuPresence = usePresence(showPresetMenu, MOTION.menuMs);
  const ctxMenuPresence = usePresence(showCtxMenu, MOTION.menuMs);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const modePopupRef = useRef<HTMLDivElement>(null);
  const modeOutsideRefs = useMemo(() => [modeMenuRef, modePopupRef], []);
  const presetMenuRef = useRef<HTMLDivElement>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modelPopupRef = useRef<HTMLDivElement>(null);
  const modelOutsideRefs = useMemo(() => [modelMenuRef, modelPopupRef], []);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const plusPopupRef = useRef<HTMLDivElement>(null);
  const plusOutsideRefs = useMemo(() => [plusMenuRef, plusPopupRef], []);

  const toggleModelMenu = useCallback((): void => {
    setShowModelMenu((prev) => !prev);
  }, []);

  // 加号面板：点外部关闭（mousedown，先于按钮 click 吞掉切换）
  useDismissOnOutsideClick(showPlusMenu, plusOutsideRefs, () => setShowPlusMenu(false));
  useOverlayDismiss(showPlusMenu, () => setShowPlusMenu(false));

  useDismissOnOutsideClick(showModelMenu, modelOutsideRefs, () => setShowModelMenu(false));
  useOverlayDismiss(showModelMenu, () => {
    setShowModelMenu(false);
    modelMenuRef.current?.querySelector<HTMLButtonElement>('.agent-composer-model-trigger')?.focus({ preventScroll: true });
  });


  useDismissOnOutsideClick(showModeMenu, modeOutsideRefs, () => setShowModeMenu(false));
  useOverlayDismiss(showModeMenu, () => {
    setShowModeMenu(false);
    modeMenuRef.current?.querySelector('button')?.focus({ preventScroll: true });
  });
  useDismissOnOutsideClick(showPresetMenu, presetMenuRef, () => setShowPresetMenu(false));
  useOverlayDismiss(showPresetMenu, () => setShowPresetMenu(false));

  useDismissOnOutsideClick(showCtxMenu, ctxMenuRef, () => setShowCtxMenu(false));

  // 模式菜单：打开即拉最新 roster（创造模式随时可能落盘新模式，不做缓存）。
  // loadRoster 经 ref 取用：preset 对象每渲染都是新引用，进 deps 会造成拉取→重渲→再拉循环。
  const loadRosterRef = useRef(preset?.loadRoster);
  loadRosterRef.current = preset?.loadRoster;
  useEffect(() => {
    if (!(separatePreset ? showPresetMenu : showModeMenu) || !preset) return;
    let alive = true;
    loadRosterRef
      .current?.()
      .then((roster) => {
        if (alive) { setPresetRoster(roster); setPresetError(roster === null); }
      })
      .catch((error) => {
        console.warn('模式列表读取失败', error);
        if (alive) { setPresetRoster([]); setPresetError(true); }
      });
    return () => {
      alive = false;
    };
  }, [showModeMenu, showPresetMenu, separatePreset, preset?.id]);

  // 胶囊名解析：挂载/换选即拉一次 roster（菜单未开过也要显示中文名而非裸 id）
  useEffect(() => {
    if (!preset) return;
    let alive = true;
    loadRosterRef
      .current?.()
      .then((roster) => {
        if (alive) { setPresetRoster(roster); setPresetError(roster === null); }
      })
      .catch((error) => {
        console.warn('模式列表读取失败', error);
        if (alive) { setPresetRoster([]); setPresetError(true); }
      });
    return () => {
      alive = false;
    };
  }, [preset?.id]);

  return {
    showModelMenu,
    setShowModelMenu,
    toggleModelMenu,
    modelMenuPresence,
    modelMenuRef,
    modelPopupRef,
    showPlusMenu,
    setShowPlusMenu,
    plusMenuPresence,
    plusMenuRef,
    plusPopupRef,
    showModeMenu,
    setShowModeMenu,
    modeMenuPresence,
    modeMenuRef,
    modePopupRef,
    showPresetMenu,
    setShowPresetMenu,
    presetMenuPresence,
    presetMenuRef,
    showCtxMenu,
    setShowCtxMenu,
    ctxMenuPresence,
    ctxMenuRef,
    presetRoster,
    presetError
  };
}
