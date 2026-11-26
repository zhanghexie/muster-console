/**
 * 会话消息头像：发送者归类、连续省略、用户头像配置归一。
 * 纯函数，主进程 / 渲染层 / 自测共用（禁止碰 process）。
 */
import { getSubagentCharacter } from './subagentCharacters';

export const DEFAULT_USER_AVATAR_EMOJI = '🙂';

/**
 * 工作区 / 外观设置共用的预设 emoji 头像集。
 * 网格与 CreateWorkspaceModal 对齐；不在集合内的 emoji 走「自定义 emoji」。
 */
export const BUILTIN_AVATARS = [
  '🤖',
  '😺',
  '🐶',
  '🦊',
  '🐸',
  '🐙',
  '🦄',
  '🐲',
  '👻',
  '👽',
  '🧠',
  '⚡',
  '🌙',
  '🔥',
  '💎',
  '🚀'
] as const;


export type UserAvatarKind = 'emoji' | 'image' | 'builtin';

/** AppConfig.userAvatar：emoji、内置符号 id 或自定义图（磁盘 image 只留 kind） */
export interface UserAvatarConfig {
  kind: UserAvatarKind;
  /** emoji 字符；builtin 时为白名单角色 id；image 时为 data URL（hydrate 后） */
  value?: string;
  /** 用户显示名：头像悬浮气泡用；空则回落「我」 */
  displayName?: string;
}

export type ChatAvatarSender = 'user' | 'host' | 'scheduler' | 'agent' | 'assistant';

export interface ChatAvatarContext {
  surfaceKind: 'dispatch' | 'gui-session';
  workspaceAvatar?: string;
  workspaceName?: string;
  runtimeId?: string;
  runtimeLabel?: string;
  sessionName?: string;
  /** 跨会话注入的发送者快照；由渲染层将内置角色 id 映射成打包图片。 */
  agentAvatarUrl?: string;
  agentName?: string;
  /** 用户所选内置符号的本地图片 URL，由渲染层解析。 */
  userBuiltinAvatarUrl?: string;
  /** 工作区分类图标，由渲染层从持久化 ID 解析。 */
  workspaceBuiltinAvatarUrl?: string;
}

export interface ChatAvatarFace {
  shape: 'circle' | 'squircle' | 'symbol';
  type: 'image' | 'text';
  value: string;
}

const DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/]+=*$/i;

export function isAvatarDataUrl(src: string): boolean {
  return DATA_URL_RE.test(src.replace(/\s+/g, ''));
}

export function isImageAvatarSrc(src: string): boolean {
  return isAvatarDataUrl(src) || src.startsWith('data:image/') || /^https?:/i.test(src);
}

export function firstGrapheme(text: string): string {
  const t = text.trim();
  if (!t) return '';
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const it = seg.segment(t)[Symbol.iterator]();
    const first = it.next().value as { segment?: string } | undefined;
    if (first?.segment) return first.segment;
  }
  return Array.from(t)[0] ?? '';
}

function takeDisplayName(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const n = (raw as { displayName?: unknown }).displayName;
  if (typeof n !== 'string') return undefined;
  const t = n.trim().slice(0, 32);
  return t || undefined;
}

function withName(base: UserAvatarConfig, displayName?: string): UserAvatarConfig {
  return displayName ? { ...base, displayName } : base;
}

export function normalizeUserAvatar(raw: unknown): UserAvatarConfig {
  const displayName = takeDisplayName(raw);
  if (typeof raw === 'string' && raw.trim()) {
    const v = raw.trim();
    const legacySymbol = getSubagentCharacter(v);
    if (legacySymbol) return { kind: 'builtin', value: legacySymbol.id };
    if (isAvatarDataUrl(v) || v.startsWith('data:image/')) return { kind: 'image', value: v };
    return { kind: 'emoji', value: v.slice(0, 16) };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'emoji', value: DEFAULT_USER_AVATAR_EMOJI };
  }
  const o = raw as { kind?: unknown; value?: unknown };
  if (o.kind === 'builtin') {
    const character = getSubagentCharacter(o.value);
    return withName(character ? { kind: 'builtin', value: character.id } : { kind: 'emoji', value: DEFAULT_USER_AVATAR_EMOJI }, displayName);
  }
  // A hot-updated renderer can talk to an older main process that coerces builtin
  // into emoji while retaining the ID. Recover known IDs in replies and on restart.
  if (o.kind === 'emoji') {
    const legacySymbol = getSubagentCharacter(o.value);
    if (legacySymbol) return withName({ kind: 'builtin', value: legacySymbol.id }, displayName);
  }
  if (o.kind === 'image') {
    const value =
      typeof o.value === 'string' && (isAvatarDataUrl(o.value) || o.value.startsWith('data:image/'))
        ? o.value
        : undefined;
    return withName(value ? { kind: 'image', value } : { kind: 'image' }, displayName);
  }
  if (typeof o.value === 'string' && o.value.trim()) {
    const v = o.value.trim();
    if (isAvatarDataUrl(v) || v.startsWith('data:image/')) {
      return withName({ kind: 'image', value: v }, displayName);
    }
    return withName({ kind: 'emoji', value: v.slice(0, 16) }, displayName);
  }
  return withName({ kind: 'emoji', value: DEFAULT_USER_AVATAR_EMOJI }, displayName);
}

/** 落盘形态：image 不写 data URL（文件在 userData/avatars/user.png） */
export function serializeUserAvatar(av: UserAvatarConfig | undefined): UserAvatarConfig {
  const n = normalizeUserAvatar(av);
  const name = n.displayName ? { displayName: n.displayName } : {};
  if (n.kind === 'image') return { kind: 'image', ...name };
  if (n.kind === 'builtin') return { kind: 'builtin', value: n.value, ...name };
  return { kind: 'emoji', value: n.value || DEFAULT_USER_AVATAR_EMOJI, ...name };
}

/** 头像悬浮气泡文案（中文 key，渲染层 t()；用户自定义名原样） */
export function resolveAvatarTooltip(args: {
  sender: ChatAvatarSender;
  userAvatar: UserAvatarConfig;
  context?: ChatAvatarContext;
}): string {
  const { sender, userAvatar, context } = args;
  if (sender === 'host') return '宿主';
  if (sender === 'scheduler') return '调度 Agent';
  if (sender === 'agent') return context?.agentName?.trim() || 'Agent';
  if (sender === 'user') {
    return normalizeUserAvatar(userAvatar).displayName?.trim() || '我';
  }
  return context?.sessionName?.trim() || context?.runtimeLabel?.trim() || 'Agent';
}

export function chatAvatarSender(
  message: { role: string; host?: boolean; source?: string },
  surfaceKind: 'dispatch' | 'gui-session'
): ChatAvatarSender {
  if (message.host) return 'host';
  if (message.source === 'scheduler') return 'scheduler';
  if (message.source === 'agent') return 'agent';
  if (message.role === 'user') return 'user';
  return surfaceKind === 'dispatch' ? 'scheduler' : 'assistant';
}

/** 普通 AI 回复不挂头像；用户、调度注入与宿主通知在右侧保留身份。 */
export function hasChatMessageAvatar(message: { role: string; host?: boolean; source?: string }): boolean {
  return !!message.host || message.source === 'scheduler' || message.role === 'user';
}

/** 连续同发送者且展示方向相同，未被时间分隔/压缩线打断时压紧消息。 */
export function shouldOmitRepeatedAvatar(
  prev: { role: string; host?: boolean; source?: string } | undefined,
  curr: { role: string; host?: boolean; source?: string },
  surfaceKind: 'dispatch' | 'gui-session',
  interrupted?: boolean
): boolean {
  if (!prev || interrupted) return false;
  // 跨会话注入可能来自不同代理；没有发送者 id 时不能合并头像。
  if (curr.source === 'agent' || prev.source === 'agent') return false;
  if (hasChatMessageAvatar(prev) !== hasChatMessageAvatar(curr)) return false;
  return chatAvatarSender(prev, surfaceKind) === chatAvatarSender(curr, surfaceKind);
}

export function runtimeGlyph(runtimeId?: string, runtimeLabel?: string): string | undefined {
  const id = (runtimeId ?? '').toLowerCase();
  if (id.includes('cursor')) return 'C';
  if (id === 'pi' || id.startsWith('pi')) return 'π';
  if (id.includes('claude')) return '✶';
  if (id.includes('codex')) return '{}';
  if (id.includes('gemini')) return 'G';
  if (runtimeLabel?.trim()) return firstGrapheme(runtimeLabel);
  return undefined;
}

export function resolveAvatarFace(args: {
  sender: ChatAvatarSender;
  userAvatar: UserAvatarConfig;
  context?: ChatAvatarContext;
}): ChatAvatarFace {
  const { sender, userAvatar, context } = args;
  if (sender === 'agent') return context?.agentAvatarUrl
    ? { shape: 'circle', type: 'image', value: context.agentAvatarUrl }
    : { shape: 'circle', type: 'text', value: 'A' };
  if (sender === 'host') {
    return { shape: 'squircle', type: 'text', value: '宿主' };
  }
  if (sender === 'user') {
    const n = normalizeUserAvatar(userAvatar);
    if (n.kind === 'builtin' && context?.userBuiltinAvatarUrl) {
      return { shape: 'symbol', type: 'image', value: context.userBuiltinAvatarUrl };
    }
    if (n.kind === 'image' && n.value) {
      return { shape: 'circle', type: 'image', value: n.value };
    }
    return {
      shape: 'circle',
      type: 'text',
      value: n.kind === 'builtin' ? DEFAULT_USER_AVATAR_EMOJI : n.value?.trim() || DEFAULT_USER_AVATAR_EMOJI
    };
  }
  if (sender === 'scheduler') {
    if (context?.workspaceBuiltinAvatarUrl) return { shape: 'symbol', type: 'image', value: context.workspaceBuiltinAvatarUrl };
    const ws = context?.workspaceAvatar?.trim();
    if (ws && isImageAvatarSrc(ws)) {
      return { shape: 'circle', type: 'image', value: ws };
    }
    if (ws) return { shape: 'circle', type: 'text', value: firstGrapheme(ws) || ws };
    const name = firstGrapheme(context?.workspaceName ?? '');
    return { shape: 'circle', type: 'text', value: name || '🤖' };
  }
  const glyph = runtimeGlyph(context?.runtimeId, context?.runtimeLabel);
  if (glyph) return { shape: 'circle', type: 'text', value: glyph };
  const name = firstGrapheme(context?.sessionName ?? '');
  return { shape: 'circle', type: 'text', value: name || 'A' };
}

export function userAvatarDisplaySrc(av: UserAvatarConfig, builtinUrl?: string): string {
  const n = normalizeUserAvatar(av);
  if (n.kind === 'builtin') return builtinUrl || DEFAULT_USER_AVATAR_EMOJI;
  if (n.kind === 'image' && n.value) return n.value;
  return n.value?.trim() || DEFAULT_USER_AVATAR_EMOJI;
}
