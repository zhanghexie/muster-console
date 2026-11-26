/** terminal.capture / terminal.write 的纯函数契约（无 Node / DOM）。 */

import { t } from './i18n';

export const CAPTURE_KEEP = 20
export const TEXT_TAIL_CHARS = 800
export const CTRL_C = '\x03'

export type TerminalWriteKey = 'ctrl-c' | 'enter'
export type TerminalWriteMode = 'raw' | 'typed'

export const DEFAULT_WRITE_ENTER_COUNT = 3

export type TerminalWriteIntent = {
  typed: boolean
  submit: boolean
  enterCount: number
  keyKind: TerminalWriteKey | null
}

/**
 * 解析 terminal.write 的提交意图。
 * typed / mode=submit：默认回车（模型常漏传 submit:true，导致字进输入框却发不出去）。
 * raw：默认不回车。显式 submit 优先。
 */
export function resolveTerminalWriteIntent(args: {
  mode?: string
  submit?: boolean
  key?: string
  enterCount?: number | string
}): TerminalWriteIntent {
  const mode = (args.mode ?? '').trim().toLowerCase()
  const typed = mode === 'typed' || mode === 'submit'
  const submit = typeof args.submit === 'boolean' ? args.submit : typed
  const n = typeof args.enterCount === 'string' ? Number(args.enterCount) : args.enterCount
  const enterCount =
    typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.min(8, Math.floor(n)) : DEFAULT_WRITE_ENTER_COUNT
  const k = (args.key ?? '').trim().toLowerCase()
  let keyKind: TerminalWriteKey | null = null
  if (k === 'ctrl-c' || k === 'ctrl+c') keyKind = 'ctrl-c'
  else if (k === 'enter' || k === 'return' || k === 'cr') keyKind = 'enter'
  else if (k) throw new Error(t('不支持的按键: {{key}}（目前仅 ctrl-c / enter）', { key: args.key }))
  return { typed, submit, enterCount, keyKind }
}


/** 按 mtime 新→旧，超出 keep 的 PNG 文件名（待删） */
export function captureFilesToDelete(
  files: readonly { name: string; mtimeMs: number }[],
  keep = CAPTURE_KEEP
): string[] {
  const pngs = files
    .filter((f) => f.name.toLowerCase().endsWith('.png'))
    .slice()
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
  return pngs.slice(Math.max(0, keep)).map((f) => f.name)
}

/** 已去 ANSI 的缓冲尾部；压缩空行后取末尾 n 字符 */
export function terminalTextTail(stripped: string, n = TEXT_TAIL_CHARS): string {
  const clean = stripped.replace(/\n{3,}/g, '\n\n').trim()
  if (n <= 0) return ''
  return clean.length > n ? clean.slice(-n) : clean
}

/** lark-cli 拒绝绝对路径；发图必须用 cwd + 相对文件名 */
export function captureImageRelPath(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename
  return `./${base}`
}

export function buildSendBotImageArgs(chatId: string, relPath: string): string[] {
  return ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--image', relPath]
}

export function encodeTerminalKey(key: string): string {
  const k = key.trim().toLowerCase()
  if (k === 'ctrl-c' || k === 'ctrl+c') return CTRL_C
  if (k === 'enter' || k === 'return' || k === 'cr') return '\r'
  throw new Error(t('不支持的按键: {{key}}（目前仅 ctrl-c / enter）', { key }))
}

export function isTypedWriteMode(mode: string | undefined): boolean {
  const m = (mode ?? '').trim().toLowerCase()
  return m === 'typed' || m === 'submit'
}

export type CaptureCanvasInfo = { width: number; height: number; webgl?: boolean }

/** 截图优先 WebGL 画布（同尺寸 overlay canvas 往往是空白层） */
export function pickTerminalCaptureCanvas<T extends CaptureCanvasInfo>(
  canvases: readonly T[]
): T | undefined {
  if (!canvases.length) return undefined
  const webgl = canvases.filter((c) => c.webgl)
  const pool = webgl.length ? webgl : canvases
  return [...pool].sort((a, b) => b.width * b.height - a.width * a.height)[0]
}

/** 截图从 xterm 缓冲栅格化，不切画面、不 fit/resize（WebGL 在 display:none 下是空的） */
export function captureUsesBufferRaster(): boolean {
  return true
}

export function isCaptureToolName(name: string | undefined): boolean {
  const n = (name ?? '').trim().replace(/_/g, '.')
  return n === 'terminal.capture'
}

/**
 * 给 UI 提供预览元数据，同时保留模型可读的本地路径；不回填图片 base64。
 */
export function splitCaptureDisplay(result: unknown): { result: unknown; imagePath?: string } {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { result }
  }
  const obj = result as Record<string, unknown>
  if (typeof obj.previewPath !== 'string' || !obj.previewPath.trim()) {
    return { result }
  }
  const imagePath = obj.previewPath.trim()
  return { result, imagePath }
}

