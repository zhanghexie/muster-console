import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import ts from 'typescript';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-reply-preview-'));
try {
  const compile = createSharedCompiler(root, tmp);
  const load = async p => import(pathToFileURL(compile(p)).href);
  const { boardReplyLine, boardReplyPartsLine, guiReplyLine, schedulerReplyLine } = await load('shared/boardReplyPreview.ts');
  const { persistEntry } = await load('main/agentSession/host/base.ts');
  const { SessionPersister } = await load('main/sessions/persister.ts');
  assert.equal(boardReplyLine('第一句。第二句！'), '第二句！');
  assert.equal(boardReplyLine('First sentence. Last sentence.'), 'Last sentence.');
  assert.equal(boardReplyLine('第一行\n最后一行'), '最后一行');
  assert.equal(boardReplyPartsLine(['旧句。最', '后一句。']), '最后一句。');
  assert.equal(boardReplyLine('如果画面有异常，我来排查。玩得开心！ 🏁'), '玩得开心！ 🏁');
  assert.equal(boardReplyPartsLine(['游戏已启动。玩得开心！', '\n🏁']), '玩得开心！ 🏁');
  assert.equal(boardReplyLine('The game is ready. Have fun! 🏁🎉'), 'Have fun! 🏁🎉');
  assert.equal(boardReplyLine('🏁'), '🏁');
  assert.equal([...boardReplyLine('😀'.repeat(300))].length, 240);
  const messages = [
    { role: 'assistant', parts: [{ kind: 'text', text: '旧回复' }] },
    { role: 'user', parts: [{ kind: 'text', text: '用户内容' }] },
    { role: 'assistant', parts: [{ kind: 'thinking', text: '思考' }, { kind: 'text', text: '第一句。' }, { kind: 'tool', tool: { output: '工具日志' } }, { kind: 'text', text: '最后一句。' }] },
    { role: 'assistant', host: true, parts: [{ kind: 'text', text: '宿主通知' }] }
  ];
  assert.equal(guiReplyLine(messages), '最后一句。');
  assert.equal(schedulerReplyLine([{ role: 'assistant', content: '不应显示', parts: [{kind:'thinking',text:'思考'}, {kind:'tool',tool:{output:'日志'}}] }]), '');
  assert.equal(schedulerReplyLine([{ role: 'assistant', content: '旧', parts: [{kind:'text', text:'前一句。最后一句。'}] }, {role:'assistant', content:'本地提示', local:true}]), '最后一句。');
  let saved, preview;
  const entry = { sessionId: 's', messages, clearing: false };
  const host = { ctx: { sessions: { setBoardReplyPreview: (id, value) => { preview = [id, value]; } } }, store: { save: (...args) => { saved = args; } } };
  persistEntry(host, entry, 'replace');
  assert.deepEqual(preview, ['s', '最后一句。']);
  assert.equal(saved[0], 's');
  entry.clearing = true; preview = undefined; saved = undefined;
  persistEntry(host, entry, 'replace');
  assert.equal(preview, undefined, 'late writes during clear cannot restore an old preview');
  assert.equal(saved, undefined);
  // Exercise the real session registry mutator and its ordinary serialization path.
  const source = ts.createSourceFile('sessions.ts', fs.readFileSync(path.join(root, 'src/main/sessions.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SessionsService');
  const method = declaration.members.find(member => member.name?.getText(source) === 'setBoardReplyPreview');
  const emitted = ts.transpileModule(`class Fixture { ${method.getText(source)} }; exports.Fixture=Fixture;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {}; new Function('exports', emitted)(exports);
  let durable = [], broadcasts = 0;
  const session = { id: 's', type: 'terminal', name: '旧会话' };
  const registry = Object.assign(new exports.Fixture(), { sessions: [session], broadcast: () => broadcasts++ });
  const persister = new SessionPersister({ saveSessions: sessions => { durable = JSON.parse(JSON.stringify(sessions)); } }, () => registry.sessions);
  registry.persist = () => persister.schedule();
  registry.setBoardReplyPreview('s', guiReplyLine(messages));
  persister.flush();
  assert.equal(durable[0].boardReplyPreview, '最后一句。', 'preview survives ordinary registry serialization');
  registry.setBoardReplyPreview('s', '最后一句。');
  assert.equal(broadcasts, 1, 'unchanged preview does not trigger another broadcast');
  registry.setBoardReplyPreview('s', '');
  persister.flush();
  assert.equal(durable[0].boardReplyPreview, undefined, 'clearing removes persisted preview');
  assert.equal(broadcasts, 2);
  console.log('board reply metadata projection ok');
} finally {
  const resolved = fs.realpathSync(tmp), parent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved), parent);
  assert.ok(path.basename(resolved).startsWith('board-reply-preview-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
