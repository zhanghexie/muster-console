import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('设置页 textarea 样式不污染 CodeMirror 的同名 cm-editor', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/settings/capability-management.css'), 'utf8');
  expect(css).toMatch(/textarea\.cm-editor\s*\{/);
  expect(css).not.toMatch(/(?:^|\n)\.cm-editor\s*\{/);
});

it('仅文件页底部留白与右侧拖拽区同宽，浏览器宿主不留边', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/right-workspace.css'), 'utf8');
  expect(css).toContain('--right-resource-divider-width: 4px');
  expect(css).toContain('flex-basis: var(--right-resource-divider-width)');
  expect(css).toContain('.right-workspace-split:not(.resources-collapsed) .right-content-page.files-panel { height: auto; bottom: var(--right-resource-divider-width); }');
  expect(css).not.toMatch(/\.right-workspace-content\s*\{[^}]*margin-bottom:/);
});

it('文件编辑滚动宿主可收缩，编辑/预览统一启用自定义双轴轨道', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/files.css'), 'utf8');
  const scroller = css.match(/\.file-editor-cm \.cm-scroller\s*\{([^}]+)\}/)?.[1];
  expect(scroller).toContain('flex: 1 1 0');
  expect(scroller).toContain('height: auto');
  expect(scroller).toContain('min-height: 0');
  expect(scroller).toContain('min-width: 0');
  const tracks = css.match(/\.file-editor \.file-editor-cm \.cm-scroller,\s*\.file-editor \.file-editor-preview\s*\{([^}]+)\}/)?.[1];
  expect(tracks).toContain('scrollbar-width: auto');
  expect(tracks).toContain('scrollbar-color: auto');
  expect(css).toMatch(/\.file-editor-preview::-webkit-scrollbar\s*\{\s*width: 8px; height: 8px;/);
});
