/** Internal browser surface; never navigate a guest to this URL. */
export function uiSessionPageUrl(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) throw new Error('Invalid UI session id');
  return `muster-ui://session/${sessionId}`;
}

export function uiSessionPageId(url: string): string | null {
  return /^muster-ui:\/\/session\/([A-Za-z0-9_-]{1,64})$/.exec(url)?.[1] ?? null;
}
