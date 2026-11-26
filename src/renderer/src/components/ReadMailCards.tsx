import { MarkdownBody } from './MarkdownBody';
import { useTranslation } from 'react-i18next';
import { EVENT_NOTIFICATION_SUBJECT_PREFIX, type ReadMailPresentation } from '../../../shared/mailReadPresentation';
import { DEFAULT_SUBAGENT_CHARACTER_ID } from '../../../shared/subagentCharacters';
import { ChatMessageAvatar } from './ChatMessageAvatar';
import { subagentAvatarUrl } from '../subagentAvatars';

export function ReadMailCards({ pages }: { pages: ReadMailPresentation[] }) {
  const { t } = useTranslation();
  return <>{pages.map(page => <div className="chat-msg assistant is-left-aligned" data-mail-read={page.key} key={page.key}>
    <ChatMessageAvatar sender="agent" face={{ type: 'image', shape: 'circle', value: subagentAvatarUrl(page.sender.characterId ?? DEFAULT_SUBAGENT_CHARACTER_ID) }} label={page.sender.name} />
    <div className="chat-msg-col">
      <div className="chat-body"><div className="chat-text read-mail-letter">
        <div className="read-mail-letter-heading">
          <svg className="read-mail-letter-mark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="1" /><path d="m3 6 9 7 9-7" /></svg>
          <span>{page.sender.name} · {t('来信')}{page.subject ? ` · ${page.hostEvent ? t('事件通知：{{kind}}', { kind: page.subject.slice(EVENT_NOTIFICATION_SUBJECT_PREFIX.length) }) : page.subject}` : ''}</span>
        </div>
        <MarkdownBody className="read-mail-letter-body" text={page.text} displayOnly />
      </div></div>
      {(page.offset > 0 || page.nextOffset != null) && <div className="chat-role">{t('已读取正文片段 · 第 {{start}}–{{end}} 字符', { start: page.offset + 1, end: page.offset + page.text.length })}</div>}
    </div>
  </div>)}</>;
}
