export type CapabilityDefinition<THandler> = {
  id: string;
  handler: THandler;
  source?: string;
  permission?: string;
  auditTag?: string;
};

export type CapabilityDescriptor = {
  id: string;
  source: string;
  permission?: string;
  auditTag?: string;
};

/** Registry shared by transports that expose the same host capability. */
export class CapabilityRegistry<THandler> {
  private readonly definitions = new Map<string, CapabilityDefinition<THandler>>();

  register(definition: CapabilityDefinition<THandler>): void {
    if (!definition.id.trim()) throw new Error('Capability id is required');
    if (this.definitions.has(definition.id)) {
      throw new Error(`Capability already registered: ${definition.id}`);
    }
    this.definitions.set(definition.id, definition);
  }

  get(id: string): CapabilityDefinition<THandler> | undefined {
    return this.definitions.get(id);
  }

  has(id: string): boolean {
    return this.definitions.has(id);
  }

  unregister(id: string): void {
    this.definitions.delete(id);
  }

  list(): CapabilityDescriptor[] {
    return [...this.definitions.values()].map(({ id, source, permission, auditTag }) => ({
      id,
      source: source ?? 'runtime',
      permission,
      auditTag
    }));
  }
}
