import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-duplicates-'));
try {
  const { extractLocaleKeys, duplicateLocaleKeys } = await import(pathToFileURL(createSharedCompiler(root, tmp)('shared/dimensionGates.ts')).href);
  assert.deepEqual(duplicateLocaleKeys(['a', 'b', 'a', 'a', 'b']), ['a', 'b']);
  assert.deepEqual(duplicateLocaleKeys(extractLocaleKeys(["  '测试': 'first',\n", "  '测试': 'second',\n"])), ['测试']);
  assert.deepEqual(duplicateLocaleKeys(extractLocaleKeys(["'one': 'x', 'two': 'y', 'one': 'z',"])), ['one']);
  const dir = path.join(root, 'src/shared/i18n/locales');
  const files = [path.join(dir, 'en.ts'), ...fs.readdirSync(path.join(dir, 'fragments')).filter(name => name.endsWith('.ts')).map(name => path.join(dir, 'fragments', name))];
  const duplicates = duplicateLocaleKeys(extractLocaleKeys(files.map(file => fs.readFileSync(file, 'utf8'))));
  assert.deepEqual(duplicates, [], `locale keys must be unique: ${duplicates.join(', ')}`);
  console.log('i18n locale key uniqueness passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
