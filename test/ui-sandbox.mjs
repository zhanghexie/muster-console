/**
 * 基于固定沙箱测试仓库的自动化 UI / 功能测试套件。
 * 验证：
 *   1. demo-playground 全格式文件与多媒体预览资产（HTML, PDF, WebM, WAV, SVG, Markdown, TS）
 *   2. 预设多会话管理与多样化业务胶囊状态 (active, done, waiting, error)
 *   3. 预设通知胶囊与通知中心联动
 *   4. Git 多分支与 Diff 还原
 *   5. 在线 CDP 自动化断言或离线基准校验
 */
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sandboxDir = path.join(repoRoot, '.dev-sandbox');
const workspacesDir = path.join(sandboxDir, 'workspaces');
const userDataDir = path.join(sandboxDir, 'userData');

// 1. 前置重置沙箱
console.log('=== [UI Sandbox Test] 1. 前置重置沙箱仓库 ===');
execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'reset-dev-sandbox.mjs')], {
  stdio: 'inherit'
});

const CDP_BASE = 'http://127.0.0.1:9222';
let msgId = 0;
let ws;
const pending = new Map();

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expression, { awaitPromise = true } = {}) {
  const r = await rpc('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true
  });
  if (r.exceptionDetails) {
    throw new Error(
      `evaluate 异常: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description ?? '')}`
    );
  }
  return r.result?.value;
}

async function runCdpTests() {
  const listRes = await fetch(`${CDP_BASE}/json/list`);
  const targets = await listRes.json();
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
  if (!page) throw new Error('未找到应用页面 target');

  ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  await rpc('Runtime.enable');

  console.log('=== [UI Sandbox Test] 2. 运行 CDP UI 自动化断言 ===');

  // 断言 1: 沙箱模式已在渲染层就绪
  const sandboxInfo = await evalJs('window.api.sandbox.getInfo()');
  assert.ok(sandboxInfo?.enabled, '渲染层必须处于沙箱模式');
  console.log('PASS: 渲染层识别沙箱环境成功:', sandboxInfo.rootDir);

  // 断言 2: 工作区列表包含 3 个固定测试仓库
  const wsList = await evalJs('window.api.workspaces.list()');
  assert.ok(Array.isArray(wsList.workspaces) && wsList.workspaces.length >= 3, '工作区列表必须包含测试仓库');
  const ids = wsList.workspaces.map((w) => w.id);
  assert.ok(ids.includes('demo-playground'), '包含 demo-playground');
  assert.ok(ids.includes('demo-frontend'), '包含 demo-frontend');
  assert.ok(ids.includes('demo-backend'), '包含 demo-backend');
  if (ids.includes('metaworldmobile')) {
    console.log('PASS: 包含真实复杂测试项目 metaworldmobile');
  }
  console.log('PASS: 工作区列表断言成功 (测试仓库均在列表中)');

  // 断言 3: 切换到 demo-frontend 工作区并读取 Git 分支
  const switchRes = await evalJs('window.api.workspaces.switch("demo-frontend")');
  assert.ok(switchRes.ok, '切换到 demo-frontend 必须成功');
  assert.equal(switchRes.activeWorkspaceId, 'demo-frontend');

  const frontendWs = wsList.workspaces.find((w) => w.id === 'demo-frontend');
  const branchesRes = await evalJs(`window.api.git.listBranches(${JSON.stringify(frontendWs.path)})`);
  // GitBranchList 形状：{current, local[], remote[]}（无 ok 字段；失败会 reject）
  assert.ok(branchesRes && branchesRes.current, '读取分支必须成功');
  const branchNames = branchesRes.local.map((b) => b.name);
  assert.ok(branchNames.includes('main'), '包含 main 分支');
  assert.ok(branchNames.includes('feature/dark-mode'), '包含 feature/dark-mode 分支');
  console.log('PASS: Git 分支列表断言成功:', branchNames);

  // 断言 4: 切换到 demo-playground 并验证文件系统与富媒体支持
  await evalJs(`window.api.workspaces.switch("demo-playground")`);

  const readTs = await evalJs('window.api.fs.readText("demo-playground", "src/index.ts")');
  assert.ok(readTs.ok && readTs.content.includes('runDemo'), '读取 TS 源码成功');

  const readHtml = await evalJs('window.api.fs.readText("demo-playground", "docs/dashboard.html")');
  assert.ok(readHtml.ok && readHtml.content.includes('canvas'), '读取 HTML 仪表盘成功');

  const statPdf = await evalJs('window.api.fs.stat("demo-playground", "docs/architecture-report.pdf")');
  assert.ok(statPdf.ok && statPdf.isFile && statPdf.size > 0, 'PDF 文件存在且有效');

  const statVideo = await evalJs('window.api.fs.stat("demo-playground", "assets/demo-screencast.webm")');
  assert.ok(statVideo.ok && statVideo.isFile && statVideo.size > 0, 'WebM 视频文件存在且有效');

  const statAudio = await evalJs('window.api.fs.stat("demo-playground", "assets/notification-chime.wav")');
  assert.ok(statAudio.ok && statAudio.isFile && statAudio.size > 0, 'WAV 音频文件存在且有效');

  const statSvg = await evalJs('window.api.fs.stat("demo-playground", "assets/workbench-architecture.svg")');
  assert.ok(statSvg.ok && statSvg.isFile && statSvg.size > 0, 'SVG 矢量图存在且有效');

  console.log('PASS: demo-playground 多格式文件与富媒体资产验证通过');

  // 断言 5: 验证多会话管理与多样化胶囊状态
  const sessionListRes = await evalJs('window.api.sessions.list()');
  const sessions = sessionListRes.sessions;
  assert.ok(Array.isArray(sessions) && sessions.length >= 4, '必须包含至少 4 个预设会话');
  const sessionLabels = sessions.map((s) => s.liveStatus?.kind);
  assert.ok(sessionLabels.includes('active'), '包含 active 状态胶囊会话');
  assert.ok(sessionLabels.includes('done'), '包含 done 状态胶囊会话');
  assert.ok(sessionLabels.includes('waiting'), '包含 waiting 状态胶囊会话');
  assert.ok(sessionLabels.includes('error'), '包含 error 状态胶囊会话');
  console.log('PASS: 多会话管理与业务胶囊状态验证通过:', sessionLabels);

  // 断言 6: 写入脏数据并执行一键沙箱重置
  await evalJs(`window.api.fs.writeText("demo-playground", "src/index.ts", "// dirty test data")`);
  const readDirty = await evalJs(`window.api.fs.readText("demo-playground", "src/index.ts")`);
  assert.equal(readDirty.content, '// dirty test data');

  const resetRes = await evalJs('window.api.sandbox.reset({ cleanWorkspaces: true })');
  assert.ok(resetRes.ok, '沙箱重置必须成功');

  const readRestored = await evalJs(`window.api.fs.readText("demo-playground", "src/index.ts")`);
  assert.ok(readRestored.content.includes('runDemo'), '重置后文件已成功恢复初始基准');
  console.log('PASS: 沙箱一键重置与文件基准还原断言成功');

  ws.close();
}

async function runOfflineAssertions() {
  console.log('=== [UI Sandbox Test] 2. 运行离线沙箱基准断言 ===');
  const pgDir = path.join(workspacesDir, 'demo-playground');
  const feDir = path.join(workspacesDir, 'demo-frontend');
  const beDir = path.join(workspacesDir, 'demo-backend');

  // 1. 目录存在性
  assert.ok(fs.existsSync(pgDir), 'demo-playground 目录存在');
  assert.ok(fs.existsSync(feDir), 'demo-frontend 目录存在');
  assert.ok(fs.existsSync(beDir), 'demo-backend 目录存在');

  // 2. Git 存在性
  assert.ok(fs.existsSync(path.join(pgDir, '.git')), 'playground git 存在');
  assert.ok(fs.existsSync(path.join(feDir, '.git')), 'frontend git 存在');
  assert.ok(fs.existsSync(path.join(beDir, '.git')), 'backend git 存在');

  // 3. demo-playground 富媒体资产断言
  const htmlContent = fs.readFileSync(path.join(pgDir, 'docs/dashboard.html'), 'utf-8');
  assert.ok(htmlContent.includes('canvas') && htmlContent.includes('MetaAgent'), 'HTML 仪表盘内容完整');

  const pdfBuf = fs.readFileSync(path.join(pgDir, 'docs/architecture-report.pdf'));
  assert.ok(pdfBuf.toString('ascii', 0, 8).startsWith('%PDF-1.4'), 'PDF 文件头合法');

  const wavBuf = fs.readFileSync(path.join(pgDir, 'assets/notification-chime.wav'));
  assert.ok(wavBuf.toString('ascii', 0, 4) === 'RIFF' && wavBuf.toString('ascii', 8, 12) === 'WAVE', 'WAV 文件头合法');

  const webmBuf = fs.readFileSync(path.join(pgDir, 'assets/demo-screencast.webm'));
  assert.ok(webmBuf.length > 100, 'WebM 视频非空且有效');

  const svgContent = fs.readFileSync(path.join(pgDir, 'assets/workbench-architecture.svg'), 'utf-8');
  assert.ok(svgContent.includes('<svg') && svgContent.includes('虚拟屏'), 'SVG 架构图内容完整');

  const guideContent = fs.readFileSync(path.join(pgDir, 'docs/features-guide.md'), 'utf-8');
  assert.ok(guideContent.includes('虚拟屏') && guideContent.includes('大爆炸') && guideContent.includes('右键识屏'), '特性指南完整');

  // 4. 预设会话与通知断言
  const sessions = JSON.parse(fs.readFileSync(path.join(userDataDir, 'sessions.json'), 'utf-8'));
  assert.ok(Array.isArray(sessions) && sessions.length >= 4, '预设会话数量 >= 4');
  const kinds = sessions.map((s) => s.liveStatus?.kind);
  assert.ok(kinds.includes('active') && kinds.includes('done') && kinds.includes('waiting') && kinds.includes('error'), '胶囊状态覆盖完整');

  const notifies = JSON.parse(fs.readFileSync(path.join(userDataDir, 'workspace-notifies.json'), 'utf-8'));
  assert.ok(Array.isArray(notifies['demo-playground']) && notifies['demo-playground'].length >= 3, '通知胶囊列表完整');

  console.log('PASS: 3 个固定测试仓库、全格式富媒体、多会话与通知胶囊离线校验全部通过！');
  console.log('提示: 启动带 --remote-debugging-port=9222 的应用后运行 npm run test:ui 可执行完整 CDP UI 交互测试。');
}

async function main() {
  try {
    const listRes = await fetch(`${CDP_BASE}/json/list`).catch(() => null);
    if (listRes && listRes.ok) {
      await runCdpTests();
    } else {
      await runOfflineAssertions();
    }
  } catch (err) {
    console.error('FAIL ui-sandbox:', err);
    process.exit(1);
  }
}

main();
