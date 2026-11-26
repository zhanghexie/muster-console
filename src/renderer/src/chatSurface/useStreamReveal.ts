/**
 * 流式揭示引擎（2026-10-30）：把「数据到达节奏」与「上屏节奏」解耦。
 *
 * 模型：一条流式 assistant 消息的全局字符预算 shown（累计正文长度），由二阶
 * 阻尼弹簧（spring.ts）逐帧推进；工具/思考段不占预算：
 * - 正文段按到达顺序累计 startOffset，渲染 local = clamp(shown - startOffset,
 *   0, len) 的前缀——只有变化的段才拿到新 text（引用稳定，ChatMarkdownBody
 *   memo 只重解析活动段）；
 * - 工具段在「它之前的正文已全部揭示」（shown >= startOffset）时整行一次性
 *   插入（parts 前缀截断天然幂等：React 按原 part 下标 keyed upsert，不重复）；
 * - 思考段是 live 活动指示（LiveThinkingText 单行），不排队、即时出现。
 *
 * 数据侧只累加全文（store/deltaBatcher 不变）；本 Hook 在 ChatMessageView 行内
 * 自持状态逐帧重渲，绕过转写层的行缓存（B1-6 元素缓存不动，未变行零成本）。
 * 推进挂在全局唯一 rAF ticker（revealTicker.ts）；流结束（streaming 翻 false）、
 * 切会话/重新生成（行按消息 id 重挂）即对齐最终状态、注销任务、无残余动画。
 * 用户或系统「减少动态」时揭示关闭：文本按合批节奏直出（现状行为）。
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatDisplayPart, ChatMessage } from '../../../shared/types';
import {
  prefersReducedMotionPreference,
  subscribeInteractionPreferences
} from '../interactionPreferences';
import { SPRING_TEXT, SPRING_TEXT_LONG, Spring } from './spring';
import { registerRevealTask } from './revealTicker';

/** 正文超过该长度换「长文」弹簧参数（k=144/c=24，稍缓） */
export const REVEAL_LONG_TEXT_CHARS = 4000;
/** 揭示渲染节拍下限（ms）：markdown 重解析限 ≤30 次/秒（节拍下限，非动画时长 token） */
export const REVEAL_RENDER_MIN_INTERVAL = 33;
/** 面板隐藏期间积压超过该字符数：重新可见时直接吸附，不播长追赶动画 */
export const REVEAL_HIDDEN_SNAP_CHARS = 600;

/** 消息的正文总字符数（parts 正文段累计；无 parts 退 content）。工具/思考不计入。 */
export function revealCharTotal(message: ChatMessage): number {
  if (message.parts?.length) {
    let total = 0;
    for (const p of message.parts) {
      if (p?.kind === 'text') total += p.text.length;
    }
    return total;
  }
  return message.content?.length ?? 0;
}

/**
 * 按字符预算截断 parts 视图（纯函数）：
 * - 正文段显示前缀 local = clamp(floor(shown)-累计, 0, len)，全显示的段保留原引用；
 * - 工具段当且仅当 shown >= 它之前的正文累计（startOffset）时保留——不满足即被
 *   截掉，后续正文按同一预算自然为空，顺序恒与数据到达一致；
 * - 思考段原样保留（live 指示不排队）。
 * 返回 null 表示无需截断（全部可见），调用方直接复用原消息引用。
 */
export function applyRevealToParts(
  parts: readonly ChatDisplayPart[],
  shown: number
): ChatDisplayPart[] | null {
  if (parts.length === 0) return null;
  const budget = Math.floor(shown);
  let cumulative = 0;
  let out: ChatDisplayPart[] | null = null;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) {
      if (out) out.push(p);
      continue;
    }
    if (p.kind === 'text') {
      if (p.text.length === 0) {
        if (out) out.push(p);
        continue;
      }
      const take = Math.max(0, Math.min(p.text.length, budget - cumulative));
      if (take === p.text.length) {
        if (out) out.push(p);
      } else {
        out ??= parts.slice(0, i);
        if (take > 0) out.push({ kind: 'text', text: p.text.slice(0, take) });
      }
      cumulative += p.text.length;
    } else if (p.kind === 'tool') {
      if (budget >= cumulative) {
        if (out) out.push(p);
      } else {
        out ??= parts.slice(0, i);
      }
    } else if (out) {
      out.push(p);
    }
  }
  return out;
}

type ShownState = { id: string; n: number };

/**
 * 流式消息的揭示投影：返回按当前字符预算截断后的消息视图（或原消息引用）。
 * 只应作用于「正在流式」的 assistant 行；非流式/减少动态/预算已满时原样返回。
 */
export function useStreamReveal(
  message: ChatMessage,
  streaming: boolean,
  rootRef: React.RefObject<HTMLElement | null>
): ChatMessage {
  const reduced = useSyncExternalStore(
    subscribeInteractionPreferences,
    prefersReducedMotionPreference
  );
  const [shown, setShown] = useState<ShownState | null>(null);
  const messageRef = useRef(message);
  messageRef.current = message;

  useEffect(() => {
    if (!streaming || reduced) return;
    const initial = revealCharTotal(messageRef.current);
    // 挂载即有正文（LRU 重挂/中途切回）：从当前全文起步，不回放旧内容
    const spring = new Spring(
      initial > REVEAL_LONG_TEXT_CHARS ? SPRING_TEXT_LONG : SPRING_TEXT,
      initial
    );
    let rendered = initial;
    if (initial > 0) setShown({ id: messageRef.current.id, n: initial });
    let visibleNow = true;
    let hiddenStreak = 0;
    let longTuning = initial > REVEAL_LONG_TEXT_CHARS;
    let lastRenderAt = 0;
    const unsub = registerRevealTask({
      measure: () => {
        const root = rootRef.current;
        // checkVisibility 覆盖 display:none 祖先与 content-visibility；checkVisibilityCSS
        // 连 xfade 的 visibility:hidden 保活层一起判隐；jsdom 等无实现环境视为可见
        type Checkable = Element & { checkVisibility?: (options?: { checkVisibilityCSS?: boolean }) => boolean };
        const check = (root as Checkable | null)?.checkVisibility;
        visibleNow =
          !document.hidden &&
          !!root &&
          root.isConnected &&
          (typeof check === 'function' ? check.call(root, { checkVisibilityCSS: true }) : true);
      },
      update: (dt, now) => {
        if (!visibleNow) {
          hiddenStreak++;
          return;
        }
        const wasHidden = hiddenStreak > 0;
        hiddenStreak = 0;
        const msg = messageRef.current;
        const t = revealCharTotal(msg);
        if (t <= rendered) {
          // 内容收缩（重生成/清空）：立即对齐，不倒放
          if (t < rendered) {
            spring.snap(t);
            rendered = t;
            setShown({ id: msg.id, n: t });
          }
          return;
        }
        // 隐藏期积压过长：吸附后继续，避免可见时播长追赶
        if (wasHidden && t - spring.pos > REVEAL_HIDDEN_SNAP_CHARS) spring.snap(t);
        if (!longTuning && t > REVEAL_LONG_TEXT_CHARS) {
          spring.setTuning(SPRING_TEXT_LONG);
          longTuning = true;
        }
        spring.target = t;
        spring.update(dt);
        const n = Math.max(0, Math.min(Math.round(spring.pos), t));
        if (n !== rendered && (n >= t || now - lastRenderAt >= REVEAL_RENDER_MIN_INTERVAL)) {
          lastRenderAt = now;
          rendered = n;
          setShown({ id: msg.id, n });
        }
      }
    });
    return unsub;
    // message.id：换消息（重挂/换代）重建引擎；正文增长不重跑（target 经 ref 每帧读）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id, streaming, reduced]);

  const total = revealCharTotal(message);
  if (!streaming || reduced || total === 0 || !shown || shown.id !== message.id || shown.n >= total) {
    return message;
  }
  if (message.parts?.length) {
    const parts = applyRevealToParts(message.parts, shown.n);
    return parts ? { ...message, parts } : message;
  }
  return { ...message, content: message.content.slice(0, shown.n) };
}
