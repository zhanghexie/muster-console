/**
 * 终端底部垫色：从视口单元格采样 TUI 背景（非默认 theme.background）。
 * 运行: node test/terminal-pad-bg.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'shared', 'terminalPadBg.ts');

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'term-pad-'));
  const outFile = path.join(tmp, 'terminalPadBg.mjs');
  const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: entry
  });
  fs.writeFileSync(outFile, outputText, 'utf8');
  return { outFile, tmp };
}

const { outFile, tmp } = compile();
const {
  rgbToCss,
  ansi256ToCss,
  cssFromCellVisualBg,
  cssFromCellVisualFg,
  majorityPadCss,
  padSideWidth
} = await import(pathToFileURL(outFile).href);

const theme = {
  background: '#0a0a0a',
  foreground: '#e4e4e7',
  black: '#111111',
  red: '#f3687b',
  green: '#45d0a0',
  yellow: '#dcc765',
  blue: '#a1a1aa',
  magenta: '#b39dff',
  cyan: '#67e8f9',
  white: '#e4e4e7',
  brightBlack: '#71717a',
  brightRed: '#f88b9a',
  brightGreen: '#5fd8ab',
  brightYellow: '#e6cf7d',
  brightBlue: '#d4d4d8',
  brightMagenta: '#d49cff',
  brightCyan: '#a5f3fc',
  brightWhite: '#fafafa'
};

assert.equal(rgbToCss(0x1a2b3c), '#1a2b3c');
assert.equal(ansi256ToCss(0, theme), '#111111');
assert.equal(ansi256ToCss(1, theme), '#f3687b');
assert.equal(ansi256ToCss(196), '#ff0000'); // 256 cube red

// default bg → theme.background
assert.equal(
  cssFromCellVisualBg(
    {
      inverse: false,
      bgDefault: true,
      bgRgb: false,
      bgPalette: false,
      bg: 0,
      fgDefault: true,
      fgRgb: false,
      fgPalette: false,
      fg: 0
    },
    theme
  ),
  '#0a0a0a'
);

// TUI truecolor bg
assert.equal(
  cssFromCellVisualBg(
    {
      inverse: false,
      bgDefault: false,
      bgRgb: true,
      bgPalette: false,
      bg: 0x16161e,
      fgDefault: true,
      fgRgb: false,
      fgPalette: false,
      fg: 0
    },
    theme
  ),
  '#16161e'
);

// inverse：视觉背景是前景色
assert.equal(
  cssFromCellVisualBg(
    {
      inverse: true,
      bgDefault: true,
      bgRgb: false,
      bgPalette: false,
      bg: 0,
      fgDefault: false,
      fgRgb: true,
      fgPalette: false,
      fg: 0xabcdef
    },
    theme
  ),
  '#abcdef'
);

assert.equal(
  cssFromCellVisualFg(
    {
      inverse: false,
      bgDefault: true,
      bgRgb: false,
      bgPalette: false,
      bg: 0,
      fgDefault: false,
      fgRgb: true,
      fgPalette: false,
      fg: 0xe4e4e7
    },
    theme
  ),
  '#e4e4e7'
);
assert.equal(
  cssFromCellVisualFg(
    {
      inverse: true,
      bgDefault: false,
      bgRgb: true,
      bgPalette: false,
      bg: 0x112233,
      fgDefault: false,
      fgRgb: true,
      fgPalette: false,
      fg: 0xabcdef
    },
    theme
  ),
  '#112233',
  'inverse 时前景走背景色'
);

// 多数票：底行主要是 TUI 色
{
  const def = {
    inverse: false,
    bgDefault: true,
    bgRgb: false,
    bgPalette: false,
    bg: 0,
    fgDefault: true,
    fgRgb: false,
    fgPalette: false,
    fg: 0
  };
  const tui = {
    inverse: false,
    bgDefault: false,
    bgRgb: true,
    bgPalette: false,
    bg: 0x1e1e2e,
    fgDefault: true,
    fgRgb: false,
    fgPalette: false,
    fg: 0
  };
  assert.equal(majorityPadCss([def, tui, tui, tui], theme, '#0a0a0a'), '#1e1e2e');
  assert.equal(majorityPadCss([def, def, def], theme, '#0a0a0a'), '#0a0a0a');
  assert.equal(majorityPadCss([], theme, '#0a0a0a'), '#0a0a0a');
}

// 右缘垫条量到 wrap 右缘（含 fit 余量 + wrap 右内边距）；网格溢出时不出负宽
assert.equal(padSideWidth(1000, 990.4), 10);
assert.equal(padSideWidth(1000, 1003), 0);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('terminal-pad-bg: ok');
