/**
 * 手机端会话状态工具：SessionMeta → 看板区（shared/boardStatus 单源推导）与
 * 胶囊样式类。L1 汇总徽标、L2 会话行、L3 顶栏胶囊、needs_y 列表共用。
 *
 * 胶囊词/色两源合一：liveStatus 文案优先（Worker 自报状态最准）；缺失时按
 * 看板状态推导（BOARD_STATUS_PRESENTATION 同一套词）——手机端任何会话都
 * 有状态可见（桌面左栏只在 liveStatus 在场时渲染胶囊）。
 */
import type { LiveStatusKind, SessionMeta } from '../../../shared/types';
import {
  boardStatusOfSession,
  boardZoneOf,
  type BoardStatus,
  type BoardZone
} from '../../../shared/boardStatus';
import { BOARD_STATUS_PRESENTATION } from '../panels/boardPresentation';

export function sessionZone(s: SessionMeta): BoardZone {
  return boardZoneOf(boardStatusOfSession(s));
}

/** 终端会话且未归档（手机列表口径：hidden 由主进程 list 已过滤） */
export function listableSession(s: SessionMeta): boolean {
  return s.type === 'terminal' && !s.archived;
}

/** liveStatus kind → 全局胶囊类（left.css .session-capsule*，桌面手机共用） */
export function capsuleKindClass(kind: LiveStatusKind): string {
  switch (kind) {
    case 'active':
      return 'session-capsule active';
    case 'waiting':
      return 'session-capsule waiting';
    case 'done':
      return 'session-capsule done';
    case 'error':
      return 'session-capsule error';
    default:
      return 'session-capsule info';
  }
}

/** liveStatus 缺失时的着色档：看板状态 → 胶囊 kind */
const FALLBACK_KIND: Record<BoardStatus, LiveStatusKind> = {
  working: 'active',
  idle: 'info',
  quiet: 'info',
  blocked: 'waiting',
  waiting: 'waiting',
  error: 'error',
  no_signal: 'info',
  done: 'done',
  exited: 'info',
  scheduled: 'info'
};

export interface SessionCapsuleInfo {
  kind: LiveStatusKind;
  label: string;
  exited: boolean;
}

/** 会话状态胶囊（L2 行 / L3 顶栏）：liveStatus 优先，缺省按看板状态推导 */
export function sessionCapsule(s: SessionMeta): SessionCapsuleInfo {
  const st = boardStatusOfSession(s);
  if (s.liveStatus) {
    return {
      kind: s.liveStatus.kind ?? 'info',
      label: s.liveStatus.label,
      exited: st === 'exited'
    };
  }
  return {
    kind: FALLBACK_KIND[st],
    label: BOARD_STATUS_PRESENTATION[st].label,
    exited: st === 'exited'
  };
}
