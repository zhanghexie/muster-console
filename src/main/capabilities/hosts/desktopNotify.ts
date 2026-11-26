export type DesktopNotifyWorkspaceOpts = {
  workspaceName?: string;
  /** emoji，或 data:/http(s) 图片；仅 data: 会作为系统通知 icon */
  avatar?: string;
};

import { t } from '../../../shared/i18n';

function isImageAvatar(avatar: string): boolean {
  return avatar.startsWith('data:') || /^https?:/i.test(avatar);
}

/**
 * 标题：可选 emoji +「工区名 · 会话名」；图片头像不进标题，交给 Notification.icon。
 */
export function resolveDesktopNotifyPayload(
  sessionName: string,
  text: string,
  opts?: DesktopNotifyWorkspaceOpts
): { title: string; body: string; icon?: string } {
  const session = sessionName.trim() || t('会话');
  const ws = opts?.workspaceName?.trim() || '';
  const avatar = opts?.avatar?.trim() || '';
  const image = avatar && isImageAvatar(avatar);
  const emoji = avatar && !image ? avatar : '';

  const core = ws ? `${ws} · ${session}` : session;
  const title = emoji ? `${emoji} ${core}` : core;

  // Electron Notification.icon 需要本地图 / NativeImage；同步路径只接 data:
  const icon = avatar.startsWith('data:') ? avatar : undefined;

  return { title, body: text, icon };
}
