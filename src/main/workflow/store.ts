/**
 * 工作流定义发现与 run 记录持久化（dynamic-workflow W1）。
 * 定义：`.muster/workflows/<name>/WORKFLOW.md + run.mjs`（进仓，人和调度都能写）。
 * run 记录：`.muster/scheduler/workflow-runs/<runId>.json`（本机状态，scheduler/ 已被 gitignore）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../atomicJson';
import {
  parseWorkflowDoc,
  parseWorkflowRunRecord,
  parseWorkflowTriggerState,
  WORKFLOW_DOC_FILE,
  WORKFLOW_NAME_RE,
  WORKFLOW_RUNS_DIR,
  WORKFLOW_SCRIPT_FILE,
  WORKFLOW_TRIGGER_STATE_FILE,
  WORKFLOWS_DIR,
  type WorkflowDef,
  type WorkflowRunRecord,
  type WorkflowTriggerState
} from '../../shared/workflow';

function relToAbs(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

export function workflowsDir(root: string): string {
  return relToAbs(root, WORKFLOWS_DIR);
}

export function workflowRunsDir(root: string): string {
  return relToAbs(root, WORKFLOW_RUNS_DIR);
}

/** Independent failure record: overrides an older runnable checkpoint after a failed write. */
function workflowFailuresDir(root: string): string {
  return path.join(path.dirname(workflowRunsDir(root)), 'workflow-failures');
}

export function writeRunFailure(root: string, rec: WorkflowRunRecord): void {
  writeJsonAtomicSync(path.join(workflowFailuresDir(root), `${rec.runId}.json`), rec);
}

export interface LoadedWorkflow {
  name: string;
  dir: string;
  docPath: string;
  scriptPath: string;
  def?: WorkflowDef;
  /** WORKFLOW.md + run.mjs 的内容指纹（sha256 前 16 位）；文件缺失时为空串 */
  fingerprint: string;
  errors: string[];
  warnings: string[];
}

export function workflowFingerprint(doc: string, script: string): string {
  return createHash('sha256').update(doc).update('\0').update(script).digest('hex').slice(0, 16);
}

export function loadWorkflow(root: string, name: string): LoadedWorkflow {
  const dir = path.join(workflowsDir(root), name);
  const docPath = path.join(dir, WORKFLOW_DOC_FILE);
  const scriptPath = path.join(dir, WORKFLOW_SCRIPT_FILE);
  const base: LoadedWorkflow = { name, dir, docPath, scriptPath, fingerprint: '', errors: [], warnings: [] };
  if (!WORKFLOW_NAME_RE.test(name)) {
    return { ...base, errors: [`工作流名「${name}」不合法（小写字母、数字、连字符）`] };
  }
  let doc: string;
  let script: string;
  try {
    doc = fs.readFileSync(docPath, 'utf8');
  } catch {
    return { ...base, errors: [`找不到 ${WORKFLOWS_DIR}/${name}/${WORKFLOW_DOC_FILE}`] };
  }
  try {
    script = fs.readFileSync(scriptPath, 'utf8');
  } catch {
    return { ...base, errors: [`找不到 ${WORKFLOWS_DIR}/${name}/${WORKFLOW_SCRIPT_FILE}`] };
  }
  const parsed = parseWorkflowDoc(doc, name);
  return {
    ...base,
    fingerprint: workflowFingerprint(doc, script),
    ...(parsed.def ? { def: parsed.def } : {}),
    errors: parsed.errors,
    warnings: parsed.warnings
  };
}

/** 扫描工作流目录：每个含 WORKFLOW.md 的子目录一条（坏定义也列出，带 errors） */
export function listWorkflows(root: string): LoadedWorkflow[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workflowsDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(workflowsDir(root), e.name, WORKFLOW_DOC_FILE)))
    .map((e) => loadWorkflow(root, e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function writeRunRecord(root: string, rec: WorkflowRunRecord): void {
  writeJsonAtomicSync(path.join(workflowRunsDir(root), `${rec.runId}.json`), rec);
}

export function readRunRecord(root: string, runId: string): WorkflowRunRecord | null {
  if (!/^[\w-]+$/.test(runId)) return null;
  try {
    const failed = parseWorkflowRunRecord(fs.readFileSync(path.join(workflowFailuresDir(root), `${runId}.json`), 'utf8'));
    if (failed?.status === 'failed') return failed;
  } catch { /* no independent failure record */ }
  try {
    return parseWorkflowRunRecord(fs.readFileSync(path.join(workflowRunsDir(root), `${runId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function listRunRecords(root: string): WorkflowRunRecord[] {
  const names = new Set<string>();
  for (const dir of [workflowRunsDir(root), workflowFailuresDir(root)]) {
    try {
      for (const name of fs.readdirSync(dir)) if (name.endsWith('.json')) names.add(name);
    } catch { /* a new workspace may not have either directory */ }
  }
  const out: WorkflowRunRecord[] = [];
  for (const n of names) {
    const rec = readRunRecord(root, n.slice(0, -5));
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export function deleteRunRecord(root: string, runId: string): void {
  if (!/^[\w-]+$/.test(runId)) return;
  // Remove the stale runnable checkpoint before its failure override.
  for (const dir of [workflowRunsDir(root), workflowFailuresDir(root)]) {
    try {
      fs.unlinkSync(path.join(dir, `${runId}.json`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

export function readTriggerState(root: string): WorkflowTriggerState {
  const file = relToAbs(root, WORKFLOW_TRIGGER_STATE_FILE);
  try {
    // X3-F11：JSON.parse 提到读侧，损坏（坏 JSON）与 fs 错误都能在这一个 catch 留诊断
    // 线索（parseWorkflowTriggerState 会静默吞掉坏 JSON 回 {}）；ENOENT=新工作区正常态
    return parseWorkflowTriggerState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `[workflow] 触发状态文件损坏/不可读，按空触发状态起步：${file}`,
        err instanceof Error ? err.message : err
      );
    }
    return {};
  }
}

export function writeTriggerState(root: string, state: WorkflowTriggerState): void {
  writeJsonAtomicSync(relToAbs(root, WORKFLOW_TRIGGER_STATE_FILE), state);
}
