/** A distinct, stable URL for each user-created home tab. */
export function browserHomeUrl(id: string): string {
  return `muster-home://new/${id}`;
}

export function isBrowserHomeUrl(url: string): boolean {
  return /^muster-home:\/\/new\/[a-z0-9-]{1,64}$/i.test(url);
}
