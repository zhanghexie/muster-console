import { ErrorTip } from './ErrorTip';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { MarkdownBody } from './MarkdownBody';
import {
  closeTextToolRun,
  readTextToolRun,
  rerunTextTool,
  subscribeTextToolRun
} from './textToolRunner';
import { copySelectionText } from '../terminal/selectionActions';
import { useUiStore } from '../store';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { IconSpinner } from './icons';

/** 运行计时：每秒跳动，区分"在工作"与"卡死" */
function Elapsed({ seq }: { seq: number }): React.JSX.Element {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    setSec(0);
    const started = Date.now();
    const timer = setInterval(() => setSec(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [seq]);
  return <span className="tt-card-elapsed">{sec}s</span>;
}

/**
 * 文本工具结果卡（全局唯一宿主挂 App 根部，不随浮条卸载）：portal 到 body、
 * fixed 贴浮条原位。点击功能即弹卡：spinner → 流式增量（markdown）→ 完成/错误。
 */
export function TextToolResultCard(): React.JSX.Element | null {
  const { t } = useTranslation();
  const run = useSyncExternalStore(subscribeTextToolRun, readTextToolRun);
  const { flashTip } = useUiStore();
  const cardRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 框内贴底跟随：用户上翻即暂停（新增量不再拽回），翻回底部/新一轮自动恢复 */
  const followRef = useRef(true);
  const lastTopRef = useRef(0);

  // 打开期间占一层 overlay（Esc 关卡，先于设置壳等下层）
  useOverlayDismiss(!!run, closeTextToolRun);

  useEffect(() => {
    const card = cardRef.current;
    if (!card || !run) return;
    const rect = run.barRect;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect ? rect.left : (vw - cw) / 2;
    let top = rect ? rect.bottom + 8 : vh * 0.2;
    if (top + ch > vh - 8) top = rect ? Math.max(8, rect.top - ch - 8) : 8;
    if (left + cw > vw - 8) left = vw - cw - 8;
    left = Math.max(8, Math.min(left, Math.max(8, vw - cw - 8)));
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
  }, [run]);

  // 新一轮调用恢复跟随（用户上一轮翻过不影响新一轮）
  useEffect(() => {
    followRef.current = true;
  }, [run?.seq]);

  // 流式期间框内贴底跟随；用户上翻即暂停，翻回底部自动恢复
  useEffect(() => {
    const el = bodyRef.current;
    if (run?.status === 'running' && el && followRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [run?.result]);

  const onBodyScroll = (): void => {
    const el = bodyRef.current;
    if (!el) return;
    const goingUp = el.scrollTop < lastTopRef.current - 1;
    lastTopRef.current = el.scrollTop;
    if (goingUp) followRef.current = false;
    else followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  if (!run) return null;

  return createPortal(
    <div
      ref={cardRef}
      className="tt-card"
      role="dialog"
      aria-label={t('文本工具：{{name}}', { name: run.name })}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <header className="tt-card-head">
        {run.status === 'running' ? <IconSpinner size={12} /> : null}
        <span className="tt-card-name">{run.name}</span>
        {run.modelLabel ? <span className="tt-card-model">{run.modelLabel}</span> : null}
        {run.status === 'running' ? (
          <>
            <span className="tt-card-running">
              {run.reasoning && !run.result
                ? t('模型思考中…')
                : run.result
                  ? t('生成中…')
                  : t('正在调用模型…')}
            </span>
            <Elapsed seq={run.seq} />
          </>
        ) : null}
        <button
          type="button"
          className="icon-btn"
          aria-label={t('关闭')}
          tabIndex={-1}
          onClick={closeTextToolRun}
        >
          ×
        </button>
      </header>
      {run.status === 'error' ? <ErrorTip message={run.error} /> : run.result ? (
        <div ref={bodyRef} className="tt-card-body" onScroll={onBodyScroll}>
          <MarkdownBody text={run.result} />
          {run.status === 'running' ? <span className="tt-card-caret" aria-hidden /> : null}
        </div>
      ) : (
        <div className="tt-card-body">
          <p className="empty-hint">
            {run.reasoning
              ? t('模型在输出思考内容，正文马上就来…')
              : t('正在调用模型，请稍候…')}
          </p>
        </div>
      )}
      {run.status !== 'running' ? (
        <footer className="tt-card-footer">
          {run.status === 'done' ? (
            <button
              type="button"
              className="ui-btn tiny"
              tabIndex={-1}
              onClick={() => void copySelectionText(run.result ?? '', flashTip)}
            >
              {t('复制')}
            </button>
          ) : null}
          <button type="button" className="ui-btn tiny" tabIndex={-1} onClick={rerunTextTool}>
            {t('重新生成')}
          </button>
        </footer>
      ) : null}
    </div>,
    document.body
  );
}
