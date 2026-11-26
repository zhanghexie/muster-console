import { OperationButton } from '../../components/OperationButton';
/**
 * GitPanel 提交输入条（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，原样迁出）。
 * commitMsg 状态收敛在组件内部，每击键不再重渲整个 GitPanel；
 * 草稿经 draftRef 与外部共享，切详情 Tab / 切仓卸载后仍可恢复（对齐原整面板 state 行为）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconCheck } from '../../components/icons';

/**
 * 提交输入条：commitMsg 状态收敛在组件内部，每击键不再重渲整个 GitPanel。
 * 草稿经 draftRef 与外部共享，切详情 Tab / 切仓卸载后仍可恢复（对齐原整面板 state 行为）。
 * 自动增高用 rAF 延后到帧内，避免每击键同步读 scrollHeight 强制 layout。
 */
export function CommitBar({
  busy,
  draftRef,
  onCommit
}: {
  busy: boolean;
  draftRef: { current: string };
  onCommit: (msg: string) => Promise<boolean>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [msg, setMsg] = useState(() => draftRef.current);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // 自动增高挪进 rAF：击键事件内不同步读 scrollHeight（强制 layout），帧内量一次；
  // 上限与 CSS .git-commit-input 的 max-height 保持一致
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.style.height = '0px';
      el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    });
    return () => cancelAnimationFrame(raf);
  }, [msg]);

  const setDraft = useCallback(
    (v: string) => {
      draftRef.current = v;
      setMsg(v);
    },
    [draftRef]
  );

  return (
    <div className="git-commit-bar">
      <div className="git-commit-compose">
        <textarea
          ref={taRef}
          className="git-commit-input"
          placeholder={t('提交说明…')}
          aria-label={t('提交说明…')}
          rows={1}
          value={msg}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
        />
        <OperationButton
          type="button"
          className="git-btn primary git-commit-action"
          disabled={busy || !msg.trim()}
          onAction={async () => {
            if (await onCommit(msg)) setDraft('');
          }}
        >
          <IconCheck size={14} /> Commit
        </OperationButton>
      </div>
    </div>
  );
}
