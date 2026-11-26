import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  detectFirstUrl,
  joinTokens,
  looksLikePath,
  tokenizeForBangLimited
} from '../../../shared/terminalSelectionText';
import {
  beginSelectionDrag,
  copySelectionText,
  openSelectionUrl,
  previewSelectionPath,
  revealSelectionPath,
  searchSelectionText,
  selectionHasPath,
  selectionHasPreviewablePath
} from '../terminal/selectionActions';
import type { SelectionBangState } from './selectionMenuController';
import { selectionFileOwner, type SelectionMenuServices } from './selectionMenuAreas';
import { openUiArtifactsInBrowser, uiArtifactLinksInText } from '../terminal/uiArtifactOpen';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';

function chipIndexFromPoint(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const chip = el.closest('[data-bang-i]') as HTMLElement | null;
  if (!chip) return null;
  const i = Number(chip.dataset.bangI);
  return Number.isFinite(i) ? i : null;
}

/** base ∪ [from, to]：选择只累加，不动手势开始前已选中的词 */
function unionRange(base: Set<number>, from: number, to: number): Set<number> {
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  const next = new Set(base);
  for (let i = a; i <= b; i++) next.add(i);
  return next;
}

interface Props {
  state: SelectionBangState;
  services: SelectionMenuServices;
  onClose: () => void;
}

/** 「爆炸」分词点选浮层（全局）：portal 到 body、fixed 全屏遮罩，来源不限终端 */
export function SelectionBangOverlay({ state, services, onClose }: Props): React.JSX.Element {
  const { t } = useTranslation();
  const { text, cwd, originTop } = state;
  const { tokens, truncated, total } = useMemo(() => tokenizeForBangLimited(text), [text]);
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const chipsRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    active: boolean;
    pointerId: number;
    base: Set<number>;
    startI: number;
    lastI: number;
  } | null>(null);
  // 已选词上按下后待定「单击移除」；真的拖出（dragstart/pointercancel）则作废
  const pendingToggleRef = useRef<number | null>(null);
  const tippedRef = useRef(false);

  useEffect(() => {
    setPicked(new Set());
    pendingToggleRef.current = null;
    tippedRef.current = false;
  }, [text]);

  useEffect(() => {
    if (truncated && !tippedRef.current) {
      tippedRef.current = true;
      services.tip(t('选区较大（{{total}} 词），已显示前 {{n}} 个', { total, n: tokens.length }));
    }
  }, [truncated, total, tokens.length, services, t]);

  const working = useMemo(() => joinTokens(tokens, [...picked]), [tokens, picked]);
  const hasUrl = Boolean(detectFirstUrl(working));
  const hasPath = selectionHasPath(working, cwd);
  const hasPreview = selectionHasPreviewablePath(working, cwd);
  // ma-ui 部件链接（按拼回文本判定，与 URL/路径按钮同口径）：在右侧网页区打开
  const uiArtifactLinks = useMemo(() => uiArtifactLinksInText(working), [working]);
  const hasUiArtifact = uiArtifactLinks.length > 0;
  const canAct = picked.size > 0;

  useOverlayDismiss(true, onClose);

  const applyUnion = useCallback((base: Set<number>, from: number, to: number) => {
    setPicked(unionRange(base, from, to));
  }, []);

  const onPointerDownChip = (e: React.PointerEvent, i: number): void => {
    if (e.button !== 0) return;
    // 已选中的词交给 HTML5 拖出；原地抬起（未拖动）时在 onChipPointerUp 里单击移除
    if (picked.has(i)) {
      pendingToggleRef.current = i;
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    pendingToggleRef.current = null;
    const base = picked;
    dragRef.current = {
      active: true,
      pointerId: e.pointerId,
      base,
      startI: i,
      lastI: i
    };
    applyUnion(base, i, i);
    chipsRef.current?.setPointerCapture?.(e.pointerId);
  };

  const onChipDragStart = (e: React.DragEvent, i: number): void => {
    if (!picked.has(i) || picked.size === 0) {
      e.preventDefault();
      return;
    }
    pendingToggleRef.current = null;
    beginSelectionDrag(e.dataTransfer, working, cwd);
  };

  // 只在已选词上收到（未选词的手势期间指针被 capture 到 wrap）：原地抬起 = 单击移除
  const onChipPointerUp = (_e: React.PointerEvent, i: number): void => {
    const pending = pendingToggleRef.current;
    pendingToggleRef.current = null;
    if (pending !== i) return;
    setPicked((prev) => {
      if (!prev.has(i)) return prev;
      const next = new Set(prev);
      next.delete(i);
      return next;
    });
  };

  const onChipPointerCancel = (i: number): void => {
    if (pendingToggleRef.current === i) pendingToggleRef.current = null;
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (!drag?.active || e.pointerId !== drag.pointerId) return;
    const i = chipIndexFromPoint(e.clientX, e.clientY);
    if (i == null || i === drag.lastI) return;
    drag.lastI = i;
    applyUnion(drag.base, drag.startI, i);
  };

  const endDrag = (e: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (!drag?.active || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    try {
      chipsRef.current?.releasePointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }
  };

  const panelStyle: React.CSSProperties = {};
  if (originTop != null && Number.isFinite(originTop)) {
    panelStyle.marginTop = Math.max(8, originTop - 4);
  }

  return createPortal(
    <div
      className="sel-bang-mask"
      data-overlay-root
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sel-bang-panel" role="dialog" aria-label={t('大爆炸')} style={panelStyle}>
        <div className="sel-bang-head">
          <span>{t('连续点选或滑动选词，多次选择累加；选中后可拖到文件区 / Git / Agent')}</span>
          <button type="button" className="ui-btn tiny" onClick={onClose}>
            {t('关闭')}
          </button>
        </div>
        <div
          className="sel-bang-chips-wrap"
          ref={chipsRef}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="sel-bang-chips">
            {tokens.map((token, i) => (
              <button
                key={`${i}-${token.slice(0, 24)}`}
                type="button"
                tabIndex={-1}
                data-bang-i={i}
                draggable={picked.has(i)}
                className={`sel-bang-chip${picked.has(i) ? ' is-on' : ''}${
                  /^https?:/i.test(token) ? ' is-url' : looksLikePath(token) ? ' is-path' : ''
                }`}
                onPointerDown={(ev) => onPointerDownChip(ev, i)}
                onPointerUp={(ev) => onChipPointerUp(ev, i)}
                onPointerCancel={() => onChipPointerCancel(i)}
                onDragStart={(ev) => onChipDragStart(ev, i)}
                onClick={(ev) => ev.preventDefault()}
              >
                {token}
              </button>
            ))}
          </div>
          {picked.size === 0 ? (
            <p className="sel-bang-hint">
              {t('单击逐词加选，按住滑动连选一段；再点已选词可移除；选中后可拖出')}
            </p>
          ) : null}
        </div>
        <div className="sel-bang-footer" role="toolbar" aria-label={t('选中词操作')}>
          {canAct ? (
            <span
              className="sel-bang-drag"
              draggable
              title={t('拖到文件区、Git、Agent 或终端')}
              onDragStart={(e) => beginSelectionDrag(e.dataTransfer, working, cwd)}
            >
              {working}
            </span>
          ) : null}
          <button
            type="button"
            className="ui-btn tiny"
            disabled={!canAct}
            onClick={() => void copySelectionText(working, services.tip)}
          >
            {t('复制')}
          </button>
          <button
            type="button"
            className="ui-btn tiny"
            disabled={!canAct}
            onClick={() => void searchSelectionText(working, services.tip)}
          >
            {t('搜索')}
          </button>
          <button
            type="button"
            className="ui-btn tiny"
            disabled={!canAct}
            onClick={() => {
              services.insertComposer(working);
              onClose();
            }}
          >
            {t('发给 Agent')}
          </button>
          {hasUrl ? (
            <button
              type="button"
              className="ui-btn tiny"
              disabled={!canAct}
              onClick={() => void openSelectionUrl(working, services.tip)}
            >
              {t('打开链接')}
            </button>
          ) : null}
          {hasUiArtifact ? (
            <button
              type="button"
              className="ui-btn tiny"
              disabled={!canAct}
              onClick={() => void openUiArtifactsInBrowser(uiArtifactLinks, services.tip, state.context?.rightOwner)}
            >
              {t('在网页区打开')}
            </button>
          ) : null}
          {hasPath ? (
            <button
              type="button"
              className="ui-btn tiny"
              disabled={!canAct}
              onClick={() => void revealSelectionPath(working, cwd, services.tip)}
            >
              {t('资源管理器')}
            </button>
          ) : null}
          {hasPreview ? (
            <button
              type="button"
              className="ui-btn tiny"
              disabled={!canAct}
              onClick={() =>
                previewSelectionPath(
                  working,
                  cwd,
                  (absPath, line, col) => services.openFile({ path: absPath, line, col, ...selectionFileOwner(state.context) }),
                  services.tip
                )
              }
            >
              {t('在文件区预览')}
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
