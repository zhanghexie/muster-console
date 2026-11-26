/**
 * 窗口背景（docs/features/frame-backdrop.md）：
 * 1) 共享模型：规整 / 按工作区解析 / 引用中的壁纸 / 浅底判定；
 * 2) 壁纸落盘：按内容哈希去重、格式与大小校验、只清 backdrops/ 下未引用文件；
 * 3) CSS 契约：模板类齐全、背景层一律静态、毛玻璃关即隐藏、.app-shell 不再自涂渐变（否则盖住背景层）。
 * 运行: node test/frame-backdrop.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-backdrop-'));
const compile = createSharedCompiler(root, path.join(tmp, 'build'));

try {
  const m = await import(pathToFileURL(compile('shared/frameBackdrop.ts')).href);
  const files = await import(pathToFileURL(compile('main/frameBackdropFiles.ts')).href);

  // ---------- 1) 模型 ----------
  assert.deepEqual(m.normalizeFrameBackdrop(undefined), { id: 'corner' });
  assert.deepEqual(m.normalizeFrameBackdrop({ id: 'nope' }), { id: 'corner' }, '未知 id 回默认');
  assert.deepEqual(m.normalizeFrameBackdrop({ id: 'mesh', solidLevel: 'full', image: 'x' }), { id: 'mesh' }, '只留与 id 相关的参数');
  assert.deepEqual(m.normalizeFrameBackdrop({ id: 'solid' }), { id: 'solid', solidLevel: 'deep' });
  assert.deepEqual(m.normalizeFrameBackdrop({ id: 'solid', solidLevel: 'bad' }), { id: 'solid', solidLevel: 'deep' });
  assert.deepEqual(m.normalizeFrameBackdrop({ id: 'solid', solidLevel: 'full' }), { id: 'solid', solidLevel: 'full' });
  assert.deepEqual(m.normalizeFrameBackdrop({ id: 'custom' }), { id: 'corner' }, '自定义缺图回默认');
  assert.deepEqual(
    m.normalizeFrameBackdrop({ id: 'custom', image: ' C:/a.png ', blur: 999, dim: -5 }),
    { id: 'custom', image: 'C:/a.png', blur: m.WALLPAPER_BLUR_MAX, dim: 0 },
    '模糊/暗化夹取'
  );
  assert.deepEqual(m.normalizeFrameBackdrop({ id: 'custom', image: 'a.png' }), {
    id: 'custom',
    image: 'a.png',
    blur: m.DEFAULT_WALLPAPER_BLUR,
    dim: m.DEFAULT_WALLPAPER_DIM
  });
  for (const b of m.FRAME_BACKDROPS) assert.equal(m.frameBackdropKind(b.id), b.kind);

  assert.deepEqual(
    m.normalizeFrameBackdropByWorkspace({ ws1: { id: 'grid' }, '  ': { id: 'mesh' }, ws2: null }),
    { ws1: { id: 'grid' } }
  );
  const byWs = { ws1: { id: 'solid', solidLevel: 'mid' } };
  assert.deepEqual(m.resolveFrameBackdrop({ id: 'velvet' }, byWs, 'ws1'), { id: 'solid', solidLevel: 'mid' }, '工作区独立设置优先');
  assert.deepEqual(m.resolveFrameBackdrop({ id: 'velvet' }, byWs, 'ws2'), { id: 'velvet' }, '未设则跟随全局');
  assert.deepEqual(m.resolveFrameBackdrop(undefined, undefined, null), { id: 'corner' });

  assert.deepEqual(
    m.referencedWallpapers({ id: 'custom', image: 'a.png' }, {
      w1: { id: 'custom', image: 'b.png' },
      w2: { id: 'custom', image: 'a.png' },
      w3: { id: 'mesh' }
    }),
    ['a.png', 'b.png']
  );

  assert.ok(m.relativeLuminance(255, 255, 255) > 0.99);
  assert.ok(m.relativeLuminance(0, 0, 0) < 0.01);
  // 调色板里的琥珀色原色档是浅底（深字），框色 #111112 是深底
  assert.ok(m.relativeLuminance(0xf0, 0xa2, 0x4a) > m.LIGHT_SURFACE_LUMINANCE);
  assert.ok(m.relativeLuminance(0x11, 0x11, 0x12) < m.LIGHT_SURFACE_LUMINANCE);

  // ---------- 2) 壁纸落盘 ----------
  const userData = path.join(tmp, 'userData');
  const srcDir = path.join(tmp, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  const a = path.join(srcDir, 'a.JPEG');
  const a2 = path.join(srcDir, 'copy-of-a.jpeg');
  const b = path.join(srcDir, 'b.png');
  fs.writeFileSync(a, 'image-a');
  fs.writeFileSync(a2, 'image-a');
  fs.writeFileSync(b, 'image-b');

  const ra = files.importWallpaper(userData, a);
  assert.equal(ra.ok, true);
  assert.equal(path.dirname(ra.path), files.backdropsDir(userData));
  assert.match(path.basename(ra.path), /^[0-9a-f]{16}\.jpg$/, 'jpeg 统一成 jpg、名为内容哈希');
  assert.equal(fs.readFileSync(ra.path, 'utf8'), 'image-a');
  const ra2 = files.importWallpaper(userData, a2);
  assert.equal(ra2.ok && ra2.path, ra.path, '同内容去重');
  const rb = files.importWallpaper(userData, b);
  assert.equal(rb.ok, true);

  const bad = path.join(srcDir, 'x.txt');
  fs.writeFileSync(bad, 'x');
  assert.equal(files.importWallpaper(userData, bad).ok, false, '非图片扩展名拒收');
  assert.equal(files.importWallpaper(userData, path.join(srcDir, 'missing.png')).ok, false, '不存在拒收');
  const big = path.join(srcDir, 'big.png');
  fs.writeFileSync(big, Buffer.alloc(files.WALLPAPER_MAX_BYTES + 1));
  assert.equal(files.importWallpaper(userData, big).ok, false, '超大拒收');

  const outside = path.join(srcDir, 'keep-me.png');
  fs.writeFileSync(outside, 'x');
  assert.equal(files.pruneWallpapers(userData, [rb.path, outside]), 1, '只清未引用的 a');
  assert.equal(fs.existsSync(ra.path), false);
  assert.equal(fs.existsSync(rb.path), true);
  assert.equal(fs.existsSync(outside), true, 'backdrops/ 之外不碰');
  assert.equal(files.pruneWallpapers(path.join(tmp, 'nope'), []), 0, '目录不存在不抛');

  // ---------- 3) CSS 契约 ----------
  const styles = path.join(root, 'src', 'renderer', 'src', 'styles');
  const css = fs.readFileSync(path.join(styles, 'backdrop.css'), 'utf8');
  for (const b of m.FRAME_BACKDROPS) {
    if (b.kind === 'gradient' || b.kind === 'solid') {
      assert.ok(css.includes(`.frame-backdrop.fb-${b.id} {`), `backdrop.css 应有 .fb-${b.id}`);
    }
  }
  const bodyOnly = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const backdropRules = bodyOnly.slice(0, bodyOnly.indexOf('.fb-picker {'));
  assert.ok(!/\banimation\s*:|\btransition\s*:/.test(backdropRules), '背景层一律静态（禁 animation/transition）');
  assert.match(bodyOnly, /html\.no-frame-fx \.frame-backdrop \{\s*display: none;/, '毛玻璃关时背景整体隐藏');
  assert.ok(
    !fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'styles.css'), 'utf8').includes('backdrop.css'),
    '旧背景样式应退出应用样式入口'
  );

  const base = fs.readFileSync(path.join(styles, 'base.css'), 'utf8');
  const shell = base.slice(base.indexOf('\n.app-shell {'), base.indexOf('}', base.indexOf('\n.app-shell {')));
  // 2026-10-14：底色 token 已从 --bg-frame 迁到 --surface-frame，
  // settings 页直接用 --surface-frame（--workspace-frame-color 仅剩静态默认值，等价）
  assert.match(shell, /background: var\(--workspace-frame-color, var\(--surface-frame\)\);/, '主窗口应只涂工作区纯色');
  const settings = fs.readFileSync(path.join(styles, 'settings.css'), 'utf8');
  const page = settings.slice(settings.indexOf('\n.settings-page {'), settings.indexOf('}', settings.indexOf('\n.settings-page {')));
  assert.match(page, /background: var\(--surface-frame\);/, '设置页应沿用工作区纯色');
  const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'App.tsx'), 'utf8');
  assert.ok(!app.includes('<FrameBackdrop'), '主窗口不应再挂渐变或壁纸背景层');

  // Settings body mutations must not make Chromium invalidate the retained
  // workbench through an ancestor :has(). Composite only its two parent
  // containers, so explicit-visible descendants cannot escape the opacity.
  const material = fs.readFileSync(path.join(styles, 'material.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(material, /\.app-shell\b[^{}]*:has\s*\([^{}]*\.settings-page\b/,
    '设置页不得用 app-shell :has(settings-page) 触发整棵工作台样式失效');
  const materialRules = [...material.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
    selectors: selectors.replace(/\s+/g, ' ').trim(), body
  }));
  const settingsUnderlay = "html:is([data-native-material='mica'], [data-native-material='vibrancy']) .app-shell.has-settings-page > :is(.chrome-bar, .main-view)";
  const underlayRule = materialRules.find(rule => rule.selectors === settingsUnderlay);
  assert.ok(underlayRule, '设置遮底仅匹配两个直接父容器');
  assert.match(underlayRule.body, /\bopacity\s*:\s*0\s*;/);
  assert.match(underlayRule.body, /\bpointer-events\s*:\s*none\s*;/);
  assert.match(underlayRule.body, /\btransition\s*:\s*none\s*!important\s*;/);
  assert.ok(materialRules.filter(rule => rule.selectors.includes('.has-settings-page')).every(rule =>
    rule.selectors === settingsUnderlay && !/\bvisibility\s*:/.test(rule.body)),
  '设置遮底不得对保活工作台的后代逐项写 visibility 或展开通配符');

  console.log('[frame-backdrop] ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
