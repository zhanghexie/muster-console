/** Owns package-fingerprint keyed DomainRuntime unregister handles. */
export class ExtensionHostDomainFactoryRegistry {
  private readonly entries = new Map<string, () => void>();

  has(key: string): boolean {
    return this.entries.has(key);
  }

  add(key: string, unregister: (() => void) | undefined): void {
    this.entries.set(key, unregister ?? (() => {}));
  }

  unregister(extensionId?: string): void {
    for (const [key, dispose] of this.entries) {
      if (extensionId && !key.startsWith(`${extensionId}:`)) continue;
      dispose();
      this.entries.delete(key);
    }
  }
}
