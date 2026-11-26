export interface CatalogModelProgress {
  completed: number;
  total: number;
  model?: string;
}

export interface CatalogModelCoverage {
  total: number;
  read: number;
  detail?: string;
}

export interface HarnessCatalogRefreshRow {
  id: string;
  name: string;
  source?: string;
  state: 'queued' | 'reading' | 'done' | 'partial' | 'failed';
  models?: number;
  progress?: CatalogModelProgress;
  coverage?: CatalogModelCoverage;
  error?: string;
}

export type HarnessCatalogRefreshEvent = { requestId: string } & (
  { kind: 'catalogs'; workspace: string; rows: HarnessCatalogRefreshRow[] } |
  { kind: 'progress'; row: HarnessCatalogRefreshRow }
);

export type HarnessCatalogRefreshResult =
  | { ok: true; workspace: string; rows: HarnessCatalogRefreshRow[] }
  | { ok: false; error: string };
