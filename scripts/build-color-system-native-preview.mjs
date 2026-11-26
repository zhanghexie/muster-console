import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const IMAGE_FILES = Object.freeze({
  'dark-original': 'dark-workbench-original.jpg',
  'dark-balanced': 'dark-workbench-balanced.jpg',
  'light-original': 'light-workbench-original.jpg',
  'light-balanced': 'light-workbench-balanced.jpg'
});
export const DEFAULT_OUTPUT = path.join(repoRoot, 'output/color-system-native/preview.html');
export const MAX_FRAGMENT_BYTES = 1_000_000;

export function normalizeSelection(raw) {
  const model = raw?.modelContent ?? raw ?? {};
  return {
    theme: model.theme === 'light' ? 'light' : 'dark',
    mode: model.mode === 'original' ? 'original' : 'balanced',
    zoom: raw?.privateContent?.zoom === true
  };
}

export function imageKey(selection) {
  return `${selection.theme}-${selection.mode}`;
}

export function renderFragment(images) {
  for (const key of Object.keys(IMAGE_FILES)) {
    assert.match(images[key] ?? '', /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/u, `Missing JPEG data for ${key}`);
  }
  return `<div id="color-system-native-preview">
  <div class="viz-controls" aria-label="工作台截图对照">
    <div class="viz-row" role="group" aria-label="主题">
      <button type="button" class="btn" data-theme="dark" aria-pressed="true">深色</button>
      <button type="button" class="btn" data-theme="light" aria-pressed="false">浅色</button>
    </div>
    <div class="viz-row" role="group" aria-label="对照版本">
      <button type="button" class="btn" data-mode="original" aria-pressed="false">原版</button>
      <button type="button" class="btn" data-mode="balanced" aria-pressed="true">微调</button>
    </div>
    <button type="button" class="btn btn-ghost" data-zoom aria-pressed="false">放大</button>
  </div>
  <div class="native-preview-image">
    <img src="${images['dark-balanced']}" alt="深色 · 微调工作台实际截图" draggable="false">
  </div>
  <span class="sr-only" aria-live="polite" data-selection>深色 · 微调</span>
</div>
<style>
#color-system-native-preview { max-width: 100%; }
#color-system-native-preview .native-preview-image { width: 100%; overflow: auto; }
#color-system-native-preview img { display: block; width: 100%; max-width: 100%; height: auto; }
</style>
<script>
(() => {
  const root = document.getElementById('color-system-native-preview');
  const image = root.querySelector('img');
  const status = root.querySelector('[data-selection]');
  const zoomButton = root.querySelector('[data-zoom]');
  const themeButtons = Array.from(root.querySelectorAll('[data-theme]'));
  const modeButtons = Array.from(root.querySelectorAll('[data-mode]'));
  const images = ${JSON.stringify(images)};
  const normalizeSelection = ${normalizeSelection.toString()};
  let selection = normalizeSelection(window.openai?.widgetState);

  function render() {
    const themeLabel = selection.theme === 'dark' ? '深色' : '浅色';
    const modeLabel = selection.mode === 'original' ? '原版' : '微调';
    const key = selection.theme + '-' + selection.mode;
    if (image.getAttribute('src') !== images[key]) image.setAttribute('src', images[key]);
    image.alt = themeLabel + ' · ' + modeLabel + '工作台实际截图';
    root.dataset.selection = key;
    status.textContent = themeLabel + ' · ' + modeLabel;
    themeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.theme === selection.theme)));
    modeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === selection.mode)));
    image.style.width = selection.zoom && image.naturalWidth ? image.naturalWidth + 'px' : '100%';
    image.style.maxWidth = selection.zoom ? 'none' : '100%';
    zoomButton.setAttribute('aria-pressed', String(selection.zoom));
    zoomButton.textContent = selection.zoom ? '适应' : '放大';
  }

  function save() {
    if (!window.openai?.setWidgetState) return;
    const snapshot = {
      modelContent: { theme: selection.theme, mode: selection.mode },
      privateContent: { zoom: selection.zoom }
    };
    try { Promise.resolve(window.openai.setWidgetState(snapshot)).catch(() => {}); } catch {}
  }

  themeButtons.forEach(button => button.addEventListener('click', () => {
    selection.theme = button.dataset.theme; render(); save();
  }));
  modeButtons.forEach(button => button.addEventListener('click', () => {
    selection.mode = button.dataset.mode; render(); save();
  }));
  zoomButton.addEventListener('click', () => {
    selection.zoom = !selection.zoom; render(); save();
  });
  image.addEventListener('load', render);
  window.addEventListener('openai:set_globals', event => {
    const globals = event.detail?.globals;
    if (!globals || !Object.prototype.hasOwnProperty.call(globals, 'widgetState')) return;
    selection = normalizeSelection(globals.widgetState); render();
  });
  render();
})();
</script>
`;
}

export async function buildPreview({ inputDir = path.join(repoRoot, 'output/color-system-native'), outputPath = DEFAULT_OUTPUT } = {}) {
  const entries = await Promise.all(Object.entries(IMAGE_FILES).map(async ([key, file]) => {
    const bytes = await readFile(path.join(inputDir, file));
    assert.equal(bytes[0], 0xff, `${file} is not a JPEG`);
    assert.equal(bytes[1], 0xd8, `${file} is not a JPEG`);
    return [key, `data:image/jpeg;base64,${bytes.toString('base64')}`];
  }));
  const fragment = renderFragment(Object.fromEntries(entries));
  const size = Buffer.byteLength(fragment, 'utf8');
  if (size >= MAX_FRAGMENT_BYTES) {
    throw new Error(`Preview fragment is ${size} bytes; budget is below ${MAX_FRAGMENT_BYTES}. Images were not recompressed.`);
  }
  assert.ok(!/<!doctype|<html(?:\s|>)|<head(?:\s|>)|<body(?:\s|>)/iu.test(fragment), 'Output must be an HTML fragment');
  assert.ok(!fragment.includes('class=\\"'), 'Output contains escaped markup');
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, fragment, 'utf8');
  assert.equal(await readFile(outputPath, 'utf8'), fragment, 'Fragment read-back differs');
  return { outputPath: path.resolve(outputPath), bytes: size, images: Object.values(IMAGE_FILES) };
}

export function checkPreview() {
  assert.deepEqual(Object.keys(IMAGE_FILES), ['dark-original', 'dark-balanced', 'light-original', 'light-balanced']);
  assert.deepEqual(normalizeSelection(), { theme: 'dark', mode: 'balanced', zoom: false });
  assert.deepEqual(normalizeSelection({ theme: 'invalid', mode: 'invalid' }), normalizeSelection());
  const images = Object.fromEntries(Object.keys(IMAGE_FILES).map(key => [key, `data:image/jpeg;base64,${Buffer.from(key).toString('base64')}`]));
  const fragment = renderFragment(images);
  const script = fragment.match(/<script>\n([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script, 'Fragment is missing runtime script');
  function element(dataset = {}) {
    const callbacks = {}, attributes = {};
    return {
      dataset, style: {}, naturalWidth: 1440, textContent: '',
      addEventListener: (name, callback) => { callbacks[name] = callback; },
      getAttribute: name => attributes[name],
      setAttribute: (name, value) => { attributes[name] = value; },
      fire: name => callbacks[name]?.(), attributes
    };
  }
  const image = element(), status = element(), zoom = element();
  const themes = ['dark', 'light'].map(theme => element({ theme }));
  const modes = ['original', 'balanced'].map(mode => element({ mode }));
  const globalsCallbacks = {}, saved = [];
  const root = {
    dataset: {},
    querySelector: query => ({ img: image, '[data-selection]': status, '[data-zoom]': zoom })[query],
    querySelectorAll: query => ({ '[data-theme]': themes, '[data-mode]': modes })[query]
  };
  const window = {
    openai: { setWidgetState: snapshot => { saved.push(snapshot); return Promise.resolve(); } },
    addEventListener: (name, callback) => { globalsCallbacks[name] = callback; }
  };
  vm.runInNewContext(script, { document: { getElementById: id => id === 'color-system-native-preview' ? root : null }, window });
  assert.equal(root.dataset.selection, 'dark-balanced');
  assert.equal(image.getAttribute('src'), images['dark-balanced']);
  assert.equal(saved.length, 0, 'Initial render must not save state');
  for (const [themeIndex, modeIndex] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    themes[themeIndex].fire('click'); modes[modeIndex].fire('click');
    const key = imageKey({ theme: themes[themeIndex].dataset.theme, mode: modes[modeIndex].dataset.mode });
    assert.equal(root.dataset.selection, key);
    assert.equal(image.getAttribute('src'), images[key]);
    assert.equal(themes[themeIndex].attributes['aria-pressed'], 'true');
    assert.equal(modes[modeIndex].attributes['aria-pressed'], 'true');
  }
  zoom.fire('click');
  assert.equal(image.style.width, '1440px');
  assert.equal(zoom.textContent, '适应');
  const saveCount = saved.length;
  globalsCallbacks['openai:set_globals']({ detail: { globals: { widgetState: { modelContent: { theme: 'dark', mode: 'original' }, privateContent: { zoom: false } } } } });
  assert.equal(root.dataset.selection, 'dark-original');
  assert.equal(image.style.width, '100%');
  assert.equal(saved.length, saveCount, 'State restoration must not save state');
  return { checks: 'four mappings, default selection, switching, zoom, persistence/restoration', passed: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    console.log(JSON.stringify(checkPreview(), null, 2));
  } else {
    const option = name => {
      const index = args.indexOf(name);
      if (index < 0) return undefined;
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a path`);
      return path.resolve(args[index + 1]);
    };
    console.log(JSON.stringify(await buildPreview({ inputDir: option('--input'), outputPath: option('--out') }), null, 2));
  }
}
