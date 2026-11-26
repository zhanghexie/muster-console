import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceFileEntry } from '../../../../shared/types';
import type { MenuKind, SlashItem } from './composerHelpers';
import { notifyComposerError } from './composerNotice';
import type { InsertTokenSpec } from '../ComposerEditable';
import type { Props } from './composerTypes';

interface Params {
  menu: MenuKind;
  setMenu: (menu: MenuKind) => void;
  slashItems: SlashItem[];
  atItems: WorkspaceFileEntry[];
  activeIdx: number;
  replaceTrigger: (replacement: string | InsertTokenSpec) => void;
  openHarness: () => boolean;
  applyValue: (next: string) => void;
  enterCmdMode: (kind: 'quickInput') => void;
  toggleModelMenu: () => void;
  onClear?: () => Promise<void>;
  onCompact?: Props['onCompact'];
  onRecordRequests?: Props['onRecordRequests'];
  onLocalCommand?: Props['onLocalCommand'];
  onStop?: () => void;
  skillSelection?: (item: SlashItem) => InsertTokenSpec | null;
  fileSelection?: (file: WorkspaceFileEntry) => InsertTokenSpec | null;
}

/** 斜杠菜单条目执行（applyItem）与两段共用的本地动作：手动清空共舞 runClear、
 *  手动压缩 runCompact。clearing/compactingRef 双在途守卫原样保留。 */
export function useComposerCommands({
  menu,
  setMenu,
  slashItems,
  atItems,
  activeIdx,
  replaceTrigger,
  openHarness,
  applyValue,
  enterCmdMode,
  toggleModelMenu,
  onClear,
  onCompact,
  onRecordRequests,
  onLocalCommand,
  onStop,
  skillSelection,
  fileSelection
}: Params): {
  clearing: boolean;
  runClear: () => Promise<void>;
  runCompact: (instructions?: string) => Promise<void>;
  applyItem: (idx: number, via?: 'complete' | 'activate') => Promise<void>;
} {
  const { t } = useTranslation();
  const [clearing, setClearing] = useState(false);
  const compactingRef = useRef(false);

  /** 手动清空共舞（applyItem /clear 与 submit /new、newSession 同款；时序保持原样） */
  const runClear = async (): Promise<void> => {
    if (!onClear) return;
    setClearing(true);
    try {
      await onClear();
      // 成功不再提示（原 hint 条已移除）
    } catch (e) {
      notifyComposerError((e as Error).message || t('清空失败'));
    } finally {
      setClearing(false);
    }
  };

  const runCompact = async (instructions?: string): Promise<void> => {
    if (!onCompact || compactingRef.current) return;
    compactingRef.current = true;
    try {
      const r = await onCompact(instructions);
      if (r && r.ok === false) {
        notifyComposerError(r.error ? t('压缩失败：{{error}}', { error: r.error }) : t('压缩失败'));
        return;
      }
      // 进行中/完成改走消息流 CompactDivider，成功不再提示
    } catch (e) {
      notifyComposerError(t('压缩失败：{{message}}', { message: (e as Error).message || String(e) }));
    } finally {
      compactingRef.current = false;
    }
  };

  /** Tab 补全可带参的命令。引用类条目可直接选择。 */
  const applyItem = async (idx: number, via: 'complete' | 'activate' = 'activate'): Promise<void> => {
    if (menu === 'slash') {
      const item = slashItems[idx];
      if (!item) return;
      if (item.action === 'harness') {
        openHarness();
        return;
      }
      if (item.id.startsWith('extension:')) {
        replaceTrigger({ type: 'skill', name: item.id.slice(10), serializedText: item.insert?.trimEnd() });
        return;
      }
      if (item.id.startsWith('skill:') && skillSelection) {
        const replacement = skillSelection(item);
        if (replacement) replaceTrigger(replacement);
        else notifyComposerError(t('技能文件路径不可用，请刷新后重试'));
        return;
      }
      if (via === 'complete') {
        if (item.id.startsWith('skill:')) {
          replaceTrigger({ type: 'skill', name: item.id.slice('skill:'.length) });
        } else {
          replaceTrigger(item.insert ?? `${item.label} `);
        }
        return;
      }
      if (item.action === 'clear') {
        setMenu(null);
        applyValue('');
        await runClear();
        return;
      }
      if (item.action === 'stop') {
        setMenu(null);
        applyValue('');
        onStop?.();
        return;
      }
      if (item.action === 'compact' && onCompact) {
        setMenu(null);
        applyValue('');
        await runCompact();
        return;
      }
      if (item.action === 'recordRequests' && onRecordRequests) {
        replaceTrigger('');
        onRecordRequests('start');
        return;
      }
      if (item.action === 'quickInput') {
        applyValue('');
        enterCmdMode(item.action);
        return;
      }
      if (item.action === 'model') {
        setMenu(null);
        applyValue('');
        toggleModelMenu();
        return;
      }
      if (item.action === 'status' || item.action === 'statusVerbose' || item.action === 'help') {
        setMenu(null);
        applyValue('');
        onLocalCommand?.(item.action);
        return;
      }
      if (item.action === 'bind' || item.action === 'unbind') {
        setMenu(null);
        applyValue('');
        onLocalCommand?.(item.action);
        return;
      }
      if (item.insert) {
        // 技能引用插成原子胶囊（序列化仍为 `/skill:name `）；其余插入文本原样保留
        if (item.id.startsWith('skill:')) {
          replaceTrigger({ type: 'skill', name: item.id.slice('skill:'.length) });
        } else {
          replaceTrigger(item.insert);
        }
      }
      return;
    }
    if (menu === 'at') {
      const file = atItems[idx];
      if (!file) return;
      // 文件引用插成原子胶囊：路径不可劈开编辑（序列化仍为 `@path `）
      if (fileSelection) {
        const replacement = fileSelection(file);
        if (replacement) replaceTrigger(replacement);
        else notifyComposerError(t('文件完整路径不可用，请完全重启应用后重试'));
      } else replaceTrigger({ type: 'file', path: file.absolutePath ?? file.path, label: `@${file.displayPath ?? file.path}` });
    }
  };

  return { clearing, runClear, runCompact, applyItem };
}
