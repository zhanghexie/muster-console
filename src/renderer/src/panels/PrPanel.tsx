import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitHubConnection, PrFilter, PrRef, PrRepository, PrResult, PrSummary } from '../../../shared/githubPr';
import { AppConfirmDialog } from '../components/AppConfirmDialog';
import { ErrorTip } from '../components/ErrorTip';
import { IconBranch, IconChat, IconRefresh, IconSliders, IconSparkle, IconUnlink } from '../components/icons';
import { usePresenceValue } from '../components/motion';
import { useGitWorkspaceScope } from './gitpanel/GitWorkspaceScope';
import { GitHubAppSetupDialog } from './GitHubAppSetupDialog';
import { PrReviewPanel, PrStateBadges } from './PrReviewPanel';
import { showTip } from '../tips';

const POLL_INTERVAL = 45_000;
const AUTH_STATUS_INTERVAL = 1000;
const PERMISSION_LABELS = { pull_requests: 'Pull requests', contents: 'Contents', checks: 'Checks', statuses: 'Commit statuses' };
type Failure = Extract<PrResult<never>, { ok: false }>;

function seen(key: string, number: number): string | null {
  try {
    const value = (JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>)[number];
    return typeof value === 'string' ? value : null;
  } catch { return null; }
}

export function PrPanel({ repoPath, active, createdPr }: { repoPath: string; active: boolean; createdPr?: PrRef | null }): React.JSX.Element {
  const { t } = useTranslation();
  const workspace = useGitWorkspaceScope();
  const scope = useMemo(() => ({ ...workspace, repoPath }), [workspace, repoPath]);
  const [connection, setConnection] = useState<GitHubConnection>();
  const [repository, setRepository] = useState<PrRepository>();
  const [filter, setFilter] = useState<PrFilter>('authored');
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [failure, setFailure] = useState<Failure>();
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState(false);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [accountRevision, setAccountRevision] = useState(0);
  const [copyNotice, setCopyNotice] = useState<{ code: string; message: string }>();
  const { value: detail, presence } = usePresenceValue(selected);
  const activeList = useRef<(() => void) | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const more = useRef<object | null>(null);
  const extended = useRef(false);
  const openedCreation = useRef<PrRef | null>(null);
  const returnFocus = useRef<number | null>(null);
  const listOwner = useRef<object>({});
  const listIdentity = useRef<{ login: string; repository: string }>();
  const setupTrigger = useRef<HTMLButtonElement>(null);
  const authorizeButton = useRef<HTMLButtonElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const seenKey = repository && connection?.state === 'connected'
    ? `muster.prSeen.v2:${connection.login}:${repository.name.toLowerCase()}` : '';

  useEffect(() => {
    if (active && createdPr && createdPr !== openedCreation.current) {
      openedCreation.current = createdPr;
      setSelected(createdPr.number);
    }
  }, [active, createdPr]);

  useEffect(() => {
    if (!active) {
      setLoading(false);
      setSetupOpen(false);
      setConfirmAuto(false);
      return;
    }
    const owner = {};
    listOwner.current = owner;
    let stopped = false;
    let running = false;
    let queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !stopped && activeRef.current && listOwner.current === owner;
    const forgetRepository = () => {
      listIdentity.current = undefined;
      extended.current = false;
      setRepository(undefined);
      setPrs([]);
      setCursor(null);
      setSelected(null);
    };
    const refresh = async (mode: 'poll' | 'resume' | 'manual' = 'poll') => {
      if (!current() || document.hidden) return;
      if (more.current === owner || (mode === 'poll' && extended.current)) {
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(), POLL_INTERVAL);
        return;
      }
      if (running) { queued = true; return; }
      running = true;
      if (mode === 'manual') extended.current = false;
      clearTimeout(timer);
      setLoading(true);
      let wait = POLL_INTERVAL;
      try {
        const account = await window.api.pr.connection();
        if (!current()) return;
        if (!account.ok) {
          setFailure(account);
          if (account.kind === 'auth' || account.kind === 'configuration') {
            forgetRepository();
            setConnection({ state: account.kind === 'auth' ? 'signedOut' : 'unconfigured' });
          }
          return;
        }
        setConnection(account.value);
        if (account.value.state === 'pending') wait = AUTH_STATUS_INTERVAL;
        if (account.value.state !== 'connected') { forgetRepository(); setFailure(undefined); return; }
        const login = account.value.login.toLowerCase();
        if (listIdentity.current && listIdentity.current.login !== login) forgetRepository();
        const repo = await window.api.pr.repository(scope);
        if (!current()) return;
        if (!repo.ok) {
          if (repo.kind !== 'network' && repo.kind !== 'rateLimit' && repo.kind !== 'failed') forgetRepository();
          setFailure(repo);
          return;
        }
        const repository = repo.value.name.toLowerCase();
        if (listIdentity.current && listIdentity.current.repository !== repository) forgetRepository();
        listIdentity.current = { login, repository };
        setRepository(repo.value);
        if (extended.current) { setFailure(undefined); return; }
        const page = await window.api.pr.list(scope, filter);
        if (!current()) return;
        if (!page.ok) {
          if (page.kind !== 'network' && page.kind !== 'rateLimit' && page.kind !== 'failed') forgetRepository();
          setFailure(page);
          return;
        }
        setFailure(undefined);
        setPrs(page.value.prs);
        setCursor(page.value.cursor);
      } catch {
        if (current()) setFailure({ ok: false, kind: 'network', message: t('读取 GitHub 失败，请重试') });
      } finally {
        running = false;
        if (current()) {
          setLoading(false);
          const next = queued ? 0 : wait;
          queued = false;
          timer = setTimeout(() => void refresh(), next);
        }
      }
    };
    activeList.current = () => { void refresh('manual'); };
    void refresh('resume');
    const show = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', show);
    window.addEventListener('focus', show);
    return () => {
      stopped = true;
      listOwner.current = {};
      activeList.current = null;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', show);
      window.removeEventListener('focus', show);
    };
  }, [active, scope, filter, accountRevision, t]);

  useEffect(() => {
    if (active && connection?.state === 'pending') authorizeButton.current?.focus({ preventScroll: true });
  }, [active, connection?.state]);

  useEffect(() => {
    if (active && selected === null && !presence.mounted && returnFocus.current !== null) {
      list.current?.querySelector<HTMLButtonElement>(`[data-pr-number="${returnFocus.current}"]`)?.focus({ preventScroll: true });
      returnFocus.current = null;
    }
  }, [active, selected, presence.mounted]);

  const accountAction = async (kind: 'authorize' | 'disconnect') => {
    if (!activeRef.current || action) return;
    setAction(true);
    try {
      const result = await window.api.pr[kind]();
      if (!result.ok) { setFailure(result); return; }
      setFailure(undefined);
      setConnection(result.value);
      if (kind === 'disconnect') { listIdentity.current = undefined; setRepository(undefined); setSelected(null); setPrs([]); }
      activeList.current?.();
    } catch { setFailure({ ok: false, kind: 'failed', message: t('GitHub 操作失败，请重试') }); }
    finally { setAction(false); }
  };

  const loadMore = async () => {
    const owner = listOwner.current;
    if (!cursor || more.current === owner || loading) return;
    more.current = owner;
    setLoading(true);
    try {
      const result = await window.api.pr.list(scope, filter, cursor);
      if (owner !== listOwner.current) return;
      if (result.ok) {
        extended.current = true;
        setPrs(prev => [...new Map([...prev, ...result.value.prs].map(pr => [pr.number, pr])).values()]);
        setCursor(result.value.cursor);
      } else setFailure(result);
    } catch {
      if (owner === listOwner.current) setFailure({ ok: false, kind: 'network', message: t('读取 GitHub 失败，请重试') });
    } finally {
      if (more.current === owner) more.current = null;
      if (owner === listOwner.current) setLoading(false);
    }
  };

  const closeSetup = () => {
    setSetupOpen(false);
    if (activeRef.current) setupTrigger.current?.focus({ preventScroll: true });
  };

  const setupSaved = (next: GitHubConnection) => {
    listOwner.current = {};
    listIdentity.current = undefined;
    extended.current = false;
    setAccountRevision(value => value + 1);
    setConnection(next);
    setRepository(undefined);
    setPrs([]);
    setCursor(null);
    setSelected(null);
    setFailure(undefined);
    closeSetup();
    if (next.state === 'signedOut') void accountAction('authorize');
  };

  const openExternal = async (url: string) => {
    try {
      const result = await window.api.shell.openExternal(url);
      if (result?.ok === false) showTip(t('无法打开 GitHub，请检查系统默认浏览器后重试'), { tone: 'error' });
    } catch { showTip(t('无法打开 GitHub，请检查系统默认浏览器后重试'), { tone: 'error' }); }
  };

  const copyAndOpen = async (code: string, url: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopyNotice({ code, message: t('授权码已复制') });
    } catch {
      setCopyNotice({ code, message: t('复制失败，请选中授权码手动复制') });
      return;
    }
    await openExternal(url);
  };

  const markSeen = useCallback((pr: PrSummary) => {
    if (!seenKey) return;
    try {
      const history = JSON.parse(localStorage.getItem(seenKey) ?? '{}') as Record<string, string>;
      const latest = pr.latestDiscussionAt ?? '';
      if (history[pr.number] === undefined || latest > history[pr.number]) {
        localStorage.setItem(seenKey, JSON.stringify({ ...history, [pr.number]: latest }));
      }
    } catch {}
  }, [seenKey]);

  const setAutoReview = async (enabled: boolean) => {
    if (!activeRef.current || !repository || action) return;
    setAction(true);
    try {
      const result = await window.api.pr.setAutoReview(scope, repository.name, enabled);
      if (result.ok) {
        setRepository(current => current?.name === repository.name ? { ...current, autoReview: result.value.enabled } : current);
        setConfirmAuto(false);
      } else { setConfirmAuto(false); setFailure(result); }
    } catch {
      setConfirmAuto(false);
      setFailure({ ok: false, kind: 'failed', message: t('GitHub 操作失败，请重试') });
    } finally { setAction(false); }
  };

  const connected = connection?.state === 'connected';
  const access = repository?.appAccess;
  const repositoryName = repository?.name ?? 'GitHub';
  const toolbar = <div className="pr-toolbar">
    <div className="pr-toolbar-location">
      <IconBranch size={15} />
      <strong className="pr-toolbar-title" title={repositoryName}>{repositoryName}</strong>
    </div>
    <div className="pr-toolbar-actions">
      {connected && <span className="pr-viewer" title={`@${connection.login}`}>@{connection.login}</span>}
      <button type="button" className="right-icon" disabled={loading || action} aria-label={t('刷新')}
        onClick={() => activeList.current?.()}><IconRefresh size={15} /></button>
      {connection?.state !== 'pending' && connection?.state !== 'unconfigured' && (connection || failure) &&
        <button ref={setupTrigger} type="button" className="right-icon" disabled={action} aria-label={t('配置 GitHub')}
          title={t('配置 GitHub')} onClick={() => setSetupOpen(true)}><IconSliders size={15} /></button>}
      {(connected || failure?.kind === 'auth') && <button type="button" className="right-icon" disabled={action}
        aria-label={t('断开连接')} title={t('断开连接')} onClick={() => void accountAction('disconnect')}><IconUnlink size={15} /></button>}
    </div>
  </div>;
  return <div className="git-pr-pane" {...(!active ? { inert: '', 'aria-hidden': true } : {})}>
    {!(repository && connected) && toolbar}
    {failure && <div className="pr-feedback">
      <ErrorTip active={active} message={failure.message} />
      {failure.installUrl && <button type="button" className="git-btn" onClick={() => void openExternal(failure.installUrl!)}>{t('在 GitHub 授权仓库')}</button>}
    </div>}
    {connected && (access?.state === 'install' || access?.state === 'permissions') && <div className="pr-guide">
      <span role="status">{access.state === 'permissions'
        ? t('已安装的 GitHub App 缺少权限：{{permissions}}', { permissions: access.missing.map(permission => PERMISSION_LABELS[permission]).join(', ') })
        : t('请在 GitHub 授权此仓库，以启用 PR 创建和发布评审。')}</span>
      <button type="button" className="git-btn" onClick={() => void openExternal(access.url)}>
        {t(access.state === 'permissions' ? '在 GitHub 更新授权' : '在 GitHub 授权仓库')}
      </button>
    </div>}
    {connected && access?.state === 'unavailable' && <p className="pr-muted" role="status">
      {t('无法确认仓库授权状态。{{reason}}', { reason: access.message })}
    </p>}
    {connection?.state === 'unconfigured' && <div className="pr-guide">
      <span>{t('配置 GitHub App 后即可连接账号')}</span>
      <button ref={setupTrigger} type="button" className="git-btn" onClick={() => setSetupOpen(true)}>{t('配置 GitHub')}</button>
    </div>}
    {connection?.state === 'signedOut' && <div className="pr-guide">
      <span>{t('连接 GitHub 后查看和评审 PR')}</span>
      <button type="button" className="git-btn" disabled={action} onClick={() => void accountAction('authorize')}>{t('连接 GitHub')}</button>
    </div>}
    {connection?.state === 'pending' && <div className="pr-guide">
      <span role="status">{t('在 GitHub 输入授权码，完成后会自动连接')}</span>
      <code className="pr-device-code">{connection.userCode}</code>
      <div className="pr-toolbar-actions">
        <button ref={authorizeButton} type="button" className="git-btn" onClick={() => void copyAndOpen(connection.userCode, connection.verificationUrl)}>{t('复制授权码并打开 GitHub')}</button>
        <button type="button" className="git-btn ghost" onClick={() => void openExternal(connection.verificationUrl)}>{t('打开 GitHub 授权')}</button>
        <button type="button" className="git-btn ghost" disabled={action} onClick={() => void accountAction('disconnect')}>{t('取消')}</button>
      </div>
      {copyNotice?.code === connection.userCode && <p className="pr-muted" role="status">{copyNotice.message}</p>}
    </div>}
    {!connection && loading && <p className="empty-hint" role="status">{t('正在连接 GitHub…')}</p>}
    {repository && connected && <div className="pr-content">
      <div className="pr-board" hidden={selected !== null || presence.mounted}>
        {toolbar}
        <div className="pr-filter-bar">
          <div className="pr-toolbar-actions" role="group" aria-label={t('PR 筛选')}>
            <button type="button" className="git-btn ghost" aria-pressed={filter === 'authored'}
              onClick={() => { if (filter !== 'authored') { extended.current = false; setFilter('authored'); setPrs([]); setCursor(null); } }}>{t('我发起的')}</button>
            <button type="button" className="git-btn ghost" aria-pressed={filter === 'reviewRequested'}
              onClick={() => { if (filter !== 'reviewRequested') { extended.current = false; setFilter('reviewRequested'); setPrs([]); setCursor(null); } }}>{t('待我审')}</button>
          </div>
          <button type="button" className="right-icon" aria-pressed={repository.autoReview} disabled={action}
            aria-label={t('就绪时生成审查草稿')} title={t('就绪时生成审查草稿')}
            onClick={() => repository.autoReview ? void setAutoReview(false) : setConfirmAuto(true)}><IconSparkle size={15} /></button>
        </div>
        {loading && !prs.length && <p className="empty-hint" role="status">{t('正在读取 PR…')}</p>}
        {!loading && !failure && !prs.length && <p className="empty-hint">
          {filter === 'authored' ? t('没有你创建的 PR') : t('没有需要你评审的 PR')}
        </p>}
        <ul className="pr-list" ref={list}>
          {prs.map(pr => {
            const previous = seen(seenKey, pr.number);
            return <li key={pr.number}>
              <button type="button" className="pr-row" data-pr-number={pr.number} onClick={() => {
                returnFocus.current = pr.number; setSelected(pr.number);
              }}>
                <span className="pr-row-head"><span className="pr-number">#{pr.number}</span>
                  <span className="pr-title">{pr.title}</span>{pr.isDraft && <span className="pr-draft-tag">{t('草稿')}</span>}
                  {previous !== null && pr.latestDiscussionAt && pr.latestDiscussionAt > previous &&
                    <span className="pr-unread-badge" role="img" aria-label={t('新讨论')} title={t('新讨论')}><IconChat size={14} /></span>}
                </span>
                <span className="pr-row-meta"><span className="pr-branches">{pr.headRefName} → {pr.baseRefName}</span><PrStateBadges pr={pr} /></span>
              </button>
            </li>;
          })}
        </ul>
        {cursor && <button type="button" className="git-btn ghost" disabled={loading} onClick={() => void loadMore()}>{t('加载更多')}</button>}
      </div>
      {presence.mounted && detail !== null && (
        <div className="pr-detail-layer mp-panel" data-mp-stage={presence.stage} {...(selected === null ? { inert: '', 'aria-hidden': true } : {})}>
          <PrReviewPanel key={`${seenKey}:${detail}`} scope={scope} repository={repository.name} number={detail} login={connection.login} markSeen={markSeen}
            active={active && selected !== null}
            onClose={() => setSelected(null)} />
        </div>
      )}
    </div>}
    <GitHubAppSetupDialog open={active && setupOpen} connected={connected} onSaved={setupSaved} onClose={closeSetup} />
    <AppConfirmDialog open={active && confirmAuto} focusCancel busy={action} title={t('启用自动审查草稿')}
      detail={t('收到当前仓库签名的 PR 就绪事件时，Muster 会将该版本的 Diff 发给已配置的文本模型，生成本地草稿。')}
      confirmLabel={t('启用')} onConfirm={() => void setAutoReview(true)} onCancel={() => setConfirmAuto(false)} />
  </div>;
}
