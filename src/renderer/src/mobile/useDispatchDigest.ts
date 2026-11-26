/**
 * 调度 Agent 摘要（L2 置顶卡）：低频采样而不是订阅热流——orchestrator 流式
 * 期间 store 每帧都在变（rAF 合批），列表页若 useSyncExternalStore 直订会跟着
 * 满帧重渲。这里 1.5s 轮询快照（busy + 末条消息预览），进 L3 对话页才订阅实况。
 */
import { useEffect, useState } from 'react';
import { getOrchestratorSurface } from '../chatSurface/orchestratorSurface';
import type { ChatMessage } from '../../../shared/types';

export interface DispatchDigest {
  busy: boolean;
  preview: string;
}

function readDigest(wsId: string): DispatchDigest {
  const snap = getOrchestratorSurface(wsId).getSnapshot();
  const last = [...snap.messages]
    .reverse()
    .find((raw) => {
      const m = raw as ChatMessage;
      return !m.local && (m.content?.trim() || m.parts?.some((p) => p.kind !== 'tool'));
    }) as ChatMessage | undefined;  let preview = last?.content?.trim() ?? '';
  if (!preview && last?.parts?.length) {
    preview = last.parts
      .filter((p) => p.kind !== 'tool')
      .map((p) => p.text)
      .join(' ')
      .trim();
  }
  // 单行化 + 截断：列表预览不换行
  preview = preview.replace(/\s+/g, ' ').slice(0, 80);
  return { busy: snap.busy, preview };
}

export function useDispatchDigest(wsId: string | null): DispatchDigest {
  const [digest, setDigest] = useState<DispatchDigest>({ busy: false, preview: '' });

  useEffect(() => {
    if (!wsId) {
      setDigest({ busy: false, preview: '' });
      return;
    }
    setDigest(readDigest(wsId));
    const iv = window.setInterval(() => setDigest(readDigest(wsId)), 1500);
    return () => window.clearInterval(iv);
  }, [wsId]);

  return digest;
}
