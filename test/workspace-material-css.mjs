import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const css = read('src/renderer/src/styles/material.css');
const left = read('src/renderer/src/styles/left.css');
assert.match(read('src/renderer/src/styles.css'), /@import '\.\/styles\/material\.css'/);
assert.match(read('src/renderer/src/RootLayout.tsx'), /useWorkspaceAppearance\(\)/);
assert.match(read('src/renderer/src/useWorkspaceAppearance.ts'), /setWorkspaceAppearance\(/);
assert.doesNotMatch(css, /(?:backdrop-filter|filter|animation)\s*:|(?:radial|linear|conic)-gradient\s*\(/);
assert.match(css, /:root\[data-workspace-material='frosted'\]/);
assert.match(css, /--glass-sheet:\s*var\(--surface-canvas\)/);
assert.match(css, /--composer-fade:\s*var\(--glass-sheet\)/, 'input footer must match the opaque reading surface');
assert.match(left, /background:\s*var\(--status-neutral-bg\)/, 'capsules must follow the actual tinted frame or drawer');
assert.match(left, /html\.is-narrow \.sessions-column \.left-panel\s*\{[^}]*--rail-surface:\s*var\(--glass-float\)/, 'narrow capsules must use the drawer surface');
assert.match(left, /\.session-rail-status\.dim\s*\{\s*opacity:\s*1;\s*color:\s*var\(--status-neutral-fg\)/, 'dim capsules retain readable text on tinted dark and light frames');

const materialRules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
const vibrancyBody = "html[data-native-material='vibrancy'] body";
const glassScrim = '.backdrop-blur-overlay.mp-scrim';
const vibrancyBackdropRoot = `${vibrancyBody}:has(${glassScrim})`;
const backdropRootRule = materialRules.find(([, selector]) => selector.trim() === vibrancyBackdropRoot);
assert.ok(backdropRootRule, 'Vibrancy needs a renderer backdrop root while a glass scrim is mounted');
assert.match(backdropRootRule[2], /^\s*will-change:\s*opacity;\s*$/);

const vibrancyScrimSelectors = new Set([
  vibrancyBackdropRoot,
  `${vibrancyBackdropRoot}::before`,
  `${vibrancyBody}:has(${glassScrim}[data-mp-stage='in'])::before`
]);
// Frame transparency is shared by Mica and Vibrancy. The temporary glass
// backdrop root and underlay apply only over Vibrancy.
const nativeRules = materialRules.filter(([, selector]) => selector.includes('data-native-material'));
assert.ok(nativeRules.length >= 8, 'native material rules must exist');
for (const [, selector] of nativeRules) {
  if (vibrancyScrimSelectors.has(selector.trim())) continue;
  assert.ok(
    selector.includes("[data-native-material='mica']") && selector.includes("[data-native-material='vibrancy']"),
    `native selector must pair mica with vibrancy: ${selector.trim().slice(0, 80)}`
  );
}

// Settings keeps the workbench DOM, but must not invalidate every retained
// descendant through inherited visibility or a wildcard selector.
const settingsRules = materialRules.filter(([, selector]) => selector.includes('.has-settings-page'));
assert.equal(settingsRules.length, 1, 'settings underlay has one bounded parent rule');
assert.equal(settingsRules[0][1].replace(/\s+/g, ' ').trim(),
  "html:is([data-native-material='mica'], [data-native-material='vibrancy']) .app-shell.has-settings-page > :is(.chrome-bar, .main-view)");
assert.match(settingsRules[0][2], /\bopacity\s*:\s*0\s*;/);
assert.match(settingsRules[0][2], /\bpointer-events\s*:\s*none\s*;/);
assert.match(settingsRules[0][2], /\btransition\s*:\s*none\s*!important\s*;/);
assert.doesNotMatch(settingsRules[0][2], /\bvisibility\s*:/);

// Native Mica supplies the material. The historical fake-grain image must never
// return on the frame, reading surfaces, inputs, drawers, or solid fallback.
const stylesDir = path.join(root, 'src/renderer/src/styles');
for (const file of fs.readdirSync(stylesDir).filter(file => file.endsWith('.css'))) {
  assert.doesNotMatch(read(`src/renderer/src/styles/${file}`), /material-grain|frosted-grain/, `${file} must not load the old noise texture`);
}
assert.doesNotMatch(read('src/renderer/src/styles.css'), /material-grain|frosted-grain/);
console.log('workspace-material-css: OK');
