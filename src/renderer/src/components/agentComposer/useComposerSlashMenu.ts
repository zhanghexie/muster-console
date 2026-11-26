import { randomUuid } from '../../../../shared/randomUuid';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentSkillInfo,
  WorkspaceFileEntry
} from '../../../../shared/types';
import type { ChatSurfaceKind, ChatEngineSlashCommand } from '../../../../shared/chatSurface';
import {
  buildSlashItems,
  findTrigger,
  HARNESS_COMMAND,
  type MenuKind,
  type SlashItem
} from './composerHelpers';
import { notifyComposerError } from './composerNotice';
import type { ComposerEditableHandle, InsertTokenSpec } from '../ComposerEditable';
import { useWorkspaceStore } from '../../store';
import { useOverlayDismiss } from '../../keybindings/KeybindingHost';
import { sourceRootsFor, workspaceRootLabel } from '../../../../shared/workspaceRoots';
import type { CapabilityTargetId } from '../../../../shared/capabilityManagement';

interface Params {
  workspaceId: string | null;
  menu: MenuKind;
  setMenu: (menu: MenuKind) => void;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  triggerStart: number;
  setTriggerStart: Dispatch<SetStateAction<number>>;
  activeIdx: number;
  setActiveIdx: Dispatch<SetStateAction<number>>;
  surfaceKind: ChatSurfaceKind;
  skillTarget?: CapabilityTargetId;
  /** CLI 只展示技能和工作台输入命令；其余斜杠命令交给 CLI 自身。 */
  cliInput?: boolean;
  rootId?: string;
  extensionSkills?: readonly string[];
  sessionId?: string;
  engineSlashCommands?: ReadonlyArray<ChatEngineSlashCommand>;
  onCompact?: import('./composerTypes').Props['onCompact'];
  requestRecordingAvailable?: boolean;
  editableRef: MutableRefObject<ComposerEditableHandle | null>;
  onOpenHarness?: (start: number, text: string) => boolean;
}

/** /、@ 触发词菜单：触发解析（findTrigger）后的候选数据面——本地命令清单、
 *  技能（agent.listSkills）、工作区文件（workspaces.listFiles，80ms 防抖）与
 *  ACP 引擎命令，加上选中态与滚跟；replaceTrigger/insertAtCaret 供选中后写入。 */
export function useComposerSlashMenu({
  workspaceId,
  menu,
  setMenu,
  query,
  setQuery,
  triggerStart,
  setTriggerStart,
  activeIdx,
  setActiveIdx,
  surfaceKind,
  skillTarget,
  cliInput = false, rootId, extensionSkills,
  sessionId,
  engineSlashCommands,
  onCompact,
  requestRecordingAvailable,
  editableRef,
  onOpenHarness
}: Params): {
  slashItems: SlashItem[];
  atItems: WorkspaceFileEntry[];
  items: SlashItem[] | WorkspaceFileEntry[];
  itemCount: number;
  menuRef: MutableRefObject<HTMLDivElement | null>;
  refreshMenuFromCaret: (next: string, cursor: number) => void;
  openHarness: (from: 'trigger' | 'draft') => boolean;
  replaceTrigger: (replacement: string | InsertTokenSpec) => void;
  insertAtCaret: (chunk: string) => void;
} {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<AgentSkillInfo[]>([]);
  const [capabilityRevision, setCapabilityRevision] = useState(0);
  const target = skillTarget ?? (surfaceKind === 'dispatch' ? 'pi-dispatcher' : 'pi-gui');
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [filesScope, setFilesScope] = useState('');
  const { workspaces } = useWorkspaceStore();
  const workspace = workspaces.find(w => w.id === workspaceId);
  const revision = workspace?.rootsRevision ?? 0;
  const scope = JSON.stringify([workspaceId, revision, query]);
  const [workflows, setWorkflows] = useState<Array<{ name: string; description?: string }>>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const loadGen = useRef(0);
  const lastTriggerPosition = useRef<{ text: string; cursor: number } | null>(null);
  const harnessAvailable = !!onOpenHarness;
  useOverlayDismiss(menu !== null, () => setMenu(null));

  const refreshMenuFromCaret = useCallback(
    (next: string, cursor: number) => {
      const last = lastTriggerPosition.current;
      // keyup/click also report the caret without moving it. Preserve a dismissed
      // menu until the text or caret actually changes (notably after Escape).
      if (last?.text === next && last.cursor === cursor) return;
      lastTriggerPosition.current = { text: next, cursor };
      const hit = findTrigger(next, cursor);
      if (!hit) {
        setMenu(null);
        setQuery('');
        return;
      }
      setMenu(hit.kind);
      setQuery(hit.query);
      setTriggerStart(hit.start);
    },
    // setMenu/setQuery/setTriggerStart 均为 useState setter（稳定引用），与原实现 deps [] 一致
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // 仅在菜单类型/过滤词变化时回到首项；上下键移动时不要被 onSelect 重置
  useEffect(() => {
    setActiveIdx(0);
  }, [menu, query]);

  useEffect(() => {
    const on = window.api?.on;
    if (typeof on !== 'function') return;
    return on('capabilityManagement:changed', (payload: { kind?: string }) => {
      if (payload?.kind === 'skills') setCapabilityRevision(revision => revision + 1);
    });
  }, []);

  useEffect(() => {
    if (!workspaceId || menu !== 'slash') return;
    const listSkills = window.api?.agent?.listSkills;
    if (typeof listSkills !== 'function') {
      notifyComposerError(t('技能列表 API 未就绪，请完全重启应用（勿只靠热更新）'));
      setSkills([]);
      return;
    }
    const gen = ++loadGen.current;
    setSkills([]);
    void (rootId ? listSkills(workspaceId, target, undefined, rootId) : sessionId ? listSkills(workspaceId, target, sessionId) : listSkills(workspaceId, target))
      .then((r) => {
        if (gen !== loadGen.current) return;
        if (r.error) {
          setSkills([]);
          notifyComposerError(t('加载技能失败：{{message}}', { message: r.error }));
          return;
        }
        setSkills(r.skills ?? []);
      })
      .catch((err) => {
        if (gen !== loadGen.current) return;
        setSkills([]);
        notifyComposerError(t('加载技能失败：{{message}}', { message: (err as Error).message || String(err) }));
      });
    return () => { if (gen === loadGen.current) loadGen.current++; };
  }, [workspaceId, revision, menu, t, target, capabilityRevision, sessionId, rootId]);

  useEffect(() => {
    if (!workspaceId || menu !== 'at') return;
    const listFiles = window.api?.workspaces?.listFiles;
    if (typeof listFiles !== 'function') {
      notifyComposerError(t('文件列表 API 未就绪，请完全重启应用'));
      setFiles([]);
      return;
    }
    const gen = ++loadGen.current;
    const requestId = randomUuid();
    const timer = window.setTimeout(() => {
      void listFiles(workspaceId, query, requestId)
        .then((r) => {
          if (gen !== loadGen.current) return;
          if (r.cancelled || r.rootsRevision !== undefined && r.rootsRevision !== revision) return;
          setFiles(r.files ?? []);
          setFilesScope(scope);
          const failures = r.roots?.filter(root => root.error || root.timedOut).map(status => {
            const root = workspace && sourceRootsFor(workspace).find(root => root.id === status.rootId);
            return root ? `${workspaceRootLabel(root)} (${root.path})` : status.rootId;
          }).join(', ');
          if (r.error) notifyComposerError(r.error);
          else if (failures) notifyComposerError(t('部分文件夹搜索失败：{{folders}}', { folders: failures }));
          else if (r.truncated) notifyComposerError(t('搜索结果已截断，请缩小范围'));
        })
        .catch((err) => {
          if (gen !== loadGen.current) return;
          setFiles([]);
          setFilesScope(scope);
          notifyComposerError(t('搜索文件失败：{{message}}', { message: (err as Error).message || String(err) }));
        });
    }, 80);
    return () => {
      window.clearTimeout(timer);
      if (gen === loadGen.current) loadGen.current++;
      void window.api.fs.cancelQuery(workspaceId, requestId).catch(err => console.warn('[composer] cancel file query failed', err));
    };
  }, [workspaceId, menu, query, revision, scope, t]);

  useEffect(() => {
    if (!workspaceId || menu !== 'slash' || surfaceKind !== 'dispatch') return;
    const overview = window.api?.workflow?.overview;
    if (typeof overview !== 'function') return;
    let alive = true;
    void overview(workspaceId)
      .then((r) => {
        if (!alive) return;
        setWorkflows(
          (r?.workflows ?? [])
            .filter((w) => !w.errors?.length)
            .map((w) => ({ name: w.name, ...(w.description ? { description: w.description } : {}) }))
        );
      })
      .catch(() => alive && setWorkflows([]));
    return () => {
      alive = false;
    };
  }, [workspaceId, menu, surfaceKind]);

  const slashItems: SlashItem[] = useMemo(
    () => [
      ...(extensionSkills ?? []).filter(name => name.toLowerCase().includes(query.toLowerCase().replace(/^skill:/, '')))
        .map(name => ({ id: 'extension:' + name, label: '/skill:' + name, description: t('扩展'), insert: '/' + name + ' ' })),
      ...buildSlashItems(
        skills,
        query,
        surfaceKind === 'gui-session',
        engineSlashCommands,
        !!onCompact,
        t,
        surfaceKind === 'dispatch' ? workflows : [],
        harnessAvailable,
        requestRecordingAvailable
      ).filter(item => !cliInput || item.action === 'quickInput' || item.action === 'harness' || item.id.startsWith('skill:'))],
    [query, skills, surfaceKind, t, engineSlashCommands, onCompact, workflows, cliInput, harnessAvailable, extensionSkills, requestRecordingAvailable]
  );

  let roots: ReturnType<typeof sourceRootsFor> = [];
  try { if (workspace) roots = sourceRootsFor(workspace); } catch { /* 坏配置不提供引用候选 */ }
  const atItems = filesScope === scope ? files.flatMap(file => {
    if (!file.fileRef) return roots.length <= 1 ? [file] : []; // 旧单根/测试调用兼容，多根不猜身份。
    const root = roots.find(r => r.id === file.fileRef!.rootId);
    if (!root || file.fileRef.workspaceId !== workspaceId) return [];
    return [{ ...file, displayPath: roots.length > 1 ? `${workspaceRootLabel(root)}/${file.path}` : file.path }];
  }) : [];

  const items = menu === 'slash' ? slashItems : menu === 'at' ? atItems : [];
  const itemCount = items.length;

  useEffect(() => {
    setActiveIdx((i) => (itemCount === 0 ? 0 : Math.min(i, itemCount - 1)));
  }, [itemCount]);

  // 键盘选中滚出可视区后会像「按不动」——跟随滚动
  useEffect(() => {
    if (!menu || itemCount === 0) return;
    const root = menuRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, menu, itemCount]);

  const openHarness = (from: 'trigger' | 'draft'): boolean => {
    const ed = editableRef.current;
    if (!ed || !onOpenHarness) return false;
    const text = ed.getText();
    const end = from === 'draft' ? text.trimEnd().length : ed.getCaret();
    const hit = findTrigger(text, end);
    if (hit?.kind !== 'slash' || (text[end] && !/\s/.test(text[end]))) return false;
    const command = text.slice(hit.start, end);
    if (from === 'draft' && text.trim().toLowerCase() !== HARNESS_COMMAND) return false;
    if (!onOpenHarness(hit.start, command)) return false;
    lastTriggerPosition.current = { text, cursor: ed.getCaret() };
    setMenu(null);
    setQuery('');
    return true;
  };

  /** 用 replacement 顶掉当前触发段（触发符起至光标）；token 则插成原子胶囊 */
  const replaceTrigger = (replacement: string | InsertTokenSpec): void => {
    const ed = editableRef.current;
    if (!ed) return;
    const cursor = ed.getCaret();
    const hit = findTrigger(ed.getText(), cursor);
    const start = hit?.start ?? triggerStart;
    ed.replaceRange(start, cursor, replacement);
    setMenu(null);
    setQuery('');
  };

  const insertAtCaret = (chunk: string): void => {
    if (!chunk) return;
    const ed = editableRef.current;
    if (!ed) return;
    ed.focus();
    ed.insertText(chunk);
  };

  return {
    slashItems,
    atItems,
    items,
    itemCount,
    menuRef,
    refreshMenuFromCaret,
    openHarness,
    replaceTrigger,
    insertAtCaret
  };
}
