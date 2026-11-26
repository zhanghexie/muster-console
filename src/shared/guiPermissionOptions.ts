import type { GuiWorkerMode } from './types';

export interface GuiPermissionOption {
  mode: GuiWorkerMode;
  label: string;
  description: string;
  disabled?: boolean;
  legacy?: boolean;
}

const coreOptions: GuiPermissionOption[] = [
  { mode: 'standard', label: '标准', description: '读取自动进行；编辑、命令和其他操作需要确认。用户工具规则仍会生效。' },
  { mode: 'accept-edits', label: '接受编辑', description: '自动接受工作区内的文件编辑，命令和其他操作需要确认。用户工具规则仍会生效。' },
  { mode: 'plan', label: '计划模式', description: '只读探索并提交计划；批准后进入执行阶段。用户工具规则仍会生效。' },
  { mode: 'auto', label: '完全访问', description: '工具请求默认自动放行；会话目录范围、用户规则和引擎限制仍然生效。Shell 的实际范围取决于引擎和系统。' }
];

const coreLegacy: GuiPermissionOption[] = [
  { mode: 'default', label: '旧权限：工作区自动', description: '工作区内编辑及命令自动执行；其他操作按现有规则处理。', legacy: true },
  { mode: 'ask', label: '旧权限：只读问答', description: '只读问答；修改和写入命令受到限制。用户工具规则仍会生效。', legacy: true }
];

export function supportsGuiPermissionMode(runtimeId: string | undefined, mode: GuiWorkerMode): boolean {
  return runtimeId === 'pi' && (coreOptions.some(option => option.mode === mode) || coreLegacy.some(option => option.mode === mode));
}

export function guiPermissionOptions(runtimeId: string | undefined, current?: GuiWorkerMode): GuiPermissionOption[] {
  return runtimeId === 'pi' ? [...coreOptions, ...coreLegacy.filter(option => option.mode === current)] : [];
}
