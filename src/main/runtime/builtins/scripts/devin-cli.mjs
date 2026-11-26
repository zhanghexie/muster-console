import { basicTui } from './_basic-tui.mjs';
const runtime = basicTui('devin', []);
export const allocate = runtime.allocate;
export const resolveLaunch = runtime.resolveLaunch;
export const appendPrompt = runtime.appendPrompt;
export const canResume = runtime.canResume;
export const receiveMessage = runtime.receiveMessage;
