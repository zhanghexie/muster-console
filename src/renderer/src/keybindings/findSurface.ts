/**
 * Ctrl+F 分流：虚拟屏当前页决定默认面，焦点在会话/文件里时盖过默认。
 * 模块态，App 写、KeybindingHost 读。
 */
import { isChatFindDomTarget, isFilesFindDomTarget } from '../chatSurface/chatFindRegistry';

export type FindSurface = 'chat' | 'files';

let preferred: FindSurface = 'chat';

export function setPreferredFindSurface(next: FindSurface): void {
  preferred = next;
}

export function getPreferredFindSurface(): FindSurface {
  return preferred;
}

export function resetPreferredFindSurfaceForTest(): void {
  preferred = 'chat';
}

/** 焦点在文件/会话内跟焦点；否则跟虚拟屏激活页（preferred） */
export function resolveCtrlFSurface(
  target: EventTarget | null,
  surface: FindSurface = getPreferredFindSurface()
): FindSurface {
  if (isFilesFindDomTarget(target)) return 'files';
  if (isChatFindDomTarget(target)) return 'chat';
  return surface;
}
