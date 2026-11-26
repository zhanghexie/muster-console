/** Shared resource ceiling for offline tests, Vitest and type checking. */
export const FULL_SUITE_BUDGET_MS = 60 * 60_000;
export const FULL_TEST_CASE_BUDGET_MS = 5 * 60_000;

/** Full coverage includes real Git and browser tests; other suites stay bounded. */
export function suiteBudgetMs(scope) {
  return scope === 'full' ? FULL_SUITE_BUDGET_MS : 175_000;
}

/** One wedged offline process must not consume the whole full-suite deadline. */
export function testCaseBudgetMs(scope, remainingMs) {
  return scope === 'full' ? Math.min(remainingMs, FULL_TEST_CASE_BUDGET_MS) : remainingMs;
}

export function testJobs(env = process.env) {
  const requested = Number(env.TEST_JOBS);
  return Number.isInteger(requested) && requested > 0 ? Math.min(requested, 4) : 2;
}

export function testDeadline(capMs, env = process.env, started = Date.now()) {
  const requested = Number(env.TEST_BUDGET_MS);
  const budget = requested > 0 ? Math.min(requested, capMs) : capMs;
  const parent = Number(env.TEST_DEADLINE);
  return Math.min(started + budget, parent > 0 ? parent : Infinity);
}
