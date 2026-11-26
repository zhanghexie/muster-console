/**
 * 统一排队面板（composer 外壳内，编辑区上方）：
 * 上泳道 = 排队自动发送（busy 队列，surface 快照 queuedItems，空闲后按序自动发出）；
 * 下泳道 = 手动确认发送（本地清单，永不自动发送；由跨泳道拖拽或
 * 忙时分流产生条目）。
 * 每行：序号/拖拽把手｜缩略图 + 单行摘要（点击取回编辑）｜立即发送 + 更多。
 * 更多菜单含取回编辑、跨组转换、上移/下移和删除，支持键盘操作。
 * 纯展示组件：清单与动作都由 AgentComposer 注入；唯一自持的交互策略是
 * 忙时队满预检（manual→auto 满载即拦下并桌面通知，条目退回手动清单——F-03）。
 * 右上角「收起」把面板缩成一枚胶囊（计数 + 展开），偏好记在 localStorage，跨会话/重启保持；
 * 面板与胶囊各走 usePresence + acc，与输入框共用实底外壳。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePresence } from './motion';
import { IconMore } from './icons';
import { ImageLightbox } from './ImageLightbox';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { notifyComposerError } from './agentComposer/composerNotice';
import { summarizeWorkerModelMentions } from '../../../shared/workerModelMention';

export type QueueLane = 'auto' | 'manual';

/** 自动泳道容量（镜像主进程忙时队列上限：orchestrator MAX_AGENT_QUEUE 与
 *  agentSession host MAX_QUEUE 均 8）。仅用于跨泳道搬入 auto 泳道的预检——
 *  忙时队满主进程只通知弃置、IPC 仍回 accepted（fs.ts 不回传拒绝），渲染层
 *  预检拦截才能把条目退回手动清单；真实受理语义仍以主进程为准。 */
export const AUTO_LANE_MAX_ITEMS = 8;

export interface QueueItemView {
  id: string;
  text: string;
  /** 随文图片张数（角标；带图行禁用「立即」——steer 不带图） */
  imageCount?: number;
  /** 缩略图预览（轻量，不含 base64；点击开灯箱） */
  imagePreviews?: Array<{ id: string; url: string; name?: string }>;
}

interface Props {
  /** 将收起胶囊与其它输入状态装配到同一行；未提供时沿用独立队列布局。 */
  renderHeader?: (capsule: React.ReactNode) => React.ReactNode;
  autoItems: ReadonlyArray<QueueItemView>;
  manualItems: ReadonlyArray<QueueItemView>;
  /** 会话是否忙：仅忙时自动队列才受容量上限约束（空闲时搬入 auto 泳道=直接发送） */
  busy?: boolean;
  /** 立即发送：忙时插话（steer）当前回合，不支持时回落排队 */
  onSendNow: (item: QueueItemView, lane: QueueLane) => void;
  /** 取回编辑：整条（文+图）填回输入框并从队列摘除 */
  onEditToDraft: (item: QueueItemView, lane: QueueLane) => void;
  onDelete: (item: QueueItemView, lane: QueueLane) => void;
  /** 拖拽排序落定（泳道内；ids 为该泳道全量 id 的目标顺序） */
  onReorder: (lane: QueueLane, orderedIds: string[]) => void;
  /** 跨泳道拖拽：排队↔手动确认互转 */
  onMoveLane: (item: QueueItemView, from: QueueLane, to: QueueLane) => void;
}

export const QUEUE_PANEL_MINIMIZED_KEY = 'muster.queuePanel.minimized';

function readMinimized(): boolean {
  try {
    return localStorage.getItem(QUEUE_PANEL_MINIMIZED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMinimized(v: boolean): void {
  try {
    if (v) localStorage.setItem(QUEUE_PANEL_MINIMIZED_KEY, '1');
    else localStorage.removeItem(QUEUE_PANEL_MINIMIZED_KEY);
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

/** 收起（下箭头） */
function MinimizeIcon(): React.JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="m2 3.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 展开（上箭头） */
function ExpandIcon(): React.JSX.Element {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false">
      <path d="M2.5 6.2 5 3.7l2.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 拖拽把手（六点） */
function DragHandleIcon(): React.JSX.Element {
  return (
    <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true" focusable="false">
      <g fill="currentColor">
        <circle cx="3" cy="2" r="1.1" />
        <circle cx="7" cy="2" r="1.1" />
        <circle cx="3" cy="6" r="1.1" />
        <circle cx="7" cy="6" r="1.1" />
        <circle cx="3" cy="10" r="1.1" />
        <circle cx="7" cy="10" r="1.1" />
      </g>
    </svg>
  );
}

/** 立即（↑ 出列） */
function SendNowIcon(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 10.2V1.8M2.8 5 6 1.8 9.2 5" />
      <path d="M1.8 10.2h8.4" />
    </svg>
  );
}

interface RowProps {
  item: QueueItemView;
  lane: QueueLane;
  index: number;
  onMore: (anchor: HTMLButtonElement) => void;
  dragArmed: boolean;
  dragging: boolean;
  dragOver: boolean;
  /** 正在拖的条目来自另一条泳道：行级拖放让位给泳道级（跨泳道移动） */
  crossLane: boolean;
  onArmDrag: (v: boolean) => void;
  onDragStart: (lane: QueueLane, id: string) => void;
  onDragOverRow: (lane: QueueLane, id: string) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onSendNow: Props['onSendNow'];
  onEditToDraft: Props['onEditToDraft'];
}

function QueueRow(props: RowProps): React.JSX.Element {
  const { item, lane } = props;
  const { t } = useTranslation();
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const previews = item.imagePreviews ?? [];
  const summary = summarizeWorkerModelMentions(item.text);
  const imgN = previews.length || (item.imageCount ?? 0);

  return (
    <div
      className={[
        'agent-composer-qsrow',
        props.dragging ? ' is-dragging' : '',
        props.dragOver && !props.dragging ? ' is-drag-over' : ''
      ].join('')}
      role="listitem"
      draggable
      onDragStart={(e) => {
        if (!props.dragArmed) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.effectAllowed = 'move';
        props.onDragStart(lane, item.id);
      }}
      onDragOver={(e) => {
        if (props.dragging || props.crossLane) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        props.onDragOverRow(lane, item.id);
      }}
      onDrop={(e) => {
        if (props.crossLane) return; // 跨泳道：冒泡给泳道级 onDrop 处理
        e.preventDefault();
        props.onDrop();
      }}
      onDragEnd={props.onDragEnd}
    >
      <button
        type="button"
        className="agent-composer-qsrow-handle"
        title={t('拖动调整顺序')}
        aria-label={t('拖动调整顺序')}
        onMouseDown={() => props.onArmDrag(true)}
        onMouseUp={() => props.onArmDrag(false)}
      >
        <span className="agent-composer-qsrow-number" aria-hidden="true">{props.index + 1}</span>
        <DragHandleIcon />
      </button>
      <div className="agent-composer-qsrow-body">
        {previews.length > 0 ? (
          <div className="agent-composer-qsrow-thumbs">
            {previews.map((p) => (
              <button
                key={p.id}
                type="button"
                className="agent-composer-qsrow-thumb"
                title={p.name ? `${p.name} · ${t('点击查看大图')}` : t('点击查看大图')}
                aria-label={t('点击查看大图')}
                onClick={() => setLightboxSrc(p.url)}
              >
                <img src={p.url} alt={p.name || t('图片')} draggable={false} />
              </button>
            ))}
          </div>
        ) : null}
        <button type="button" className="agent-composer-qsrow-text" title={summary || t('取回输入框编辑（含图片）')} aria-label={t('取回输入框编辑')} onClick={() => props.onEditToDraft(item, lane)}>
          {summary || (imgN > 0 ? t('图片') : '')}
          {previews.length === 0 && imgN > 0 ? (
            <span className="agent-composer-qsrow-img" title={t('含 {{n}} 张图片', { n: imgN })}>
              🖼 {imgN}
            </span>
          ) : null}
        </button>
      </div>
      <span className="agent-composer-qsrow-actions">
        <button
          type="button"
          className="agent-composer-qsrow-now"
          title={
            imgN > 0
              ? t('带图消息不支持插话，将在当前回合结束后自动发出')
              : lane === 'auto'
                ? t('立即插话：不等排队，直接注入当前回合')
                : t('立即发送：忙时插话当前回合，空闲直接发送')
          }
          aria-label={t('立即发送')}
          disabled={imgN > 0}
          onClick={() => props.onSendNow(item, lane)}
        >
          <SendNowIcon />
        </button>
        <button
          type="button"
          className="agent-composer-qsrow-icon"
          aria-label={t('消息操作')}
          aria-haspopup="menu"
          onClick={(event) => props.onMore(event.currentTarget)}
        >
          <IconMore size={15} />
        </button>
      </span>
      {imgN > 0 ? (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      ) : null}
    </div>
  );
}

/** 泳道标题（计数强调，语义靠分割线与文案区分上下） */
function LaneHead(props: { kind: QueueLane; count: number; onMinimize?: () => void; buttonRef?: React.RefObject<HTMLButtonElement> }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className={`agent-composer-qslane-head is-${props.kind}`}>
      <span>{props.kind === 'auto' ? t('排队自动发送') : t('手动确认发送')} <b>{props.count}</b></span>
      {props.onMinimize && <button ref={props.buttonRef} type="button" className="agent-composer-qspanel-min" aria-label={t('收起排队面板')} onClick={props.onMinimize}><MinimizeIcon /></button>}
    </div>
  );
}

export function QueueSendPanel(props: Props): React.JSX.Element | null {
  const { t } = useTranslation();
  const open = props.autoItems.length > 0 || props.manualItems.length > 0;
  const [minimized, setMinimizedState] = useState(readMinimized);
  const setMinimized = (v: boolean): void => {
    setMinimizedState(v);
    writeMinimized(v);
  };
  // 两态共用 acc 与缺省 exitMs，外壳持续在场，开合高度随布局让位。
  const presence = usePresence(open && !minimized);
  const capsule = usePresence(open && minimized);
  const panelButton = useRef<HTMLButtonElement>(null);
  const capsuleButton = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  const [menu, setMenu] = useState<{ id: string; lane: QueueLane; x: number; y: number; anchor: HTMLButtonElement } | null>(null);
  const [armed, setArmed] = useState(false);
  const [drag, setDrag] = useState<{ lane: QueueLane; id: string } | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverLane, setDragOverLane] = useState<QueueLane | null>(null);
  const laneItems = (lane: QueueLane): ReadonlyArray<QueueItemView> =>
    lane === 'auto' ? props.autoItems : props.manualItems;

  const menuItem = menu ? laneItems(menu.lane).find(item => item.id === menu.id) : undefined;
  useEffect(() => {
    if (menu && (!menuItem || minimized)) setMenu(null);
  }, [menu, menuItem, minimized]);
  useEffect(() => {
    if (!moveFocus.current) return;
    const target = minimized ? capsuleButton.current : panelButton.current;
    if (target) { target.focus(); moveFocus.current = false; }
  }, [minimized, presence.mounted, capsule.mounted]);
  if (!presence.mounted && !capsule.mounted && !props.renderHeader) return null;

  const toggleMinimized = (value: boolean): void => { moveFocus.current = true; setMinimized(value); };
  /** 忙时自动队列已满（预检用快照计数）：主进程满载只通知弃置且不回传拒绝，
   *  这里提前拦截，条目留在手动清单（退回不丢）。 */
  const autoLaneFull = (): boolean =>
    props.busy === true && laneItems('auto').length >= AUTO_LANE_MAX_ITEMS;
  const menuList = menu ? laneItems(menu.lane) : [];
  const menuIndex = menuList.findIndex(item => item.id === menu?.id);
  const menuItems: ContextMenuItem[] = [
    { id: 'edit', label: t('取回输入框编辑') },
    { id: 'move', label: menu?.lane === 'auto' ? t('转为手动确认') : t('加入自动队列') },
    { id: 'sep1', separator: true },
    { id: 'up', label: t('上移'), disabled: menuIndex <= 0 },
    { id: 'down', label: t('下移'), disabled: menuIndex >= menuList.length - 1 },
    { id: 'sep2', separator: true },
    { id: 'delete', label: t('删除'), danger: true }
  ];
  const onMenuSelect = (id: string): void => {
    if (!menu || !menuItem) return;
    if (id === 'edit') props.onEditToDraft(menuItem, menu.lane);
    else if (id === 'delete') props.onDelete(menuItem, menu.lane);
    else if (id === 'move') {
      // 队满预检：目标 auto 泳道满载时不发起搬移，条目退回手动清单并提示
      if (menu.lane === 'manual' && autoLaneFull()) {
        notifyComposerError(t('队列已满，条目已退回清单'));
        return;
      }
      props.onMoveLane(menuItem, menu.lane, menu.lane === 'auto' ? 'manual' : 'auto');
    }
    else if (id === 'up' || id === 'down') {
      const target = menuIndex + (id === 'up' ? -1 : 1);
      if (menuIndex < 0 || target < 0 || target >= menuList.length) return;
      const ids = menuList.map(item => item.id);
      [ids[menuIndex], ids[target]] = [ids[target], ids[menuIndex]];
      props.onReorder(menu.lane, ids);
    }
  };

  const finishDrag = (): void => {
    setArmed(false);
    setDrag(null);
    setDragOverId(null);
    setDragOverLane(null);
  };

  /** 跨泳道移动：排队→手动确认 / 手动确认→排队，具体由调用方按泳道落定 */
  const dropToLane = (to: QueueLane): void => {
    if (!drag) return;
    const from = drag.lane;
    const item = laneItems(from).find((i) => i.id === drag.id);
    if (item && from !== to) {
      // 队满预检（F-03 退回不丢）：目标 auto 泳道满载时不发起搬移，条目留在
      // 原手动清单——主进程满载只发系统通知弃置，等受理失败再退回就晚了
      if (to === 'auto' && autoLaneFull()) {
        notifyComposerError(t('队列已满，条目已退回清单'));
      } else {
        props.onMoveLane(item, from, to);
      }
    }
    finishDrag();
  };

  const dropOn = (targetId: string | null): void => {
    if (!drag) return;
    const lane = drag.lane;
    const list = [...laneItems(lane)];
    const from = list.findIndex((i) => i.id === drag.id);
    if (from >= 0) {
      const [moved] = list.splice(from, 1);
      const to = targetId == null ? list.length : list.findIndex((i) => i.id === targetId);
      // 目标行不存在（如拖回自身后已被移除）：只收尾，不提交残缺顺序
      if (to >= 0) {
        list.splice(to, 0, moved);
        props.onReorder(lane, list.map((i) => i.id));
      }
    }
    finishDrag();
  };

  const renderLane = (lane: QueueLane): React.JSX.Element => {
    const crossDrag = !!drag && drag.lane !== lane;
    return (
      <div
        className={`agent-composer-qslane is-${lane}${dragOverLane === lane ? ' is-drop-target' : ''}`}
        onDragOver={(e) => {
          if (!crossDrag) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          setDragOverLane(lane);
        }}
        onDrop={(e) => {
          if (!crossDrag) return;
          e.preventDefault();
          dropToLane(lane);
        }}
      >
        <LaneHead kind={lane} count={laneItems(lane).length} onMinimize={lane === 'auto' ? () => toggleMinimized(true) : undefined} buttonRef={lane === 'auto' ? panelButton : undefined} />
        <div className="agent-composer-qslane-list" role="list" aria-label={lane === 'auto' ? t('自动发送') : t('手动确认')}>
          {laneItems(lane).map((item, index) => (
            <QueueRow
              key={item.id}
              item={item}
              lane={lane}
              index={index}
              onMore={(anchor) => { const rect = anchor.getBoundingClientRect(); setMenu({ id: item.id, lane, x: rect.right - 180, y: rect.bottom, anchor }); }}
              dragArmed={armed}
              dragging={drag?.id === item.id}
              dragOver={dragOverId === item.id}
              crossLane={crossDrag}
              onArmDrag={setArmed}
              onDragStart={(l, id) => setDrag({ lane: l, id })}
              onDragOverRow={(l, id) => setDragOverId(id)}
              onDrop={() => dropOn(dragOverId)}
              onDragEnd={finishDrag}
              onSendNow={props.onSendNow}
              onEditToDraft={props.onEditToDraft}
            />
          ))}
          {laneItems(lane).length === 0 ? (
            <div className="agent-composer-qslane-empty">
              {t('暂无消息，可拖入此处')}
            </div>
          ) : null}
          {/* 泳道尾部保留小块拖放空白，便于将消息移到末尾。 */}
          <div
            className="agent-composer-qslane-tail"
            onDragOver={(e) => {
              if (!drag || drag.lane !== lane) return;
              e.preventDefault();
              setDragOverId(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (drag?.lane === lane) dropOn(null);
            }}
          />
        </div>
      </div>
    );
  };

  const autoN = props.autoItems.length;
  const manualN = props.manualItems.length;

  const minimizedCapsule = capsule.mounted ? (
    <div className={`agent-composer-queue-presence acc${capsule.stage === 'in' ? ' is-open' : ''}`} aria-hidden={capsule.stage === 'out'} {...(capsule.stage === 'out' ? { inert: '' } : {})}><div className="acc-body"><div className="agent-composer-qscapsule-wrap"><button
      ref={capsuleButton}
      type="button"
      className="agent-composer-qscapsule"
      title={t('展开排队面板')}
      aria-label={t('展开排队面板')}
      onClick={() => toggleMinimized(false)}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M5 4h8M5 8h8M5 12h5M2 4h.1M2 8h.1M2 12h.1" strokeLinecap="round" /></svg>
      {autoN > 0 ? (
        <span className="agent-composer-qscapsule-part is-auto">{t('自动 {{n}}', { n: autoN })}</span>
      ) : null}
      {autoN > 0 && manualN > 0 ? <span className="agent-composer-qscapsule-divider" aria-hidden="true" /> : null}
      {manualN > 0 ? (
        <span className="agent-composer-qscapsule-part is-manual">{t('待确认 {{n}}', { n: manualN })}</span>
      ) : null}
      <ExpandIcon />
    </button></div></div></div>
  ) : null;

  return (
    <>
      {props.renderHeader?.(minimizedCapsule)}
      {presence.mounted ? (
        <div className={`agent-composer-queue-presence acc${presence.stage === 'in' ? ' is-open' : ''}`} aria-hidden={presence.stage === 'out'} {...(presence.stage === 'out' ? { inert: '' } : {})}>
          <div className="acc-body"><div className="agent-composer-qspanel" aria-label={t('发送队列')}>
            {renderLane('auto')}
            {renderLane('manual')}
          </div></div>
        </div>
      ) : null}
      {!props.renderHeader && minimizedCapsule}
      {menu && menuItem ? <ContextMenu x={menu.x} y={menu.y} anchor={menu.anchor} items={menuItems} onSelect={onMenuSelect}
        onClose={reason => { if (!reason) menu.anchor.focus({ preventScroll: true }); setMenu(null); }} /> : null}
    </>
  );
}
