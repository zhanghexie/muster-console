/** 内置子代理职业身份；纯数据/选择逻辑，主进程与渲染层共用，图片 URL 只在渲染层解析。 */
export const SUBAGENT_CHARACTERS = [
  { id: 'pixel', name: '像素', role: '设计师' },
  { id: 'rivet', name: '铆钉', role: '工程师' },
  { id: 'quantum', name: '量子', role: '科学家' },
  { id: 'welder', name: '小焊', role: '蓝领技师' },
  { id: 'scout', name: '星探', role: '探索者' },
  { id: 'sentinel', name: '哨兵', role: '安全员' },
  { id: 'compass', name: '罗盘', role: '产品经理' },
  { id: 'joinery', name: '榫卯', role: '架构师' },
  { id: 'atlas', name: '星图', role: '数据分析师' },
  { id: 'pi', name: '小派', role: '数学家' },
  { id: 'bubble', name: '泡泡', role: '测试员' },
  { id: 'wrench', name: '扳手', role: '运维师' },
  { id: 'bookmark', name: '书签', role: '图书管理员' },
  { id: 'ink', name: '墨墨', role: '作家' },
  { id: 'bridge', name: '语桥', role: '翻译家' },
  { id: 'bean', name: '智豆', role: '教师' },
  { id: 'healer', name: '小愈', role: '医生' },
  { id: 'sprout', name: '萌芽', role: '园丁' },
  { id: 'stew', name: '小炖', role: '厨师' },
  { id: 'note', name: '音符', role: '音乐家' },
  { id: 'palette', name: '彩彩', role: '艺术家' },
  { id: 'shutter', name: '快门', role: '摄影师' },
  { id: 'scales', name: '法尺', role: '法律顾问' },
  { id: 'courier', name: '信使', role: '协调员' }
] as const;

export type SubagentCharacterId = (typeof SUBAGENT_CHARACTERS)[number]['id'];
export const DEFAULT_SUBAGENT_CHARACTER_ID: SubagentCharacterId = 'rivet';
export function getSubagentCharacter(id: unknown): (typeof SUBAGENT_CHARACTERS)[number] | undefined {
  return SUBAGENT_CHARACTERS.find(character => character.id === id);
}

/** Display-only round robin per host process; explicit IDs support queued/legacy requests. */
let nextCharacterIndex = 0;
export function selectSubagentCharacter(_task: string, explicit?: string): (typeof SUBAGENT_CHARACTERS)[number] {
  if (explicit !== undefined) {
    const selected = getSubagentCharacter(explicit);
    if (!selected) throw new Error(`未知子代理角色 characterId: ${explicit}`);
    return selected;
  }
  const selected = SUBAGENT_CHARACTERS[nextCharacterIndex];
  nextCharacterIndex = (nextCharacterIndex + 1) % SUBAGENT_CHARACTERS.length;
  return selected;
}

export function subagentSessionName(characterId: SubagentCharacterId, taskName: string): string {
  const character = getSubagentCharacter(characterId)!;
  const text = taskName.trim().replace(/\s+/g, ' ');
  const composed = text === character.name || text.startsWith(`${character.name} · `) ? text : `${character.name} · ${text}`;
  if (composed.length <= 80) return composed;
  // 截断补省略号（与任务短名派生 deriveDisplayName 风格一致）；边界避让 UTF-16 代理对，
  // 不把增补平面字符（emoji 等）劈成半个——末位是高位代理时回退一位再截。
  const cut = composed.charCodeAt(78) >= 0xd800 && composed.charCodeAt(78) <= 0xdbff ? 78 : 79;
  return `${composed.slice(0, cut)}…`;
}

/** 历史消息携带发送时的身份快照；不保存任意图片 URL。 */
export interface SourceAgentIdentity {
  sessionId: string;
  name: string;
  characterId?: SubagentCharacterId;
}

export function coerceSourceAgentIdentity(value: unknown): SourceAgentIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.sessionId !== 'string' || !v.sessionId.trim() || typeof v.name !== 'string' || !v.name.trim()) return undefined;
  const character = getSubagentCharacter(v.characterId);
  return { sessionId: v.sessionId.trim().slice(0, 120), name: v.name.trim().slice(0, 80), ...(character ? { characterId: character.id } : {}) };
}
