import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Dispatch, KeyboardEvent as ReactKeyboardEvent, MutableRefObject, SetStateAction } from 'react';
import { parseCompactCommand } from '../../../../shared/compactCommand';
import { parseWorkbenchCommand } from '../../../../shared/workbenchCommands';
import type { ChatImageAttachment } from '../../../../shared/types';
import type { QuickPhrase, TosendItem } from '../../../../shared/composerTools';
import { HARNESS_COMMAND, RECORD_REQUESTS_COMMAND, isLocalClearCommand, isUnsupportedSlash, type MenuKind } from './composerHelpers';
import { notifyComposerError } from './composerNotice';

interface Params {
  cmdMode: null | 'quickInput';
  /** /quickInput 命令态的键盘选择（主输入框即搜索框） */
  qipFiltered: QuickPhrase[];
  qipActive: number;
  setQipActive: Dispatch<SetStateAction<number>>;
  insertPhrase: (p: QuickPhrase) => void;
  exitCmdMode: (keepValue?: boolean) => void;
  valueRef: MutableRefObject<string>;
  busy: boolean;
  disabled?: boolean;
  clearing: boolean;
  images: ChatImageAttachment[];
  setImages: Dispatch<SetStateAction<ChatImageAttachment[]>>;
  menu: MenuKind;
  setMenu: (menu: MenuKind) => void;
  itemCount: number;
  activeIdx: number;
  setActiveIdx: Dispatch<SetStateAction<number>>;
  applyValue: (next: string) => void;
  applyItem: (idx: number, via?: 'complete' | 'activate') => Promise<void>;
  runClear: () => Promise<void>;
  runCompact: (instructions?: string) => Promise<void>;
  toggleModelMenu: () => void;
  openHarness: () => boolean;
  enterCmdMode: (kind: 'quickInput') => void;
  onCompact?: import('./composerTypes').Props['onCompact'];
  onRecordRequests?: import('./composerTypes').Props['onRecordRequests'];
  onSend: import('./composerTypes').Props['onSend'];
  onStop?: () => void;
  onLocalCommand?: import('./composerTypes').Props['onLocalCommand'];
  tosend: TosendItem[];
  addTosend: (text: string, images?: Array<{
    id: string;
    data: string;
    mimeType: string;
    name?: string;
    size?: number;
  }>) => void;
  /** 调度表面：/workflow-new、/workflow 原文发送（主进程展开） */
  workflowCommands?: boolean;
  extensionTask?: boolean;
  /** 单题问答等待期间，纯文本发送应回答问题而非进入手动队列。 */
  pendingQuestion?: boolean;
  /** CLI 自己处理 /new、/help 等命令，工作台截获自己的输入命令。 */
  nativeSlashCommands?: boolean;
  creation?: { allowEmpty: boolean; submitDisabled: boolean };
  /** PTY 提交要原样保留用户输入的前后空白。 */
  preserveWhitespace?: boolean;
}

/** 发送判定与主键盘路径：submit（本地命令拦截 / busy 手动清单分流 / 图片快照回滚）
 *  与 onKeyDown（命令态键盘、菜单上下键、Enter 发送，含 IME 合成期 guard）。 */
export function useComposerSubmit({
  cmdMode,
  qipFiltered,
  qipActive,
  setQipActive,
  insertPhrase,
  exitCmdMode,
  valueRef,
  busy,
  disabled,
  clearing,
  images,
  setImages,
  menu,
  setMenu,
  itemCount,
  activeIdx,
  setActiveIdx,
  applyValue,
  applyItem,
  runClear,
  runCompact,
  toggleModelMenu,
  openHarness,
  enterCmdMode,
  onCompact,
  onRecordRequests,
  onSend,
  onStop,
  onLocalCommand,
  tosend,
  addTosend,
  workflowCommands = false,
  extensionTask = false,
  pendingQuestion = false,
  nativeSlashCommands = false, creation,
  preserveWhitespace = false
}: Params): {
  submitting: boolean;
  submit: () => Promise<void>;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
} {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const submit = async (): Promise<void> => {
    // 命令激活态：/quickInput 的 Enter 已在 onKeyDown 消费
    if (cmdMode || submittingRef.current) return;
    const text = preserveWhitespace ? valueRef.current : valueRef.current.trim();
    if ((!text.trim() && images.length === 0 && !creation?.allowEmpty) || creation?.submitDisabled || disabled || clearing) return;
    if (/^\/quickinput$/i.test(text.trim())) {
      applyValue('');
      enterCmdMode('quickInput');
      return;
    }
    if (text.trim().toLowerCase() === HARNESS_COMMAND && openHarness()) return;
    if (!nativeSlashCommands) {
      if (text.split(/\s/, 1)[0]?.toLowerCase() === RECORD_REQUESTS_COMMAND) {
        const argument = text.slice(RECORD_REQUESTS_COMMAND.length).trim().toLowerCase();
        if (!onRecordRequests) notifyComposerError(t('当前会话不支持录制模型请求'));
        else if (argument && argument !== 'view') notifyComposerError(t('使用 /record-requests 录制请求，或加 view 查看历史'));
        else {
          applyValue('');
          setMenu(null);
          onRecordRequests(argument === 'view' ? 'view' : 'start');
        }
        return;
      }
      if (isLocalClearCommand(text)) {
        if (busy) {
          notifyComposerError(t('Agent 正在工作，清空请等当前回合结束'));
          return;
        }
        applyValue('');
        setMenu(null);
        await runClear();
        return;
      }
      if (text === '/model') {
        applyValue('');
        setMenu(null);
        // 调度与 GUI 会话都直接开模型菜单（GUI=会话级覆盖；旁边按钮同款）
        toggleModelMenu();
        return;
      }
      // 手动压缩（可带摘要侧重）：本地命令不进模型；无能力表面落到未支持提示
      const compactHit = onCompact ? parseCompactCommand(text) : null;
      if (compactHit) {
        applyValue('');
        setMenu(null);
        await runCompact(compactHit.instructions);
        return;
      }
      const cmd = parseWorkbenchCommand(text);
      if (cmd.type === 'status') {
        applyValue('');
        setMenu(null);
        onLocalCommand?.(cmd.detail === 'verbose' ? 'statusVerbose' : 'status');
        return;
      }
      if (cmd.type === 'stop') {
        applyValue('');
        setMenu(null);
        onStop?.();
        return;
      }
      if (cmd.type === 'help' || cmd.type === 'palette') {
        applyValue('');
        setMenu(null);
        onLocalCommand?.('help');
        return;
      }
      if (cmd.type === 'bind') {
        applyValue('');
        setMenu(null);
        onLocalCommand?.('bind', cmd.target);
        return;
      }
      if (cmd.type === 'unbind') {
        applyValue('');
        setMenu(null);
        onLocalCommand?.('unbind');
        return;
      }
      if (
        cmd.type === 'workspaces' ||
        cmd.type === 'sessions' ||
        cmd.type === 'useWorkspace' ||
        cmd.type === 'useSession'
      ) {
        notifyComposerError(t('工作区 / 会话请用左侧列表切换'));
        return;
      }
      if (cmd.type === 'newSession') {
        if (busy) {
          notifyComposerError(t('Agent 正在工作，清空请等当前回合结束'));
          return;
        }
        applyValue('');
        setMenu(null);
        await runClear();
        return;
      }
      if (isUnsupportedSlash(text, !!onCompact, workflowCommands, extensionTask)) {
        notifyComposerError(t('未支持的命令：{{cmd}}（输入 / 查看命令）', { cmd: text.split(/\s/)[0] }));
        return;
      }
    }
    // busy 分流（统一排队面板）：手动确认泳道非空时，新消息默认也进手动确认
    //（清单语义跟随）；为空则维持原排队（主进程 busy 排队、空闲自动续发）。
    // 手动清单支持随文图片（2026-09-27）；图-only 也可入。
    if (busy && tosend.length > 0 && (!pendingQuestion || images.length > 0)) {
      addTosend(text, images.length > 0 ? [...images] : undefined);
      if (images.length > 0) setImages([]);
      applyValue('');
      setMenu(null);
      return;
    }
    setMenu(null);
    const pendingImgs = images.length > 0 ? [...images] : undefined;
    const sentImageIds = new Set(pendingImgs?.map((im) => im.id) ?? []);
    // 发送瞬间的草稿快照：send 是异步的（冷启动连接可达数十秒），期间用户继续
    // 打的字/加的图不属于本次发送——成功后只清快照本身，失败保留/还原
    const sentText = text;
    let ok: boolean | void = true;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      ok = await onSend(sentText, pendingImgs);
    } catch {
      ok = false;
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
    if (ok === false) {
      if (pendingImgs) {
        setImages((prev) => {
          const have = new Set(prev.map((im) => im.id));
          const missing = pendingImgs.filter((im) => !have.has(im.id));
          return missing.length ? [...missing, ...prev] : prev;
        });
      }
      return;
    }
    if (creation) return; // The launch dialog owns its draft until it closes.
    setImages((prev) => prev.filter((im) => !sentImageIds.has(im.id)));
    if ((preserveWhitespace ? valueRef.current : valueRef.current.trim()) === sentText) applyValue('');
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // 命令激活态：主输入框键盘全归命令（quickInput=搜索选择），
    // 不进普通发送与菜单路径；Esc/空值退格取消命令
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (cmdMode === 'quickInput') {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (qipFiltered.length) setQipActive((i) => (i + 1) % qipFiltered.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (qipFiltered.length) {
          setQipActive((i) => (i - 1 + qipFiltered.length) % qipFiltered.length);
        }
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        const p = qipFiltered[qipActive];
        if (p) insertPhrase(p);
        return;
      }
      if (e.key === 'Escape' || (e.key === 'Backspace' && !valueRef.current)) {
        e.preventDefault();
        exitCmdMode();
        return;
      }
      return;
    }
    if (menu && itemCount > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % itemCount);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + itemCount) % itemCount);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        // 连发会在 re-render 前再次 activate：compact() 二次 abort 会掐死第一次摘要
        if (e.repeat) return;
        void applyItem(activeIdx, 'activate');
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenu(null);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.repeat) return;
        void applyItem(activeIdx, 'complete');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && (!creation || e.ctrlKey || e.metaKey)) {
      // isComposing：IME 合成期的 Enter 是「确认候选」，不能当发送（中文输入主场景）
      e.preventDefault();
      void submit();
    }
  };

  return { submitting, submit, onKeyDown };
}
