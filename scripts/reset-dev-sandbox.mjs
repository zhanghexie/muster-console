/**
 * 一键重置开发沙箱环境（优先从 .dev-sandbox-template 快照还原，无模板时代码兜底）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sandboxDir = path.join(repoRoot, '.dev-sandbox');
const tplDir = path.join(repoRoot, '.dev-sandbox-template');
const workspacesDir = path.join(sandboxDir, 'workspaces');
const userDataDir = path.join(sandboxDir, 'userData');

const tplWorkspacesDir = path.join(tplDir, 'workspaces');
const tplUserDataDir = path.join(tplDir, 'userData');

console.log('[reset-sandbox] 正在重置开发沙箱...');

fs.mkdirSync(workspacesDir, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });

function copyDirectorySync(src, dest, ignoreNames) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoreNames && ignoreNames.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectorySync(srcPath, destPath, ignoreNames);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 检查是否存在用户自定义的快照模板
const hasTemplate = fs.existsSync(tplDir) && fs.existsSync(tplWorkspacesDir);

if (hasTemplate) {
  console.log(`[reset-sandbox] 🎯 发现基准快照模板 (.dev-sandbox-template)，正在 1:1 还原...`);

  // 1. 还原工作区目录
  const internalWorkspaces = ['demo-playground', 'demo-frontend', 'demo-backend'];
  for (const name of internalWorkspaces) {
    const srcWs = path.join(tplWorkspacesDir, name);
    const destWs = path.join(workspacesDir, name);
    if (fs.existsSync(destWs)) {
      fs.rmSync(destWs, { recursive: true, force: true });
    }
    if (fs.existsSync(srcWs)) {
      copyDirectorySync(srcWs, destWs);
      console.log(`  - 已还原工作区: ${name}`);
    }
  }

  // 2. 还原会话与通知文件
  const keyFiles = ['sessions.json', 'workspace-notifies.json', 'prompt-tasks.json', 'config.json'];
  for (const file of keyFiles) {
    const srcFile = path.join(tplUserDataDir, file);
    const destFile = path.join(userDataDir, file);
    if (fs.existsSync(srcFile)) {
      fs.copyFileSync(srcFile, destFile);
      console.log(`  - 已还原配置文件: ${file}`);
    }
  }

  // 3. 确保 config.json 中保留外部大型项目 (metaworldmobile)
  const configPath = path.join(userDataDir, 'config.json');
  const mobileCandidate = process.env.MUSTER_DEV_MOBILE_WS?.trim() && path.resolve(process.env.MUSTER_DEV_MOBILE_WS.trim());
  if (fs.existsSync(configPath) && fs.existsSync(mobileCandidate)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (Array.isArray(cfg.workspaces) && !cfg.workspaces.some((w) => w.id === 'metaworldmobile')) {
        cfg.workspaces.push({
          id: 'metaworldmobile',
          name: 'MetaWorld Mobile (移动端工程)',
          path: mobileCandidate,
          avatar: '📱',
          openedAt: 1700000004000
        });
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
      }
    } catch {
      /* ignore */
    }
  }

  console.log('[reset-sandbox] ✅ 已成功从快照模板还原至基准状态！');
  process.exit(0);
}

// 若无模板，走代码兜底生成
console.log('[reset-sandbox] 未发现快照模板，使用代码兜底生成 3 个初始测试仓库...');

function runGit(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }).trim();
  } catch (err) {
    const msg = err.stderr || err.message || String(err);
    console.warn(`[reset-sandbox:git] git ${args.join(' ')} failed in ${cwd}:`, msg);
    return '';
  }
}

function writeFiles(baseDir, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(baseDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(fullPath, content);
    } else {
      fs.writeFileSync(fullPath, content, 'utf-8');
    }
  }
}

function buildSamplePdf() {
  const text = `BT
/F1 18 Tf
50 760 Td
(Muster Workbench - Architecture & Feature Report) Tj
0 -36 Td
/F1 11 Tf
(1. Virtual Screen: Seamless horizontal sliding between Terminal and Git Panel) Tj
0 -22 Td
(2. Terminal Bang & Selection Recognition: Instant file recognition and jump-to-editor) Tj
0 -22 Td
(3. Multi-Session Management: Live status capsules, pinned items, background tasks) Tj
0 -22 Td
(4. Workspace Notification Center: Real-time progress updates & alert capsules) Tj
0 -22 Td
(5. Rich File Previews: Native support for HTML, PDF, Video, Audio, and SVG) Tj
0 -36 Td
/F1 12 Tf
(Status: Verified and Ready for Live Demonstration) Tj
ET`;
  const streamLen = Buffer.byteLength(text);
  const pdfStr = `%PDF-1.4
1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj
2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj
3 0 obj <</Type /Page /Parent 2 0 R /Resources <</Font <</F1 4 0 R>>>> /MediaBox [0 0 595 842] /Contents 5 0 R>> endobj
4 0 obj <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>> endobj
5 0 obj <</Length ${streamLen}>> stream
${text}
endstream endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000222 00000 n 
0000000299 00000 n 
trailer <</Size 6 /Root 1 0 R>>
startxref
${400 + streamLen}
%%EOF`;
  return Buffer.from(pdfStr);
}

function buildSampleWav() {
  const sampleRate = 8000;
  const duration = 0.5;
  const numSamples = Math.floor(sampleRate * duration);
  const buf = Buffer.alloc(44 + numSamples);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + numSamples, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate, 28);
  buf.writeUInt16LE(1, 32);
  buf.writeUInt16LE(8, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(numSamples, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const val = Math.floor(128 + 110 * Math.sin(2 * Math.PI * 520 * t) * Math.exp(-2.5 * t));
    buf.writeUInt8(val, 44 + i);
  }
  return buf;
}

function buildSampleWebm() {
  const base64 =
    'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJ8gijxgQAAAG11eHB1dAMAAAAAABGcqE2AQlmuAQAAAAAAAFpggkCKgURheGlzX1dvcmsAZWJtYXBwAIdEb2N1bWVudAAWZWJtYXBwAGFubm90YXRpb25zAAAZG5tAQCBAAAAAAABVoIEeIQBUq4EBAAAAAAAAM2eBA4EAq4EEgQSpAQAAAAAAAEtngQCvgQSpAQAAAAAAAE1ngQGvAQAAAAAAAFhngQLngQCvgQSpAQAAAAAAAEtngQCvgQSpAQAAAAAAAE1ngQGvAQAAAAAAAFhngQLn';
  return Buffer.from(base64, 'base64');
}

function buildSamplePng() {
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPjfDwAEeQHzE1LqjQAAAABJRU5ErkJggg==';
  return Buffer.from(base64, 'base64');
}

function buildSampleSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 500" width="100%" height="100%">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
  </defs>

  <rect width="900" height="500" rx="16" fill="url(#bgGrad)" stroke="#334155" stroke-width="2"/>
  
  <text x="50" y="55" font-family="system-ui, sans-serif" font-size="22" font-weight="700" fill="#f8fafc">
    Muster 工作台核心架构与功能矩阵
  </text>
  <text x="50" y="85" font-family="system-ui, sans-serif" font-size="13" fill="#94a3b8">
    三栏布局 · 虚拟屏横向切换 · 选区大爆炸 · 右键识屏 · 通知胶囊 · 富媒体实时预览
  </text>
</svg>`;
}

function buildSampleHtmlDashboard() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Muster 实时监控仪表盘</title>
</head>
<body>
  <h1>Muster Dashboard</h1>
  <canvas id="chart"></canvas>
</body>
</html>`;
}

function seedRepo(repoDir, files, commitMsg, extraBranch, uncommittedModifications) {
  if (fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
  fs.mkdirSync(repoDir, { recursive: true });
  writeFiles(repoDir, files);

  runGit(repoDir, ['init', '-b', 'main']);
  runGit(repoDir, ['config', 'user.name', 'Muster Demo']);
  runGit(repoDir, ['config', 'user.email', 'demo@muster.local']);
  runGit(repoDir, ['add', '.']);
  runGit(repoDir, ['commit', '-m', commitMsg]);

  if (extraBranch) {
    runGit(repoDir, ['checkout', '-b', extraBranch.branchName]);
    writeFiles(repoDir, extraBranch.files);
    runGit(repoDir, ['add', '.']);
    runGit(repoDir, ['commit', '-m', extraBranch.commitMsg]);
    runGit(repoDir, ['checkout', 'main']);
  }

  if (uncommittedModifications) {
    writeFiles(repoDir, uncommittedModifications);
  }
}

// 1. demo-playground
seedRepo(
  path.join(workspacesDir, 'demo-playground'),
  {
    'package.json': JSON.stringify(
      {
        name: 'demo-playground',
        version: '1.2.0',
        description: 'Muster 工作台全功能特性演练与实操游乐场'
      },
      null,
      2
    ),
    'src/index.ts': `export function runDemo(name: string): string {\n  return \`Welcome \${name}! Muster features are ready.\`;\n}\n\nrunDemo('Muster Developer');\n`,
    'docs/dashboard.html': buildSampleHtmlDashboard(),
    'docs/architecture-report.pdf': buildSamplePdf(),
    'assets/demo-screencast.webm': buildSampleWebm(),
    'assets/notification-chime.wav': buildSampleWav(),
    'assets/logo.png': buildSamplePng(),
    'assets/workbench-architecture.svg': buildSampleSvg(),
    'docs/features-guide.md': `# Muster 工作台特色功能演示指南\n\n虚拟屏、选区大爆炸、右键识屏、多会话管理与通知胶囊演示指南。\n`,
    '.muster/workspace.json': JSON.stringify({ statusVocabulary: ['待办', '进行中', '已完成'] }, null, 2),
    'README.md': `# Muster Demo Playground\n`
  },
  'feat: initial demo playground with full feature assets'
);

// 2. demo-frontend
seedRepo(
  path.join(workspacesDir, 'demo-frontend'),
  {
    'package.json': JSON.stringify({ name: 'demo-frontend', version: '0.1.0' }, null, 2),
    'src/App.tsx': `export function App() { return <div>Frontend</div>; }\n`,
    'README.md': `# Demo Frontend\n`
  },
  'feat: initial frontend',
  {
    branchName: 'feature/dark-mode',
    files: { 'src/App.tsx': `export function App() { return <div>Dark Mode</div>; }\n` },
    commitMsg: 'feat: dark mode'
  }
);

// 3. demo-backend
seedRepo(
  path.join(workspacesDir, 'demo-backend'),
  {
    'package.json': JSON.stringify({ name: 'demo-backend', version: '1.0.0' }, null, 2),
    'src/server.ts': `export function start() {}\n`,
    'README.md': `# Demo Backend\n`
  },
  'feat: initial backend'
);

// 4. 初始化代码兜底会话列表 (sessions.json)
const now = Date.now();
const pgPath = path.resolve(workspacesDir, 'demo-playground');

const presetSessions = [
  {
    id: 'demo-session-watch',
    type: 'terminal',
    name: '⚡ 编译与热重载 (Watch)',
    createdAt: now - 3600000,
    lastUsedAt: now,
    workspaceId: 'demo-playground',
    cwd: pgPath,
    launchKind: 'agent',
    runtime: 'cursor-cli',
    externalSessionId: 'ses_watch_01',
    status: 'idle',
    lifecycle: 'working',
    pinned: true,
    pinnedAt: now - 3600000,
    liveStatus: {
      label: '监听中 · 0 错误',
      kind: 'active',
      ts: now
    }
  },
  {
    id: 'demo-session-review',
    type: 'terminal',
    name: '🔍 智能代码审查 (Review)',
    createdAt: now - 1800000,
    lastUsedAt: now - 600000,
    workspaceId: 'demo-playground',
    cwd: pgPath,
    launchKind: 'agent',
    runtime: 'claude-code',
    externalSessionId: 'ses_review_02',
    status: 'idle',
    lifecycle: 'idle',
    liveStatus: {
      label: '审查通过 · 0 缺陷',
      kind: 'done',
      ts: now - 600000
    }
  },
  {
    id: 'demo-session-build',
    type: 'terminal',
    name: '📦 构建发布流水线 (Build)',
    createdAt: now - 900000,
    lastUsedAt: now - 300000,
    workspaceId: 'demo-playground',
    cwd: pgPath,
    launchKind: 'agent',
    runtime: 'cursor-cli',
    externalSessionId: 'ses_build_03',
    status: 'idle',
    lifecycle: 'blocked',
    liveStatus: {
      label: '等待确认发布',
      kind: 'waiting',
      ts: now - 300000
    }
  },
  {
    id: 'demo-session-debug',
    type: 'terminal',
    name: '🛑 端口占用检测 (Debug)',
    createdAt: now - 300000,
    lastUsedAt: now - 100000,
    workspaceId: 'demo-playground',
    cwd: pgPath,
    launchKind: 'agent',
    runtime: 'opencode',
    externalSessionId: 'ses_debug_04',
    status: 'exited',
    lifecycle: 'exited',
    liveStatus: {
      label: 'Port 8080 busy',
      kind: 'error',
      ts: now - 100000
    }
  }
];

fs.writeFileSync(path.join(userDataDir, 'sessions.json'), JSON.stringify(presetSessions, null, 2), 'utf-8');

// 5. 初始化代码兜底通知中心 (workspace-notifies.json)
const presetNotifies = {
  'demo-playground': [
    {
      id: 'notify-1',
      workspaceId: 'demo-playground',
      sessionId: 'demo-session-watch',
      sessionName: '⚡ 编译与热重载 (Watch)',
      ts: now - 120000,
      lifecycle: 'working',
      kind: 'active',
      text: '⚡ 编译与热重载 (Watch) · TypeScript 增量构建完成 (240ms)',
      updateKey: 'lifecycle:demo-session-watch'
    },
    {
      id: 'notify-2',
      workspaceId: 'demo-playground',
      sessionId: 'demo-session-build',
      sessionName: '📦 构建发布流水线 (Build)',
      ts: now - 300000,
      lifecycle: 'blocked',
      kind: 'waiting',
      text: '📦 构建发布流水线 (Build) · 产物已生成至 docs/dashboard.html',
      updateKey: 'lifecycle:demo-session-build'
    },
    {
      id: 'notify-3',
      workspaceId: 'demo-playground',
      sessionId: 'demo-session-debug',
      sessionName: '🛑 端口占用检测 (Debug)',
      ts: now - 100000,
      lifecycle: 'exited',
      kind: 'error',
      text: '🛑 端口占用检测 (Debug) · 检测到本地端口 8080 冲突',
      updateKey: 'lifecycle:demo-session-debug'
    }
  ]
};

fs.writeFileSync(path.join(userDataDir, 'workspace-notifies.json'), JSON.stringify(presetNotifies, null, 2), 'utf-8');

// 6. 初始化配置 (config.json)
const configPath = path.join(userDataDir, 'config.json');
let config = {
  workspaces: [
    {
      id: 'demo-playground',
      name: '演示-游乐场',
      path: path.resolve(workspacesDir, 'demo-playground'),
      avatar: '🎮',
      openedAt: 1700000000000
    },
    {
      id: 'demo-frontend',
      name: '演示-前端项目',
      path: path.resolve(workspacesDir, 'demo-frontend'),
      avatar: '⚛️',
      openedAt: 1700000001000
    },
    {
      id: 'demo-backend',
      name: '演示-后端服务',
      path: path.resolve(workspacesDir, 'demo-backend'),
      avatar: '⚙️',
      openedAt: 1700000002000
    }
  ],
  activeWorkspaceId: 'demo-playground',
  workspace: path.resolve(workspacesDir, 'demo-playground')
};

const mobileCandidate = process.env.MUSTER_DEV_MOBILE_WS?.trim() && path.resolve(process.env.MUSTER_DEV_MOBILE_WS.trim());
if (fs.existsSync(mobileCandidate)) {
  config.workspaces.push({
    id: 'metaworldmobile',
    name: 'MetaWorld Mobile (移动端工程)',
    path: mobileCandidate,
    avatar: '📱',
    openedAt: 1700000004000
  });
}

if (fs.existsSync(configPath)) {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cur = JSON.parse(raw);
    config = { ...cur, ...config, workspaces: config.workspaces };
  } catch {
    /* ignore */
  }
}
fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

console.log('[reset-sandbox] ✅ 开发沙箱代码兜底生成完成！');
