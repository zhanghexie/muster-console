import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MutableRefObject } from 'react';
import {
  addTosendItem,
  parseTosendList,
  removeTosendItem,
  serializeTosendList,
  reorderTosendByIds,
  TOSEND_MAX_CHARS,
  TOSEND_MAX_ITEMS,
  type TosendItem,
  type TosendImage
} from '../../../../shared/composerTools';
import { notifyComposerError } from './composerNotice';
import { hasWorkerModelMentions } from '../../../../shared/workerModelMention';
import type { ComposerEditableHandle } from '../ComposerEditable';
import type { QueueItemView, QueueLane } from '../QueueSendPanel';
import type { Props } from './composerTypes';

interface Params {
  prepareManualDraft?: Props['prepareManualDraft'];
  restoreManualDraft?: Props['restoreManualDraft'];
  draftBucket: string | null;
  enabled?: boolean;
  editableRef: MutableRefObject<ComposerEditableHandle | null>;
  onSendNow?: (text: string) => Promise<'sent' | 'steered' | 'unsupported' | 'queued' | 'failed'>;
  onSendNowFallback?: (text: string) => Promise<'sent' | 'failed'>;
  onCancelQueued?: (messageId: string) => void;
  onEditQueued?: (messageId: string, text: string) => void;
  onReorderQueued?: (orderedIds: string[]) => void;
  onSend: Props['onSend'];
  /** 跨泳道 auto→manual 时取排队条目的随文图片（主进程/display 持有，快照只带张数） */
  getQueuedImages?: (messageId: string) => TosendImage[] | undefined;
  /** 取回编辑：把条目文+图填入输入框草稿（调用方负责 setImages/applyValue） */
  onFillDraft?: (text: string, images?: TosendImage[]) => void;
}

/** 手动确认发送清单（原 /tosend 清单的存储，命令已删）：纯本地（按草稿桶=会话
 *  隔离），永不自动发送；条目经跨泳道拖拽或「忙时手动区非空则默认进这里」的分流产生。
 *  同时承载统一排队面板的全部动作回调。 */
export function useTosendQueue({
  draftBucket, enabled = true,
  editableRef,
  onSendNow,
  onSendNowFallback,
  onCancelQueued,
  onEditQueued,
  onReorderQueued,
  onSend,
  getQueuedImages,
  onFillDraft,
  prepareManualDraft,
  restoreManualDraft
}: Params): {
  tosend: TosendItem[];
  addTosend: (text: string, images?: TosendImage[]) => void;
  removeTosend: (id: string) => void;
  handlePanelSendNow: (item: QueueItemView, lane: QueueLane) => Promise<void>;
  handlePanelEditToDraft: (item: QueueItemView, lane: QueueLane) => void;
  handlePanelDelete: (item: QueueItemView, lane: QueueLane) => void;
  handlePanelReorder: (lane: QueueLane, orderedIds: string[]) => void;
  handlePanelMoveLane: (item: QueueItemView, from: QueueLane, to: QueueLane) => Promise<void>;
} {
  const { t } = useTranslation();
  const tosendStoreKey = `muster.tosend.v1:${draftBucket ?? '_global'}`;
  const [tosend, setTosend] = useState<TosendItem[]>([]);
  const tosendLoadedFor = useRef<string | null>(null);
  /** 清单写失败提示只发一次（连续失败不刷屏；写恢复成功后重置） */
  const tosendPersistWarnedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(tosendStoreKey);
    } catch {
      /* 隐私模式等场景忽略 */
    }
    tosendLoadedFor.current = tosendStoreKey;
    setTosend(parseTosendList(raw));
  }, [enabled, tosendStoreKey]);

  useEffect(() => {
    // 载入完成前不回写：防切桶瞬间用旧清单盖掉新键
    if (!enabled || tosendLoadedFor.current !== tosendStoreKey) return;
    try {
      localStorage.setItem(tosendStoreKey, serializeTosendList(tosend));
      tosendPersistWarnedRef.current = false; // 恢复可写后解除静默：下次失败可再提示
    } catch {
      // send-queue F-02：配额满/隐私模式下写失败不再静默——一次性桌面通知，
      // 否则重启后清单回退到最后一次成功写入，中间条目（含批注快照）无声丢失
      if (!tosendPersistWarnedRef.current) {
        tosendPersistWarnedRef.current = true;
        notifyComposerError(t('清单未能保存，重启后将丢失（本地存储已满或不可用）'));
      }
    }
  }, [enabled, tosend, tosendStoreKey, t]);

  const addTosend = (text: string, images?: TosendImage[]): void => {
    const prepared = prepareManualDraft?.(text) ?? { text };
    const next = addTosendItem(tosend, prepared.text, Date.now(), images, prepared.noteDraft);
    if (next === tosend) return;
    setTosend(next);
    // 成功不再提示（原 hint 条已移除）
  };

  const removeTosend = (id: string): void => {
    setTosend((prev) => removeTosendItem(prev, id));
  };

  // ── 统一排队面板动作：「立即」按落点提示（steered/queued），失败保留条目 ──
  /** 在途守卫：IPC 往返窗口内双击同一行会双次 steer 同一文本 */
  const sendNowInFlightRef = useRef<Set<string>>(new Set());
  const handlePanelSendNow = async (item: QueueItemView, lane: QueueLane): Promise<void> => {
    if (sendNowInFlightRef.current.has(item.id)) return;
    // 手动泳道带图：走普通发送（忙时入自动队列/空闲直发），steer 不带图
    if (lane === 'manual' && (item.imageCount ?? 0) > 0) {
      const full = tosend.find((t) => t.id === item.id);
      if (!full) return;
      sendNowInFlightRef.current.add(item.id);
      try {
        let ok: boolean | void;
        try {
          ok = await onSend(full.text, full.images);
        } catch {
          ok = false;
        }
        if (ok === false) {
          notifyComposerError(t('立即发送失败，请重试'));
          return;
        }
        setTosend((prev) => removeTosendItem(prev, item.id));
        requestAnimationFrame(() => editableRef.current?.focus());
      } finally {
        sendNowInFlightRef.current.delete(item.id);
      }
      return;
    }
    // 自动泳道带图不走插话（steer 只注入文本）；已在队列的会随回合结束原样发出。
    // 「立即」未按用户要求生效（不静默）→ 桌面通知
    if ((item.imageCount ?? 0) > 0) {
      notifyComposerError(t('带图消息不支持插话，将在当前回合结束后自动发出'));
      return;
    }
    if (!onSendNow) return;
    sendNowInFlightRef.current.add(item.id);
    try {
      // 先受理再摘副本：受理失败（队满/清空中/IPC 异常）条目原地保留可重试，不丢消息。
      // auto 泳道成功后摘排队副本——steered/sent 后副本已多余；queued 时新副本已入队尾，
      // 摘旧位置等价于挪到末尾
      const r = await onSendNow(item.text);
      if (r === 'failed') {
        notifyComposerError(t('立即发送失败，请重试')); // auto/manual 一致：条目保留，等用户重试
        return;
      }
      let fallbackHandled = false;
      if ((r === 'unsupported' || r === 'queued') && onSendNowFallback) {
        fallbackHandled = true;
        const fallback = await onSendNowFallback(item.text);
        if (fallback === 'failed') {
          notifyComposerError(t('立即发送失败，请重试'));
          return;
        }
      }
      if (r === 'unsupported' && !fallbackHandled) {
        notifyComposerError(t('当前引擎不支持立即插话，请稍后重试'));
        return;
      }
      if (lane === 'auto') onCancelQueued?.(item.id);
      else setTosend((prev) => removeTosendItem(prev, item.id));
      // steered=成功不再提示；queued=回落排队（未按「立即插话」意图生效）→ 桌面通知
      if (r === 'queued' && !fallbackHandled) notifyComposerError(t('当前回合不接受插话，已加入排队末尾'));
      // 旧行为保留：发完回焦输入框，键盘流不中断
      requestAnimationFrame(() => editableRef.current?.focus());
    } finally {
      sendNowInFlightRef.current.delete(item.id);
    }
  };

  /** 取回编辑：整条（文+图）填回输入框并出列（不在行内改文本/图） */
  const handlePanelEditToDraft = (item: QueueItemView, lane: QueueLane): void => {
    let text = item.text;
    let images: TosendImage[] | undefined;
    if (lane === 'manual') {
      const full = tosend.find((t) => t.id === item.id);
      text = full?.noteDraft && restoreManualDraft
        ? restoreManualDraft(full.noteDraft)
        : full?.text ?? item.text;
      images = full?.images;
      setTosend((prev) => removeTosendItem(prev, item.id));
    } else {
      images = getQueuedImages?.(item.id) as TosendImage[] | undefined;
      onCancelQueued?.(item.id);
    }
    onFillDraft?.(text, images);
    requestAnimationFrame(() => editableRef.current?.focus());
  };

  const handlePanelDelete = (item: QueueItemView, lane: QueueLane): void => {
    if (lane === 'auto') onCancelQueued?.(item.id);
    else removeTosend(item.id);
  };

  const handlePanelReorder = (lane: QueueLane, orderedIds: string[]): void => {
    if (lane === 'auto') onReorderQueued?.(orderedIds);
    else setTosend((prev) => reorderTosendByIds(prev, orderedIds));
  };

  // 跨泳道拖拽：排队→手动确认（先预检再摘排队副本——超长/满员直接提示并保留原位；
  // addTosendItem 对无批注快照的普通条目截 TOSEND_MAX_CHARS 字、清单满 TOSEND_MAX_ITEMS
  // 裁最旧，若先摘副本再入清单就成了静默截断正文/静默删无关旧条目）；手动确认→排队
  // （忙时入队；空闲无队列，直接发送）。入队/发送失败（队满/清空中）文本留回清单并
  // 提示，不静默丢；忙时队满的退回预检在 QueueSendPanel（auto 泳道快照满 8 条即拦截）。
  const handlePanelMoveLane = async (
    item: QueueItemView,
    from: QueueLane,
    to: QueueLane
  ): Promise<void> => {
    if (from === to) return;
    if (from === 'auto') {
      // 搬移路径的条目来自主进程排队队列，不携带 noteDraft（批注快照只随手动新增
      // 产生），入清单必走截断分支——超长时保留排队副本原地提示，不发出截断正文
      if (item.text.trim().length > TOSEND_MAX_CHARS && !hasWorkerModelMentions(item.text)) {
        notifyComposerError(
          t('内容超过 {{n}} 字上限，已保留在自动队列', { n: TOSEND_MAX_CHARS })
        );
        return;
      }
      // 清单满员时 addTosendItem 会裁掉最旧的手动条目——拒绝搬移，不静默删除无关条目
      if (tosend.length >= TOSEND_MAX_ITEMS) {
        notifyComposerError(
          t('手动确认清单已满（{{n}} 条），已保留在自动队列', { n: TOSEND_MAX_ITEMS })
        );
        return;
      }
      onCancelQueued?.(item.id);
      // 手动清单支持随文图片；自动泳道的图在主进程 queue/display 上，
      // 面板快照只带张数——由 getQueuedImages 钩子补全（缺省则纯文本，不丢条目）
      const imgs = getQueuedImages?.(item.id);
      setTosend((prev) => addTosendItem(prev, item.text, Date.now(), imgs));
      return;
    }
    let ok: boolean | void;
    const full = tosend.find((t) => t.id === item.id);
    try {
      ok = await onSend(item.text, full?.images);
    } catch {
      ok = false;
    }
    if (ok === false) {
      notifyComposerError(t('加入排队失败，条目已保留'));
      return;
    }
    setTosend((prev) => removeTosendItem(prev, item.id));
  };

  return {
    tosend,
    addTosend,
    removeTosend,
    handlePanelSendNow,
    handlePanelEditToDraft,
    handlePanelDelete,
    handlePanelReorder,
    handlePanelMoveLane
  };
}
