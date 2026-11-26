/**
 * scheduler.memory 工具面退役收口测试（2026-10-26 F-01/F-03 随可靠性专项改写）：
 * - scheduler.memory.write 工具已退役（已移除注册与宿主；本测试
 *   原断言其在册——因引用已删除的 hosts/schedulerMemory.ts 长期转红，随直写通道
 *   退役一并收口）：catalog 不再注册；宿主/落盘层源文件不存在（还原即红：恢复任一
 *   文件或注册即转红）；
 * - MEMORY.md 直写通道退役：memory/directWrite.ts、memory/noteTools.ts 已删除
 *   （remember 生产路径=knowledgeTools.rememberKnowledge → 类型化知识库候选）；
 * - memory.note / memory.remember 仍在册（写入统一走类型化知识库候选）；
 * - Worker 白名单族不含 scheduler.memory.* 前缀工具。
 * 运行: node test/scheduler-memory-tools.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-mem-tools-'));
const compile = createSharedCompiler(root, tmp);

const catalog = await import(pathToFileURL(compile('main/capabilities/catalog.ts')).href);
const hostToolsMeta = await import(pathToFileURL(compile('shared/hostTools/meta.ts')).href);

// ---------- 1) Catalog：scheduler.memory.write 已退役；memory.note/remember 保留 ----------
{
  assert.equal(catalog.getToolDef('scheduler.memory.write'), undefined, 'scheduler.memory.write 已退役（不再注册）');
  assert.equal(catalog.getToolDef('scheduler.memory.append'), undefined, 'scheduler.memory.append 保持退役');
  assert.equal(catalog.getToolDef('memory.append'), undefined, 'memory.append 保持退役');
  assert.equal(catalog.getToolDef('memory.remove'), undefined, 'memory.remove 保持退役');
  assert.ok(catalog.getToolDef('memory.list'), 'memory.list 保留（读面）');
  assert.ok(catalog.getToolDef('memory.search'), 'memory.search 保留（读面）');
  assert.ok(catalog.getToolDef('memory.note'), 'memory.note 保留（常规写→候选）');
  assert.ok(catalog.getToolDef('memory.remember'), 'memory.remember 保留（明示写→候选）');
  const [verMaj, verMin] = catalog.CATALOG_VERSION.split('.').map(Number);
  assert.ok(verMaj > 1 || verMin >= 39, `catalog 版本地板（≥1.39，当前 ${catalog.CATALOG_VERSION}）`);
  console.log('ok: catalog 退役收口');
}

// ---------- 2) 退役文件不存在（还原即红：恢复直写通道任一源文件即转红） ----------
{
  const gone = [
    'src/main/capabilities/hosts/schedulerMemory.ts', // scheduler.memory.write 宿主
    'src/main/memory/schedulerCurated.ts',            // write 工具落盘层
    'src/main/memory/directWrite.ts',                 // MEMORY.md 直写门
    'src/main/memory/noteTools.ts'                    // 旧 runMemoryRemember/Note handler
  ];
  for (const rel of gone) {
    assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} 已随直写通道退役删除`);
  }
  console.log('ok: 直写通道源文件退役');
}

// ---------- 3) Worker 不可见：不在任何 Worker 白名单 ----------
{
  assert.equal(catalog.WORKER_TOOL_ALLOWLIST.includes('scheduler.memory.write'), false);
  assert.equal(catalog.EXTENSION_HOST_TOOLS.includes('scheduler.memory.write'), false);
  const hostLists = [
    ...(hostToolsMeta.HOST_STATUS_TOOL_IDS ?? []),
    ...(hostToolsMeta.HOST_OBSERVE_TOOL_IDS ?? []),
    ...(hostToolsMeta.HOST_SHARE_TOOL_IDS ?? []),
    ...(hostToolsMeta.HOST_AGENT_TASK_TOOL_IDS ?? [])
  ];
  for (const id of hostLists) {
    assert.ok(typeof id === 'string' && !id.startsWith('scheduler.memory'), `GUI 宿主工具面不含 scheduler.memory（${id}）`);
  }
  console.log('ok: Worker 白名单不可见');
}

console.log('scheduler-memory-tools: all ok');
