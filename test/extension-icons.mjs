import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-icons-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const { default: sharp } = await import('sharp');
  const { EXTENSION_ICONS, DEFAULT_EXTENSION_ICON, extensionIconId, extensionIconValue, isValidExtensionIcon } = await import(pathToFileURL(compile('shared/extensionIcons.ts')));
  assert.equal(EXTENSION_ICONS.length, 132);
  assert.equal(new Set(EXTENSION_ICONS.map(icon => icon.id)).size, 132);
  assert.equal(extensionIconId(extensionIconValue(DEFAULT_EXTENSION_ICON)), DEFAULT_EXTENSION_ICON);
  assert.equal(extensionIconId('builtin-extension:missing'), undefined);
  assert.equal(isValidExtensionIcon('builtin-extension:constructor'), false);
  assert.equal(extensionIconId('📅'), undefined);
  assert.equal(isValidExtensionIcon('📅'), true);
  assert.equal(isValidExtensionIcon(extensionIconValue('calendar')), true);
  assert.equal(isValidExtensionIcon('builtin-extension:../../file'), false);
  const files = fs.readdirSync(path.join(repo, 'src/renderer/src/assets/extensions')).filter(file => file.endsWith('.svg')).sort();
  assert.deepEqual(files, EXTENSION_ICONS.map(icon => `${icon.id}.svg`).sort());
  for (const icon of EXTENSION_ICONS) {
    const data = fs.readFileSync(path.join(repo, 'src/renderer/src/assets/extensions', `${icon.id}.svg`), 'utf8');
    assert.match(data, /^<svg\s/);
    assert.match(data, /viewBox="0 0 24 24"/);
    assert.match(data, /stroke="currentColor"/, '图标资产必须是单色 currentColor 源文件，才能经 CSS mask 跟随主题');
    const metadata = await sharp(Buffer.from(data)).metadata();
    assert.equal(metadata.width, 24);
    assert.equal(metadata.height, 24);
    assert.equal(metadata.format, 'svg');
  }
  console.log('extension-icons: 132 unique stable IDs, hand-authored monochrome SVG assets and legacy fallback passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
