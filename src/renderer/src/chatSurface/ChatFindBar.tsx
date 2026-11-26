/**
 * 会话查找浮条：共用 FindFloatBar + 全部会话结果列表。
 * 进出场 usePresence + mp-pop（禁止自造时长/keyframes）。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatSearchGroup, ChatSearchHit } from '../../../shared/chatSearch';
import { CHAT_SEARCH_MAX_HITS, sameChatSearchHitId } from '../../../shared/chatSearch';
import { FindFloatBar } from '../components/FindFloatBar';
import { IconLayers } from '../components/icons';
import { MOTION, usePresence } from '../components/motion';
import type { ChatFindScope } from './chatFindRegistry';

export function ChatFindBar(props: {
  open: boolean;
  query: string;
  onQueryChange: (q: string) => void;
  matchIndex: number;
  matchTotal: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  scope: ChatFindScope;
  onToggleScope: () => void;
  groups?: ChatSearchGroup[];
  activeHit?: ChatSearchHit | null;
  onJumpHit?: (hit: ChatSearchHit) => void;
  focusEpoch?: number;
  /** 全部会话范围内拉取失败的会话数（F-01）：尾部提示「结果可能不完整」 */
  failedSessions?: number;
  /** 命中触达上限被截断（F-02）：列表头部提示已截断 */
  truncated?: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const barPresence = usePresence(props.open, MOTION.menuMs);
  const listPresence = usePresence(
    props.open && props.scope === 'all' && props.query.trim().length > 0,
    MOTION.menuMs
  );

  if (!barPresence.mounted) return null;

  return (
    <div className="chat-find-pos" data-overlay-root="">
      <div className="chat-find-layer">
        <FindFloatBar
          open={props.open}
          query={props.query}
          onQueryChange={props.onQueryChange}
          placeholder={props.scope === 'all' ? t('搜索全部会话…') : t('搜索当前会话…')}
          inputAriaLabel={props.scope === 'all' ? t('搜索全部会话') : t('搜索当前会话')}
          ariaLabel={t('会话内查找')}
          matchIndex={props.matchIndex}
          matchTotal={props.matchTotal}
          onPrev={props.onPrev}
          onNext={props.onNext}
          onClose={props.onClose}
          focusEpoch={props.focusEpoch}
          extraTrailing={
            <button
              type="button"
              className={`search-bar-btn${props.scope === 'all' ? ' is-on' : ''}`}
              title={
                props.scope === 'all' ? t('正在搜索全部会话，点击改回当前会话') : t('搜索全部会话')
              }
              aria-label={
                props.scope === 'all' ? t('范围：全部会话') : t('范围：当前会话')
              }
              aria-pressed={props.scope === 'all'}
              onMouseDown={(e) => e.preventDefault()}
              onClick={props.onToggleScope}
            >
              <IconLayers size={12} />
            </button>
          }
        />
        {props.scope === 'current' && props.failedSessions ? (
          <div className="chat-find-incomplete" role="status">
            {t('{{n}} 个会话读取失败，结果可能不完整', { n: props.failedSessions })}
          </div>
        ) : null}
        {listPresence.mounted ? (
          <div
            className="chat-find-results mp-pop"
            {...listPresence.spread}
            role="listbox"
            aria-label={t('全部会话命中')}
          >
            {props.matchTotal === 0 ? (
              <div className="chat-find-empty">
                {t('无匹配的会话消息')}
                {props.failedSessions ? (
                  <div className="chat-find-incomplete" role="note">
                    {t('{{n}} 个会话读取失败，结果可能不完整', { n: props.failedSessions })}
                  </div>
                ) : null}
              </div>
            ) : (
              <>
                {props.truncated ? (
                  <div className="chat-find-truncated" role="note">
                    {t('命中已达 {{n}} 条上限，部分结果未显示，请缩小搜索范围', {
                      n: CHAT_SEARCH_MAX_HITS
                    })}
                  </div>
                ) : null}
                {(props.groups ?? []).map((g) => (
                  <div key={g.sessionId} className="chat-find-group">
                    <div className="chat-find-group-title">{g.sessionName}</div>
                    {g.hits.map((hit, i) => {
                      const active = props.activeHit ? sameChatSearchHitId(hit, props.activeHit) : false;
                      return (
                        <button
                          key={`${hit.messageId}:${hit.indexInMessage}:${i}`}
                          type="button"
                          role="option"
                          aria-selected={!!active}
                          className={`chat-find-hit${active ? ' is-active' : ''}`}
                          onClick={() => props.onJumpHit?.(hit)}
                        >
                          <span className="chat-find-hit-role">
                            {hit.role === 'user' ? t('用户') : t('助手')}
                          </span>
                          <span className="chat-find-hit-snip">{hit.snippet}</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
                {props.failedSessions ? (
                  <div className="chat-find-incomplete" role="note">
                    {t('{{n}} 个会话读取失败，结果可能不完整', { n: props.failedSessions })}
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
