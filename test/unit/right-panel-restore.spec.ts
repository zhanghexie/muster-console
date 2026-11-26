/**
 * 右上角右栏开关「收起前姿态」记忆（组件级纯逻辑）：
 * - 折叠前姿态 {focus, dock} 落盘后原样读回——展开按收起前状态恢复，
 *   不再恒「VS 开 + Git 页」（2026-10-10 用户反馈「没有记忆」）；
 * - 旧版布尔键（muster.rightPanelRestoreFocus.v1）迁移为 {focus:true}；
 * - 坏数据/缺键回退 null（展开走默认 enableHVs('git')）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadRightPanelRestore,
  saveRightPanelRestore
} from '../../src/renderer/src/rightPanelRestore';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('右栏开关收起前姿态记忆', () => {
  it('折叠姿态落盘后原样读回（dock 记忆）', () => {
    expect(loadRightPanelRestore()).toBeNull();
    saveRightPanelRestore({ focus: false, dock: 'terminal' });
    expect(loadRightPanelRestore()).toEqual({ focus: false, dock: 'terminal' });
    saveRightPanelRestore({ focus: false, dock: 'git' });
    expect(loadRightPanelRestore()).toEqual({ focus: false, dock: 'git' });
    saveRightPanelRestore({ focus: true, dock: 'terminal' });
    expect(loadRightPanelRestore()).toEqual({ focus: true, dock: 'terminal' });
  });

  it('旧版布尔专注标记迁移为 {focus:true, dock:"git"}，保存新格式后清除', () => {
    localStorage.setItem('muster.rightPanelRestoreFocus.v1', '1');
    expect(loadRightPanelRestore()).toEqual({ focus: true, dock: 'git' });
    saveRightPanelRestore({ focus: false, dock: 'git' });
    expect(localStorage.getItem('muster.rightPanelRestoreFocus.v1')).toBeNull();
    expect(loadRightPanelRestore()).toEqual({ focus: false, dock: 'git' });
  });

  it('坏 JSON / 非法 dock 回退 null，展开走默认 Git 驻留', () => {
    localStorage.setItem('muster.rightPanelRestore.v1', '{oops');
    expect(loadRightPanelRestore()).toBeNull();
    localStorage.setItem('muster.rightPanelRestore.v1', '{"dock":"left"}');
    expect(loadRightPanelRestore()).toBeNull();
  });
});
