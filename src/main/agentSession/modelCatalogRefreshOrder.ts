/** Only the most recently requested manual refresh may replace a catalog snapshot. */
export class ModelCatalogRefreshOrder {
  private readonly requests = new Map<string, symbol>();

  begin(key: string): () => boolean {
    if (this.requests.size >= 256 && !this.requests.has(key)) this.requests.delete(this.requests.keys().next().value!);
    const token = Symbol();
    this.requests.set(key, token);
    return () => this.requests.get(key) === token;
  }
}
