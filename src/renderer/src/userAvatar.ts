/**
 * 用户消息头像（渲染层）：locale / panelGlow 同款三段式。
 * 1. 模块态默认 🙂（与 AppConfig.userAvatar 缺省一致）；
 * 2. main.tsx 启动时 initUserAvatar()：config.get() 校正；
 * 3. 设置页切换走 setUserAvatar()（本地立即生效 + config:update 落盘）。
 */
import {
  DEFAULT_USER_AVATAR_EMOJI,
  normalizeUserAvatar,
  type UserAvatarConfig
} from '../../shared/userAvatar';

const listeners = new Set<() => void>();
let current: UserAvatarConfig = { kind: 'emoji', value: DEFAULT_USER_AVATAR_EMOJI };

export function getUserAvatar(): UserAvatarConfig {
  return current;
}

export function subscribeUserAvatar(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function apply(next: UserAvatarConfig): void {
  const n = normalizeUserAvatar(next);
  if (
    current.kind === n.kind &&
    current.value === n.value &&
    current.displayName === n.displayName
  ) {
    return;
  }
  current = n;
  for (const fn of listeners) fn();
}

/** 设置「外观」页切换：本地立即生效 + 落盘（不随设置表单草稿回写）。
 * 返回落盘结果：ok=false 时已回滚本地态并带主进程失败原因（P3 头像 F-01，
 * 上传图片落盘失败不再静默变 emoji，由设置页提示）。 */
export async function setUserAvatar(
  next: UserAvatarConfig
): Promise<{ ok: true } | { ok: false; msg: string }> {
  const prev = current;
  apply(next);
  const applied = current;
  try {
    const updated = await window.api.config.update({ userAvatar: getUserAvatar() });
    // 主进程返回归一后的 config（image 落文件/缺省校正）：用返回值校正本地态，
    // 避免「本地显示 A、磁盘是 B」的分叉（config.update 契约见 preload）。
    // 与回滚分支同口径：期间用户又换了头像（current 已不是 applied）就不覆盖。
    if (updated?.userAvatar && current === applied) apply(updated.userAvatar);
    return { ok: true };
  } catch (e) {
    // 落盘失败：主进程没写进去，本地留着新值会导致重启后头像跳回旧值。
    // 只在期间没有更改动时回滚，别把用户新的选择冲掉。
    if (current === applied) {
      apply(prev);
      console.warn('[userAvatar] config.update 失败，本地头像已回滚');
    }
    return { ok: false, msg: e instanceof Error ? e.message : String(e) };
  }
}

/** main.tsx 启动调用：主进程配置为准校正 */
export function initUserAvatar(): void {
  try {
    void window.api.config
      .get()
      .then((cfg) => {
        if (cfg.userAvatar) apply(cfg.userAvatar);
      })
      .catch(() => {
        /* 保持默认 */
      });
  } catch {
    /* ignore */
  }
}

/** 测试用：只写内存态，不落盘 */
export function resetUserAvatarForTest(
  next: UserAvatarConfig = { kind: 'emoji', value: DEFAULT_USER_AVATAR_EMOJI }
): void {
  apply(next);
}
