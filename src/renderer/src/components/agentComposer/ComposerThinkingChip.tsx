import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GUI_THINKING_LEVELS } from '../../../../shared/thinkingLevels';
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick';
import { usePresence, MOTION } from '../motion';
import { thinkingLevelLabel } from './composerHelpers';
import { IconThinking } from '../icons';

/** 会话级思考档 chip（Pi + 服务商配置了思考映射）：五档 + 跟随默认，热生效 */
export function ComposerThinkingChip({
  thinking
}: {
  thinking: {
    level: string | null;
    onChange: (level: string | null) => void;
  };
}): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const presence = usePresence(open, MOTION.menuMs);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsideClick(open, wrapRef, () => setOpen(false));
  const levels = GUI_THINKING_LEVELS;
  return (
    <div className="agent-mode-wrap agent-thinking-wrap" ref={wrapRef}>
      <button
        type="button"
        className="agent-mode-chip agent-thinking-chip"
        title={t('模型思考强度（服务商映射在 设置 → 模型服务商 配置；下回合起生效）')}
        onClick={() => setOpen((v) => !v)}
      >
        <IconThinking size={12} className="agent-thinking-glyph" />
        <span className="agent-thinking-chip-text">
          {t('思考')}
          <span className="agent-thinking-chip-level">
            {thinking.level ? thinkingLevelLabel(thinking.level) : t('默认')}
          </span>
        </span>
        <span className="agent-mode-caret" aria-hidden>
          ▾
        </span>
      </button>
      {presence.mounted && (
        <div
          className="agent-mode-menu mp-pop mp-pop-up"
          data-mp-stage={presence.stage}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className={`agent-mode-item${!thinking.level ? ' is-active' : ''}`}
            onClick={() => {
              setOpen(false);
              thinking.onChange(null);
            }}
          >
            <span>{t('跟随默认')}</span>
            {!thinking.level ? <span className="agent-mode-item-check" aria-hidden>✔</span> : null}
          </button>
          {levels.map((lv) => (
            <button
              key={lv}
              type="button"
              role="menuitem"
              className={`agent-mode-item${thinking.level === lv ? ' is-active' : ''}`}
              onClick={() => {
                setOpen(false);
                thinking.onChange(lv);
              }}
            >
              <span>{thinkingLevelLabel(lv)}</span>
              {thinking.level === lv ? (
                <span className="agent-mode-item-check" aria-hidden>
                  ✔
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
