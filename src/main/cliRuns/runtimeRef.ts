import type { CliRunService } from './service';
let service: CliRunService | null = null;
export function bindCliRuns(value: CliRunService | null) { service = value; }
export function getCliRuns(): CliRunService { if (!service) throw new Error('CLI run service is unavailable'); return service; }
