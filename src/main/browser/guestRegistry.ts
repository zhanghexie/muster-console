/**
 * 内置浏览器 guest 注册表（纯逻辑，可单测）：tab 壳 ↔ webview guest webContents 的
 * 绑定关系与生命周期守卫。webview 化迁移（2026-10-08）后 BrowserTabService 不再
 * 拥有原生视图——渲染层持有 <webview> 元素，did-attach 后把 guest webContents id
 * 报给主进程；本注册表负责校验、换代与反查。
 *
 * 守卫语义（fail-closed，对齐 ZCode IAB 的经验）：
 * - 只接受 type === "webview" 的 guest（防误绑主窗口/其他 webContents 上 CDP 输入）
 * - 只接受主窗口 embedder 的直接 guest（windowId 必须匹配）
 * - 关闭的 tabId 留 tombstone，拒绝迟到 attach 复活
 * - guest 换代（renderer 重建元素）自增 generation，旧 guest 的迟到上报作废
 */

export interface GuestAttachOptions {
  tabId: string;
  webContentsId: number;
  /** 主窗口 id（embedder）；缺省视为不匹配 */
  windowId?: number;
  guestType?: string;
  /** embedder 的 webContents id（校验 guest 归属） */
  embedderId?: number;
}

export interface GuestRecord {
  webContentsId: number;
  generation: number;
  attachedAt: number;
}

export interface GuestAttachOutcome {
  ok: boolean;
  reason?: 'no-tab' | 'closed' | 'not-webview' | 'window-mismatch' | 'embedder-mismatch' | 'guest-in-use' | 'stale-generation';
  generation?: number;
}

export class BrowserGuestRegistry {
  private tabs = new Map<string, { exists: boolean; guest: GuestRecord | null; generation: number }>();
  /** tombstone：closed 后拒绝迟到 attach，防 UI 侧壳残留被复活 */
  private closed = new Set<string>();
  /** A detached/replaced guest cannot attach again from a delayed old renderer report. */
  private retired = new Set<number>();
  private windowId: number | null = null;
  private embedderId: number | null = null;

  setWindow(windowId: number | null, embedderId?: number): void {
    this.windowId = windowId;
    this.embedderId = embedderId ?? null;
  }

  /** tab 创建（壳注册；guest 等渲染层挂载 webview 后 attach）。同 id 重建=新生命周期，清 tombstone */
  createTab(tabId: string): void {
    if (!this.tabs.has(tabId)) this.tabs.set(tabId, { exists: true, guest: null, generation: 0 });
    this.closed.delete(tabId);
  }

  /** tab 关闭：清绑定 + tombstone */
  closeTab(tabId: string): void {
    const guest = this.tabs.get(tabId)?.guest;
    if (guest) this.retired.add(guest.webContentsId);
    this.tabs.delete(tabId);
    this.closed.add(tabId);
  }

  guestOf(tabId: string): GuestRecord | null {
    return this.tabs.get(tabId)?.guest ?? null;
  }

  tabIdOf(webContentsId: number): string | null {
    for (const [tabId, rec] of this.tabs) {
      if (rec.guest?.webContentsId === webContentsId) return tabId;
    }
    return null;
  }

  /** 渲染层 did-attach 上报：校验通过即绑定（换代自动清旧） */
  attach(opts: GuestAttachOptions): GuestAttachOutcome {
    const tabId = opts.tabId;
    if (this.closed.has(tabId)) return { ok: false, reason: 'closed' };
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.exists) return { ok: false, reason: 'no-tab' };
    if (opts.guestType !== 'webview') return { ok: false, reason: 'not-webview' };
    if (opts.windowId == null || this.windowId == null || opts.windowId !== this.windowId) {
      return { ok: false, reason: 'window-mismatch' };
    }
    if (this.embedderId != null && opts.embedderId !== this.embedderId) return { ok: false, reason: 'embedder-mismatch' };
    if (this.retired.has(opts.webContentsId)) return { ok: false, reason: 'stale-generation' };
    const owner = this.tabIdOf(opts.webContentsId);
    if (owner != null && owner !== tabId) return { ok: false, reason: 'guest-in-use' };
    const prev = tab.guest;
    if (prev?.webContentsId === opts.webContentsId) return { ok: true, generation: prev.generation };
    if (prev) this.retired.add(prev.webContentsId);
    const generation = ++tab.generation;
    tab.guest = { webContentsId: opts.webContentsId, generation, attachedAt: Date.now() };
    return { ok: true, generation };
  }

  /** guest 销毁上报（webview 元素卸载/renderer 崩溃）：壳保留、绑定清除 */
  detach(tabId: string, webContentsId: number): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab?.guest || tab.guest.webContentsId !== webContentsId) return false;
    this.retired.add(webContentsId);
    tab.guest = null;
    return true;
  }

  has(tabId: string): boolean {
    return !!this.tabs.get(tabId)?.exists && !this.closed.has(tabId);
  }

  isClosed(tabId: string): boolean {
    return this.closed.has(tabId);
  }
}
