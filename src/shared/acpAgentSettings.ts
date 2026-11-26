/** Product-level visibility, independent of the shared ACP transport runtime. */
export function normalizeDisabledAcpAgents(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === 'string' && /^[a-zA-Z][\w-]{0,63}$/.test(id)))]
    : [];
}

export function acpAgentEnabled(config: { disabledAcpAgents?: readonly string[] }, id: string): boolean {
  return !config.disabledAcpAgents?.includes(id);
}
