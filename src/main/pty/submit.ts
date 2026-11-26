/**
 * 向交互式 CLI 写入并提交。
 * Cursor 优先走「CLI 初始 prompt 重拉」（见 sessions.relaunchWithPrompt），此处作通用回退。
 */
import { setTimeout as delay } from 'node:timers/promises';
import { t } from '../../shared/i18n';

/** 键入完成到第一次 Enter 的间隔（给 TUI 输入框一帧去消化按键） */
const TYPE_TO_ENTER_MS = 350;
/** 多次 Enter 之间的间隔 */
const ENTER_GAP_MS = 200;
/** bracketed paste 写入后到 Enter 的间隔（TUI 需整段消化粘贴内容） */
const PASTE_TO_ENTER_MS = 500;
/** 退格（DEL, \x7f）：各 TUI 输入框的最小公分母删字键。不用 Ctrl+U 清行——
 * Claude Code/Codex 等自绘输入框对它支持不一，退格按精确个数发送最保守。 */
const BACKSPACE = '\x7f';

/**
 * 半途失败的键入残留：会话 id → 输入框里的字符数（按码点计）和可选进程代际。
 * 正文写入后 Enter 被拦（会话翻 blocked、进程退出等）时正文就成了残留，下次键入
 * 必须先按记录退格清行，否则重发文本与残留拼接，TUI 输入框出现重复内容（F-03）。
 * 会话重生（respawn 换新终端）后残留标记会过期，多余退格在空输入框上是 no-op，自愈。
 */
const inputResidues = new Map<string, { generation?: string; chars: number }>();

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface PtyWriter {
  write(sessionId: string, data: string): boolean;
}

/** 压成单行，供输入框直接键入（非粘贴） */
export function flattenForTypedInput(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' | ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 键入 + 多次隔离 Enter（拉长间隔，降低 ConPTY 合并读写的概率）。
 *
 * Enter 只发 `\r`，**不补 `\n`**：首条 `\r` 提交成功后，多余的按键都会落进已清空的
 * 输入框——`\r` 在空框上是 no-op，`\n` 却会插入空行（cursor-cli/opencode 输入框残留
 * 空行的根因，2026-09-04）。多次 Enter 仅作 ConPTY 丢键兜底，空框上的 `\r` 无副作用。
 *
 * opts.paste：输入框支持 bracketed paste 的 TUI（runtime 声明 pasteInput）走粘贴——
 * 文本以 ESC[200~…ESC[201~ 原子进框，单次 Enter 提交。ConPTY 下 Ink 系 TUI 对 paste
 * 无效，勿对未声明 runtime 使用。
 */
export async function typeAndSubmit(
  pty: PtyWriter,
  sessionId: string,
  text: string,
  opts?: { afterTypeMs?: number; enterGapMs?: number; enterCount?: number; paste?: boolean;
    signal?: AbortSignal; generation?: string; onFirstSubmit?: () => void }
): Promise<{ typed: number; submits: number; flat: string }> {
  const enterCount = opts?.paste ? 1 : (opts?.enterCount ?? 3);
  const signal = opts?.signal;
  signal?.throwIfAborted();

  const flat = flattenForTypedInput(text);
  if (!flat) throw new Error(t('写入内容为空'));

  // 上一次提交半途失败会在输入框残留整段文本：重发前先按记录长度退格清行。
  // 清理写不出去（门禁拦截/进程退出）时不键入正文，保留标记等下次尝试。
  const residue = inputResidues.get(sessionId);
  const leftover = residue && residue.generation === opts?.generation ? residue.chars : 0;
  if (leftover > 0) {
    if (!pty.write(sessionId, BACKSPACE.repeat(leftover))) {
      throw new Error(t('提交失败：输入框残留未清理，稍后重试'));
    }
  }
  inputResidues.delete(sessionId);

  signal?.throwIfAborted();
  const body = opts?.paste ? `\x1b[200~${flat}\x1b[201~` : flat;
  if (!pty.write(sessionId, body)) {
    throw new Error(t('写入终端失败：进程未在运行'));
  }

  // 正文已入框：Enter 发不出去时它就是残留；任一 Enter 成功即清空输入框。
  let submits = 0;
  try {
    for (let i = 0; i < enterCount; i++) {
      const gap = opts?.paste ? PASTE_TO_ENTER_MS :
        i === 0 ? (opts?.afterTypeMs ?? TYPE_TO_ENTER_MS) : (opts?.enterGapMs ?? ENTER_GAP_MS);
      await delay(gap, undefined, { signal });
      signal?.throwIfAborted();
      if (!pty.write(sessionId, '\r')) throw new Error(t('提交失败：进程未在运行'));
      if (++submits === 1) opts?.onFirstSubmit?.();
    }
  } catch (error) {
    if (!submits) {
      // A cancellation sends no additional keys. Cleanup on a later typed
      // submission is scoped to the process generation when one is supplied.
      if (inputResidues.size >= 512) inputResidues.delete(inputResidues.keys().next().value!);
      inputResidues.set(sessionId, { generation: opts?.generation, chars: [...flat].length });
    }
    throw error;
  }
  return { typed: flat.length, submits, flat };
}

export async function submitOnly(pty: PtyWriter, sessionId: string): Promise<void> {
  if (!pty.write(sessionId, '\r')) {
    throw new Error(t('终端进程未在运行，可先 sessions.select 拉起'));
  }
}
