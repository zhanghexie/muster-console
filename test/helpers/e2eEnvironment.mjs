/** Carry the shared deadline into isolated Electron fixtures. */
export function e2eEnvironment(parent, deadline) {
  return { ...parent, TEST_DEADLINE: String(deadline), NODE_ENV_ELECTRON_VITE: 'development' };
}
