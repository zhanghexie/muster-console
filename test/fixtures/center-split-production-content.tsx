/** Only leaf content/IPC are substitutes; CenterPanel, stores, producers and CSS stay production. */
import React from 'react';
import { injectPanelRelay } from '../../src/shared/panelRelay';

function Content(props: { sessionId: string; visible: boolean; style?: React.CSSProperties }, chat: boolean) {
  const [draft, setDraft] = React.useState('');
  return <div data-session={props.sessionId} data-visible={String(props.visible)}
    className={`${chat ? 'agent-chat-view' : 'terminal-wrap'} xfade xfade-instant${props.visible ? ' is-shown' : ''}`}
    style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: 'var(--bg-panel)', ...props.style }}>
    <div className="fixture-conversation" data-conversation={props.sessionId}
      style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '48px 24px 16px', fontSize: 15, lineHeight: 1.7 }}>
      <button data-body-control={props.sessionId} onClick={() => { (window as any).__centerSplitTest.clicked = props.sessionId; }}>正文操作 {props.sessionId}</button>
      {Array.from({ length: 30 }, (_, index) => <p key={index}>会话 {props.sessionId}：实际正文和输入应当跟着布局一起变化。第 {index + 1} 段，保留滚动、草稿和面板实例。</p>)}
    </div>
    <div className="fixture-composer" data-composer={props.sessionId} style={{ flex: 'none', margin: 16, padding: 12, border: '1px solid var(--hairline)', borderRadius: 10 }}>
      <textarea aria-label={`草稿 ${props.sessionId}`} value={draft} onChange={event => setDraft(event.target.value)}
        style={{ width: '100%', height: 54, display: 'block', font: 'inherit', resize: 'none' }} />
    </div>
  </div>;
}
export function TerminalView(props: any) { return Content(props, false); }
export function AgentChatView(props: any) { return Content(props, true); }
export function PromptTaskPanel(props: { onClose?: () => void }) {
  return <section data-tasks-panel style={{ height: '100%', overflow: 'auto', padding: 48 }}>
    <p>任务工具真实内容根用于中央几何与命中回归。</p><input aria-label="任务草稿" />
    <button onClick={props.onClose}>工具内部关闭</button>
  </section>;
}
export function ExtensionPanel(props: { extId: string; viewId?: string; active: boolean; placement?: string; onClose?: () => void }) {
  const src = React.useMemo(() => injectPanelRelay(`<!doctype html><html><head></head><body><label>iframe草稿<input id="draft"></label>
    <p>沙箱 iframe：父面板拖动应通过盾层跨过这个文档。</p>
    <script>window.loads=(window.loads||0)+1;document.body.dataset.ready='true';</script></body></html>`), []);
  return <section data-extension={props.extId} data-view={props.viewId} data-placement={props.placement ?? 'center'} data-active={String(props.active)} style={{ height: '100%' }}>
    <button onClick={props.onClose}>扩展内部关闭</button>
    <iframe title={props.viewId === 'pane-b' ? '分屏测试沙箱乙' : '分屏测试沙箱'} sandbox="allow-scripts" srcDoc={src} style={{ border: 0, width: '100%', height: 'calc(100% - 30px)' }} />
  </section>;
}

/** Substitute the iframe surface and retain production navigation and folder cards. */
export function DomainExtensionPanel(props: { extensionId: string; surfaceKey?: string; active: boolean; placement?: string; onClose?: () => void }) {
  const nodeId = props.surfaceKey ? JSON.parse(props.surfaceKey)[1] : undefined;
  return <ExtensionPanel extId={props.extensionId} viewId={nodeId === 'child-b' ? 'pane-b' : 'pane'}
    active={props.active} placement={props.placement} onClose={props.onClose} />;
}
