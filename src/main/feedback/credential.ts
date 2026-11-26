import { spawn } from 'node:child_process';
import os from 'node:os';
import type { FeedbackTarget } from '../../shared/feedback';
import { gitCommandArgs, gitCommandEnvironment } from '../git/gitEnvironment';

export interface FeedbackCredentialRequest { args: string[]; input: string; env: NodeJS.ProcessEnv }
export type CredentialRunner = (request: FeedbackCredentialRequest) => Promise<string | null>;

/** Dedicated path keeps this token separate from ordinary Git credentials for the same host. */
export function feedbackCredentialRequest(target: FeedbackTarget, platform: NodeJS.Platform = process.platform, source: NodeJS.ProcessEnv = process.env): FeedbackCredentialRequest {
  const host = new URL(target.repository).host;
  const env = gitCommandEnvironment(source);
  for (const name of Object.keys(env)) if (/^(GIT_TRACE|GCM_TRACE|GIT_CURL_VERBOSE)/i.test(name)) delete env[name];
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GCM_PROVIDER: 'generic' });
  return { args: gitCommandArgs(['-c', 'credential.useHttpPath=true', 'credential', 'fill'], platform),
    input: `protocol=https\nhost=${host}\npath=__muster_feedback__\nusername=muster-feedback\n\n`, env };
}
const runCredentialHelper: CredentialRunner = request => new Promise(resolve => {
  let settled = false;
  const finish = (value: string | null): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
  const child = spawn('git', request.args, { cwd: os.homedir(), env: request.env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const timer = setTimeout(() => { child.kill(); finish(null); }, 10_000);
  timer.unref();
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { output += chunk; if (output.length > 8192) { child.kill(); finish(null); } });
  child.on('error', () => finish(null));
  child.on('close', code => finish(code === 0 ? output : null));
  child.stdin.on('error', () => finish(null));
  child.stdin.end(request.input);
});

export async function readFeedbackCredential(target: FeedbackTarget, runner: CredentialRunner = runCredentialHelper): Promise<string | null> {
  const output = await runner(feedbackCredentialRequest(target));
  if (!output || output.length > 8192) return null;
  const values = output.split(/\r?\n/).filter(line => line.startsWith('password='));
  if (values.length !== 1) return null;
  const token = values[0]!.slice('password='.length);
  return token && !/[\r\n\0]/.test(token) ? token : null;
}
