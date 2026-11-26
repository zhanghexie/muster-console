/**
 * GUI 会话的人机交互卡：工具审批 / 用户提问（ask_user_question / 计划审阅 / askQuestion）。
 * 挂在所属 assistant 消息内（anchorPartIndex 插槽）；子代理面板（BgTasksPanel）同用。
 * 应答直连 agentSession IPC——本文件属会话协议适配层，不面向通用视图。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import type { ChatUserQuestionView } from '../../../shared/types';
import { safeJson } from './safeJson';
import { IconChat } from '../components/icons';

export type UserQuestionRespondArgs = {
  questionId: string;
  action: 'answer' | 'abort';
  answers?: Array<{ id: string; selected: string[]; custom?: string }>;
};

/** 审批卡（挂在所属 assistant 消息后；子代理审批冒泡同用） */
export function ApprovalCard(props: {
  sessionId: string;
  approval: NonNullable<GuiChatMessage['approval']>;
}): React.JSX.Element {
  const { sessionId, approval } = props;
  const { t } = useTranslation();
  const [responding, setResponding] = React.useState(false);
  const [error, setError] = React.useState('');
  const submitted = React.useRef<string>();
  const respond = async (answer: { approved: boolean } | { nativeChoiceId: string }): Promise<void> => {
    if (submitted.current === approval.approvalId) return;
    submitted.current = approval.approvalId;
    setResponding(true);
    setError('');
    try {
      const result = await window.api.agentSession.respondApproval({
        sessionId,
        approvalId: approval.approvalId,
        ...answer
      });
      if (result.ok) return;
      setError(t('此审批请求已失效'));
    } catch (error) {
      setError(error instanceof Error ? error.message : t('此审批请求已失效'));
      submitted.current = undefined;
      setResponding(false);
    }
  };
  return (
    <div className="ac-approval">
      <div className="ac-approval-title">
        {approval.nativeSource ? `${approval.nativeSource} · ` : t('请求执行 ')}
        <code>{approval.toolName}</code>
      </div>
      {approval.reason ? <div className="ac-approval-reason">{approval.reason}</div> : null}
      {Object.keys(approval.input).length ? <pre className="ac-approval-args">{safeJson(approval.input)}</pre> : null}
      {error ? <div role="alert">{error}</div> : null}
      <div className="ac-approval-actions">
        {approval.nativeChoices ? approval.nativeChoices.map(choice => (
          <button key={choice.id} type="button"
            className={choice.kind?.startsWith('allow') || choice.kind === 'approved' ? 'ac-approval-allow' : 'ac-approval-deny'}
            disabled={responding}
            onClick={() => void respond({ nativeChoiceId: choice.id })}
            title={choice.description}>
            {choice.name}
            {choice.scope === 'persistent' ? <small> · {t('持久规则')}</small>
              : choice.scope === 'session' ? <small> · {t('本会话')}</small> : null}
          </button>
        )) : <>
        <button
          type="button"
          className="ac-approval-allow"
          disabled={responding}
          onClick={() => void respond({ approved: true })}
        >
          {t('允许')}
        </button>
        <button
          type="button"
          className="ac-approval-deny"
          disabled={responding}
          onClick={() => void respond({ approved: false })}
        >
          {t('拒绝')}
        </button>
        </>}
      </div>
    </div>
  );
}

/**
 * 用户提问卡（挂在所属 assistant 消息后；一次一张）：ask_user_question / 计划审阅 / askQuestion。
 * pending 可作答（单选/多选/自定义），answered/aborted 只读回显。
 * 多题分页：一次只展示一题（上一题 / 下一题）；题干与选项分层。
 * 语义与引擎问卷词表对齐：单选 custom 覆盖 selected；多选 custom 补充 selected。
 */
type UserQuestionCardProps = {
  sessionId: string;
  card: ChatUserQuestionView;
  /** 缺省走 GUI agentSession IPC；调度面传入 chat.respondUserQuestion */
  onRespond?: (args: UserQuestionRespondArgs) => Promise<{ ok: boolean }>;
};

export function UserQuestionCard(props: UserQuestionCardProps): React.JSX.Element {
  // 请求身份改变时整张表单重挂：答案、分页与提交中状态都不能跨请求继承。
  return <UserQuestionCardForm key={JSON.stringify([props.sessionId, props.card.questionId])} {...props} />;
}

function UserQuestionCardForm(props: UserQuestionCardProps): React.JSX.Element {
  const { sessionId, card, onRespond } = props;
  const { t } = useTranslation();
  const [answers, setAnswers] = React.useState<
    Record<string, { selected: string[]; custom: string }>
  >({});
  const [submitting, setSubmitting] = React.useState(false);
  const [page, setPage] = React.useState(0);

  const total = card.questions.length;
  const index = Math.min(Math.max(0, page), Math.max(0, total - 1));
  const q = card.questions[index];
  const header = <div className="ac-uq-head chat-card-header">
    <div className="ac-uq-heading">
      <span className="chat-card-header-icon" aria-hidden="true"><IconChat size={18}/></span>
      <span className="ac-uq-title">{t('Agent 提问')}</span>
    </div>
    <div className="ac-uq-meta">
      {card.status === 'pending' && total > 1 && <span className="ac-uq-step">{t('第 {{current}} 题 / 共 {{total}} 题', { current: index + 1, total })}</span>}
      <span className="ac-uq-status">{t(card.status === 'pending' ? '待回答' : card.status === 'answered' ? '已回答' : card.abortReason === 'superseded' ? '已被新消息取代' : '已取消')}</span>
    </div>
  </div>;

  const stateOf = (id: string): { selected: string[]; custom: string } =>
    answers[id] ?? { selected: [], custom: card.questions.find(item => item.id === id)?.textInput?.defaultValue ?? '' };
  const setStateOf = (id: string, next: { selected: string[]; custom: string }): void =>
    setAnswers((prev) => ({ ...prev, [id]: next }));

  const toggle = (item: ChatUserQuestionView['questions'][number], label: string): void => {
    const cur = stateOf(item.id);
    if (item.multiSelect) {
      setStateOf(item.id, {
        ...cur,
        selected: cur.selected.includes(label)
          ? cur.selected.filter((l) => l !== label)
          : [...cur.selected, label]
      });
    } else {
      setStateOf(item.id, { ...cur, selected: cur.selected[0] === label ? [] : [label] });
    }
  };

  const respond = async (args: UserQuestionRespondArgs): Promise<void> => {
    if (onRespond) {
      await onRespond(args);
      return;
    }
    await window.api.agentSession.respondUserQuestion({
      sessionId,
      questionId: args.questionId,
      action: args.action,
      answers: args.answers
    });
  };

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    try {
      await respond({
        questionId: card.questionId,
        action: 'answer',
        answers: card.questions.map((item) => {
          const cur = stateOf(item.id);
          if (item.textInput) return { id: item.id, selected: [], custom: cur.custom };
          const custom = cur.custom.trim();
          if (!item.multiSelect && custom) return { id: item.id, selected: [], custom };
          return { id: item.id, selected: cur.selected, ...(custom ? { custom } : {}) };
        })
      });
    } catch {
      /* 主进程侧已结时 sync 会翻卡面 */
    } finally {
      setSubmitting(false);
    }
  };

  const abort = async (): Promise<void> => {
    setSubmitting(true);
    try {
      await respond({ questionId: card.questionId, action: 'abort' });
    } catch {
      /* ignore */
    } finally {
      setSubmitting(false);
    }
  };

  if (card.status !== 'pending') {
    const answeredOf = (id: string) => card.answers?.find((a) => a.id === id);
    return (
      <div className="ac-uq is-settled">
        {header}
        <div className="ac-uq-body">
        {card.questions.map((item) => {
          const a = answeredOf(item.id);
          const text = item.textInput && typeof a?.custom === 'string' ?
            (a.custom === '' ? t('空文本') : a.custom.trim() ? a.custom : t('空白文本')) :
            a?.custom?.trim() ||
            (a?.selected?.length ? a.selected.join('、') : '') ||
            t('未作答');
          return (
            <div key={item.id} className="ac-uq-settled-row">
              <span className="ac-uq-settled-q">{item.question}</span>
              <span className="ac-uq-settled-a">{text}</span>
            </div>
          );
        })}
        </div>
      </div>
    );
  }

  if (!q) {
    return (
      <div className="ac-uq">
        {header}
        <div className="ac-uq-body">{t('Agent 需要你的回答')}</div>
      </div>
    );
  }

  const cur = stateOf(q.id);
  const approveLabel = q.intent?.kind === 'plan-review' ? q.intent?.approve : undefined;
  const last = index >= total - 1;
  const unanswered = card.questions.some((item) => {
    if (item.textInput) return false;
    const s = stateOf(item.id);
    return !s.selected.length && !s.custom.trim();
  });
  const paged = total > 1;

  return (
    <div className="ac-uq">
      {header}
      <div className="ac-uq-item ac-uq-body" key={q.id}>
        <div className="ac-uq-prompt">
          {q.header ? <span className="ac-uq-header">{q.header}</span> : null}
          <div className="ac-uq-q">
            {q.question}
            {q.multiSelect ? <span className="ac-uq-multi">{t('多选')}</span> : null}
          </div>
          {q.detail ? <div className="ac-uq-detail">{q.detail}</div> : null}
        </div>
        <div className="ac-uq-answers">
          {q.options?.length ? (
            <>
              <div className={q.multiSelect ? 'ac-uq-options is-multi' : 'ac-uq-options'}>
                {q.options.map((opt) => {
                  const active = cur.selected.includes(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      className={`ac-uq-option${active ? ' is-active' : ''}${
                        approveLabel === opt.label ? ' is-approve' : ''
                      }`}
                      title={opt.description}
                      aria-pressed={active}
                      disabled={submitting}
                      onClick={() => toggle(q, opt.label)}
                    >
                      <span className="ac-uq-option-label">{opt.label}</span>
                      {approveLabel === opt.label ? (
                        <span className="ac-uq-approve-badge">{t('批准')}</span>
                      ) : null}
                      {opt.description ? (
                        <span className="ac-uq-option-desc">{opt.description}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
          {q.textInput?.multiline ? <textarea
            className="ac-uq-custom" rows={4} placeholder={q.textInput.placeholder ?? t('自定义回答…')}
            value={cur.custom} disabled={submitting} onChange={(e) => setStateOf(q.id, { ...cur, custom: e.target.value })}
          /> : <input
            type="text" className="ac-uq-custom" placeholder={q.textInput?.placeholder ?? t('自定义回答…')}
            value={cur.custom} disabled={submitting} onChange={(e) => setStateOf(q.id, { ...cur, custom: e.target.value })}
          />}
        </div>
      </div>
      <div className="ac-uq-actions">
        {paged ? (
          <div className="ac-uq-nav">
            <button
              type="button"
              className="ac-approval-deny"
              disabled={submitting || index === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              {t('上一题')}
            </button>
            <button
              type="button"
              className="ac-approval-deny"
              disabled={submitting || last}
              onClick={() => setPage((p) => Math.min(total - 1, p + 1))}
            >
              {t('下一题')}
            </button>
          </div>
        ) : null}
        <div className="ac-uq-submit">
          {last ? (
            <button
              type="button"
              className="ac-approval-allow"
              disabled={submitting || unanswered}
              title={unanswered ? t('还有题目未作答；不想答可点「取消作答」') : undefined}
              onClick={() => void submit()}
            >
              {t('提交回答')}
            </button>
          ) : null}
          <button
            type="button"
            className="ac-approval-deny"
            disabled={submitting}
            onClick={() => void abort()}
          >
            {t('取消作答')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 调度面板提问卡：作答走 chat.respondUserQuestion（与 GUI agentSession 通道分开） */
export function DispatchUserQuestionCard(props: {
  workspaceId: string;
  card: ChatUserQuestionView;
}): React.JSX.Element {
  const { workspaceId, card } = props;
  return (
    <UserQuestionCard
      sessionId={workspaceId}
      card={card}
      onRespond={(args) =>
        window.api.chat.respondUserQuestion({
          workspaceId,
          questionId: args.questionId,
          action: args.action,
          answers: args.answers
        })
      }
    />
  );
}
