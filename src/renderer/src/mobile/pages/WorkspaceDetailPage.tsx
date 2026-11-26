/**
 * 手机端 L2 工作区详情（mobile-remote-interaction-plan）：置顶调度 Agent 卡
 * （状态胶囊 + 低频消息预览，见 useDispatchDigest）+ 会话列表（needs_you 置顶）；
 * 「＋」弹底部抽屉选模式新建 GUI 会话（sessions.create 直建空会话，首条消息在
 * L3 输入框发——与桌面左栏 createTerminal 同一条管线）。
 *
 * T5.6：pty 会话可进 L3（仅回复框 → 邮箱存信）；GUI 会话进对话+审批卡。
 */
import React, { useMemo, useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { formatRelativeTime } from '../../../../shared/relativeTime';
import { sessionCliLabel, formatSessionListName } from '../../../../shared/sessionListName';
import { runtimeSurface } from '../../../../shared/types';
import { useRuntimesStore, useSessionStore, useWorkspaceStore } from '../../store';
import { TaskSourceField, useTaskSource } from '../../components/TaskSourceField';
import { MobileSheet } from '../MobileSheet';
import { useDispatchDigest } from '../useDispatchDigest';
import { capsuleKindClass, listableSession, sessionCapsule, sessionZone } from '../sessionStatus';
import { availableRuntimeEntries, runtimeSelectionAvailable, useRuntimeAvailability } from '../../hooks/useRuntimeAvailability';

export function WorkspaceDetailPage(props: {
  wsId: string;
  onBack: () => void;
  onOpenChat: (wsId: string, target: { kind: 'dispatch' } | { kind: 'session'; sessionId: string }) => void;
  onTip: (text: string) => void;
  children?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { sessions } = useSessionStore();
  const { runtimes } = useRuntimesStore();
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const { workspaces } = useWorkspaceStore();
  const workspace = workspaces.find(w => w.id === props.wsId);
  const source = useTaskSource(createOpen, workspace);
  const availability = useRuntimeAvailability(createOpen);
  const registeredRef = useRef(runtimes);
  registeredRef.current = runtimes;
  const generation = useRef(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; generation.current++; }; }, []);
  const lastWs = useRef(props.wsId);
  if (lastWs.current !== props.wsId) {
    lastWs.current = props.wsId;
    generation.current++;
    setCreating(false);
    setCreateOpen(false);
  }

  const digest = useDispatchDigest(props.wsId);

  const rows = useMemo(() => {
    const own = sessions.filter((s) => listableSession(s) && (s.workspaceId ?? '') === props.wsId);
    const zoneRank = (s: (typeof own)[number]): number => {
      const z = sessionZone(s);
      if (z === 'needsYou') return 0;
      if (s.pinned) return 1;
      return 2;
    };
    return [...own].sort((a, b) => {
      const r = zoneRank(a) - zoneRank(b);
      if (r !== 0) return r;
      return (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt);
    });
  }, [sessions, props.wsId]);

  const chatRuntimes = useMemo(
    () => availableRuntimeEntries(availability.snapshot, runtimes).filter(r => runtimeSurface(r) === 'chat'),
    [availability.snapshot, runtimes]
  );

  const isChatSession = (s: (typeof rows)[number]): boolean => {
    const entry = s.runtime ? runtimes.find((r) => r.id === s.runtime) : undefined;
    return runtimeSurface(entry) === 'chat';
  };

  const onRowTap = (s: (typeof rows)[number]): void => {
    props.onOpenChat(props.wsId, { kind: 'session', sessionId: s.id });
  };

  const onCreate = async (runtime: string): Promise<void> => {
    if (creating || !availability.ready || !source.target) return;
    const attempt = ++generation.current;
    setCreating(true);
    try {
      const checked = await availability.refresh(true) ?? availability.snapshot;
      if (!live.current || generation.current !== attempt) return;
      const piModeId = runtime === 'acp' ? checked?.acpAgents[0]?.id : undefined;
      if (!runtimeSelectionAvailable(checked, registeredRef.current, runtime, piModeId)) throw new Error(t('所选 Worker 已不可用，请重新选择'));
      const meta = await window.api.sessions.create({ runtime, ...source.target, ...(piModeId ? { piModeId } : {}) });
      if (!live.current || generation.current !== attempt) return;
      setCreateOpen(false);
      props.onOpenChat(props.wsId, { kind: 'session', sessionId: meta.id });
    } catch (e) {
      if (live.current && generation.current === attempt) props.onTip((e as Error).message || t('创建失败'));
    } finally {
      if (live.current && generation.current === attempt) setCreating(false);
    }
  };

  return (
    <div className="ma-page-body ma-ws-detail">
      {props.children}
      <main className="ma-scroll">
        <button
          type="button"
          className={`ma-dispatch-card${digest.busy ? ' busy' : ''}`}
          onClick={() => props.onOpenChat(props.wsId, { kind: 'dispatch' })}
        >
          <span className="ma-dispatch-icon" aria-hidden>
            ✦
          </span>
          <span className="ma-ws-info">
            <span className="ma-ws-name">{t('调度 Agent')}</span>
            <span className="ma-ws-sub">
              {digest.preview ||
                (digest.busy ? t('正在处理…') : t('工作区管家：对话 / 状态 / 远程审批'))}
            </span>
          </span>
          <span className={`ma-mini-capsule ${digest.busy ? 'work' : ''}`}>
            {digest.busy ? t('工作中') : t('待命')}
          </span>
        </button>

        <div className="ma-section-title">{t('会话')}</div>
        {rows.length === 0 ? (
          <div className="ma-empty">{t('暂无会话，点右上角「＋」新建')}</div>
        ) : (
          rows.map((s) => {
            const cap = sessionCapsule(s);
            return (
              <button
                type="button"
                key={s.id}
                className={`ma-session-row${sessionZone(s) === 'needsYou' ? ' needs' : ''}${
                  isChatSession(s) ? '' : ' is-cli'
                }`}
                onClick={() => onRowTap(s)}
              >
                <span className="ma-ws-info">
                  <span className="ma-ws-name">
                    {formatSessionListName(s.name, sessionCliLabel(s, runtimes))}
                  </span>
                  <span className="ma-ws-sub">
                    {formatRelativeTime(s.lastUsedAt ?? s.createdAt)}
                  </span>
                </span>
                <span className={capsuleKindClass(cap.kind) + (cap.exited ? ' dim' : '')}>
                  <span className="session-capsule-label">{cap.label}</span>
                </span>
              </button>
            );
          })
        )}
      </main>

      <button
        type="button"
        className="ma-fab"
        aria-label={t('新建会话')}
        disabled={creating || !workspace}
        onClick={() => setCreateOpen(true)}
      >
        ＋
      </button>

      <MobileSheet open={createOpen} onClose={() => { if (!creating) setCreateOpen(false); }} title={t('新建会话')}>
        <TaskSourceField source={source} disabled={creating} />
        {availability.loading || availability.error || chatRuntimes.length === 0 ? <div className="ma-sheet-note" role="status">
          {availability.loading ? t('正在检测 Worker…') : availability.error ? t('Worker 检测失败：{{message}}', { message: availability.error }) : t('暂无可用 Worker，请在设置中安装或配置')}
          {!availability.loading ? <button type="button" disabled={creating} onClick={() => void availability.refresh(true)}>{t('重新检测 Worker')}</button> : null}
        </div> : null}
        {chatRuntimes.map((r) => (
            <button
              type="button"
              key={r.id}
              className="ma-sheet-item"
              disabled={creating || !availability.ready || !source.target}
              onClick={() => void onCreate(r.id)}
            >
              {r.label}
            </button>
          ))}
      </MobileSheet>
    </div>
  );
}
