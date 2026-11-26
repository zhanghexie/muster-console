/** 全局看板保留语义状态提示，但不再绘制装饰灯带。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src/renderer/src/styles/board.css'), 'utf8');
const component = fs.readFileSync(path.join(root, 'src/renderer/src/panels/GlobalBoard.tsx'), 'utf8');
assert.ok(!css.includes('.g-board-ring'), '看板不再加载灯带样式');
assert.ok(!component.includes('g-board-ring'), '看板不再挂灯带节点');
console.log('board-glow-sheen-css: OK');
