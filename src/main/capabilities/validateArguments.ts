import type { JsonObject, Tool } from '@earendil-works/pi-ai';

/** Reuse the same schema validator as the existing Pi execution boundary. */
export async function validateDiscoveredArguments(name: string, schema: Record<string, unknown>, args: JsonObject): Promise<Record<string, unknown>> {
  // The production Electron main bundle is CommonJS. This package exports this
  // entry only for ESM import, so a static import becomes an invalid require().
  const { validateToolArguments } = await import('@earendil-works/pi-ai/utils/validation');
  return validateToolArguments({ name, description: '', parameters: schema as Tool['parameters'] },
    { type: 'toolCall', id: 'discovered-call', name, arguments: args }) as Record<string, unknown>;
}
