/** Strip host control variables before launching bundled engine workers. */
export function genericWorkerEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (/^MUSTER_/i.test(key) || /^(NODE_OPTIONS|NODE_PATH|ELECTRON_RENDERER_URL)$/i.test(key)) delete env[key];
  }
  return env;
}
