/** 左栏会话 CLI 标识 */

export function sessionCliLabel(
  s: {
    type?: string;
    launchKind?: string;
    runtime?: string | null;
    shellProfileId?: string | null;
  },
  runtimes: { id: string; label: string }[]
): string {
  if (s.type === 'scheduled') return '';
  if (s.launchKind === 'shell') return s.shellProfileId?.trim() || '';
  const id = s.runtime?.trim();
  if (!id) return '';
  return runtimes.find((r) => r.id === id)?.label ?? id;
}

export function formatSessionListName(name: string, cli?: string | null): string {
  const tail = cli?.trim();
  if (!tail) return name;
  return `${name} · ${tail}`;
}
