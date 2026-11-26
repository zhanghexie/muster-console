/** The palette resolver is the contract for CSS, native chrome, CodeMirror and xterm. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'resolved-appearance-'));
try {
  const compile = createSharedCompiler(root, temporary);
  const { builtinTheme, parseTheme, parseCssColor, themeColorAllowsAlpha } = await import(pathToFileURL(compile('shared/theme.ts')).href);
  const { resolveAppearance, mixAppearanceColors, mixFrameColors, appearanceContrast } = await import(pathToFileURL(compile('shared/resolvedAppearance.ts')).href);
  const { WORKSPACE_ACCENTS } = await import(pathToFileURL(compile('shared/workspaceAccent.ts')).href);
  for (const mode of ['dark', 'light']) {
    const theme = builtinTheme(mode);
    for (const accent of WORKSPACE_ACCENTS) {
      const appearance = resolveAppearance(theme, { workspaceId: 'project', accent, enabled: true }, 19);
      assert.equal(appearance.surfaces['board-column'], appearance.surfaces.canvas, 'board panel shares the session canvas');
      assert.notEqual(appearance.surfaces['board-card'], appearance.surfaces.input, 'content cards do not inherit editable input fill');
      assert.ok(appearanceContrast(appearance.surfaces['board-card'], appearance.surfaces['board-column']) < 1.5, 'repeated cards have a quiet lift');
      assert.equal(appearance.revision, 19);
      assert.equal(appearance.cssVars['--user-bubble-bg'], appearance.cssVars['--action-bg'], 'user bubbles follow the enabled workspace accent');
      assert.equal(appearance.cssVars['--user-bubble-fg'], appearance.cssVars['--fg-primary'], 'accent bubble text uses the same body ink instead of switching to black on bright accents');
      assert.ok(appearanceContrast(appearance.cssVars['--user-bubble-link'], appearance.cssVars['--user-bubble-bg']) >= 4.5, 'user bubble links stay readable for every accent');
      const frame = mixFrameColors(theme.colors['bg-frame'], accent, .28);
      assert.equal(appearance.surfaces.frame, frame, 'production frame preserves 28% oklab');
      assert.equal(appearance.surfaces.canvas, mixAppearanceColors(theme.colors['bg-panel'], frame, .12), 'canvas composites exactly once');
      assert.equal(appearance.surfaces.input, mixAppearanceColors(theme.colors[mode === 'dark' ? 'bg-raised' : 'bg-input'], frame, .12));
      assert.equal(appearance.terminal.background, appearance.cm.background);
      assert.equal(appearance.terminal.background, appearance.surfaces.canvas);
      assert.equal(appearance.terminal.red, theme.terminal.red, 'ANSI identity survives project tint');
      assert.equal(appearance.material.nativeTintAlpha, .28);
      assert.equal(parseCssColor(appearance.material.nativeTint).a, .28, 'native layer is pure accent alpha, never a pre-tinted opaque frame');
      assert.deepEqual(appearance.cm.dark, mode === 'dark');
      for (const [surface, background] of Object.entries(appearance.surfaces)) {
        assert.equal(parseCssColor(background).a, 1, `${surface} opaque`);
        for (const level of ['primary', 'secondary', 'muted']) {
          assert.ok(appearanceContrast(appearance.cssVars[`--${surface}-fg-${level}`], background) >= 4.5, `${mode}/${accent}/${surface}/${level}`);
          for (const state of ['hover', 'pressed']) assert.ok(appearanceContrast(appearance.cssVars[`--${surface}-fg-${level}`], appearance.cssVars[`--${surface}-interaction-${state}`]) >= 4.5, `${mode}/${accent}/${surface}/${state}/${level}`);
          for (const state of ['selected', 'selected-hover']) assert.ok(appearanceContrast(appearance.cssVars[`--${surface}-fg-selected-${level}`], appearance.cssVars[`--${surface}-interaction-${state}`]) >= 4.5, `${surface}/${state}/${level}`);
        }
        for (const bg of [background, appearance.cssVars[`--${surface}-interaction-hover`], appearance.cssVars[`--${surface}-interaction-pressed`]]) assert.ok(appearanceContrast(appearance.cssVars[`--${surface}-border-focus`], bg) >= 3, `${mode}/${accent}/${surface} focus matches the actual surface state`);
        for (const status of ['neutral', 'success', 'warning', 'danger', 'info']) assert.ok(appearanceContrast(appearance.cssVars[`--${surface}-status-${status}-fg`], appearance.cssVars[`--${surface}-status-${status}-bg`]) >= 4.5);
      }
      assert.ok(appearance.contrastReport.every(check => check.ok));
      assert.equal(appearance.cssVars['--identity-surface'], theme.colors['bg-raised'], 'avatars do not inherit project tint');
      assert.notEqual(appearance.cssVars['--frame-interaction-selected'], appearance.cssVars['--canvas-interaction-selected'], 'frame selection belongs to frame');
      assert.ok(!appearance.cssVars['--shadow-card'].startsWith('0 0 0 1px'), 'control border is not duplicated by an outset glow ring');
    }
    const disabled = resolveAppearance(theme, { accent: '#8b7bff', enabled: false });
    const purpleEdges = resolveAppearance(theme, { accent: '#9276d8', enabled: true });
    const greenEdges = resolveAppearance(theme, { accent: '#5fae83', enabled: true });
    assert.notEqual(purpleEdges.cssVars['--material-rim'], disabled.cssVars['--material-rim'], 'enabled accent tints decorative rims');
    assert.notEqual(purpleEdges.cssVars['--material-rim'], greenEdges.cssVars['--material-rim'], 'changing accent updates rims');
    assert.notEqual(purpleEdges.cssVars['--frame-edge'], purpleEdges.cssVars['--border-subtle'], 'frame perimeter is paired with frame, not reading canvas');
    assert.notEqual(purpleEdges.cssVars['--frame-edge'], greenEdges.cssVars['--frame-edge']);
    const disabledOther = resolveAppearance(theme, { accent: '#5fae83', enabled: false });
    assert.equal(disabled.cssVars['--material-rim'], disabledOther.cssVars['--material-rim'], 'disabled accent cannot tint the rim');
    assert.equal(disabled.cssVars['--frame-edge'], disabledOther.cssVars['--frame-edge']);
    assert.notEqual(disabled.surfaces['board-card'], disabled.surfaces.input);
    assert.equal(disabled.surfaces.frame, theme.colors['bg-frame']);
    assert.equal(disabled.surfaces.canvas, theme.colors['bg-panel']);
    assert.equal(disabled.cssVars['--user-bubble-bg'], disabled.surfaces.raised, 'disabled workspace color preserves the original neutral user bubble in both themes');
    assert.equal(disabled.cssVars['--user-bubble-fg'], disabled.cssVars['--fg-primary'], 'neutral bubbles preserve the shared body text color');
    if (mode === 'light') {
      assert.notEqual(disabled.surfaces.input, disabled.surfaces.canvas, 'light inputs remain distinguishable from the reading surface without workspace tint');
    } else {
      assert.equal(disabled.surfaces.input, theme.colors['bg-raised'], 'dark input surface keeps its existing raised background');
    }
    assert.equal(disabled.material.nativeTint, 'transparent');
    for (const [surface, background] of Object.entries(disabled.surfaces)) {
      for (const state of ['hover', 'pressed']) for (const level of ['primary', 'secondary', 'muted']) assert.ok(appearanceContrast(disabled.cssVars[`--${surface}-fg-${level}`], disabled.cssVars[`--${surface}-interaction-${state}`]) >= 4.5, `${mode}/disabled/${surface}/${state}/${level}`);
      assert.ok(appearanceContrast(disabled.cssVars[`--${surface}-border-focus`], background) >= 3, `${mode}/disabled/${surface} focus`);
    }
    assert.equal(disabled.cssVars['--border-focus'], disabled.cssVars['--canvas-border-focus']);
    assert.equal(disabled.cssVars['--divider-focus'], disabled.cssVars['--canvas-border-focus']);
  }
  // Changing input/frame seeds cannot recolour neutral content cards; canvas
  // changes must still propagate, and workspace tint must remain reversible.
  for (const mode of ['dark', 'light']) {
    const base = builtinTheme(mode);
    const original = resolveAppearance(base);
    const inputs = resolveAppearance({ ...base, colors: { ...base.colors,
      'bg-raised': '#82553e', 'bg-input': '#337761', 'bg-frame': '#513a77' } });
    assert.notEqual(inputs.surfaces.input, original.surfaces.input);
    for (const role of ['board-column', 'board-card']) {
      assert.equal(inputs.surfaces[role], original.surfaces[role], `${mode}/${role} is independent of input and app frame`);
      const custom = resolveAppearance({ ...base, colors: { ...base.colors, 'bg-panel': mode === 'dark' ? '#242039' : '#f3ece1' } });
      assert.notEqual(custom.surfaces[role], original.surfaces[role], `${mode}/${role} respects custom canvas seeds`);
      const tinted = resolveAppearance(base, { accent: '#9276d8', enabled: true });
      assert.notEqual(tinted.surfaces[role], original.surfaces[role], `${mode}/${role} respects workspace tint`);
      const off = resolveAppearance(base, { accent: '#9276d8', enabled: false });
      assert.equal(off.surfaces[role], original.surfaces[role]);
      assert.ok(custom.contrastReport.every(check => check.ok));
    }
  }
  // Awkward user colors must repair each foreground/background pairing, not globally bleach the palette.
  const custom = parseTheme({ name: 'low contrast', appearance: 'dark', colors: { 'bg-panel': '#777777', ink: '#777777', 'text-2': '#787878', 'text-3': '#767676' } }).theme;
  const snapshot = resolveAppearance(custom, { accent: '#757575', enabled: true });
  assert.ok(snapshot.contrastReport.every(check => check.ok), JSON.stringify(snapshot.contrastReport.filter(check => !check.ok)));
  assert.equal(custom.colors.ink, '#777777', 'readability repair never rewrites editable seeds');
  assert.equal(snapshot.surfaces.canvas, mixAppearanceColors(custom.colors['bg-panel'], snapshot.surfaces.frame, .12), 'cross-threshold repair never lifts the reading surface');
  const rawPressed = parseCssColor(custom.colors['hover-fill-strong']);
  const rawPressedHex = '#' + [rawPressed.r, rawPressed.g, rawPressed.b].map(value => Math.round(value).toString(16).padStart(2, '0')).join('');
  assert.notEqual(snapshot.interactions.pressed, mixAppearanceColors(snapshot.surfaces.canvas, rawPressedHex, rawPressed.a), 'mid-luminance pressed fill retracts only when no common endpoint is readable');
  assert.ok(appearanceContrast(snapshot.cssVars['--action-fg'], snapshot.cssVars['--action-bg']) >= 4.5, 'near-black foreground can become true black for middle-luminance actions');
  const extreme = parseTheme({ name: 'opaque white hover on black', appearance: 'dark', colors: {
    'bg-frame': '#000000', 'bg-panel': '#000000', 'bg-raised': '#000000', 'bg-overlay': '#000000', 'bg-input': '#000000',
    'hover-fill': '#ffffff', 'hover-fill-strong': '#ffffff'
  } }).theme;
  const extremeSnapshot = resolveAppearance(extreme, { accent: '#8b7bff', enabled: false });
  assert.equal(extremeSnapshot.surfaces.canvas, '#000000');
  assert.equal(extreme.colors['hover-fill'], '#ffffff', 'repair does not rewrite custom hover seed');
  assert.ok(extremeSnapshot.contrastReport.every(check => check.ok), JSON.stringify(extremeSnapshot.contrastReport.filter(check => !check.ok)));
  assert.ok(parseCssColor(extremeSnapshot.interactions.hover).r > 100, 'repair preserves the closest readable hover rather than replacing it with rest');
  for (const state of ['hover', 'pressed']) for (const level of ['primary', 'secondary', 'muted']) {
    assert.ok(appearanceContrast(extremeSnapshot.cssVars[`--fg-${level}`], extremeSnapshot.interactions[state]) >= 4.5, `opaque white ${state} shares canvas foreground`);
  }
  // Selected hover can also cross the narrow range where two backgrounds need opposite endpoints.
  for (const mode of ['dark', 'light']) {
    const selectedTheme = parseTheme({ name: 'selected hover contrast threshold', appearance: mode, colors: {
      'bg-frame': '#5a5a5a', 'bg-panel': '#5a5a5a', 'bg-raised': '#5a5a5a', 'bg-overlay': '#5a5a5a', 'bg-input': '#5a5a5a',
      ink: '#ffffff', 'text-2': '#ffffff', 'text-3': '#ffffff'
    } }).theme;
    const rawSelected = mixAppearanceColors('#5a5a5a', '#ffffff', .15), rawSelectedHover = mixAppearanceColors(rawSelected, '#ffffff', .035);
    assert.ok(!['#ffffff', '#000000'].some(fg => [rawSelected, rawSelectedHover].every(bg => appearanceContrast(fg, bg) >= 4.5)), 'fixture reproduces the incompatible selected/hover endpoints before repair');
    for (const accent of [null, ...WORKSPACE_ACCENTS]) {
      const appearance = resolveAppearance(selectedTheme, { accent: accent ?? '#8b7bff', enabled: accent !== null });
      assert.ok(appearance.contrastReport.every(check => check.ok), JSON.stringify(appearance.contrastReport.filter(check => !check.ok)));
      for (const [surface, background] of Object.entries(appearance.surfaces)) {
        const selected = appearance.cssVars[`--${surface}-interaction-selected`];
        assert.equal(selected, mixAppearanceColors(background, '#ffffff', .15), `${mode}/${accent}/${surface}: selected itself is never lifted`);
        for (const state of ['selected', 'selected-hover']) for (const level of ['primary', 'secondary', 'muted']) {
          assert.ok(appearanceContrast(appearance.cssVars[`--${surface}-fg-selected-${level}`], appearance.cssVars[`--${surface}-interaction-${state}`]) >= 4.5, `${mode}/${accent}/${surface}/${state}/${level}`);
        }
      }
      if (accent === null) {
        assert.equal(appearance.surfaces.canvas, '#5a5a5a');
        assert.equal(appearance.interactions.selected, rawSelected);
        assert.notEqual(appearance.interactions.selectedHover, rawSelectedHover);
      }
    }
    assert.equal(selectedTheme.colors['bg-panel'], '#5a5a5a');
    assert.equal(selectedTheme.colors.ink, '#ffffff');
  }
  assert.equal(themeColorAllowsAlpha('colors', 'bg-panel'), false);
  assert.equal(themeColorAllowsAlpha('colors', 'hover-fill'), true);
  assert.equal(themeColorAllowsAlpha('terminal', 'foreground'), false);
  assert.equal(themeColorAllowsAlpha('terminal', 'selectionBackground'), true);
  console.log('resolved appearance contracts passed');
} finally {
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('resolved-appearance-')) throw new Error('Unexpected temporary directory');
  fs.rmSync(temporary, { recursive: true, force: true });
}
