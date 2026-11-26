export const FULL_SUITE_BUDGET_MS: number;
export const FULL_TEST_CASE_BUDGET_MS: number;
export function suiteBudgetMs(scope: string): number;
export function testCaseBudgetMs(scope: string, remainingMs: number): number;
export function testJobs(env?: Record<string, string | undefined>): number;
export function testDeadline(capMs: number, env?: Record<string, string | undefined>, started?: number): number;
