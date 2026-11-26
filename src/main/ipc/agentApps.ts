import { randomUUID } from 'node:crypto';
import { dialog } from 'electron';
import type { AppContext } from '../context';
import type { AppCall, AppConnectionInput, AppQuery } from '../../shared/agentApps';
import { t } from '../../shared/i18n';
import { handle as registerIpc, type IpcHandler } from './handle';
import { localizeAppUserError } from '../../shared/appUserErrors';

function handle<T extends IpcHandler>(channel: string, fn: T): void {
  registerIpc(channel, (event, ...args) => {
    try {
      const result = fn(event, ...args);
      return result instanceof Promise ? result.catch(localizeAppUserError) : result;
    } catch (error) { return localizeAppUserError(error); }
  });
}

export function registerAgentAppsIpc(ctx: AppContext): void {
  const service = () => { if (!ctx.agentApps) throw new Error(t('应用服务尚未就绪')); return ctx.agentApps; };
  const localWindow = (event: Electron.IpcMainInvokeEvent) => {
    const window = ctx.getWindow();
    if (!window || !event?.sender || event.sender.id !== window.webContents.id) throw new Error(t('选图仅支持本机工作台窗口'));
    return window;
  };
  handle('agentApps:snapshot', (_event, ws: string) => service().snapshot(ws));
  handle('agentApps:query', (_event, ws: string, query: AppQuery) => service().query(ws, query));
  handle('agentApps:call', (_event, ws: string, call: AppCall) => service().execute(ws, call, { kind: 'human', runId: randomUUID() }));
  handle('agentApps:setEnabled', (_event, ws: string, appId: string, enabled: boolean) => service().setEnabled(ws, appId, enabled, 'human'));
  handle('agentApps:uninstall', (_event, ws: string, appId: string, deleteData: boolean) => service().uninstall(ws, appId, deleteData));
  handle('agentApps:listLibrary', (_event, ws: string) => service().listLibrary(ws));
  handle('agentApps:installFromLibrary', (_event, ws: string, catalogId: string, version?: number) => service().installFromLibrary(ws, catalogId, version, 'human'));
  handle('agentApps:publish', (_event, ws: string, appId: string) => service().publishToLibrary(ws, appId));
  handle('agentApps:setPrivate', (_event, ws: string, appId: string, privateApp: boolean) => service().setLibraryPrivate(ws, appId, privateApp));
  handle('agentApps:saveConnection', (_event, ws: string, input: AppConnectionInput) => service().saveConnection(ws, input));
  handle('agentApps:testConnection', (_event, ws: string, id: string) => service().testConnection(ws, id));
  handle('agentApps:listFeishuChats', async (_event, ws: string, identity: 'bot' | 'user', pageToken?: string) => {
    const page = await service().listFeishuChats(ws, identity, pageToken);
    return { ...page, chats: page.chats.map(chat => ({ ...chat,
      unavailable: chat.unavailable === '已添加到手机，请编辑原连接' ? t('已添加到手机，请编辑原连接') : chat.unavailable
    })) };
  });
  handle('agentApps:feishuStatus', (_event, ws: string) => service().feishuStatus(ws));
  handle('agentApps:startFeishuSetup', (_event, ws: string) => service().startFeishuSetup(ws));
  handle('agentApps:cancelFeishuSetup', (_event, ws: string) => service().cancelFeishuSetup(ws));
  handle('agentApps:beginFeishuBinding', (_event, ws: string) => service().beginFeishuBinding(ws));
  handle('agentApps:pickImage', async (event, ws: string, appId: string) => {
    const window = localWindow(event), images = service();
    const result = await dialog.showOpenDialog(window, { title: t('选择图片'), properties: ['openFile'], filters: [{ name: t('图片'), extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const };
    return { canceled: false as const, asset: await images.importImage(ws, appId, result.filePaths[0]) };
  });
  handle('agentApps:dropImage', (event, ws: string, appId: string, source: string) => {
    localWindow(event);
    if (typeof source !== 'string' || !source) throw new Error(t('无法读取拖入的本地图片'));
    return service().importImage(ws, appId, source);
  });
  handle('agentApps:readImage', (_event, ws: string, appId: string, id: string, thumbnail?: boolean) => service().readImage(ws, appId, id, thumbnail));
  handle('agentApps:releaseImage', (_event, ws: string, appId: string, id: string) => service().releaseImage(ws, appId, id));
}
