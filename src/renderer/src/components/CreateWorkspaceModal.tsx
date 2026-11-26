import { ErrorTip } from './ErrorTip';
import { AppConfirmDialog } from './AppConfirmDialog';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { AvatarPicker, BUILTIN_AVATARS } from './AvatarPicker';
import { DEFAULT_WORKSPACE_ICON, WORKSPACE_ICONS, workspaceIconId, workspaceIconValue } from '../../../shared/workspaceIcons';
import { workspaceAvatarImageSrc, workspaceIconUrl } from '../workspaceIcons';
import { usePresence } from './motion';
import type { WorkspaceRoot, WorkspaceRootDependency } from '../../../shared/types';
import { extractAvatarAccent } from '../avatarAccent';
import { WorkspaceRootsEditor } from './WorkspaceRootsEditor';
import { legacyWorkspaceRootId } from '../../../shared/workspaceRoots';
import { randomUuid } from '../../../shared/randomUuid';
import { pathKey } from '../../../shared/pathKey';
import { WorkspaceRootDependencies, WorkspaceSaveError } from './WorkspaceRootDependencies';
import { WorktreePreparationSettings } from './WorktreePreparationSettings';
import { IconChevronDown } from './icons';

export { BUILTIN_AVATARS };
const WORKSPACE_PRESETS = WORKSPACE_ICONS.map(icon => ({ id: icon.id, label: icon.label, src: workspaceIconUrl(workspaceIconValue(icon.id))! }));

export interface CreateWorkspaceResult {
  path: string;
  name: string;
  avatar: string;
  /** 头像取色；头像无明显颜色时 null（清除旧缓存） */
  avatarAccent: string | null;
  roots?: WorkspaceRoot[];
  defaultRootId?: string;
  controlRootId?: string;
  /** 使用推荐路径一键填入：提交时由主进程按需创建 defaultWorkspaceRoot() 目录。 */
  ensureRecommendedRoot?: boolean;
  expectedRootsRevision?: number;
}

export interface WorkspaceModalInitial {
  id?: string;
  path: string;
  name: string;
  avatar?: string;
  roots?: WorkspaceRoot[];
  defaultRootId?: string;
  controlRoot?: string;
  rootsRevision?: number;
}

interface Props {
  /** 创建与编辑默认使用多文件夹表单；保留单目录形式供兼容调用方使用。 */
  multiFolder?: boolean;
  mode?: 'create' | 'edit';
  /** 编辑模式预填 */
  initial?: WorkspaceModalInitial;
  /** false 时播退场后卸载；缺省 true（老调用方语义不变） */
  open?: boolean;
  onClose: () => void;
  onSave: (opts: CreateWorkspaceResult) => Promise<void>;
  onOpenDependency?: (dependency: WorkspaceRootDependency) => Promise<void>;
  /** 编辑模式：删除当前工作区 */
  onDelete?: () => Promise<void>;
  /** 是否允许删除 */
  canDelete?: boolean;
  /** 零工作区时的常驻引导：不可关闭、显示引导文案，创建成功后由列表变化自动收起。 */
  required?: boolean;
  /** 主进程给的推荐目录（新建面板「还没想好放哪里」提示 + 一键填入）。 */
  recommendedRoot?: string;
  /** 一键填入时使用的名称。 */
  recommendedName?: string;
  /** Opened from the workspace stack during first-time setup. */
  guided?: boolean;
  busy?: boolean;

}

function basenameHint(dir: string): string {
  const cleaned = dir.replace(/[\\/]+$/, '');
  const i = Math.max(cleaned.lastIndexOf('\\'), cleaned.lastIndexOf('/'));
  return i >= 0 ? cleaned.slice(i + 1) : cleaned;
}

export function CreateWorkspaceModal({
  multiFolder = true,
  mode = 'create',
  initial,
  open = true,
  onClose,
  onSave,
  onOpenDependency,
  onDelete,
  canDelete = false,
  required = false,
  recommendedRoot,
  recommendedName,
  guided = false,
  busy
}: Props): React.JSX.Element | null {
  const { t } = useTranslation();
  const editing = mode === 'edit';
  const [dirPath, setDirPath] = useState(initial?.path ?? '');
  const [roots, setRoots] = useState<WorkspaceRoot[]>([]);
  const [defaultRootId, setDefaultRootId] = useState<string>();
  const [controlRootId, setControlRootId] = useState<string>();
  const [pickingRoots, setPickingRoots] = useState(false);
  const [name, setName] = useState(initial?.name ?? '');
  const [avatar, setAvatar] = useState<string>(
    initial?.avatar?.trim() || DEFAULT_WORKSPACE_ICON
  );
  const [error, setError] = useState('');
  const [rootDependencies, setRootDependencies] = useState<WorkspaceRootDependency[]>([]);
  const [saving, setSaving] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const formEpoch = useRef(0);
  const saveInFlight = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [avatarExpanded, setAvatarExpanded] = useState(false);
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  /** 本次草稿是否来自推荐路径一键填入；用户改路径即失效，避免给任意目录自动建文件夹。 */
  const [useRecommended, setUseRecommended] = useState(false);
  const avatarPresence = usePresence(open && avatarExpanded);
  const settingsPresence = usePresence(open && settingsExpanded);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameTouched = useRef(editing);

  // 常驻挂载（open 驱动 presence 进出场）后，表单在每次 open 边沿重置：
  // 等价于原先「卸载重挂载自动回初值」的行为
  useEffect(() => {
    formEpoch.current++;
    saveInFlight.current = false;
    setSaving(false);
    setNavigating(false);
    if (!open) return;
    const suggested = guided && !editing ? recommendedRoot : undefined;
    setDirPath(initial?.path ?? suggested ?? '');
    setPickingRoots(false);
    const initialRoots = initial?.roots ?? (initial?.path ? [{ id: legacyWorkspaceRootId(initial.id ?? 'draft'), path: initial.path }]
      : suggested && multiFolder ? [{ id: randomUuid(), path: suggested }] : []);
    setRoots(initialRoots);
    setDefaultRootId(initial?.defaultRootId ?? initialRoots[0]?.id);
    setControlRootId(initialRoots.find((r) => pathKey(r.path) === pathKey(initial?.controlRoot ?? initial?.path ?? ''))?.id ?? initialRoots[0]?.id);
    setName(initial?.name ?? (suggested ? recommendedName ?? '' : ''));
    setAvatar(initial?.avatar?.trim() || DEFAULT_WORKSPACE_ICON);
    setError('');
    setRootDependencies([]);
    setDeleting(false);
    setConfirmDelete(false);
    setAvatarExpanded(false);
    setSettingsExpanded(false);
    setUseRecommended(!!suggested);
    nameTouched.current = editing;
    // 弹层在 portal 里：打开时抢回焦点，避免终端/聊天仍吃键盘
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body) active.blur();
    const t = window.setTimeout(() => nameRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open 边沿时 initial 必为本次打开的新值
  }, [open, initial?.id]);

  useEffect(() => () => { formEpoch.current++; }, []);

  const presence = usePresence(open);
  // 常驻引导不进 ESC 栈：没有工作区时没有可关闭的退路，创建成功后由列表变化收起。
  useOverlayDismiss(presence.mounted && presence.stage !== 'out' && !required, onClose);

  if (!presence.mounted) return null;

  const fillRecommended = (): void => {
    if (!recommendedRoot || busy || saving || pickingRoots || navigating || deleting) return;
    const root: WorkspaceRoot = { id: randomUuid(), path: recommendedRoot };
    setRoots([root]);
    setDefaultRootId(root.id);
    setControlRootId(root.id);
    setDirPath(recommendedRoot);
    if (recommendedName && (!guided || !nameTouched.current)) setName(recommendedName);
    if (!guided) nameTouched.current = true;
    setUseRecommended(true);
    setError('');
    setRootDependencies([]);
  };

  const pickDir = async (): Promise<void> => {
    if (editing || locked) return;
    const epoch = formEpoch.current;
    setError('');
    setPickingRoots(true);
    try {
      const result = await window.api.workspaces.pickDir();
      if (epoch !== formEpoch.current) return;
      if (!result.ok || !result.path) {
        if (result.message && result.message !== 'cancelled') setError(result.message);
        return;
      }
      setUseRecommended(false);
      setDirPath(result.path);
      if (!nameTouched.current) setName(basenameHint(result.path));
    } catch (error) {
      if (epoch === formEpoch.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (epoch === formEpoch.current) setPickingRoots(false);
    }
  };

  const onCustomFile = (file: File): void => {
    if (!file.type.startsWith('image/')) {
      setError(t('请选择图片文件'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        changeAvatar(reader.result);
        setError('');
      }
    };
    reader.readAsDataURL(file);
  };

  const changeAvatar = (next: string): void => {
    setAvatar(next);
  };

  const submit = async (): Promise<void> => {
    if (saveInFlight.current || busy || navigating || pickingRoots || deleting || !open) return;
    const selectedPath = multiFolder ? roots.find((r) => r.id === defaultRootId)?.path ?? '' : dirPath;
    if (!selectedPath.trim()) {
      setError(t('请先选择目录'));
      return;
    }
    const n = name.trim() || basenameHint(selectedPath);
    const a = avatar.trim() || DEFAULT_WORKSPACE_ICON;
    // Capture the draft before avatar decoding; edits and repeat saves are locked until completion.
    const snapshot = { path: selectedPath.trim(), name: n, avatar: a,
      ...(!editing && useRecommended ? { ensureRecommendedRoot: true } : {}),
      ...(multiFolder ? { roots: roots.map(root => ({ ...root })), defaultRootId, controlRootId,
        ...(editing ? { expectedRootsRevision: initial?.rootsRevision ?? 0 } : {}) } : {}) };
    const epoch = formEpoch.current;
    saveInFlight.current = true;
    setSaving(true);
    setError('');
    setRootDependencies([]);
    try {
      const avatarAccent = await extractAvatarAccent(a);
      if (epoch !== formEpoch.current) return;
      await onSave({ ...snapshot, avatarAccent });
    } catch (err) {
      if (epoch !== formEpoch.current) return;
      setError(err instanceof WorkspaceSaveError && err.rootDependencies.length ? t('设置尚未保存') : String((err as Error).message ?? err));
      if (err instanceof WorkspaceSaveError) setRootDependencies(err.rootDependencies.map(item => ({ ...item })));
    } finally {
      if (epoch === formEpoch.current) { saveInFlight.current = false; setSaving(false); }
    }
  };

  const openDependency = async (dependency: WorkspaceRootDependency): Promise<void> => {
    if (!onOpenDependency || navigating || saving || busy || !open) return;
    const epoch = formEpoch.current;
    setNavigating(true);
    try { await onOpenDependency(dependency); }
    catch (err) { if (epoch === formEpoch.current) setError(String((err as Error).message ?? err)); }
    finally { if (epoch === formEpoch.current) setNavigating(false); }
  };

  const remove = async (): Promise<void> => {
    if (!onDelete || !canDelete) return;
    setConfirmDelete(false);
    setError('');
    setDeleting(true);
    const epoch = formEpoch.current;
    try {
      await onDelete();
    } catch (err) {
      if (epoch !== formEpoch.current) return;
      setError(String((err as Error).message ?? err));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const locked = busy || deleting || pickingRoots || saving || navigating;
  return createPortal(
    <div
      className={`modal-mask mp-scrim${required ? ' is-required' : ''}`}
      data-mp-stage={presence.stage}
      onMouseDown={required ? undefined : onClose}
    >
      <div
        className="modal create-ws-modal mp-panel"
        data-mp-stage={presence.stage}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="create-ws-modal-title"
      >
        <div className="modal-head">
          <h3 id="create-ws-modal-title">{editing ? t('编辑工作区') : t('新建工作区')}</h3>
          {!required ? <button type="button" className="modal-close" aria-label={t('关闭')} onClick={onClose}>
            ×
          </button> : null}
        </div>

        {required ? <p className="create-ws-lead">{t('创建一个工作区就可以使用了')}</p> : null}
        {guided && !editing && <p className="create-ws-lead">{t('使用推荐文件夹，或选择已有项目。该文件夹会作为会话的工作目录。')}</p>}
        {!editing && recommendedRoot && (!guided || !useRecommended) ? (
          <div className="create-ws-recommend">
            <span className="create-ws-recommend-text">
              {t('还没想好放哪里？用 {{path}} 试试', { path: recommendedRoot })}
            </span>
            <button type="button" className="ui-btn" disabled={locked} onClick={fillRecommended}>
              {guided ? t('使用推荐文件夹') : t('一键填入')}
            </button>
          </div>
        ) : null}

        <div className="create-ws-identity">
          <button type="button" className={`create-ws-avatar-preview${workspaceIconUrl(avatar) ? ' is-symbol' : ''}`} aria-label={t('更换头像')} aria-expanded={avatarExpanded}
            aria-controls="create-ws-avatar-options" disabled={locked} onClick={() => setAvatarExpanded(v => !v)}>
            {workspaceAvatarImageSrc(avatar) ? <img src={workspaceAvatarImageSrc(avatar)} alt="" /> : <span>{avatar}</span>}
          </button>
          <label className="create-ws-field">
            {t('工作区名称')}
            <input ref={nameRef} value={name} placeholder={t('名称')} autoFocus disabled={locked}
              onChange={e => { nameTouched.current = true; setName(e.target.value); }} />
          </label>
        </div>
        <div id="create-ws-avatar-options" className={`acc${avatarPresence.stage === 'in' ? ' is-open' : ''}`} {...avatarPresence.spread} {...(!avatarExpanded ? { inert: '' } : {})} aria-hidden={!avatarExpanded}>
          <div className="acc-body create-ws-avatar-options">
          <fieldset className="create-ws-avatar-lock" disabled={locked}>
            <AvatarPicker value={workspaceAvatarImageSrc(avatar) ?? avatar} onUpload={onCustomFile}
              imagePresets={WORKSPACE_PRESETS} selectedImagePreset={workspaceIconId(avatar)}
              onPickImagePreset={id => changeAvatar(workspaceIconValue(id))} allowEmoji={false} embedded />
          </fieldset>
          </div>
        </div>

        {multiFolder ? <div className="create-ws-field">
          <WorkspaceRootsEditor roots={roots} defaultRootId={defaultRootId} controlRootId={controlRootId} busy={locked} active={open}
            onPickingChange={setPickingRoots}
            onPick={async () => {
              const r = await window.api.workspaces.pickDir(true);
              return r.ok ? r.paths ?? (r.path ? [r.path] : undefined) : undefined;
            }}
            onChange={(next, id, management) => {
              // 只切换默认目录不算换路径，保留推荐根自动建目录的资格。
              if (next.length !== roots.length || next.some((root, i) => pathKey(root.path) !== pathKey(roots[i].path))) {
                setUseRecommended(false);
              }
              setRoots(next); setDefaultRootId(id); setControlRootId(management);
              setError(''); setRootDependencies([]);
              if (!nameTouched.current && !roots.length && next.length) setName(basenameHint(next[0].path));
            }} />
        </div> : <label className="create-ws-field">
          {t('目录')}
          <div className="create-ws-path-row">
            <input
              value={dirPath}
              readOnly
              placeholder={t('尚未选择')}
              title={dirPath}
            />
            {!editing ? (
              <button type="button" className="ui-btn" disabled={locked} onClick={() => void pickDir()}>
                {guided ? t('选择已有文件夹') : t('浏览…')}
              </button>
            ) : null}
          </div>
        </label>}

        {editing ? <>
        <button type="button" className="create-ws-settings-toggle" disabled={locked} aria-expanded={settingsExpanded}
          aria-controls="create-ws-settings" onClick={() => setSettingsExpanded(v => !v)}>
          {t('更多设置')}<IconChevronDown size={12} className={settingsExpanded ? 'is-open' : ''} />
        </button>
        <div id="create-ws-settings" className={`acc${settingsPresence.stage === 'in' ? ' is-open' : ''}`} {...settingsPresence.spread} {...(!settingsExpanded ? { inert: '' } : {})} aria-hidden={!settingsExpanded}>
        <div className="acc-body">
        {editing && initial?.id ? <WorktreePreparationSettings workspaceId={initial.id} active={open} busy={locked} /> : null}
        {onDelete ? <button type="button" className="btn danger create-ws-close-workspace" disabled={locked || !canDelete || confirmDelete}
          title={t('从已打开列表移除')} onClick={() => setConfirmDelete(true)}>{t('关闭工作区')}</button> : null}
        <AppConfirmDialog open={confirmDelete && open} title={t('关闭工作区')}
          detail={t('关闭工作区「{{name}}」？不会删除磁盘文件，仅从已打开列表移除。', { name: name.trim() || basenameHint(dirPath) || t('该工作区') })}
          confirmLabel={t('确认关闭')} danger onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { if (!locked && canDelete) void remove(); }}/>

        </div></div>
        </> : null}
        {error ? <ErrorTip message={error} /> : null}
        <WorkspaceRootDependencies dependencies={rootDependencies} roots={initial?.roots ?? roots} busy={locked} active={open}
          onOpen={onOpenDependency ? dependency => void openDependency(dependency) : undefined} />

        <div className="modal-actions create-ws-actions">
          <span />
          <div className="create-ws-actions-right">
            {!required ? <button
              type="button"
              className="btn"
              disabled={locked}
              onClick={() => {
                setConfirmDelete(false);
                onClose();
              }}
            >
              {t('取消')}
            </button> : null}
            <button
              type="button"
              className="btn primary"
              disabled={locked || (multiFolder ? !roots.some((r) => r.id === defaultRootId) : !dirPath.trim())}
              onClick={() => void submit()}
            >
              {busy || saving ? (editing ? t('保存中…') : t('创建中…')) : editing ? t('保存') : t('创建')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
