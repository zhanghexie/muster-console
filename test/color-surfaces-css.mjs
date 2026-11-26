/** Production CSS regressions for the shared appearance migration.
 * Run: node test/color-surfaces-css.mjs
 * These guards protect declarations; actual Mica, geometry and contrast require Electron capture.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const domains = ['skel', 'side', 'files', 'git', 'browser', 'right-workspace', 'chrome', 'selection', 'markdown', 'dialogs', 'harness', 'settings', 'ext', 'tasks', 'board', 'evidence', 'usage', 'bgTasks', 'workflow', 'memory', 'responsive', 'mobile'];
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const styles = Object.fromEntries(domains.map((name) => [name, read(`src/renderer/src/styles/${name}.css`)]));
styles.capability = read('src/renderer/src/components/settings/capability-management.css');

function rule(css, target) {
  const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].split(',').map((selector) => selector.trim()).includes(target))
    .map((match) => match[2]);
  assert.ok(bodies.length, `Missing production rule: ${target}`);
  return bodies.join('\n');
}
function hasRole(css, selector, property, role) {
  assert.match(rule(css, selector), new RegExp(`${property}:\\s*var\\(--${role}\\)`), `${selector} must consume ${role}`);
}

// Theme seeds belong to the resolver. Reintroducing one of these in a host domain
// silently creates a second material or a foreground checked against the wrong surface.
for (const [name, css] of Object.entries(styles)) {
  assert.doesNotMatch(css, /var\(--(?:bg(?:-canvas|-panel|-raised|-input|-overlay|-inset|-elevated)?|glass-sheet|glass-float|text(?:-1|-2|-3|-muted|-dim)?|ink(?:-soft)?|hairline|hover-fill(?:-strong)?|selected-fill|selection-surface|focus-border)(?:[,)]|\s)/, `${name}: use resolved appearance roles`);
}

// A custom input/overlay background needs its own focus pairing, not a canvas-only ring.
for (const [name, css] of Object.entries(styles)) {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const context = match[2].match(/--fg-primary:\s*var\(--(frame|canvas|chrome|raised|input|overlay)-fg-primary\);/);
    if (context) assert.match(match[2], new RegExp(`--border-focus:\\s*var\\(--${context[1]}-border-focus\\)`), `${name}: ${match[1].trim()} needs its focus context`);
  }
}

hasRole(styles['right-workspace'], '.right-workspace-toolbar', 'background', 'surface-chrome');
hasRole(styles['right-workspace'], '.right-current-row', 'background', 'surface-canvas');
hasRole(styles['right-workspace'], '.right-tab.is-selected', 'background', 'selected-tab');
hasRole(styles['right-workspace'], '.right-tab.is-selected', 'color', 'fg-selected-tab-primary');
hasRole(styles['right-workspace'], '.right-resources', 'background', 'surface-canvas');
hasRole(styles['right-workspace'], '.right-browser-location:focus-within', 'border-color', 'border-focus');
assert.match(rule(styles.git, '.git-repo-scroll'), /padding:\s*0\s+[4-9]px\s+8px/, 'Repository selection must leave inset space on both sides');
assert.doesNotMatch(rule(styles.git, '.git-repo-tree-leaf.is-hidden-repo'), /opacity:/, 'Hidden repository names must use a foreground, not fade the entire row');

assert.match(styles.chrome, /\.ctx-item:hover:not\(:disabled\):not\(\[aria-disabled='true'\]\)/, 'ARIA-disabled menu items must not receive hover fill');
assert.match(styles.chrome, /\.ctx-item\.is-active:not\(:disabled\):not\(\[aria-disabled='true'\]\)/, 'Keyboard-active disabled items must remain neutral');
hasRole(styles.dialogs, ".ctx-item[aria-disabled='true']", 'color', 'fg-disabled');
hasRole(styles.settings, '.s-seg button.is-on', 'background', 'interaction-selected');
assert.match(rule(styles.settings, '.s-seg button.is-on'), /box-shadow:\s*none/, 'Segment selection must not add a dark nested shadow');
hasRole(styles.settings, '.runtime-preflight-problem code', 'background', 'surface-input');
hasRole(styles.capability, '.cm-button-solid', 'background', 'action-bg');
hasRole(styles.capability, '.cm-button-solid', 'color', 'action-fg');
hasRole(styles.capability, '.cm-modal-shade', 'background', 'scrim');
hasRole(styles.bgTasks, '.bg-capsule-badge', 'color', 'status-success-fg');
hasRole(styles.mobile, '.ma-sheet-btn.danger', 'background', 'status-danger-bg');
hasRole(styles.mobile, '.ma-sheet-btn.danger', 'color', 'status-danger-fg');
assert.doesNotMatch(styles.markdown, /\.fti-[\w-]+\s*\{[^}]*#[\da-f]{3,8}/i, 'File-kind icons must follow theme content roles');

// Host labels and inline error text must stay readable independently from data-graph palettes.
hasRole(styles.memory, '.memory-tag.is-preference', 'color', 'status-neutral-fg');
hasRole(styles.memory, '.memory-tag.is-preference', 'background', 'status-neutral-bg');
hasRole(styles.memory, '.memory-tag.is-sched', 'color', 'status-info-fg');
hasRole(styles.memory, '.memory-tag.is-sched', 'background', 'status-info-bg');
hasRole(styles.memory, '.ns-note', 'background', 'status-info-bg');
hasRole(styles.memory, '.ns-note', 'color', 'status-info-fg');
for (const file of ['CapabilitiesPane', 'ModelProviderPane']) {
  assert.doesNotMatch(read(`src/renderer/src/components/settings/${file}.tsx`), /var\(--red\)/, `${file}: inline errors consume resolved danger foreground`);
}
assert.doesNotMatch(read('src/renderer/src/components/KnowledgeCenter.tsx'), /var\(--text-2\)/, 'Memory labels consume the paired foreground');
const history = read('src/renderer/src/panels/GitHistory.tsx');
assert.doesNotMatch(history, /color:\s*row\?\.color/, 'Graph lane color must not color branch-label text');
assert.match(history, /color:\s*cur\s*\?\s*'var\(--status-info-fg\)'\s*:\s*'var\(--fg-secondary\)'/, 'Current and ordinary branch labels consume paired foregrounds');

// A narrow center pane must wrap whole action buttons instead of squeezing Chinese labels vertically.
assert.match(rule(styles.tasks, '.prompt-task-toolbar'), /flex-wrap:\s*wrap/);
assert.match(rule(styles.tasks, '.prompt-task-toolbar-actions'), /flex-wrap:\s*wrap/);
for (const [css, selector] of [[styles.tasks, '.prompt-task-toolbar-actions > .ui-btn'], [styles.ext, '.ext-manager-actions > .ui-btn']]) {
  assert.match(rule(css, selector), /white-space:\s*nowrap/);
  assert.match(rule(css, selector), /flex:\s*0\s+0\s+auto/);
}
assert.match(rule(styles.ext, '.ext-manager-row-main'), /flex-wrap:\s*wrap/);
assert.match(rule(styles.ext, '.ext-manager-panel'), /container:\s*extension-manager\s*\/\s*inline-size/);
assert.match(styles.ext, /@container extension-manager \(max-width:\s*640px\)/);
assert.match(styles.ext, /\.ext-manager-actions\s*\{[^}]*flex-basis:\s*100%/);
assert.match(rule(styles.memory, '.memory-overview'), /container:\s*memory-overview\s*\/\s*inline-size/);
assert.match(styles.memory, /@container memory-overview \(max-width:\s*1099px\)/);
assert.match(styles.memory, /\.memory-overview-body\s*\{[^}]*flex-direction:\s*column/);

// HTML/video/QR/document paper remain their own content, rather than becoming a UI surface.
assert.match(rule(styles.files, '.file-editor-preview-html'), /background:\s*#fff/);
assert.match(styles.files, /background:\s*#000/);
assert.match(styles.settings, /background:\s*#fff/);
console.log('color-surfaces-css: ok (declaration guards; Electron visual acceptance separate)');
