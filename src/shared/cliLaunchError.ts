import { t } from './i18n';

/** Keep validation errors stable for agents and stored data; translate only at a user-facing boundary. */
export const CLI_LAUNCH_ERROR_KEYS = [
  'CLI 配置格式无效',
  'CLI 模型 ID 无效或该引擎暂不支持启动时指定模型',
  'CLI 不支持所选思考强度',
  'CLI 全局启动参数包含 --，无法安全覆盖会话选项；请在 Worker 设置中移除',
  'Codex 配置参数缺少值'
] as const;
export const CLI_LAUNCH_ERROR_FRAMES = [
  { prefix: '未知 CLI 配置项: ', suffix: '', key: '未知 CLI 配置项: {{name}}' },
  { prefix: 'CLI ', suffix: ' 配置无效', key: 'CLI {{name}} 配置无效' },
  { prefix: 'CLI 不支持所选 ', suffix: ' 配置', key: 'CLI 不支持所选 {{name}} 配置' },
  { prefix: 'CLI 启动参数 ', suffix: ' 缺少值', key: 'CLI 启动参数 {{name}} 缺少值' }
] as const;
const known = new Set<string>(CLI_LAUNCH_ERROR_KEYS);
export function localizeCliLaunchError(value: string): string {
  if (known.has(value)) return t(value);
  const wrapped = /^(?:Error invoking remote method '[^']+': )?Error: ([\s\S]*)$/.exec(value);
  if (wrapped) {
    const detail = localizeCliLaunchError(wrapped[1]);
    return detail === wrapped[1] ? value : detail;
  }
  const frame = CLI_LAUNCH_ERROR_FRAMES.find(item => value.startsWith(item.prefix) && value.endsWith(item.suffix) && value.length > item.prefix.length + item.suffix.length);
  return frame ? t(frame.key, { name: value.slice(frame.prefix.length, frame.suffix ? -frame.suffix.length : undefined) }) : value;
}
