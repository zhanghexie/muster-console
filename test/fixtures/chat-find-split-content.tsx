/** Production search controller/bar/highlights; only the message/IPC leaves are fixtures. */
import React, { useLayoutEffect, useRef, useState } from 'react';
import { useChatFind } from '../../src/renderer/src/chatSurface/useChatFind';
import { ChatFindBar } from '../../src/renderer/src/chatSurface/ChatFindBar';
import { applyChatFindMarks, clearChatFindMarks } from '../../src/renderer/src/chatSurface/chatFindHighlight';
import { getChatFindShared, patchChatFindShared, resolveChatFindTarget } from '../../src/renderer/src/chatSurface/chatFindRegistry';
import { useKeybinding } from '../../src/renderer/src/keybindings/KeybindingHost';
import { getCenterSplitState } from '../../src/renderer/src/centerSplitStore';
import { getCenterSplitPaneRefs } from '../../src/shared/centerSplit';
export { TerminalView, PromptTaskPanel, ExtensionPanel } from './center-split-production-content';

export function FindKeyboard() {
  useKeybinding('chat.find', () => {
    const split = getCenterSplitState();
    const ref = getCenterSplitPaneRefs((window as any).__centerSplitTest.primary(), split)[split.open ? split.focused : 0];
    const target = resolveChatFindTarget(ref?.kind === 'session' ? ref.sessionId : undefined);
    if (target) patchChatFindShared({ open: true, ownerId: target.id, focusEpoch: getChatFindShared().focusEpoch + 1 });
  });
  return null;
}

export function AgentChatView(props: { sessionId: string; visible: boolean; style?: React.CSSProperties }) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const text = '我看了文件，这个不会自动注入到提示词吗？';
  const find = useChatFind({ enabled: props.visible, surfaceKind: 'gui-session', sessionId: props.sessionId,
    sessionName: props.sessionId, messages: [{ id: 'm1', role: 'user', content: text }], sessions: [], runtimes: [], surfaceEl: node });
  useLayoutEffect(() => {
    if (!body.current) return;
    applyChatFindMarks(body.current, find.isOwner ? find.query : '', { messageId: 'm1', indexInMessage: 0 });
    return () => { if (body.current) clearChatFindMarks(body.current); };
  }, [find.isOwner, find.query]);
  return <div data-session={props.sessionId} className={`agent-chat-view xfade xfade-instant${props.visible ? ' is-shown' : ''}`} style={props.style}>
    <div ref={setNode} className="chat-surface-view">
      <div ref={body} style={{ padding: '90px 24px 16px' }}>
        <div data-mid="m1" className="chat-msg user"><div className="chat-body"><div className="chat-text" data-find-body={props.sessionId}>{text}</div></div></div>
        <div data-mid="m2" className="chat-msg assistant"><div className="md-body"><p>我记住了，直接告诉我即可。</p></div></div>
        <p data-click-body={props.sessionId}>点击这里聚焦会话 {props.sessionId}，正文不获取键盘焦点。</p>
      </div>
      <ChatFindBar open={find.isOwner} query={find.query} onQueryChange={find.setQuery} matchIndex={find.activeIndex}
        matchTotal={find.hits.length} onPrev={() => find.go(-1)} onNext={() => find.go(1)} onClose={find.close}
        scope={find.scope} onToggleScope={find.toggleScope} groups={find.groups} activeHit={find.activeHit} focusEpoch={find.focusEpoch}/>
    </div>
  </div>;
}
