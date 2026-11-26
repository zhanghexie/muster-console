import { app } from 'electron';
import type { AppContext } from '../../context';
import { t } from '../../../shared/i18n';
import { BrowserAgentTools, type BrowserActor } from '../../browser/agentTools';
import { snapshotUploadFiles } from '../../browser/uploadFiles';
import { uploadScope } from '../../browser/uploadScope';
import { authorizeSafetyOperation } from '../../safety/bindings';

/**
 * browser.*：内置浏览器操控（虚拟屏侧栏「浏览器」页的标签）。
 * 观察表示 = ariaSnapshot 无障碍树 + ref（Playwright 同源）；无审批门
 * （用户决策 2026-09-07）；页面独立后台执行，操作不改变用户前台标签或焦点。
 * R2 起 catalog 面收敛为 browser.run 单入口；本文件是 25 个动作的内部执行真源，
 * 参数语义与组合套路见 ~/.muster/skills/browser/SKILL.md。
 */
let singleton: BrowserAgentTools | null = null;

function toolsFor(ctx: AppContext): BrowserAgentTools {
  if (!singleton) {
    if (!ctx.browser) throw new Error(t('内置浏览器服务未就绪'));
    singleton = new BrowserAgentTools(ctx.browser, ctx.getWindow, app.getPath('userData'));
  }
  return singleton;
}

/** Worker binding supplies trusted session identity; scheduler calls have workspace scope only. */
function browserActor(ctx: AppContext, args?: { __browserOwner?: BrowserActor }): BrowserActor {
  return args?.__browserOwner ?? { workspaceId: ctx.resolveBubbleWorkspaceId() };
}

export const browserHost: Record<string, (ctx: AppContext, args: any, options?: { signal?: AbortSignal }) => unknown> = {
  'browser.tabs': (ctx) => toolsFor(ctx).tabsList(),
  'browser.open': (ctx, args: { url?: string; __browserOwner?: BrowserActor }) =>
    toolsFor(ctx).open(args?.url, browserActor(ctx, args)),
  'browser.close': (ctx, args: { tabId: string }) => {
    toolsFor(ctx).closeTab(String(args?.tabId ?? ''));
    return { ok: true };
  },
  'browser.activate': (ctx, args: { tabId: string; foreground?: boolean; __browserOwner?: BrowserActor }) =>
    toolsFor(ctx).activate(String(args?.tabId ?? ''), browserActor(ctx, args), {
      foreground: !!args?.foreground
    }),
  'browser.navigate': (ctx, args: { tabId: string; input: string }) =>
    toolsFor(ctx).navigate(String(args?.tabId ?? ''), String(args?.input ?? '')),
  'browser.snapshot': async (
    ctx,
    args: {
      tabId: string;
      selector?: string;
      interactiveOnly?: boolean;
      maxChars?: number;
      offset?: number;
    }
  ) =>
    toolsFor(ctx).snapshot(String(args?.tabId ?? ''), {
      selector: args?.selector,
      interactiveOnly: args?.interactiveOnly,
      maxChars: args?.maxChars,
      offset: args?.offset
    }),
  'browser.click': async (ctx, args: { tabId: string; target: string }) =>
    toolsFor(ctx).click(String(args?.tabId ?? ''), String(args?.target ?? '')),
  'browser.fill': async (ctx, args: { tabId: string; target: string; text: string }) =>
    toolsFor(ctx).fill(String(args?.tabId ?? ''), String(args?.target ?? ''), String(args?.text ?? '')),
  'browser.selectOption': async (
    ctx,
    args: { tabId: string; target: string; value: string }
  ) =>
    toolsFor(ctx).selectOption(
      String(args?.tabId ?? ''),
      String(args?.target ?? ''),
      String(args?.value ?? '')
    ),
  'browser.pressKey': async (ctx, args: { tabId: string; key: string; target?: string }) =>
    toolsFor(ctx).pressKey(
      String(args?.tabId ?? ''),
      String(args?.key ?? 'Enter'),
      args?.target ? String(args.target) : undefined
    ),
  'browser.hover': async (ctx, args: { tabId: string; target: string }) =>
    toolsFor(ctx).hover(String(args?.tabId ?? ''), String(args?.target ?? '')),
  'browser.movePointer': async (ctx, args: { tabId: string; target: string }) =>
    toolsFor(ctx).movePointer(String(args?.tabId ?? ''), String(args?.target ?? '')),
  'browser.scroll': async (
    ctx,
    args: { tabId: string; direction?: 'up' | 'down'; amount?: number; target?: string }
  ) =>
    toolsFor(ctx).scroll(
      String(args?.tabId ?? ''),
      args?.direction === 'up' ? 'up' : 'down',
      args?.amount,
      args?.target
    ),
  'browser.waitFor': async (
    ctx,
    args: {
      tabId: string;
      text?: string;
      selector?: string;
      url?: string;
      hiddenSelector?: string;
      state?: 'load' | 'domcontentloaded' | 'networkidle';
      timeoutMs?: number;
      timeMs?: number;
    }
  ) =>
    toolsFor(ctx).waitFor(String(args?.tabId ?? ''), {
      text: args?.text,
      selector: args?.selector,
      url: args?.url,
      hiddenSelector: args?.hiddenSelector,
      state: args?.state,
      timeoutMs: args?.timeoutMs,
      timeMs: args?.timeMs
    }),
  'browser.screenshot': async (
    ctx,
    args: { tabId: string; selector?: string; fullPage?: boolean }
  ) =>
    toolsFor(ctx).screenshot(String(args?.tabId ?? ''), {
      selector: args?.selector,
      fullPage: args?.fullPage
    }),
  'browser.evaluate': async (ctx, args: { tabId: string; expression: string }) =>
    toolsFor(ctx).evaluate(String(args?.tabId ?? ''), String(args?.expression ?? '')),
  'browser.upload': async (
    ctx,
    args: { tabId: string; target: string; files: string[]; workspaceId?: string },
    options?: { signal?: AbortSignal }
  ) => {
    const scope = uploadScope(ctx, args?.workspaceId);
    const snapshot = await snapshotUploadFiles(args?.files, scope.cwd, scope.dirs);
    const assertCurrent = () => { options?.signal?.throwIfAborted(); scope.assertCurrent(); };
    let cleanupError: unknown;
    let result: unknown;
    try {
      assertCurrent();
      result = await toolsFor(ctx).upload(String(args?.tabId ?? ''), String(args?.target ?? ''), snapshot.paths, snapshot.objects.map(file => file.sha256), assertCurrent,
        async destination => {
          options?.signal?.throwIfAborted();
          if (!snapshot.objects.length) return;
          const decision = await authorizeSafetyOperation(ctx, {
            action: 'browser.fileAssignment', source: 'catalog', dangerous: true, signal: options?.signal, workspaceId: scope.workspaceId,
            summary: 'Assign these exact local files to the target web page; the page may upload them immediately.',
            args: { tabId: String(args?.tabId ?? ''), target: String(args?.target ?? ''), ...destination, files: snapshot.objects }
          });
          if (!decision.allowed) throw new Error(`File assignment was not authorized: ${decision.reason}`);
          options?.signal?.throwIfAborted();
        });
    } finally {
      try { await snapshot.cleanup(); } catch (error) { cleanupError = error; console.warn('[browser] upload snapshot cleanup failed:', String(error)); }
    }
    return cleanupError ? { ...(result as object), cleanupWarning: `Upload snapshots could not be removed: ${String(cleanupError)}` } : result;
  },
  'browser.drag': async (
    ctx,
    args: { tabId: string; from: string; to: string; timeoutMs?: number }
  ) =>
    toolsFor(ctx).drag(
      String(args?.tabId ?? ''),
      String(args?.from ?? ''),
      String(args?.to ?? ''),
      args?.timeoutMs
    ),
  'browser.setViewport': async (ctx, args: { tabId: string; width?: number; height?: number; reset?: boolean }) => {
    if (args?.reset === true) {
      if (args.width !== undefined || args.height !== undefined) throw new Error(t('reset 不与 width/height 组合'));
      return toolsFor(ctx).resetViewport(String(args.tabId ?? ''));
    }
    return toolsFor(ctx).setViewport(String(args?.tabId ?? ''), Number(args?.width), Number(args?.height));
  },
  'browser.recording': async (
    ctx,
    args: { action?: string; tabId?: string; recordingId?: string }
  ) => toolsFor(ctx).recording({ action: args?.action, tabId: args?.tabId, recordingId: args?.recordingId }),
  /** Deterministic extension renderer.  Unlike browser.recording this is
   * allowed to run on a hidden native page and drives window.renderAt(t). */
  'tasks.render': async (
    ctx,
    args: {
      action?: string;
      tabId?: string;
      url?: string;
      renderId?: string;
      jobId?: string;
      recordingId?: string;
      width?: number;
      height?: number;
      times?: number[];
      durationMs?: number;
      fps?: number;
      __browserOwner?: BrowserActor;
    },
    options?: { signal?: AbortSignal }
  ) => toolsFor(ctx).render(args, browserActor(ctx, args), options?.signal),
  'browser.dialog': async (
    ctx,
    args: {
      action: 'list' | 'accept' | 'dismiss' | 'policy';
      tabId: string;
      dialogId?: string;
      promptText?: string;
      policy?: 'manual' | 'auto-accept' | 'auto-dismiss';
    }
  ) => {
    const tabId = String(args?.tabId ?? '');
    const action = String(args?.action ?? 'list');
    if (action === 'accept') return toolsFor(ctx).dialogAct(tabId, String(args?.dialogId ?? ''), true, args?.promptText);
    if (action === 'dismiss') return toolsFor(ctx).dialogAct(tabId, String(args?.dialogId ?? ''), false);
    if (action === 'policy') return toolsFor(ctx).dialogPolicy(tabId, args?.policy ?? 'manual');
    return toolsFor(ctx).dialogList(tabId);
  },
  'browser.cookies': async (
    ctx,
    args: {
      action?: 'get' | 'set' | 'clear';
      tabId?: string;
      cookies?: Array<Record<string, unknown>>;
      urls?: string[];
      name?: string;
      __browserOwner?: BrowserActor;
    }
  ) =>
    toolsFor(ctx).cookies(
      args?.tabId ? String(args.tabId) : undefined,
      {
        action: args?.action === 'set' || args?.action === 'clear' ? args.action : 'get',
        cookies: args?.cookies,
        urls: args?.urls,
        name: args?.name
      },
      browserActor(ctx, args)
    ),
  'browser.storage': async (
    ctx,
    args: {
      action?: 'get' | 'set' | 'remove' | 'clear';
      kind?: 'local' | 'session';
      tabId: string;
      key?: string;
      value?: string;
    }
  ) =>
    toolsFor(ctx).storage(String(args?.tabId ?? ''), {
      action: args?.action ?? 'get',
      kind: args?.kind === 'session' ? 'session' : 'local',
      key: args?.key,
      value: args?.value
    }),
  'browser.console': (ctx, args: { tabId: string; level?: string; contains?: string; limit?: number }) =>
    toolsFor(ctx).consoleEntries(String(args?.tabId ?? ''), {
      level: args?.level,
      contains: args?.contains,
      limit: args?.limit
    }),
  'browser.network': async (
    ctx,
    args: {
      action?: 'list' | 'body';
      tabId: string;
      method?: string;
      status?: number;
      contains?: string;
      limit?: number;
      requestId?: string;
    }
  ) =>
    toolsFor(ctx).network(String(args?.tabId ?? ''), {
      action: args?.action,
      method: args?.method,
      status: args?.status,
      contains: args?.contains,
      limit: args?.limit,
      requestId: args?.requestId
    }),
  'browser.downloads': (ctx, args: { limit?: number }) => toolsFor(ctx).downloads({ limit: args?.limit }),
};
