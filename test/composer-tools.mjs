/**
 * Composer 本地工具自测：手动确认发送清单操作（原 tosend 清单）、快捷短语 CRUD / 过滤 / 落盘回读。
 * 运行: node test/composer-tools.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-tools-'));

const entry = path.join(root, 'src/shared/composerTools.ts');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: entry
});
const out = path.join(tmp, 'composerTools.mjs');
fs.writeFileSync(out, outputText.replace("'./workerModelMention'", "'./workerModelMention.mjs'"), 'utf8');
fs.writeFileSync(path.join(tmp, 'workerModelMention.mjs'), ts.transpileModule(
  fs.readFileSync(path.join(root, 'src/shared/workerModelMention.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText, 'utf8');
const {
  addTosendItem,
  removeTosendItem,
  updateTosendItem,
  reorderTosendByIds,
  parseTosendList,
  serializeTosendList,
  TOSEND_MAX_ITEMS,
  normalizePhrase,
  filterQuickPhrases,
  upsertQuickPhrase,
  removeQuickPhrase,
  parseQuickPhrases,
  serializeQuickPhrases
} = await import(pathToFileURL(out).href);
const { encodeWorkerModelMention, serializeWorkerModelMentions, workerModelMentions } = await import(pathToFileURL(path.join(tmp, 'workerModelMention.mjs')).href);
const firstModel = { targetRef: 'wr1.' + 'A'.repeat(32), label: 'Kimi · GUI · 批注1 · High' };
const secondModel = { targetRef: 'wr1.' + 'B'.repeat(32), label: 'OpenCode · GUI · Same name · High' };
const referencedDraft = `${'x'.repeat(1999)} ${encodeWorkerModelMention(firstModel)} and ${encodeWorkerModelMention(secondModel)}`;
assert.equal(parseTosendList(serializeTosendList(addTosendItem([], referencedDraft)))[0].text, referencedDraft);
assert.deepEqual(workerModelMentions(referencedDraft).map(item => item.mention), [firstModel, secondModel]);
assert.match(serializeWorkerModelMentions(referencedDraft), /host\.sessions\.create/);
assert.equal(workerModelMentions(`[File: ${JSON.stringify(encodeWorkerModelMention(firstModel))}]`).length, 0);

// ---------- 手动确认发送清单操作 ----------
{
  let list = [];
  list = addTosendItem(list, '  有空格  ');
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '有空格');
  assert.equal(addTosendItem(list, '   '), list); // 空内容原样返回
  // 上限裁最旧
  for (let i = 0; i < TOSEND_MAX_ITEMS + 3; i++) list = addTosendItem(list, `条目${i}`, 1000 + i);
  assert.equal(list.length, TOSEND_MAX_ITEMS);
  assert.equal(list[0].text, '条目3');
  // 删除
  list = removeTosendItem(list, list[0].id);
  assert.equal(list.length, TOSEND_MAX_ITEMS - 1);
  // 落盘回读
  const back = parseTosendList(serializeTosendList(list));
  assert.deepEqual(back, list);
  assert.deepEqual(parseTosendList(null), []);
  assert.deepEqual(parseTosendList('not json'), []);
  assert.deepEqual(parseTosendList('{"a":1}'), []);
  assert.deepEqual(parseTosendList('[{"text":"  "}]'), []); // 空白条目剔除
}

// ---------- 手动清单随文图片（2026-09-27）----------
{
  const noteDraft = { text: '看这里 批注1', notes: [{ id: 'n1', messageId: 'a1', seq: 1, quote: '长原文'.repeat(800), note: '末尾批注', web: { label: '元素', selector: '.target', url: 'https://example.test', shot: 'AAAA' } }] };
  const expanded = `原文：${noteDraft.notes[0].quote}；用户批注：末尾批注`;
  const list = addTosendItem([], expanded, 1, undefined, noteDraft);
  noteDraft.notes[0].note = '后续修改';
  assert.equal(list[0].noteDraft.notes[0].note, '末尾批注', '队列保存独立的批注快照');
  assert.equal(list[0].text, expanded, '长批注正文不能按短消息限长截断');
  assert.deepEqual(parseTosendList(serializeTosendList(list)), list, '批注快照与完整正文落盘往返');
  assert.equal(updateTosendItem(list, list[0].id, '新内容')[0].noteDraft, undefined, '直接改写正文不能取回旧批注');
  assert.equal(parseTosendList(JSON.stringify([{ text: '正文', noteDraft: { text: '批注1', notes: [null] } }]))[0].noteDraft, undefined, '坏快照剥离，正文仍可取回');
}

{
  const imgs = [{ id: 'im1', data: 'AAAA', mimeType: 'image/png', name: 'a.png' }];
  let list = addTosendItem([], '看图', 1, imgs);
  assert.equal(list[0].images.length, 1, '追加带图');
  assert.equal(list[0].images[0].data, 'AAAA');
  // 图-only：text 可空
  const onlyImg = addTosendItem([], '   ', 2, imgs);
  assert.equal(onlyImg.length, 1, '图-only 可入清单');
  assert.equal(onlyImg[0].text, '');
  assert.equal(onlyImg[0].images.length, 1);
  // 编辑文本保留图片
  const edited = updateTosendItem(list, list[0].id, '看图（改）');
  assert.equal(edited[0].text, '看图（改）');
  assert.equal(edited[0].images.length, 1, '编辑保留随文图片');
  // 图-only 清空文本仍保留（有图即可发）
  const cleared = updateTosendItem(onlyImg, onlyImg[0].id, '  ');
  assert.equal(cleared, onlyImg, '有图时清空文本不拒绝');
  // 落盘回读带图
  const back = parseTosendList(serializeTosendList(edited));
  assert.deepEqual(back, edited, '图片随清单序列化往返');
  // 坏图剔除但条目仍在（有正文）
  const bad = parseTosendList(JSON.stringify([{ id: 'x', text: 't', ts: 1, images: [{ data: 1 }] }]));
  assert.equal(bad.length, 1);
  assert.equal(bad[0].images, undefined, '非法图片被剥掉');
}

// ---------- tosend 编辑 / 拖拽排序（统一排队面板） ----------
{
  let list = [];
  for (const text of ['一', '二', '三']) list = addTosendItem(list, text);
  // 编辑：trim + 保留其余条目
  const two = list[1];
  list = updateTosendItem(list, two.id, '  二改  ');
  assert.equal(list[1].text, '二改');
  assert.equal(list.length, 3);
  // 编辑成空 = 无效，不动清单
  assert.equal(updateTosendItem(list, two.id, '   '), list);
  assert.equal(list.map((i) => i.text).join(), '一,二改,三'); // 入参未被改动
  // 全量重排：缺失 id 忽略、多出条目保序追加
  const ids = list.map((i) => i.id);
  const reordered = reorderTosendByIds(list, [ids[2], 'nope', ids[0]]);
  assert.deepEqual(reordered.map((i) => i.text), ['三', '一', '二改']);
  assert.deepEqual(reorderTosendByIds(list, []).map((i) => i.text), ['一', '二改', '三']);
}

// ---------- 快捷短语：规整 / 过滤 / CRUD ----------
{
  assert.equal(normalizePhrase('  ', '  '), null);
  assert.deepEqual(normalizePhrase(' 地址 ', ' xx路 '), { key: '地址', value: 'xx路' });
  assert.deepEqual(normalizePhrase('', '只要内容'), { key: '', value: '只要内容' });

  let list = [];
  let r = upsertQuickPhrase(list, null, '地址', 'xx路99号');
  list = r.list;
  r = upsertQuickPhrase(list, null, '座右铭', '慢慢比较快');
  list = r.list;
  assert.equal(list.length, 2);
  assert.equal(list[1].key, '座右铭');
  // 更新原地保持顺序
  r = upsertQuickPhrase(list, list[0].id, '地址', '新地址yy大道');
  list = r.list;
  assert.equal(list.length, 2);
  assert.equal(list[0].value, '新地址yy大道');
  assert.equal(list[0].key, '地址');
  // 无效更新原样返回
  r = upsertQuickPhrase(list, list[0].id, ' ', ' ');
  assert.equal(r.list, list);

  // 过滤：key / value / 大小写不敏感 / 空查询
  assert.deepEqual(filterQuickPhrases(list, '').length, 2);
  assert.equal(filterQuickPhrases(list, '地址')[0].id, list[0].id);
  assert.equal(filterQuickPhrases(list, 'yy大道')[0].key, '地址');
  assert.equal(filterQuickPhrases(list, '慢慢')[0].key, '座右铭');
  assert.deepEqual(filterQuickPhrases(list, '不存在'), []);

  // 删除 + 落盘回读 + 坏数据防御
  list = removeQuickPhrase(list, list[0].id);
  assert.equal(list.length, 1);
  const back = parseQuickPhrases(serializeQuickPhrases(list));
  assert.deepEqual(back, list);
  assert.deepEqual(parseQuickPhrases(null), []);
  assert.deepEqual(parseQuickPhrases('[{broken'), []);
  assert.deepEqual(parseQuickPhrases('[{"key":" ","value":" "}]'), []);
  assert.deepEqual(parseQuickPhrases('[{"key":"k"}]'), []); // 缺 value 剔除
}

console.log('ok composer-tools');
