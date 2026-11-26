import { basicTui } from './_basic-tui.mjs';
import { piHostMcpLaunch } from './_pi-host-mcp.mjs';
const runtime = basicTui('pi', []);
export const allocate = runtime.allocate;
export const resolveLaunch = async input => piHostMcpLaunch(input, 'pi');
export const appendPrompt = runtime.appendPrompt;
export const canResume = runtime.canResume;
export const receiveMessage = runtime.receiveMessage;
