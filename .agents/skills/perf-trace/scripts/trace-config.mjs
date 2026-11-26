// Pure CLI/category policy, shared with synthetic regression fixtures.
export function parseTraceArguments(argv) {
  const invalidations = argv.filter(value => value === '--invalidations').length;
  const positional = argv.filter(value => value !== '--invalidations');
  if (invalidations > 1 || positional.length !== 3 || positional.some(value => value.startsWith('--'))) {
    throw new Error('Usage: node trace-capture.mjs <port> <scenario.json> <new-output-prefix> [--invalidations]');
  }
  return { port: positional[0], scenarioPath: positional[1], prefix: positional[2], invalidationsEnabled: invalidations === 1 };
}

export function traceCategories(invalidationsEnabled = false) {
  const categories = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'toplevel', 'cc', 'benchmark', 'latencyInfo'];
  if (invalidationsEnabled) categories.push('disabled-by-default-devtools.timeline.invalidationTracking');
  return categories.join(',');
}
