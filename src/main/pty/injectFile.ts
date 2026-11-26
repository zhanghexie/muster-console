/**
 * 提示词落盘（主进程）。与 `_helpers.mjs` 的 writeInjectPrompt 同契约，供 sessions / chat 使用。
 * runtime 脚本不能 import 本文件，继续走 _helpers.mjs。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const INJECT_PROMPT_PREFIX = '请使用 UTF-8 编码读取并立即执行任务文件：';

export function injectPromptDir(): string {
  return path.join(os.tmpdir(), 'muster-injects');
}

export function injectFileFromPromptArg(promptArg?: string): string {
  const s = String(promptArg ?? '');
  if (!s.startsWith(INJECT_PROMPT_PREFIX)) return '';
  return s.slice(INJECT_PROMPT_PREFIX.length);
}

export function writeInjectPrompt(
  prompt: string,
  dir = injectPromptDir()
): { file: string; promptArg: string } | null {
  const text = String(prompt ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return null;
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  return { file, promptArg: `${INJECT_PROMPT_PREFIX}${file}` };
}

/** Preserve the user's exact multiline input for runtimes without reliable paste. */
export function writeComposerInputFile(text: string, dir = injectPromptDir()): { file: string; promptArg: string } {
  if (!text.trim()) throw new Error('输入内容为空');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `composer-${randomUUID()}.md`);
  writeFileSync(file, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { file, promptArg: `Read the UTF-8 file \`${file}\` and treat its exact contents as the user's complete message for this turn.` };
}
