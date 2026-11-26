import { randomUUID } from 'node:crypto';
import { cliLaunch } from './_native.mjs';
import { filterExtraArgs } from './_helpers.mjs';

export function basicTui(binary, baseArgs = []) {
  return {
    async allocate() { return { sessionId: randomUUID() }; },
    async resolveLaunch({ mode, extraArgs = [] }) {
      if (mode !== 'start') throw new Error(`${binary} CLI adapter cannot restore or fork a native conversation`);
      return cliLaunch([binary, ...baseArgs, ...filterExtraArgs(extraArgs)]);
    },
    async appendPrompt() { return false; },
    async canResume() { return false; },
    async receiveMessage() {
      return { status: 'unsupported', reason: 'This CLI has no verified live message transport; use its terminal.' };
    }
  };
}
