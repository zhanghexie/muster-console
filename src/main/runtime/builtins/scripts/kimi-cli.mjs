import { basicTui } from './_basic-tui.mjs';
import { cliLaunch } from './_native.mjs';
import { prepareKimiSession, splitKimiLaunchArgs } from './_kimi-acp.mjs';
const runtime = basicTui('kimi', []);
export const allocate = runtime.allocate;
export async function resolveLaunch(input) {
  if (!input.cliLaunchOptions?.reasoning || input.probe) return runtime.resolveLaunch(input);
  if (input.mode !== 'start') throw new Error('Kimi CLI 暂不支持为已有会话重新指定思考强度');
  const { args, model, plan, additionalDirectories } = splitKimiLaunchArgs(input.extraArgs ?? []);
  const sessionId = await prepareKimiSession({ cwd: input.cwd, env: input.env, model,
    reasoning: input.cliLaunchOptions.reasoning, plan, additionalDirectories });
  return { ...cliLaunch(['kimi', '--session', sessionId, ...args]), externalSessionId: sessionId };
}
export const appendPrompt = runtime.appendPrompt;
export const canResume = runtime.canResume;
export const receiveMessage = runtime.receiveMessage;
