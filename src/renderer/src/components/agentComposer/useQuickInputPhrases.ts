import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, MutableRefObject, SetStateAction } from 'react';
import { usePresence, MOTION } from '../motion';
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick';
import { useOverlayDismiss } from '../../keybindings/KeybindingHost';
import {
  filterQuickPhrases,
  parseQuickPhrases,
  serializeQuickPhrases,
  upsertQuickPhrase,
  type QuickPhrase
} from '../../../../shared/composerTools';
import { PHRASES_STORE_KEY, type MenuKind } from './composerHelpers';
import type { ComposerEditableHandle } from '../ComposerEditable';

interface Params {
  /** 命令态下输入框全文即搜索词（普通态恒为 ''） */
  value: string;
  applyValue: (next: string) => void;
  setMenu: (menu: MenuKind) => void;
  editableRef: MutableRefObject<ComposerEditableHandle | null>;
}

/** /quickInput 命令激活态：命令以 chip 形式留在输入框内，主输入框直接充当搜索框
 *  （不再有面板内搜索框），功能完成或取消后 chip 消失。快捷短语全局共用一份存储。 */
export function useQuickInputPhrases({
  value,
  applyValue,
  setMenu,
  editableRef
}: Params): {
  cmdMode: null | 'quickInput';
  qipOpen: boolean;
  qipPresence: ReturnType<typeof usePresence>;
  phrases: QuickPhrase[];
  setPhrases: Dispatch<SetStateAction<QuickPhrase[]>>;
  qipEdit: { id: string | null; key: string; value: string } | null;
  setQipEdit: Dispatch<SetStateAction<{ id: string | null; key: string; value: string } | null>>;
  qipFiltered: QuickPhrase[];
  qipActive: number;
  setQipActive: Dispatch<SetStateAction<number>>;
  composerRef: MutableRefObject<HTMLDivElement | null>;
  qipRef: MutableRefObject<HTMLDivElement | null>;
  qipKeyRef: MutableRefObject<HTMLInputElement | null>;
  qipValueRef: MutableRefObject<HTMLTextAreaElement | null>;
  enterCmdMode: (kind: 'quickInput') => void;
  exitCmdMode: (keepValue?: boolean) => void;
  insertPhrase: (p: QuickPhrase) => void;
  savePhrase: () => void;
  onQipKeyDown: (e: ReactKeyboardEvent) => void;
} {
  const [cmdMode, setCmdMode] = useState<null | 'quickInput'>(null);
  const [phrases, setPhrases] = useState<QuickPhrase[]>([]);
  const [qipActive, setQipActive] = useState(0);
  /** 编辑态：id null=新增，否则改这条；null=列表模式 */
  const [qipEdit, setQipEdit] = useState<{ id: string | null; key: string; value: string } | null>(
    null
  );
  const qipOpen = cmdMode === 'quickInput';
  const qipPresence = usePresence(qipOpen, MOTION.menuMs);
  const composerRef = useRef<HTMLDivElement>(null);
  const qipRef = useRef<HTMLDivElement>(null);
  const qipKeyRef = useRef<HTMLInputElement>(null);
  const qipValueRef = useRef<HTMLTextAreaElement>(null);
  const outsideRefs = useMemo(() => [composerRef, qipRef], []);
  const phrasesLoadedRef = useRef(false);

  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(PHRASES_STORE_KEY);
    } catch {
      /* ignore */
    }
    phrasesLoadedRef.current = true;
    setPhrases(parseQuickPhrases(raw));
  }, []);

  useEffect(() => {
    if (!phrasesLoadedRef.current) return;
    try {
      localStorage.setItem(PHRASES_STORE_KEY, serializeQuickPhrases(phrases));
    } catch {
      /* ignore */
    }
  }, [phrases]);

  // 主输入框即搜索框：命令态下输入框全文就是过滤词（不再有面板内搜索框）
  const qipQuery = qipOpen ? value : '';
  const qipFiltered = useMemo(() => filterQuickPhrases(phrases, qipQuery), [phrases, qipQuery]);

  const enterCmdMode = (kind: 'quickInput'): void => {
    setMenu(null);
    setQipEdit(null);
    applyValue('');
    setCmdMode(kind);
    requestAnimationFrame(() => editableRef.current?.focus());
  };

  const exitCmdMode = (keepValue = false): void => {
    setCmdMode(null);
    setQipEdit(null);
    if (!keepValue) applyValue('');
    requestAnimationFrame(() => editableRef.current?.focus());
  };

  // App 的 Escape 在捕获阶段先关闭最顶层；必须让命令浮层先于背景菜单响应。
  useOverlayDismiss(qipOpen, () => {
    if (qipEdit) {
      setQipEdit(null);
      requestAnimationFrame(() => editableRef.current?.focus());
    } else exitCmdMode();
  });

  // 点选短语：整段替换命令态的查询文本；插入即命令完成，chip 随之收场
  const insertPhrase = (p: QuickPhrase): void => {
    applyValue(p.value.trim() ? p.value : p.key);
    exitCmdMode(true);
  };

  const savePhrase = (): void => {
    if (!qipEdit) return;
    const { list } = upsertQuickPhrase(phrases, qipEdit.id, qipEdit.key, qipEdit.value);
    setPhrases(list);
    setQipEdit(null);
    requestAnimationFrame(() => editableRef.current?.focus());
  };

  /** 面板内键盘只管编辑表单（Esc 回列表 / Ctrl+Enter 存）；列表态键盘全在主输入框上 */
  const onQipKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setQipEdit(null);
      requestAnimationFrame(() => editableRef.current?.focus());
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      savePhrase();
    }
  };

  // 换查询词回到首项
  useEffect(() => {
    setQipActive(0);
  }, [qipQuery]);

  useEffect(() => {
    setQipActive((i) => (qipFiltered.length === 0 ? 0 : Math.min(i, qipFiltered.length - 1)));
  }, [qipFiltered.length]);

  // 键盘选中滚出可视区后跟随滚动（与斜杠菜单同配方）
  useEffect(() => {
    if (!qipOpen || qipEdit) return;
    const root = qipRef.current;
    if (!root) return;
    root.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [qipActive, qipOpen, qipEdit]);

  // 点输入框以外的页面区域收起（面板挂在 composer 内，点输入框/面板都不算外部）；不抢焦点
  useDismissOnOutsideClick(qipOpen, outsideRefs, () => {
    setCmdMode(null);
    setQipEdit(null);
    applyValue('');
  });

  return {
    cmdMode,
    qipOpen,
    qipPresence,
    phrases,
    setPhrases,
    qipEdit,
    setQipEdit,
    qipFiltered,
    qipActive,
    setQipActive,
    composerRef,
    qipRef,
    qipKeyRef,
    qipValueRef,
    enterCmdMode,
    exitCmdMode,
    insertPhrase,
    savePhrase,
    onQipKeyDown
  };
}
