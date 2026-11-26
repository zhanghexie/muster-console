import { BrowserWindow, session, type Session } from 'electron';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SMOKE_BUDGET_MS = 2500;
let smokeQueue: Promise<unknown> = Promise.resolve();
export interface UiSmokeReport { warnings: string[]; diagnostics: Record<string, unknown>[]; }

/** Execute the production artifact in the same opaque allow-scripts iframe as chat.
 * The parent only acknowledges in-memory state; it cannot call host tools or actions. */
function buildUiWidgetSmokePage(filePath: string): string {
  const url = JSON.stringify(pathToFileURL(filePath).href).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; frame-src file:; style-src 'unsafe-inline'"><iframe sandbox="allow-scripts" style="width:780px;height:900px"></iframe><script>
  window.__maSmokeDone = new Promise(function(resolve) {
    var frame = document.querySelector('iframe'), errors = [], diagnostics = [], timer;
    function finishSoon() { if (!timer) timer = setTimeout(function() { resolve({ errors: errors, diagnostics: diagnostics }); }, 100); }
    window.addEventListener('message', function(event) {
      if (event.source !== frame.contentWindow || !event.data || event.data.__ma !== true || event.data.v !== 2) return;
      var data = event.data;
      if (Array.isArray(data.diagnostics)) data.diagnostics.forEach(function(detail) { if (detail && diagnostics.length < 8 && !diagnostics.some(function(current) { return current.id === detail.id && current.attribute === detail.attribute && current.message === detail.message; })) diagnostics.push(detail); });
      function reply(message) { frame.contentWindow.postMessage(Object.assign({ __ma: true }, message), '*'); }
      if (data.type === 'ready') reply({ type: 'init', state: { revision: 0, modelContent: null, privateContent: null, presentation: { collapsed: false } } });
      else if (data.type === 'state') reply({ type: 'state-result', id: data.id, ok: true });
      else if (data.type === 'action') reply({ type: 'action-result', id: data.id, ok: false, error: '运行时冒烟不执行交互动作' });
      if (data.type === 'error' || data.type === 'diagnostic' || data.type === 'render' && (data.status === 'failed' || data.status === 'degraded')) {
        var text = typeof data.message === 'string' && data.message ? data.message : '内容渲染失败';
        if (errors.indexOf(text) < 0 && errors.length < 5) errors.push(text.slice(0, 1000));
        finishSoon();
      } else if (data.type === 'render' && data.status === 'rendered') finishSoon();
    });
    frame.src = ${url};
  });
  </script>`;
}

async function executeSmoke(filePath: string, deadline: number): Promise<UiSmokeReport> {
  if (Date.now() >= deadline) return { warnings: ['运行时冒烟未完成：等待检查器超时，请在挂载后用 ui.inspect 复验'], diagnostics: [] };
  let window: BrowserWindow | undefined, directory = '', wrapper = '';
  let isolated: Session | undefined, stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanupFiles = async (): Promise<void> => {
    if (wrapper) await unlink(wrapper).catch(() => {});
    if (directory) await rmdir(directory).catch(() => {});
  };
  const checkDeadline = async (): Promise<void> => {
    if (stopped || Date.now() >= deadline) {
      await cleanupFiles();
      throw new Error('执行超时，请在挂载后用 ui.inspect 复验');
    }
  };
  try {
    const result = await Promise.race([
      (async () => {
        directory = await mkdtemp(path.join(os.tmpdir(), 'ma-ui-smoke-'));
        await checkDeadline();
        wrapper = path.join(directory, 'index.html');
        await writeFile(wrapper, buildUiWidgetSmokePage(filePath), 'utf8');
        await checkDeadline();
        // One ephemeral partition is reused only by this serialized checker.
        isolated = session.fromPartition('ui-widget-smoke', { cache: false });
        isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        isolated.setPermissionCheckHandler(() => false);
        const allowed = new Set([pathToFileURL(wrapper).href, pathToFileURL(filePath).href]);
        isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
          callback({ cancel: !allowed.has(details.url) && !/^(about:|data:|blob:)/.test(details.url) });
        });
        window = new BrowserWindow({ show: false, width: 800, height: 950,
          webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', event => event.preventDefault());
        await window.loadFile(wrapper);
        await checkDeadline();
        const value = await window.webContents.executeJavaScript('window.__maSmokeDone') as { errors?: unknown; diagnostics?: unknown };
        return { warnings: Array.isArray(value?.errors) ? value.errors.filter((error): error is string => typeof error === 'string').map(error => `运行时报错：${error}`) : ['运行时冒烟未完成：检查结果无效'],
          diagnostics: Array.isArray(value?.diagnostics) ? value.diagnostics.filter((detail): detail is Record<string, unknown> => !!detail && typeof detail === 'object').map(detail => ({ ...detail, message: String(detail.message || '').slice(0, 1500), expression: String(detail.expression || '').slice(0, 4096) })) : [] };
      })(),
      new Promise<UiSmokeReport>(resolve => { timer = setTimeout(() => resolve({ warnings: ['运行时冒烟未完成：执行超时，请在挂载后用 ui.inspect 复验'], diagnostics: [] }), Math.max(1, deadline - Date.now())); })
    ]);
    return result;
  } catch (error) {
    return { warnings: [`运行时冒烟未完成：${String((error as Error).message).slice(0, 500)}`], diagnostics: [] };
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (window && !window.isDestroyed()) window.destroy();
    isolated?.webRequest.onBeforeRequest(null);
    await cleanupFiles();
  }
}

/** Serialize hidden renderers; queue time counts toward each tool call's short budget. */
export function smokeUiWidget(filePath: string): Promise<string[]> {
  return smokeUiWidgetReport(filePath).then(report => report.warnings);
}

export function smokeUiWidgetReport(filePath: string): Promise<UiSmokeReport> {
  const deadline = Date.now() + SMOKE_BUDGET_MS;
  const operation = smokeQueue.then(() => executeSmoke(filePath, deadline));
  smokeQueue = operation.catch(() => undefined);
  return operation;
}
