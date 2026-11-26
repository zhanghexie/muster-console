/** 内置浏览器（虚拟屏「浏览器」页签）共享类型：标签信息、事件 payload、config 段 */

/** 单个浏览器标签的投影（主进程 → 渲染层快照；id 主进程分配） */
export interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
  favicon: string | null;
  workspaceId?: string;
  sessionId?: string;
  scope?: 'workspace' | 'session';
  /** 新页面由哪个已有网页打开；仅当前运行中用于继承最新作用域。 */
  openerId?: string;
  /** Opening by an agent must register a tab without changing the user's selection. */
  openInBackground?: boolean;
  /** Renderer-only identity for a committed Chromium history position. */
  panelHistoryKey?: string;
  panelHistoryUserNavigation?: boolean;
  panelUserOpen?: boolean;
  /** Correlates the new native shell with its existing logical right tab. */
  panelReplayRequest?: string;
  panelRestorePending?: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** 崩溃已达上限：自动恢复停止，等待用户手动重试（浏览器页显示错误卡） */
  crashed?: boolean;
}

/** Used only to instantiate the webview. The host clears it before guest navigation. */
export const browserPanelReplaySrcPrefix = 'about:blank#muster-panel-replay-';

export interface BrowserPanelReplayRequest {
  requestId: string;
  browserId?: string;
  historyKey?: string;
  url: string;
  workspaceId: string;
  sessionId: string;
  scope: 'workspace' | 'session';
}

export interface BrowserTabsPayload {
  tabs: BrowserTabInfo[];
  activeId: string | null;
  /** 统一后退链可用性（网页历史 ∪ 激活轨迹）：侧栏 ‹ › 与 Alt+←/→ 共用 */
  nav?: { back: boolean; forward: boolean };
}

/** Agent 操控状态条（T3 工具面动作前后推送；active=false 表示空闲） */
export interface BrowserAgentStatePayload {
  active: boolean;
  /** 当前动作简述（如 navigate / click / fill），仅展示用 */
  action: string | null;
  tabId: string | null;
}

/** 输入动作在 guest 挂载后确认 embedder 的键盘焦点，状态胶囊不负责焦点。 */
export interface BrowserFocusRequest {
  requestId: string;
  tabId: string;
  webContentsId: number;
  /** Agent 显式激活可恢复当前会话的工作面；普通输入不改变布局。 */
  reveal?: boolean;
  /** 防止延迟的 renderer 帧在主进程已超时后抢回焦点。 */
  expiresAt?: number;
}
export interface BrowserFocusAck extends BrowserFocusRequest {
  focused: boolean;
  reason?: 'outside-scope';
}

/** 网页 CSS 视口坐标与像素滚动量（已处理宿主 transform 和 deltaMode）。 */
export interface BrowserWheelPayload {
  tabId: string;
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
}

/** 前台翻转视口对账（browser:view-sync）：渲染层上报 webview 元素 CSS 尺寸，
 *  主进程核对 guest 实际视口，失步时经 Emulation 覆写强制同步 */
export interface BrowserViewSync {
  tabId: string;
  webContentsId: number;
  width: number;
  height: number;
}

/** config.json 的 browser 段 */
export interface BrowserConfig {
  /** 重启恢复的标签壳（url 列表 + 激活下标）；工作面可见或工具请求才挂 guest */
  tabs?: { urls: string[]; activeIdx?: number; owners?: { workspaceId?: string; sessionId?: string; scope?: 'workspace' | 'session' }[] };
  /** 垂直标签栏宽度 px（140-320，拖把手调整；主进程合并写防与 tabs 段互踩） */
  tabbarWidth?: number;
  /** 标签栏收起（页头开关切换；收起时网页区占满） */
  tabbarCollapsed?: boolean;
  /**
   * CDP 调试端口开关（默认开）。端口本身无鉴权、仅绑 127.0.0.1，
   * 本机任意进程可连——已知残余风险；关闭后重启生效，agent 操控不可用。
   */
  cdpEnabled?: boolean;
}
