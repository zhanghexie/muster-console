/**
 * 主进程唯一的 ANSI 转义序列文法（无依赖叶子模块，检测/展示都从这里取）。
 *
 * 曾有第二份实现散在 extensions/text.ts，两边的 CSI/OSC 正则不一致——同一段
 * 终端输出在生命周期检测和扩展输出预览里会被切成不同结果。新增剥离需求请
 * 在此扩展，不要再抄一份正则。
 */

/** CSI：ESC[ 或 8-bit 0x9b 引导，参数字节 + 中间字节 + 终止字节 */
const CSI_PATTERN = /(?:\x1b\x5b|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g;
/** 单字符转义：ESC + 0x40-0x5f（CSI 已先行剥离，剩下的是 ESC7/ESC= 之类） */
const SINGLE_ESC_PATTERN = /\x1b[\x40-\x5f]/g;
/** OSC：ESC] 或 0x9d 引导，直到 BEL / ST；payload 里可能是 `<code>;<text>` */
const OSC_PATTERN = /(?:\x1b\x5d|\x9d)([\s\S]*?)(?:\x07|\x1b\x5c|\x9c)/g;
/** OSC payload 的 `<数字码>;<内容>` 形式（0/2 是窗口标题） */
const OSC_TITLE_PAYLOAD = /^(\d+);([\s\S]*)$/;
/** 除 \t \n 外的 C0 控制字符（\r 单独处理） */
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f]/g;

/** 只去转义序列，其它字节原样保留（生命周期检测按原始版式匹配） */
export function stripAnsi(s: string): string {
  return s
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(SINGLE_ESC_PATTERN, '');
}

export function plainTextFromPtyBuffer(buf: string): { text: string; oscTitle?: string } {
  let oscTitle: string | undefined;

  const withoutOsc = buf.replace(OSC_PATTERN, (_match, payload: string) => {
    const m = OSC_TITLE_PAYLOAD.exec(payload);
    if (m && (m[1] === '0' || m[1] === '2')) oscTitle = m[2];
    return '';
  });

  const text = withoutOsc.replace(CSI_PATTERN, '').replace(SINGLE_ESC_PATTERN, '');
  return oscTitle !== undefined ? { text, oscTitle } : { text };
}

/** 展示用：额外丢掉 \r 并把其余控制字符压成空格（\t \n 保留） */
export function stripAnsiForDisplay(s: string): string {
  return stripAnsi(s).replace(/\r/g, '').replace(CONTROL_CHARS, ' ');
}


/** Incremental visible text: incomplete CSI/OSC/DCS payloads never become text between chunks. */
export function createAnsiTextStream(): { push(chunk: string): string } {
  let state: 'text' | 'esc' | 'esc-intermediate' | 'csi' | 'osc' | 'string' | 'osc-esc' | 'string-esc' = 'text';
  return { push(chunk) {
    const visible: string[] = [];
    for (const char of chunk) {
      const code = char.charCodeAt(0);
      if (state === 'osc' || state === 'string') {
        if (code === 0x9c || state === 'osc' && code === 7) state = 'text';
        else if (code === 0x1b) state = state === 'osc' ? 'osc-esc' : 'string-esc';
        continue;
      }
      if (state === 'osc-esc' || state === 'string-esc') {
        const osc = state === 'osc-esc';
        if (char === '\\' || code === 0x9c || osc && code === 7) state = 'text';
        else if (code !== 0x1b) state = osc ? 'osc' : 'string';
        continue;
      }
      if (state === 'csi') {
        if (code === 0x1b) state = 'esc';
        else if (code >= 0x40 && code <= 0x7e) state = 'text';
        continue;
      }
      if (state === 'esc' || state === 'esc-intermediate') {
        if (char === '[') state = 'csi';
        else if (char === ']') state = 'osc';
        else if (['P', 'X', '^', '_'].includes(char)) state = 'string';
        else if (code >= 0x20 && code <= 0x2f) state = 'esc-intermediate';
        else if (code !== 0x1b) state = 'text';
        continue;
      }
      if (code === 0x1b) state = 'esc';
      else if (code === 0x9b) state = 'csi';
      else if (code === 0x9d) state = 'osc';
      else if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) state = 'string';
      else if (code === 13 || code === 0x9c) continue;
      else if (code < 0x20 && code !== 9 && code !== 10) visible.push(' ');
      else visible.push(char);
    }
    return visible.join('');
  } };
}
