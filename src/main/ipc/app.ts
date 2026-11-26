import { app, dialog } from 'electron';
import { sendSystemShortcut } from '../systemShortcuts';
import { importWallpaper, pruneWallpapers, WALLPAPER_EXTS } from '../frameBackdropFiles';
import { referencedWallpapers } from '../../shared/frameBackdrop';
import QRCode from 'qrcode';
import { handle } from './handle';
import type { AppContext } from '../context';
import { readCapturePreview } from '../capabilities/hosts/terminal';
import { t } from '../../shared/i18n';
import type { WebAccessStatusInfo } from '../../shared/webAccess';
import { appendRendererError } from '../logs/rendererError';
import { applyWindowChrome, type WindowAppearance } from '../windowMaterial';

type EditAction = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll';

/** 网关状态 + 推荐地址二维码（设置页「远程连接 · 网址连接」展示） */
async function webAccessStatus(ctx: AppContext): Promise<WebAccessStatusInfo> {
  const info = ctx.webAccess?.getStatusInfo() ?? {
    running: false,
    port: 0,
    token: '',
    urls: [],
    disabledReason: t('网页访问未启动'),
    hook: { path: '', urls: [], secret: '', signatureEnabled: false }
  };
  const primary = info.urls[0] ?? '';
  let qrDataUrl = '';
  if (info.running && primary) {
    try {
      qrDataUrl = await QRCode.toDataURL(primary, { margin: 1, width: 240 });
    } catch (err) {
      console.error('[web-access] qr generate failed:', err);
    }
  }
  return { ...info, qrDataUrl };
}

export function registerAppIpc(ctx: AppContext): void {
  handle('app:runSystemShortcut', (event, id: string) => {
    if (!event?.sender || event.sender !== ctx.getWindow()?.webContents) {
      return { ok: false, error: t('请在桌面工作台中使用系统快捷操作') };
    }
    const shortcut = ctx.config.get().systemShortcuts?.find(item => item.id === id);
    if (!shortcut) return { ok: false, error: t('快捷操作已删除，请重新打开菜单') };
    return sendSystemShortcut(shortcut.chord);
  });
  // handler 惰性执行：注册时 webAccess 可能尚未 bind（启动链尾部才建），调用时已就绪
  handle('webAccess:status', () => webAccessStatus(ctx));
  handle('webAccess:rotate', async () => {
    if (!ctx.webAccess) return { ok: false as const, error: t('网页访问未启动') };
    const res = ctx.webAccess.rotateToken();
    if (!res.ok) return { ok: false as const, error: res.error };
    return { ok: true as const, status: await webAccessStatus(ctx) };
  });
  // T3.2：hook token 轮换（旧 hook 地址立即失效）与签名密钥设置（空串 = 关闭校验）。
  // 轮换/设置以持久化成功为判据：落盘失败时 ok=false 保留旧凭证（R2，审计 2026-10-02）
  handle('webAccess:rotateHook', async () => {
    if (!ctx.webAccess) return { ok: false as const, error: t('网页访问未启动') };
    const res = ctx.webAccess.rotateHookToken();
    if (!res.ok) return { ok: false as const, error: res.error };
    return { ok: true as const, status: await webAccessStatus(ctx) };
  });
  handle('webAccess:setHookSecret', async (_event, secret?: unknown) => {
    if (!ctx.webAccess) return { ok: false as const, error: t('网页访问未启动') };
    const res = ctx.webAccess.setHookSecret(typeof secret === 'string' ? secret : '');
    if (!res.ok) return { ok: false as const, error: res.error };
    return { ok: true as const, status: await webAccessStatus(ctx) };
  });
  handle('app:quit', () => {
    app.quit();
    return { ok: true };
  });
  handle('app:version', () => app.getVersion());
  // 颜色来自当前主题（renderer/theme.ts 应用时同步下发）；缺省回深色 token 值
  handle('app:setChromeTheme', (_e, colors?: { panel?: string; ink?: string; appearance?: WindowAppearance }) => {
    const win = ctx.getWindow();
    if (!win) return { ok: false };
    const panel = colors?.panel ?? '#111112';
    const ink = colors?.ink ?? '#ededee';
    const appearance = colors?.appearance === 'light' || colors?.appearance === 'dark'
      ? colors.appearance
      : ctx.themes.getActive().appearance;
    const material = applyWindowChrome(win, { panel, ink, appearance });
    return { ok: true, material };
  });
  // 自定义壁纸：系统选图 → 复制进 userData/backdrops/；顺手清掉全局与各工作区都不再引用的旧图
  handle('app:pickWallpaper', async () => {
    const win = ctx.getWindow();
    const opts = {
      title: t('选择壁纸图片'),
      properties: ['openFile' as const],
      filters: [{ name: t('图片'), extensions: [...WALLPAPER_EXTS] }]
    };
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || !picked.filePaths[0]) return { ok: false as const, canceled: true };
    const userData = app.getPath('userData');
    const res = importWallpaper(userData, picked.filePaths[0]);
    if (!res.ok) return res;
    const cfg = ctx.config.get();
    pruneWallpapers(userData, [
      ...referencedWallpapers(cfg.frameBackdrop, cfg.frameBackdropByWorkspace),
      res.path
    ]);
    return res;
  });
  handle(
    'app:captureRect',
    async (_e, rect: { x: number; y: number; width: number; height: number }) => {
      const win = ctx.getWindow();
      if (!win) return null;
      const x = Math.max(0, Math.round(rect.x));
      const y = Math.max(0, Math.round(rect.y));
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const img = await win.webContents.capturePage({ x, y, width, height });
      return img.toDataURL();
    }
  );
  handle('captures:readPreview', (_e, absPath: string) =>
    readCapturePreview(String(absPath ?? ''))
  );
  handle('app:edit', (_e, action: EditAction) => {
    const wc = ctx.getWindow()?.webContents;
    if (!wc) return { ok: false };
    switch (action) {
      case 'undo':
        wc.undo();
        break;
      case 'redo':
        wc.redo();
        break;
      case 'cut':
        wc.cut();
        break;
      case 'copy':
        wc.copy();
        break;
      case 'paste':
        wc.paste();
        break;
      case 'selectAll':
        wc.selectAll();
        break;
      default:
        return { ok: false };
    }
    return { ok: true };
  });
  handle(
    'app:report-renderer-error',
    (
      _e,
      payload?: { label?: string; message?: string; stack?: string; componentStack?: string }
    ) => {
      const label = String(payload?.label ?? 'panel');
      const message = String(payload?.message ?? '');
      const file = appendRendererError(app.getPath('userData'), {
        ts: Date.now(),
        label,
        message,
        stack: payload?.stack,
        componentStack: payload?.componentStack
      });
      const wsId = ctx.config.get().activeWorkspaceId;
      if (wsId && message) {
        ctx.notify.push({
          workspaceId: wsId,
          sessionId: `renderer-error:${label}`,
          sessionName: t('工作台'),
          text: t('渲染层崩溃（{{label}}）：{{message}}', { label, message: message.slice(0, 240) }),
          toast: true
        });
      }
      return { ok: true, file };
    }
  );
}
