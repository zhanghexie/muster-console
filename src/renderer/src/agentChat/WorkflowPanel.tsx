import { ErrorTip, ErrorTipDetails } from '../components/ErrorTip';
import { AppConfirmDialog } from '../components/AppConfirmDialog';
/**
 * 工作流面板（dynamic-workflow）：与输入壳同宽的上弹浮层，两个标签——
 * 「运行」：运行中（run 卡片：阶段 / 在等什么 / 待答问题；问用户的问题可直接选项或输入答复；
 * 日志展开；取消可勾选同时关闭派出的会话）+ 最近结束；
 * 「列表」：工作流清单（触发与信任状态，信任 / 撤销信任、停用 / 启用触发、删除）。
 * 打开时有运行中的 run 落「运行」，否则落「列表」。问调度的问题只展示，由调度答复。
 */
import React, { useState } from 'react';
import type { WorkflowOverview, WorkflowOverviewItem, WorkflowRunView } from '../../../shared/workflow';
import { t } from '../../../shared/i18n';

function fmtTime(ms: number | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

function statusText(s: WorkflowRunView['status']): string {
  switch (s) {
    case 'running':
      return t('运行中');
    case 'waiting':
      return t('等待中');
    case 'completed':
      return t('已完成');
    case 'failed':
      return t('失败');
    case 'cancelled':
      return t('已取消');
    default:
      return t('已中断');
  }
}

function triggerText(tr: WorkflowRunView['trigger']): string | null {
  if (tr === 'schedule') return t('定时');
  if (tr === 'event') return t('事件');
  return null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** preload 不随热更新重载：新加的接口在旧窗口里不存在，同步 TypeError 转成行内提示而非渲染层崩溃 */
function callWorkflowApi<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err instanceof TypeError ? new Error(t('工作流接口未就绪，请完全重启应用（勿只靠热更新）')) : err);
  }
}

function HumanAskForm(props: {
  workspaceId: string;
  run: WorkflowRunView;
  onChanged: () => void;
}): React.JSX.Element {
  const ask = props.run.pendingAsk!;
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (answer: string | string[]): void => {
    setBusy(true);
    setError(null);
    callWorkflowApi(() => window.api.workflow.answer(props.workspaceId, props.run.runId, ask.askId, answer))
      .then(() => props.onChanged())
      .catch((err) => setError(errMsg(err)))
      .finally(() => setBusy(false));
  };

  const custom = text.trim();
  const multiAnswer = custom ? [...picked, custom] : picked;
  return (
    <div className="wf-ask is-human">
      <div className="wf-ask-q">{ask.question}</div>
      {ask.options?.length && !ask.multi ? (
        <div className="wf-ask-options">
          {ask.options.map((o) => (
            <button key={o} type="button" className="bg-btn" disabled={busy} onClick={() => submit(o)}>
              {o}
            </button>
          ))}
        </div>
      ) : null}
      {ask.options?.length && ask.multi ? (
        <div className="wf-ask-options is-multi">
          {ask.options.map((o) => (
            <label key={o} className="wf-check">
              <input
                type="checkbox"
                checked={picked.includes(o)}
                onChange={(e) => setPicked((p) => (e.target.checked ? [...p, o] : p.filter((x) => x !== o)))}
              />
              {o}
            </label>
          ))}
        </div>
      ) : null}
      <form
        className="wf-ask-input"
        onSubmit={(e) => {
          e.preventDefault();
          if (ask.multi) {
            if (multiAnswer.length) submit(multiAnswer);
          } else if (custom) submit(custom);
        }}
      >
        <input
          type="text"
          value={text}
          placeholder={ask.options?.length ? t('或输入其他答复') : t('输入答复')}
          aria-label={t('答复')}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />
        <button
          type="submit"
          className="bg-btn"
          disabled={busy || (ask.multi ? multiAnswer.length === 0 : !custom)}
        >
          {t('提交')}
        </button>
      </form>
      {error ? <ErrorTip message={error} /> : null}
    </div>
  );
}

function RunLog(props: { run: WorkflowRunView }): React.JSX.Element {
  return (
    <ol className="wf-log">
      {props.run.log.map((e, i) => (
        <li key={`${e.ts}-${i}`}>
          <span className="wf-log-ts">{fmtTime(e.ts)}</span>
          <span className="wf-log-text">{e.text}</span>
        </li>
      ))}
    </ol>
  );
}

function RunCard(props: {
  workspaceId: string;
  run: WorkflowRunView;
  subRuns: WorkflowRunView[];
  onChanged: () => void;
}): React.JSX.Element {
  const { run } = props;
  const [showLog, setShowLog] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [closeSessions, setCloseSessions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const all = [run, ...props.subRuns];
  const sessionCount = new Set(all.flatMap((r) => r.sessions ?? [])).size;
  const asking = all.find((r) => r.pendingAsk);
  const trig = triggerText(run.trigger);

  const doCancel = (): void => {
    setBusy(true);
    setError(null);
    callWorkflowApi(() => window.api.workflow.cancel(props.workspaceId, run.runId, closeSessions))
      .then((r) => {
        const failed = Array.isArray(r?.failed) ? (r.failed as Array<{ sessionId: string; error: string }>) : [];
        if (failed.length) setError(t('{{n}} 个会话没关掉：{{detail}}', { n: failed.length, detail: failed.map((f) => f.error).join('；') }));
        setConfirming(false);
        props.onChanged();
      })
      .catch((err) => setError(errMsg(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className={`wf-run is-${run.status}`} data-run-id={run.runId}>
      <div className="wf-run-head">
        <span className="wf-run-name">{run.name}</span>
        <span className="wf-chip">{statusText(run.status)}</span>
        {trig ? <span className="wf-chip is-trigger">{trig}</span> : null}
        <span className="bg-tasks-spacer" />
        <span className="wf-run-meta">
          {t('派活 {{d}} · 已运行 {{m}} 分钟', { d: run.delegates, m: run.activeMinutes })}
        </span>
      </div>
      {run.phase ? <div className="wf-run-line">{t('阶段：{{phase}}', { phase: run.phase })}</div> : null}
      {props.subRuns.map((c) => (
        <div key={c.runId} className="wf-run-line is-sub">
          {t('子工作流 {{name}}：{{status}}', { name: c.name, status: statusText(c.status) })}
          {c.phase ? ` · ${c.phase}` : ''}
        </div>
      ))}
      {asking?.pendingAsk?.to === 'human' ? (
        <HumanAskForm workspaceId={props.workspaceId} run={asking} onChanged={props.onChanged} />
      ) : asking?.pendingAsk ? (
        <div className="wf-ask">
          <div className="wf-ask-label">{t('等调度判断')}</div>
          <div className="wf-ask-q">{asking.pendingAsk.question}</div>
        </div>
      ) : run.waiting ? (
        <div className="wf-run-line is-waiting">{run.waiting}</div>
      ) : null}
      <div className="wf-run-actions">
        <button type="button" className="bg-btn ghost" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
          {showLog ? t('收起日志') : t('日志')}
        </button>
        <span className="bg-tasks-spacer" />
        {confirming ? (
          <>
            {sessionCount > 0 ? (
              <label className="wf-check">
                <input type="checkbox" checked={closeSessions} onChange={(e) => setCloseSessions(e.target.checked)} />
                {t('同时关闭派出的 {{n}} 个会话', { n: sessionCount })}
              </label>
            ) : null}
            <button type="button" className="bg-btn ghost" onClick={() => setConfirming(false)} disabled={busy}>
              {t('返回')}
            </button>
            <button type="button" className="bg-btn danger" onClick={doCancel} disabled={busy}>
              {t('确认取消')}
            </button>
          </>
        ) : (
          <button type="button" className="bg-btn ghost" onClick={() => setConfirming(true)}>
            {t('取消运行')}
          </button>
        )}
      </div>
      {showLog ? <RunLog run={run} /> : null}
      {error ? <ErrorTip message={error} /> : null}
    </div>
  );
}

function RecentRow(props: { workspaceId: string; run: WorkflowRunView; onChanged: () => void }): React.JSX.Element {
  const { run } = props;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trig = triggerText(run.trigger);
  const remove = (): void => {
    setBusy(true);
    setError(null);
    callWorkflowApi(() => window.api.workflow.clearRuns(props.workspaceId, [run.runId]))
      .then(() => props.onChanged())
      .catch((err) => setError(errMsg(err)))
      .finally(() => setBusy(false));
  };
  return (
    <div className={`wf-recent is-${run.status}`}>
      <button type="button" className="wf-recent-row" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="wf-run-name">{run.name}</span>
        <span className="wf-chip">{statusText(run.status)}</span>
        {trig ? <span className="wf-chip is-trigger">{trig}</span> : null}
        <span className="bg-tasks-spacer" />
        <span className="wf-run-meta">{fmtTime(run.endedAt ?? run.updatedAt)}</span>
      </button>
      {open ? (
        <div className="wf-recent-detail">
          {run.error ? <ErrorTipDetails message={run.error} /> : null}
          {run.result !== undefined && run.result !== null ? (
            <pre className="wf-result">{typeof run.result === 'string' ? run.result : JSON.stringify(run.result, null, 2)}</pre>
          ) : null}
          <RunLog run={run} />
          <div className="wf-run-actions">
            <span className="bg-tasks-spacer" />
            <button type="button" className="bg-btn ghost" disabled={busy} onClick={remove}>
              {t('删除记录')}
            </button>
          </div>
          {error ? <ErrorTip message={error} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function RecentSection(props: { workspaceId: string; runs: WorkflowRunView[]; onChanged: () => void }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clearAll = (): void => {
    setBusy(true);
    setError(null);
    callWorkflowApi(() => window.api.workflow.clearRuns(props.workspaceId))
      .then(() => {
        setConfirming(false);
        props.onChanged();
      })
      .catch((err) => setError(errMsg(err)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="wf-section" aria-label={t('最近')}>
      <div className="wf-section-head">
        <div className="wf-section-title">{t('最近')}</div>
        <span className="bg-tasks-spacer" />
        <button type="button" className="bg-btn ghost" disabled={busy} onClick={() => setConfirming(true)}>{t('清空历史')}</button>
        <AppConfirmDialog open={confirming} title={t('清空历史')} detail={t('删除全部已结束的运行记录')}
          confirmLabel={t('确认清空')} danger onCancel={() => setConfirming(false)}
          onConfirm={() => { if (!busy) { setConfirming(false); clearAll(); } }}/>

      </div>
      {error ? <ErrorTip message={error} /> : null}
      {props.runs.map((r) => (
        <RecentRow key={r.runId} workspaceId={props.workspaceId} run={r} onChanged={props.onChanged} />
      ))}
    </section>
  );
}

function trustText(w: WorkflowOverviewItem): string {
  if (w.trust === 'trusted') return t('已信任');
  if (w.trust === 'changed') return t('已修改，待确认');
  return t('未信任');
}

function WorkflowRow(props: { workspaceId: string; wf: WorkflowOverviewItem; onChanged: () => void }): React.JSX.Element {
  const { wf } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const hasTrigger = !!(wf.schedule || wf.on);
  const act = (fn: () => Promise<unknown>): void => {
    setBusy(true);
    setError(null);
    callWorkflowApi(fn)
      .then(() => props.onChanged())
      .catch((err) => setError(errMsg(err)))
      .finally(() => setBusy(false));
  };
  return (
    <div className={`wf-def${wf.errors?.length ? ' has-error' : ''}`} data-workflow={wf.name}>
      <div className="wf-run-head">
        <span className="wf-run-name">{wf.name}</span>
        <span className={`wf-chip is-trust-${wf.trust}`}>{trustText(wf)}</span>
        <span className="bg-tasks-spacer" />
        {wf.errors?.length ? null : wf.trust === 'trusted' ? (
          <button type="button" className="bg-btn ghost" disabled={busy} onClick={() => act(() => window.api.workflow.revokeTrust(props.workspaceId, wf.name))}>
            {t('撤销信任')}
          </button>
        ) : (
          <button type="button" className="bg-btn" disabled={busy} onClick={() => act(() => window.api.workflow.trust(props.workspaceId, wf.name))}>
            {t('信任')}
          </button>
        )}
      </div>
      {wf.description ? <div className="wf-run-line">{wf.description}</div> : null}
      {wf.args?.length ? <div className="wf-run-line is-dim">{t('参数：{{args}}', { args: wf.args.join(', ') })}</div> : null}
      {wf.schedule ? <div className="wf-run-line is-dim">{t('定时：{{s}}', { s: wf.schedule })}</div> : null}
      {wf.on ? (
        <div className="wf-run-line is-dim">{t('事件：{{s}}（冷却 {{m}} 分钟）', { s: wf.on, m: wf.cooldownMin ?? 0 })}</div>
      ) : null}
      {hasTrigger && wf.triggersDisabled ? (
        <div className="wf-run-line is-warn">{t('触发已停用：不会按定时/事件自动运行，可随时启用')}</div>
      ) : hasTrigger && wf.trust !== 'trusted' ? (
        <div className="wf-run-line is-warn">{t('触发未生效：点「信任」后才会按定时/事件自动运行')}</div>
      ) : null}
      {wf.nextDueAt ? <div className="wf-run-line is-dim">{t('下次：{{time}}', { time: fmtTime(wf.nextDueAt) })}</div> : null}
      {wf.lastFiredAt ? <div className="wf-run-line is-dim">{t('上次触发：{{time}}', { time: fmtTime(wf.lastFiredAt) })}</div> : null}
      {wf.lastSkip ? (
        <div className="wf-run-line is-warn">
          {t('{{time}} 跳过：{{reason}}', { time: fmtTime(wf.lastSkip.at), reason: wf.lastSkip.reason })}
        </div>
      ) : null}
      {wf.errors?.length ? <ErrorTipDetails message={wf.errors.join('\n')} /> : null}
      {wf.warnings?.map((w) => (
        <div key={w} className="wf-run-line is-warn">
          {w}
        </div>
      ))}
      <div className="wf-run-actions">
        {hasTrigger && !wf.errors?.length ? (
          <button
            type="button"
            className="bg-btn ghost"
            disabled={busy}
            onClick={() => act(() => window.api.workflow.setTriggers(props.workspaceId, wf.name, !!wf.triggersDisabled))}
          >
            {wf.triggersDisabled ? t('启用触发') : t('停用触发')}
          </button>
        ) : null}
        <span className="bg-tasks-spacer" />
        <button type="button" className="bg-btn ghost" disabled={busy} onClick={() => setConfirmingDelete(true)}>{t('删除')}</button>
        <AppConfirmDialog open={confirmingDelete} title={t('确认删除')} detail={`${wf.name}\n${t('目录将移到回收站')}`}
          confirmLabel={t('确认删除')} danger onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => { setConfirmingDelete(false); act(() => window.api.workflow.delete(props.workspaceId, wf.name)); }}/>

      </div>
      {error ? <ErrorTip message={error} /> : null}
    </div>
  );
}

export function WorkflowPanel(props: {
  workspaceId: string;
  overview: WorkflowOverview;
  stage: 'enter' | 'in' | 'out';
  onClose: () => void;
  onChanged: () => void;
  outerRef?: (node: HTMLDivElement | null) => void;
}): React.JSX.Element {
  const { overview } = props;
  const tops = overview.active.filter((r) => !r.parentRunId);
  const [tab, setTab] = useState<'runs' | 'defs'>(() => (tops.length ? 'runs' : 'defs'));
  const subsOf = (id: string): WorkflowRunView[] => {
    const out: WorkflowRunView[] = [];
    const walk = (pid: string): void => {
      for (const r of overview.active) {
        if (r.parentRunId === pid) {
          out.push(r);
          walk(r.runId);
        }
      }
    };
    walk(id);
    return out;
  };
  return (
    <div
      className="bg-tasks-pop wf-pop mp-pop mp-pop-up"
      role="dialog"
      aria-label={t('工作流')}
      data-mp-stage={props.stage}
      ref={props.outerRef}
    >
      <div className="bg-tasks-head">
        <span className="bg-tasks-title">{t('工作流')}</span>
        <div
          className="board-view-switch wf-tabs"
          role="tablist"
          aria-label={t('工作流视图')}
          title={t('左右方向键切换视图')}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            setTab((v) => (v === 'runs' ? 'defs' : 'runs'));
          }}
        >
          <button type="button" role="tab" aria-selected={tab === 'runs'} className="board-view-tab" onClick={() => setTab('runs')}>
            {t('运行')}
            {tops.length ? <span className="wf-tab-count">{tops.length}</span> : null}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'defs'} className="board-view-tab" onClick={() => setTab('defs')}>
            {t('列表')}
            {overview.workflows.length ? <span className="wf-tab-count">{overview.workflows.length}</span> : null}
          </button>
        </div>
        <span className="bg-tasks-spacer" />
        <button type="button" className="bg-btn ghost" onClick={props.onClose}>
          {t('关闭面板')}
        </button>
      </div>
      {tab === 'runs' ? (
        <div className="wf-body" role="tabpanel" aria-label={t('运行')}>
          <section className="wf-section" aria-label={t('运行中')}>
            <div className="wf-section-title">{t('运行中')}</div>
            {tops.length ? (
              tops.map((r) => (
                <RunCard key={r.runId} workspaceId={props.workspaceId} run={r} subRuns={subsOf(r.runId)} onChanged={props.onChanged} />
              ))
            ) : (
              <div className="empty-hint wf-empty">{t('没有运行中的工作流。在输入框用 /workflow 名字 启动。')}</div>
            )}
          </section>
          {overview.recent.length ? (
            <RecentSection workspaceId={props.workspaceId} runs={overview.recent} onChanged={props.onChanged} />
          ) : null}
        </div>
      ) : (
        <div className="wf-body" role="tabpanel" aria-label={t('列表')}>
          {overview.workflows.length ? (
            overview.workflows.map((w) => (
              <WorkflowRow key={w.name} workspaceId={props.workspaceId} wf={w} onChanged={props.onChanged} />
            ))
          ) : (
            <div className="empty-hint wf-empty">{t('还没有工作流。在输入框用 /workflow-new 描述想自动化的流程。')}</div>
          )}
        </div>
      )}
    </div>
  );
}
