import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { AgentRuntimeEntry, SessionMeta, ShellProfile, WorkspaceInfo } from '../../../shared/types';
import type { SplitPaneRef } from '../../../shared/centerSplit';
import { AppLogo } from './AppLogo';
import { IconSearch, IconTerminal } from './icons';
import { NewTaskDialog } from './NewTaskDialog';
import { usePresence } from './motion';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';

/** Mounted only for an empty pane, keyed by workspace: late creation cannot fill another pane/workspace. */
export function SplitContentPicker({ choices, sessions, workspace, runtimes, labelFor, onSelect, testIdPrefix, onOpenWorkerSettings }: {
  choices: SplitPaneRef[];
  sessions: SessionMeta[];
  workspace?: WorkspaceInfo;
  runtimes: AgentRuntimeEntry[];
  labelFor: (ref: SplitPaneRef) => string;
  onSelect: (ref: SplitPaneRef) => void;
  testIdPrefix: string;
  onOpenWorkerSettings?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [taskOpen, setTaskOpen] = useState(false);
  const [shellOpen, setShellOpen] = useState(false);
  const shellPresence = usePresence(shellOpen);
  const shellPanel = useRef<HTMLDivElement>(null);
  const shellTrigger = useRef<HTMLButtonElement>(null);
  const [profiles, setProfiles] = useState<ShellProfile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createdId, setCreatedId] = useState<string | null>(null);
  const closeShell = (): void => {
    if (busy) return;
    setShellOpen(false);
    shellTrigger.current?.focus();
  };
  useOverlayDismiss(shellOpen, closeShell);
  useEffect(() => {
    if (shellOpen && shellPresence.mounted) shellPanel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [shellOpen, shellPresence.mounted]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void window.api.shell.listProfiles().then(list => { if (!cancelled && list?.length) setProfiles(list); })
      .catch(reason => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; alive.current = false; };
  }, []);
  useEffect(() => {
    if (createdId && sessions.some(session => session.id === createdId && session.workspaceId === workspace?.id)) {
      setCreatedId(null);
      onSelect({ kind: 'session', sessionId: createdId });
    }
  }, [createdId, sessions, workspace?.id, onSelect]);
  const created = (session?: SessionMeta): void => {
    if (alive.current && session?.id) setCreatedId(session.id);
  };
  const filtered = choices.filter(ref => labelFor(ref).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="center-split-pane-empty">
    <div className="center-snap-picker">
      <p className="hint-muted">{t('选择内容')}</p>
      <label className="center-snap-search"><IconSearch size={16} />
        <input type="search" aria-label={t('搜索会话、终端或工具')} placeholder={t('搜索会话、终端或工具')}
          value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      <div className="center-snap-create">
        <button type="button" className="ui-btn ghost" disabled={!workspace || busy} onClick={() => setTaskOpen(true)}>{t('新建会话')}</button>
        <button ref={shellTrigger} type="button" className="ui-btn ghost" disabled={!workspace || busy || !profiles.length}
          aria-haspopup="dialog" aria-expanded={shellOpen} onClick={() => { setError(''); setShellOpen(true); }}>{t('新建终端')}</button>
      </div>
      {error && !shellOpen && <p role="alert" className="hint-muted">{error}</p>}
      <div className="center-snap-assist" aria-label={t('选择内容')}>
        {filtered.map(choice => {
          const id = choice.kind === 'session' ? choice.sessionId : choice.kind === 'utility' ? choice.sel : 'empty';
          const shell = choice.kind === 'session' && sessions.find(session => session.id === choice.sessionId)?.launchKind === 'shell';
          return <button type="button" className="center-snap-assist-choice" key={`${choice.kind}:${id}`}
            data-testid={`${testIdPrefix}-${id}`} onClick={() => onSelect(choice)}>
            {shell ? <IconTerminal size={18} /> : <AppLogo size={18} />}<span>{labelFor(choice)}</span>
          </button>;
        })}
        {!filtered.length && <p className="hint-muted">{query.trim() ? t('没有匹配的内容') : t('暂无可选内容')}</p>}
      </div>
    </div>
    {shellPresence.mounted && createPortal(
      <div className="new-task-overlay mp-scrim" {...shellPresence.spread}
        ref={element => { if (element) { if (shellOpen) element.removeAttribute('inert'); else element.setAttribute('inert', ''); } }} aria-hidden={!shellOpen || undefined}
        onMouseDown={event => { if (event.target === event.currentTarget) closeShell(); }}>
        <div ref={shellPanel} className="new-task-dialog split-shell-dialog mp-panel" {...shellPresence.spread}
          role="dialog" aria-modal="true" aria-label={t('选择 Shell')}
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeShell(); }
            if (event.key === 'Tab') {
              const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
              const first = buttons[0], last = buttons[buttons.length - 1];
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
          }}>
          <h3>{t('选择 Shell')}</h3>
          <div className="split-shell-list">
            {profiles.map(profile => <button type="button" className="center-snap-assist-choice" key={profile.id} disabled={busy}
              onClick={async () => {
                if (!workspace || busy) return;
                setBusy(true); setError('');
                try {
                  created(await window.api.sessions.create({ shellProfileId: profile.id, workspaceId: workspace.id, rootsRevision: workspace.rootsRevision, activate: false }));
                  if (alive.current) { setShellOpen(false); shellTrigger.current?.focus(); }
                } catch (reason) { if (alive.current) setError(String(reason)); }
                finally { if (alive.current) setBusy(false); }
              }}><IconTerminal size={18} /><span>{profile.label}</span></button>)}
          </div>
          {error && <p role="alert">{error}</p>}
          <button type="button" className="ui-btn ghost" disabled={busy} onClick={closeShell}>{busy ? t('创建中…') : t('取消')}</button>
        </div>
      </div>, document.body)}
    <NewTaskDialog open={taskOpen} runtimes={runtimes} workspace={workspace} onClose={() => setTaskOpen(false)}
      onOpenWorkerSettings={onOpenWorkerSettings ? () => { setTaskOpen(false); onOpenWorkerSettings(); } : undefined}
      onBlankSession={async (runtime, name, advanced, source, isolation) => {
        created(await window.api.sessions.create({ runtime, name: name || undefined, ...advanced, ...source, ...isolation, activate: false }));
      }}
      onDelegate={async ({ task, attachments, submissionId, runtime, isolate, isolationGroups, name, advanced, source }) => {
        const result = await window.api.sessions.delegate({ task, submissionId, ...(attachments?.length ? { attachments } : {}), runtime, isolate, isolationGroups, name: name || undefined, ...advanced, ...source, select: false });
        created(result.session);
        return result;
      }} />
  </div>;
}
