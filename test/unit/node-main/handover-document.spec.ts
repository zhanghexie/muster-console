import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { attachmentDir } from '../../../src/main/attachments/service';
import { beginHandoverSubmission, discardHandoverDraft, finishHandoverSubmission, prepareCanvasHandover, renderGuiHandover } from '../../../src/main/handover/documents';
import { applyLocaleSetting } from '../../../src/shared/i18n';
import { deleteSessionHandover, existingHandoverDirectory, sweepOrphanHandovers, withHandoverReadAccess } from '../../../src/main/handover/paths';
import { additionalExecutionDirectories, captureWorkspaceExecutionContext } from '../../../src/main/workspaceExecutionContext';
import { decideToolCallPermission } from '../../../src/main/agentSession/tools/policy';

const roots: string[] = [];
function fixture(runtime = 'acp') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-test-')); roots.push(root);
  const cwd = path.join(root, 'workspace'), userData = path.join(root, 'userdata');
  fs.mkdirSync(cwd); fs.mkdirSync(userData);
  const source = { id: '11111111-1111-4111-8111-111111111111', name: '源任务', runtime,
    workspaceId: 'ws', cwd, type: 'terminal' as const, createdAt: 1 };
  const cfg = { workspace: cwd, activeWorkspaceId: 'ws', workspaces: [{ id: 'ws', path: cwd, name: 'ws' }] };
  const messages: any[] = [];
  const ctx = { config: { get: () => cfg }, sessions: { isChatRuntime: () => runtime === 'acp', get: () => source },
    agentSessions: { getHistory: () => ({ messages, busy: false }) } } as any;
  return { root, cwd, userData, source, ctx, messages };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('localizes handover errors without writing a document or changing message numbering', async () => {
  const f = fixture();
  try {
    applyLocaleSetting('en');
    await expect(prepareCanvasHandover(f.ctx, f.source, f.userData)).rejects.toThrow('The source session has no chat history to hand over.');
    expect(fs.existsSync(path.join(f.userData, 'session-handovers'))).toBe(false);
    await expect(renderGuiHandover([{ id: 'a', role: 'user', ts: 1, parts: [], images: [{ id: 'missing-image', mimeType: 'image/png', data: '' }] }], f.userData))
      .rejects.toThrow('Image data for message 1 is unavailable; the handover document cannot be generated completely.');
  } finally { applyLocaleSetting('zh-CN'); }
});

it('完整保存 GUI 历史、工具和附件，交接目录只授予目标会话并可删除', async () => {
  const f = fixture();
  const sourceAttachments = attachmentDir(f.userData, `gui:${f.source.id}`);
  fs.mkdirSync(sourceAttachments, { recursive: true });
  const oldAttachment = path.join(sourceAttachments, 'original.txt');
  fs.writeFileSync(oldAttachment, 'attachment contents');
  f.messages.push({ id: 'u', role: 'user', ts: 1, parts: [{ kind: 'text', text: `开始 ${'x'.repeat(81000)} 最新标记 ${oldAttachment}` }],
    images: [{ id: 'i', name: 'image.png', mimeType: 'image/png', data: Buffer.from('image bytes').toString('base64') }] });
  f.messages.push({ id: 'a', role: 'assistant', ts: 2, parts: [{ kind: 'tool', tool: { id: 't', name: 'Read', input: { file: oldAttachment }, status: 'ok', output: '结果标记' } },
    { kind: 'text', text: '最后回答' }] });
  const draft = await prepareCanvasHandover(f.ctx, f.source, f.userData);
  const doc = fs.readFileSync(draft.documentPath, 'utf8');
  expect(doc).toContain('最新标记'); expect(doc).toContain('最后回答'); expect(doc).toContain('结果标记');
  expect(doc).toContain(`原会话 ID：${f.source.id}`);
  expect(draft.lockedTask).toContain('【交接背景】');
  expect(draft.lockedTask).toContain('共 1 轮，包含 1 条用户消息、1 条助手消息和 1 次工具调用');
  expect(draft.lockedTask).not.toContain('工具输出已截断');
  expect(draft.lockedTask).not.toContain('请先完整阅读');
  const lines = doc.split('\n');
  const body = draft.lockedTask.match(/沟通正文：第 (\d+)–(\d+) 行/)!;
  const appendix = draft.lockedTask.match(/工具调用附录：第 (\d+)–(\d+) 行/)!;
  const bodyLines = lines.slice(Number(body[1]) - 1, Number(body[2])).join('\n');
  const detailLines = lines.slice(Number(appendix[1]) - 1, Number(appendix[2])).join('\n');
  expect(bodyLines).toContain('## [用户 #0001] 第 1 轮');
  expect(bodyLines).toContain('## [助手 #0001] 第 1 轮');
  expect(bodyLines).toContain('[工具 #0001] Read');
  expect(bodyLines).not.toContain('结果标记');
  expect(lines[Number(body[1]) - 1]).toBe('## [用户 #0001] 第 1 轮');
  expect(lines[Number(body[2]) - 1]).toBe('最后回答');
  expect(detailLines).toContain('## [工具详情 #0001] Read');
  expect(detailLines).toContain('结果标记');
  expect(lines[Number(appendix[1]) - 1]).toBe('# 附录：工具调用详情');
  expect(lines[Number(appendix[2]) - 1]).toMatch(/^`+$/);
  expect(doc).not.toContain(oldAttachment);
  expect(fs.readFileSync(path.join(path.dirname(draft.documentPath), 'attachments', 'original.txt'), 'utf8')).toBe('attachment contents');
  expect(fs.readFileSync(path.join(path.dirname(draft.documentPath), 'images', '1-1.png'), 'utf8')).toBe('image bytes');
  expect(draft.lockedTask).toContain(draft.documentPath);
  expect(() => beginHandoverSubmission(f.userData, draft.id, 'other')).toThrow(/工作区/);
  expect(beginHandoverSubmission(f.userData, draft.id, 'ws').id).toBe(draft.id);
  finishHandoverSubmission(draft.id, true);
  await discardHandoverDraft(f.userData, draft.id); // confirmed tasks keep their document
  const context = captureWorkspaceExecutionContext(f.ctx.config.get(), { ...f.source, id: draft.id })!;
  const granted = withHandoverReadAccess(context, f.userData, draft.id)!;
  expect(granted.readableDirectories.map(d => d.path)).toContain(path.dirname(draft.documentPath));
  expect(additionalExecutionDirectories(granted)).toContain(path.dirname(draft.documentPath));
  expect(withHandoverReadAccess(context, f.userData, '22222222-2222-4222-8222-222222222222')).toBe(context);
  const decide = (tool: string, file: string) => decideToolCallPermission({ mode: 'auto', planExecuting: false,
    engineToolName: tool, input: { path: file }, cwd: granted.cwd, workspaceContext: granted,
    hostToolIds: [], hostClassOf: () => 'edit', userRules: [] }).decision;
  expect(decide('Read', draft.documentPath)).toBe('auto');
  expect(decide('Write', draft.documentPath)).toBe('deny');
  await deleteSessionHandover(f.userData, draft.id);
  expect(fs.existsSync(path.dirname(draft.documentPath))).toBe(false);
});

it('轮次、消息标记与工具编号能区分宿主、排队输入和重复工具', async () => {
  const f = fixture();
  f.messages.push(
    { id: 'u1', role: 'user', ts: 1, parts: [{ kind: 'text', text: '第一个要求\r\n## [用户 #9999] 只是用户原文中的示例' }] },
    { id: 'host', role: 'user', host: true, ts: 2, parts: [{ kind: 'text', text: '宿主提醒' }] },
    { id: 'agent', role: 'user', source: 'agent', ts: 3, parts: [{ kind: 'text', text: '代理消息' }] },
    { id: 'a1', role: 'assistant', ts: 4, parts: [
      { kind: 'text', text: '调用前' }, { kind: 'tool', tool: { id: 'a', name: 'Read', input: { path: 'one' }, status: 'ok', output: 'result one' } },
      { kind: 'text', text: '调用后' }, { kind: 'tool', tool: { id: 'b', name: 'Read', input: { path: 'two' }, status: 'ok', output: 'result two' } }
    ] },
    { id: 'u2', role: 'user', ts: 5, parts: [{ kind: 'text', text: '第二个要求' }] },
    { id: 'a2', role: 'assistant', ts: 6, parts: [{ kind: 'text', text: '第二次回复' }] },
    { id: 'queued', role: 'user', queued: true, ts: 7, parts: [{ kind: 'text', text: '排队中的用户输入' }] }
  );
  const draft = await prepareCanvasHandover(f.ctx, f.source, f.userData);
  const doc = fs.readFileSync(draft.documentPath, 'utf8');
  expect(draft.lockedTask).toContain('共 2 轮，包含 3 条用户消息（其中 1 条排队未发送，不计入轮次）、2 条助手消息和 2 次工具调用');
  expect(draft.lockedTask).toContain('另有 2 条宿主、调度或代理消息');
  expect(doc).toContain('## [宿主 #0001]');
  expect(doc).toContain('## [代理 #0001]');
  expect(doc).toContain('## [用户 #0002] 第 2 轮');
  expect(doc).toContain('## [用户 #0003]（排队中，尚未发送）');
  expect(doc).toContain('\\## [用户 #9999] 只是用户原文中的示例');
  expect(doc.match(/^## \[用户 #/gm)).toHaveLength(3);
  expect(doc.indexOf('调用前')).toBeLessThan(doc.indexOf('[工具 #0001] Read'));
  expect(doc.indexOf('[工具 #0001] Read')).toBeLessThan(doc.indexOf('调用后'));
  expect(doc).toContain('[工具 #0002] Read');
  expect(doc).toContain('[工具详情 #0001] Read');
  expect(doc).toContain('[工具详情 #0002] Read');
});

it('只截断过长的 GUI 工具结果和补丁，保留首尾、精确省略量及源消息', async () => {
  const f = fixture();
  const output = `输出开头🧪${'中'.repeat(6000)}不应出现在快照中的输出中段${'文'.repeat(6000)}输出结尾🧪`;
  const patch = `补丁开头${'a'.repeat(18000)}不应出现在快照中的补丁中段${'b'.repeat(18000)}补丁结尾`;
  const escaped = `转义开头${'\0'.repeat(4000)}转义结尾`;
  const userText = `用户内容${'u'.repeat(18000)}用户内容结尾`;
  const assistantText = `助手内容${'a'.repeat(18000)}助手内容结尾`;
  const input = { query: `工具输入${'i'.repeat(18000)}工具输入结尾` };
  const sourceTool = { id: 't', name: 'Read', input, status: 'ok', output, patch };
  f.messages.push({ id: 'u', role: 'user', ts: 1, parts: [{ kind: 'text', text: userText }] },
    { id: 'a', role: 'assistant', ts: 2, parts: [
      { kind: 'text', text: assistantText },
      { kind: 'tool', tool: sourceTool },
      { kind: 'tool', tool: { id: 'escaped', name: 'Read', input: {}, status: 'ok', output: escaped } },
      { kind: 'tool', tool: { id: 'small', name: 'Read', input: {}, status: 'ok', output: '短输出原样保留' } }
    ] });
  const draft = await prepareCanvasHandover(f.ctx, f.source, f.userData);
  const doc = fs.readFileSync(draft.documentPath, 'utf8');
  const details = [...doc.matchAll(/调用记录：\n\n```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  expect(details).toHaveLength(3);
  expect(doc).toContain(userText);
  expect(doc).toContain(assistantText);
  expect(details[0].input).toEqual(input);
  expect(details[0].output).toContain('输出开头🧪');
  expect(details[0].output).toContain('输出结尾🧪');
  expect(details[0].output).not.toContain('不应出现在快照中的输出中段');
  const outputParts = details[0].output.match(/^([\s\S]*)\n\n\[交接快照：工具输出已截断，原始 (\d+) 字节，省略 (\d+) 字节（UTF-8）\]\n\n([\s\S]*)$/);
  expect(outputParts).not.toBeNull();
  expect(Number(outputParts![2])).toBe(Buffer.byteLength(output));
  expect(Number(outputParts![3])).toBe(Buffer.byteLength(output) - Buffer.byteLength(outputParts![1]) - Buffer.byteLength(outputParts![4]));
  expect(details[0].patch).toContain('补丁开头');
  expect(details[0].patch).toContain('补丁结尾');
  expect(details[0].patch).not.toContain('不应出现在快照中的补丁中段');
  expect(details[1].output).toContain('工具输出已截断'); // 以 JSON 体积判断，避免转义后单行过长
  expect(Buffer.byteLength(JSON.stringify(details[1].output))).toBeLessThan(16 * 1024);
  expect(details[2].output).toBe('短输出原样保留');
  expect(sourceTool.output).toBe(output);
  expect(sourceTool.patch).toBe(patch);
  expect(draft.lockedTask).toContain('部分超长工具输出已截断');
  const lines = doc.split('\n');
  const appendix = draft.lockedTask.match(/工具调用附录：第 (\d+)–(\d+) 行/)!;
  expect(lines[Number(appendix[1]) - 1]).toBe('# 附录：工具调用详情');
  expect(lines[Number(appendix[2]) - 1]).toMatch(/^`+$/);
});

it('Claude 交接正文和原生附录都截断工具结果，源 JSONL 与用户输入保持原样', async () => {
  const f = fixture('claude-code');
  const original = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(f.root, 'claude');
  try {
    const source = { ...f.source, externalSessionId: '33333333-3333-4333-8333-333333333333' };
    const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', path.resolve(f.cwd).replace(/[^a-zA-Z0-9-]/g, '-'), `${source.externalSessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const output = `原生结果开头${'前'.repeat(6000)}不应出现在快照中的原生结果中段${'后'.repeat(6000)}原生结果结尾`;
    const input = `原生工具输入${'i'.repeat(18000)}原生工具输入结尾`;
    const rows = [
      { type: 'user', message: { content: '用户原始任务' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-a', name: 'Read', input: { value: input } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-a', content: [{ type: 'text', text: output }] }] }, toolUseResult: { stdout: output } },
      { type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 'other', content: output }] } }
    ];
    const raw = rows.map(row => JSON.stringify(row)).join('\n');
    fs.writeFileSync(file, raw);
    const draft = await prepareCanvasHandover(f.ctx, source, f.userData);
    const doc = fs.readFileSync(draft.documentPath, 'utf8');
    expect(doc).toContain('用户原始任务');
    expect(doc).toContain(input);
    expect(doc).toContain('原生结果开头');
    expect(doc).toContain('原生结果结尾');
    expect(doc).not.toContain('不应出现在快照中的原生结果中段');
    expect(doc.match(/工具输出已截断/g)!.length).toBeGreaterThanOrEqual(3);
    expect(draft.lockedTask).toContain('部分超长工具输出已截断');
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    const nativeRange = draft.lockedTask.match(/原生记录附录：第 (\d+)–(\d+) 行/)!;
    const native = doc.split('\n').slice(Number(nativeRange[1]) - 1, Number(nativeRange[2])).join('\n');
    const jsonl = native.match(/```jsonl\n([\s\S]*?)\n```/)![1];
    const exported = jsonl.split('\n').map(line => JSON.parse(line));
    expect(exported[1].message.content[0].input.value).toBe(input);
    expect(exported[2].message.content[0].content).toContain('工具输出已截断');
    expect(exported[2].toolUseResult).toContain('工具输出已截断');
    expect(exported[3].message.content[0].content).toContain('工具输出已截断');
  } finally { if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = original; }
});

it('没有工具时不生成工具附录，交接背景明确说明', async () => {
  const f = fixture();
  f.messages.push({ id: 'u', role: 'user', ts: 1, parts: [{ kind: 'text', text: '任务' }] });
  const draft = await prepareCanvasHandover(f.ctx, f.source, f.userData);
  expect(draft.lockedTask).toContain('工具调用附录：无');
  expect(fs.readFileSync(draft.documentPath, 'utf8')).not.toContain('# 附录：工具调用详情');
});

it('取消草稿删除目录；后台清扫只移除过期且没有会话的目录', async () => {
  const f = fixture();
  f.messages.push({ id: 'u', role: 'user', ts: 1, parts: [{ kind: 'text', text: '任务' }] });
  const cancelled = await prepareCanvasHandover(f.ctx, f.source, f.userData);
  await discardHandoverDraft(f.userData, cancelled.id);
  expect(fs.existsSync(cancelled.documentPath)).toBe(false);
  const live = await prepareCanvasHandover(f.ctx, f.source, f.userData);
  const orphan = await prepareCanvasHandover(f.ctx, f.source, f.userData);
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  fs.utimesSync(path.dirname(live.documentPath), old, old);
  fs.utimesSync(path.dirname(orphan.documentPath), old, old);
  await sweepOrphanHandovers(f.userData, new Set([live.id]));
  expect(fs.existsSync(live.documentPath)).toBe(true);
  expect(fs.existsSync(orphan.documentPath)).toBe(false);
});

it('忙碌或无历史时拒绝创建，不用空文档假装交接', async () => {
  const f = fixture();
  await expect(prepareCanvasHandover(f.ctx, f.source, f.userData)).rejects.toThrow(/没有可交接/);
  f.ctx.agentSessions.getHistory = () => ({ messages: [{ id: 'u', role: 'user', ts: 1, parts: [{ kind: 'text', text: 'x' }] }], busy: true });
  await expect(prepareCanvasHandover(f.ctx, f.source, f.userData)).rejects.toThrow(/正在回复/);
  expect(existingHandoverDirectory(f.userData, '22222222-2222-4222-8222-222222222222')).toBeUndefined();
});

it('Claude CLI 读取原生记录，损坏或缺失时明确失败', async () => {
  const f = fixture('claude-code');
  const original = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(f.root, 'claude');
  try {
    const source = { ...f.source, externalSessionId: '33333333-3333-4333-8333-333333333333' };
    const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', path.resolve(f.cwd).replace(/[^a-zA-Z0-9-]/g, '-'), `${source.externalSessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [JSON.stringify({ type: 'user', message: { content: '原始任务' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '原始回复' },
        { type: 'tool_use', id: 'tool-a', name: 'Read', input: { path: 'example.ts' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-a', content: '原生工具结果标记' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '最终回复' }] } })].join('\n'));
    const draft = await prepareCanvasHandover(f.ctx, source, f.userData);
    const doc = fs.readFileSync(draft.documentPath, 'utf8');
    expect(doc).toContain('原始任务'); expect(doc).toContain('原始回复'); expect(doc).toContain('最终回复');
    expect(draft.lockedTask).toContain('共 1 轮，包含 1 条用户消息、2 条助手消息和 1 次工具调用');
    const lines = doc.split('\n');
    const body = draft.lockedTask.match(/沟通正文：第 (\d+)–(\d+) 行/)!;
    const tool = draft.lockedTask.match(/工具调用附录：第 (\d+)–(\d+) 行/)!;
    const native = draft.lockedTask.match(/原生记录附录：第 (\d+)–(\d+) 行/)!;
    expect(lines.slice(Number(body[1]) - 1, Number(body[2])).join('\n')).not.toContain('原生工具结果标记');
    expect(lines.slice(Number(tool[1]) - 1, Number(tool[2])).join('\n')).toContain('原生工具结果标记');
    expect(lines[Number(native[1]) - 1]).toBe('# 附录：原生记录');
    expect(Number(tool[1])).toBeGreaterThan(Number(native[2]));
    fs.appendFileSync(file, '\n{bad');
    await expect(prepareCanvasHandover(f.ctx, source, f.userData)).rejects.toThrow(/无法解析/);
    fs.unlinkSync(file);
    await expect(prepareCanvasHandover(f.ctx, source, f.userData)).rejects.toThrow(/无法读取/);
  } finally { if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = original; }
});
