import { handle } from './handle';
import { normalizeUrlInput, type BrowserTabService } from '../browser/tabs';
import type { BrowserFocusAck, BrowserPanelReplayRequest, BrowserWheelPayload } from '../../shared/browser';
import { randomUUID } from 'node:crypto';
import { browserHomeUrl } from '../../shared/browserHome';

/**
 * 内置浏览器（虚拟屏「浏览器」页签）：渲染层直连 IPC。
 * 单对象参数（webApiShim 网关兼容；通道名符合 ns:method）。
 *
 * webview 化（2026-10-08）：旧视图管理通道（setContentBounds/setPageVisible/
 * setOverlayed/set-pointer-pipe/capture）整体移除——webview 随 DOM 布局移动、
 * 浮层直接覆盖；新增 guest attach/detach（注册表上报）、mount-request 推送
 * （懒挂载）与 wheel-forward（露条态滚轮经 CDP 转发）。
 */
export function registerBrowserIpc(svc: BrowserTabService): void {
  handle('browser:restore', () => svc.restore());
  handle('browser:replay-panel-history', (e, request: BrowserPanelReplayRequest) => {
    if (!e.sender || !svc.isHostContents(e.sender.id)) throw new Error('Browser history requires the desktop host');
    return svc.replayPanelHistory(request);
  });
  handle('browser:retain-panel-history', (e, keys: string[]) => {
    if (e.sender && svc.isHostContents(e.sender.id)) svc.retainPanelHistory(keys);
  });
  handle('browser:open', (e, args?: { url?: string; workspaceId?: string; sessionId?: string; scope?: 'workspace' | 'session'; openerId?: string; newTab?: boolean; background?: boolean; restoreShell?: boolean }) => ({
    id: svc.createTab(args?.newTab ? browserHomeUrl(randomUUID()) : normalizeUrlInput(args?.url ?? ''), { workspaceId: args?.workspaceId, sessionId: args?.sessionId, scope: args?.scope, openerId: args?.openerId },
      { background: args?.background === true, panelUserOpen: !!e.sender && svc.isHostContents(e.sender.id) && !args?.restoreShell })
  }));
  handle('browser:setOwner', (_e, args: { id: string; workspaceId: string; sessionId: string; scope: 'workspace' | 'session' }) => ({
    ok: svc.setOwner(args.id, { workspaceId: args.workspaceId, sessionId: args.sessionId, scope: args.scope })
  }));
  handle('browser:close', (e, args: { id: string }) => {
    const tab = svc.closeTab(args?.id, !!e.sender && svc.isHostContents(e.sender.id));
    return { ok: true, ...(tab ? { tab } : {}) };
  });
  handle('browser:bookmark-favicon', async (_e, args: { id: string }) => ({ dataUrl: await svc.bookmarkFavicon(String(args?.id ?? '')) }));
  handle('browser:activate', (_e, args: { id: string }) => {
    svc.activate(args?.id);
    return { ok: true };
  });
  handle('browser:navigate', async (e, args: { id: string; input: string }) => {
    await svc.runOperation(args?.id, () => svc.navigate(args?.id, String(args?.input ?? '')), e.sender && svc.isHostContents(e.sender.id) ? 'user' : 'agent');
    return { ok: true };
  });
  /** dir 导航；id 省略时作用于激活标签（全局前进后退集成用） */
  handle('browser:nav', async (e, args: { id?: string; dir: 'back' | 'forward' | 'refresh' }) => {
    const dir = args?.dir === 'forward' ? 'forward' : args?.dir === 'refresh' ? 'refresh' : 'back';
    const id = args?.id || svc.activeTabId();
    if (id) await svc.runOperation(id, () => svc.nav(id, dir), e.sender && svc.isHostContents(e.sender.id) ? 'user' : 'agent');
    return { ok: true };
  });
  handle('browser:devtools', (_e, args: { id: string }) => {
    void svc.openDevTools(args?.id);
    return { ok: true };
  });
  /** 渲染层 webview did-attach 上报（注册表绑定 + 事件接线；fail-closed 校验） */
  handle('browser:guest-attach', (_e, args: { tabId: string; webContentsId: number }) => {
    const r = svc.guestAttach(String(args?.tabId ?? ''), Number(args?.webContentsId));
    if (!r.ok) console.warn('[browser] guest attach rejected:', args, r.reason);
    return r;
  });
  /** 渲染层 webview 卸载/销毁上报（壳保留、绑定清除） */
  handle('browser:guest-detach', (_e, args: { tabId: string; webContentsId: number }) => {
    svc.guestDetach(String(args?.tabId ?? ''), Number(args?.webContentsId));
    return { ok: true };
  });
  /** 露条态滚轮转发（wc.sendInputEvent 对 guest 不生效，走 CDP Input 域） */
  handle('browser:focus-ack', (e, args: BrowserFocusAck) => {
    // 只有宿主 renderer 能确认焦点，guest 或其他窗口的回执不能解锁输入。
    return { ok: svc.ackGuestFocus(args, e.sender.id) };
  });
  handle('browser:wheel-forward', async (_e, args: BrowserWheelPayload) => {
    return { ok: await svc.wheelForward(String(args?.tabId ?? ''), args) };
  });
  /** 崩溃错误态手动重试（清零退避计数并 reload；非错误态返回 false） */
  handle('browser:retry-crash', (_e, args: { id: string }) => svc.retryCrash(String(args?.id ?? '')));
  /** webview preload 路径（<webview preload> 属性用；弹窗同步桥） */
  handle('browser:preload-path', () => ({ path: svc.preloadPath() }));
  /** 标签栏布局偏好（宽度/收起；主进程合并写进 config.browser） */
  handle('browser:setTabbar', (_e, args: { width?: number; collapsed?: boolean }) => {
    svc.setTabbarPrefs({ width: args?.width, collapsed: args?.collapsed });
    return { ok: true };
  });
  /** 元素拾取（DevTools 式：悬停高亮+名称，点击回传）；结果走 browser:picked 事件 */
  handle('browser:pick', () => {
    void svc.pick();
    return { ok: true };
  });
  handle('browser:cancelPick', () => {
    void svc.cancelPick();
    return { ok: true };
  });
  /** CDP 桥信息（设置页展示端口 / 一键配置外部 MCP 用） */
  handle('browser:cdp', async () => {
    const enabled = svc.cdpEnabledInConfig();
    const port = enabled ? await svc.cdpPort() : 0;
    return { enabled, port };
  });
}
