import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-dialog-'));
const compile = createSharedCompiler(root, tmp);
const out = compile('shared/uiDialog.ts');

const {
  normalizePromptArgs,
  normalizeSelectArgs,
  normalizeMultiSelectArgs,
  normalizeMenuArgs
} = await import(pathToFileURL(out));

{
  const p = normalizePromptArgs({ title: ' 你好 ', placeholder: 'x', multiline: true });
  assert.equal(p.title, '你好');
  assert.equal(p.multiline, true);
}
assert.throws(() => normalizePromptArgs({ title: '' }), /title/);

{
  const s = normalizeSelectArgs({
    title: '选',
    items: [
      { id: 'a', label: '甲', detail: 'd' },
      { id: 'b', label: '乙' }
    ]
  });
  assert.equal(s.items.length, 2);
  assert.equal(s.items[0].detail, 'd');
}
assert.throws(
  () => normalizeSelectArgs({ title: 't', items: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }),
  /重复/
);

{
  const m = normalizeMultiSelectArgs({
    title: '多选',
    items: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }],
    selectedIds: ['y']
  });
  assert.deepEqual(m.selectedIds, ['y']);
}

{
  const menu = normalizeMenuArgs({
    items: [{ id: '1', label: '一' }, { separator: true }, { id: '2', label: '二' }]
  });
  assert.equal(menu.items.length, 3);
  assert.equal(menu.items[1].separator, true);
}
assert.throws(() => normalizeMenuArgs({ items: [{ separator: true }] }), /至少需要一项/);

console.log('ui-dialog: ok');
