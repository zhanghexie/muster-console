import type { PiCatalogModel } from './piCatalog';

/** Connection draft: refreshing never saves or edits the provider configuration. */
export interface ProviderModelCatalogRequest {
  id: string;
  baseUrl: string;
  apiKey: string;
  api?: string;
}

export interface ProviderModelCatalogSnapshot {
  fetchedAt: number;
  models: Array<PiCatalogModel & { id: string }>;
}

export type ProviderModelCatalogResult =
  | { ok: true; snapshot: ProviderModelCatalogSnapshot | null }
  | { ok: false; error: string };
