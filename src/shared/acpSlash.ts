/**
 * ACP AvailableCommands → Composer 斜杠菜单条目（按当前界面语言包装参数提示）。
 */
import { t } from './i18n';
export interface AcpSlashCommand {
  name: string;
  description?: string;
  inputHint?: string;
}

export interface AcpSlashMenuItem {
  id: string;
  label: string;
  description: string;
  insert: string;
}

/** 引擎下发的命令名去前导斜杠后拼进 / 菜单 */
export function acpCommandsToSlashItems(commands: readonly AcpSlashCommand[]): AcpSlashMenuItem[] {
  const out: AcpSlashMenuItem[] = [];
  const seen = new Set<string>();
  for (const c of commands) {
    const name = (c.name ?? '').trim().replace(/^\/+/, '');
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const hint = (c.inputHint ?? '').trim();
    const baseDescription = (c.description ?? '').trim() || name;
    out.push({
      id: `acp:${name}`,
      label: `/${name}`,
      // F-03（reliability/acp-gui-driver）：inputHint（streamMap 解析的 input/input.hint）
      // 真正进菜单出口——拼进 description 作参数提示；insert 统一带尾随空格方便补参数
      description: hint ? t('{{description}}（参数：{{hint}}）', { description: baseDescription, hint }) : baseDescription,
      insert: `/${name} `
    });
  }
  return out;
}

export function filterAcpSlashItems(items: readonly AcpSlashMenuItem[], query: string): AcpSlashMenuItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter(
    (i) =>
      i.label.slice(1).toLowerCase().startsWith(q) ||
      i.label.toLowerCase().includes(q) ||
      i.description.toLowerCase().includes(q)
  );
}
