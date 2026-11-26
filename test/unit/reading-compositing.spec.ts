import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

it('虚拟屏静止阅读不强制 3D 合成，保留原有 transform 过渡', () => {
  const app = read('src/renderer/src/App.tsx');
  const strip = app.slice(app.indexOf('className={`h-strip'), app.indexOf('className="h-page workspace-page"'));
  expect(strip).toContain('translateX(${hOffset}px)');
  expect(strip).not.toContain('translate3d');
  const css = read('src/renderer/src/styles/base.css');
  const rule = css.match(/\.h-strip\.vs-axis\s*\{([^}]+)\}/)?.[1];
  expect(rule).toContain('transition: transform var(--dur-move) var(--ease-move)');
  expect(rule).not.toMatch(/will-change:\s*transform/);
});

it('工作区过场结束后解除合成提示，移动阶段仍可预备合成', () => {
  const css = read('src/renderer/src/styles/base.css');
  expect(css.match(/\.ws-rail\s*\{([^}]+)\}/)?.[1]).toContain('will-change: transform');
  const idle = css.match(/\.ws-rail\.ws-rail-idle\s*\{([^}]+)\}/)?.[1];
  expect(idle).toContain('transform: none');
  expect(idle).toContain('will-change: auto');
});
