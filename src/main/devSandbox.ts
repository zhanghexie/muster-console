import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { needsSeedRepo, seedSingleRepo } from './devSandboxGit';
import { productUserDataPath } from './productStorage';
import { extensionTrialRoot } from './extensions/extensionTrialEnvironment';
import { PRODUCT_NAME, PRODUCT_NAME_ZH } from '../shared/productIdentity';
import type {
  AppConfig,
  McpConfig,
  SessionMeta,
  WorkspaceInfo
} from '../shared/types';

export interface DevSandboxInfo {
  enabled: boolean;
  rootDir: string;
  userDataDir: string;
  workspacesDir: string;
  templateDir: string;
  hasTemplate: boolean;
  workspaces: WorkspaceInfo[];
}

let sandboxState: DevSandboxInfo | null = null;
let originalUserDataPath: string | null = null;
let sandboxPaths: Omit<DevSandboxInfo, 'enabled' | 'hasTemplate' | 'workspaces'> | null = null;

type RemoveDirectorySync = (
  target: string,
  options: { recursive: true; force: true; maxRetries: number; retryDelay: number }
) => void;

type RenameDirectorySync = (source: string, destination: string) => void;

/** Windows 文件可能短暂被索引器或旧 Electron 子进程占用，删除目录时使用内建重试。 */
export function removeDevSandboxDirectorySync(
  target: string,
  remove: RemoveDirectorySync = fs.rmSync,
  rename: RenameDirectorySync = fs.renameSync
): void {
  const options = { recursive: true as const, force: true as const, maxRetries: 5, retryDelay: 100 };
  try {
    remove(target, options);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error;
    // Windows can keep a directory busy for a short period after an Electron
    // child exits. Rename first to release the destination path, then retry
    // removal. If the tombstone itself remains locked, the caller can continue
    // with a clean destination while the next sandbox cleanup removes it.
    const tombstone = `${target}.delete-${process.pid}-${Date.now()}`;
    try {
      rename(target, tombstone);
      try { remove(tombstone, options); }
      catch (cleanupError) {
        console.warn('[devSandbox] deferred locked directory cleanup:', tombstone, cleanupError);
      }
      return;
    } catch {
      throw error;
    }
  }
}

/** 探测是否处于开发沙箱环境 */
export function isDevSandboxEnabled(): boolean {
  if (process.env.MUSTER_NO_SANDBOX === '1') return false;
  if (process.env.MUSTER_SANDBOX === '1' || process.env.MUSTER_DEV === '1') return true;
  return !app.isPackaged || process.env.NODE_ENV === 'development';
}

/** 获得沙箱根目录（默认为项目根目录下的 .dev-sandbox） */
export function getDevSandboxRootDir(): string {
  const repoRoot = extensionTrialRoot() ?? (app.isPackaged ? path.dirname(app.getPath('exe')) : process.cwd());
  return path.resolve(repoRoot, '.dev-sandbox');
}

/** 获得沙箱基准快照模板目录（默认为项目根目录下的 .dev-sandbox-template） */
export function getDevSandboxTemplateDir(): string {
  const repoRoot = extensionTrialRoot() ?? (app.isPackaged ? path.dirname(app.getPath('exe')) : process.cwd());
  return path.resolve(repoRoot, '.dev-sandbox-template');
}

/** 是否存在用户保存的快照基准模板 */
export function hasDevSandboxTemplate(): boolean {
  const tplDir = getDevSandboxTemplateDir();
  const tplWorkspaces = path.join(tplDir, 'workspaces');
  return fs.existsSync(tplDir) && fs.existsSync(tplWorkspaces);
}

/** 获取演示与测试工作区的基准元信息 */
export function getSeedWorkspaceInfos(workspacesDir: string): WorkspaceInfo[] {
  const playgroundPath = path.resolve(workspacesDir, 'demo-playground');
  const frontendPath = path.resolve(workspacesDir, 'demo-frontend');
  const backendPath = path.resolve(workspacesDir, 'demo-backend');

  const list: WorkspaceInfo[] = [
    {
      id: 'demo-playground',
      name: '演示-游乐场',
      path: playgroundPath,
      avatar: '🎮',
      openedAt: 1700000000000
    },
    {
      id: 'demo-frontend',
      name: '演示-前端项目',
      path: frontendPath,
      avatar: '⚛️',
      openedAt: 1700000001000
    },
    {
      id: 'demo-backend',
      name: '演示-后端服务',
      path: backendPath,
      avatar: '⚙️',
      openedAt: 1700000002000
    }
  ];

  // 开发机个人工程的额外种子工作区：路径不入库，经环境变量注入（存在才收录）
  const mobileCandidate = process.env.MUSTER_DEV_MOBILE_WS?.trim();
  if (mobileCandidate && fs.existsSync(mobileCandidate)) {
    list.push({
      id: 'metaworldmobile',
      name: 'MetaWorld Mobile (移动端工程)',
      path: path.resolve(mobileCandidate),
      avatar: '📱',
      openedAt: 1700000004000
    });
  }

  return list;
}

/** 深度拷贝目录，忽略指定目录名称（如 node_modules） */
function copyDirectorySync(src: string, dest: string, ignoreNames?: Set<string>): void {
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

/** 生成合法的极简 PDF 报告文档 */
function buildSamplePdf(): Buffer {
  const text = `BT
/F1 18 Tf
50 760 Td
(Muster Console - Architecture & Feature Report) Tj
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

/** 生成合法的 WAV 提示音音频文件 */
function buildSampleWav(): Buffer {
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

/** 极简有效 WebM 视频 */
function buildSampleWebm(): Buffer {
  const base64 =
    'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJ8gijxgQAAAG11eHB1dAMAAAAAABGcqE2AQlmuAQAAAAAAAFpggkCKgURheGlzX1dvcmsAZWJtYXBwAIdEb2N1bWVudAAWZWJtYXBwAGFubm90YXRpb25zAAAZG5tAQCBAAAAAAABVoIEeIQBUq4EBAAAAAAAAM2eBA4EAq4EEgQSpAQAAAAAAAEtngQCvgQSpAQAAAAAAAE1ngQGvAQAAAAAAAFhngQLngQCvgQSpAQAAAAAAAEtngQCvgQSpAQAAAAAAAE1ngQGvAQAAAAAAAFhngQLn';
  return Buffer.from(base64, 'base64');
}

/** 极简有效 1x1 PNG 图像 */
function buildSamplePng(): Buffer {
  const base64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPjfDwAEeQHzE1LqjQAAAABJRU5ErkJggg==';
  return Buffer.from(base64, 'base64');
}

/** 生成科技感架构 SVG 矢量图 */
function buildSampleSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 500" width="100%" height="100%">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#020617"/>
    </linearGradient>
  </defs>

  <rect width="900" height="500" rx="16" fill="url(#bgGrad)" stroke="#334155" stroke-width="2"/>
  
  <text x="50" y="55" font-family="system-ui, sans-serif" font-size="22" font-weight="700" fill="#f8fafc">
    ${PRODUCT_NAME_ZH}核心架构与功能矩阵
  </text>
  <text x="50" y="85" font-family="system-ui, sans-serif" font-size="13" fill="#94a3b8">
    三栏布局 · 虚拟屏横向切换 · 选区大爆炸 · 右键识屏 · 通知胶囊 · 富媒体实时预览
  </text>

  <!-- Module 1: Left Sessions -->
  <g transform="translate(50, 120)">
    <rect width="240" height="320" rx="10" fill="#1e293b" stroke="#475569" stroke-width="1.5"/>
    <text x="20" y="35" font-family="system-ui, sans-serif" font-size="15" font-weight="600" fill="#38bdf8">1. 多会话与胶囊状态</text>
    <rect x="20" y="55" width="200" height="42" rx="6" fill="#0f172a" stroke="#334155"/>
    <text x="32" y="81" font-family="system-ui, sans-serif" font-size="12" fill="#e2e8f0">⚡ 编译与热重载</text>
    <rect x="150" y="66" width="60" height="20" rx="4" fill="#065f46"/>
    <text x="162" y="80" font-family="system-ui, sans-serif" font-size="10" fill="#34d399">active</text>

    <rect x="20" y="110" width="200" height="42" rx="6" fill="#0f172a" stroke="#334155"/>
    <text x="32" y="136" font-family="system-ui, sans-serif" font-size="12" fill="#e2e8f0">🔍 代码审查</text>
    <rect x="150" y="121" width="60" height="20" rx="4" fill="#1e3a8a"/>
    <text x="167" y="135" font-family="system-ui, sans-serif" font-size="10" fill="#60a5fa">done</text>

    <rect x="20" y="165" width="200" height="42" rx="6" fill="#0f172a" stroke="#334155"/>
    <text x="32" y="191" font-family="system-ui, sans-serif" font-size="12" fill="#e2e8f0">📦 构建发布</text>
    <rect x="150" y="176" width="60" height="20" rx="4" fill="#78350f"/>
    <text x="158" y="190" font-family="system-ui, sans-serif" font-size="10" fill="#f59e0b">waiting</text>

    <rect x="20" y="220" width="200" height="42" rx="6" fill="#0f172a" stroke="#334155"/>
    <text x="32" y="246" font-family="system-ui, sans-serif" font-size="12" fill="#e2e8f0">🛑 端口占用排查</text>
    <rect x="150" y="231" width="60" height="20" rx="4" fill="#881337"/>
    <text x="166" y="245" font-family="system-ui, sans-serif" font-size="10" fill="#f43f5e">error</text>
  </g>

  <!-- Module 2: Virtual Screen -->
  <g transform="translate(320, 120)">
    <rect width="260" height="320" rx="10" fill="#1e293b" stroke="#475569" stroke-width="1.5"/>
    <text x="20" y="35" font-family="system-ui, sans-serif" font-size="15" font-weight="600" fill="#818cf8">2. 虚拟屏交互</text>
    
    <rect x="20" y="55" width="220" height="110" rx="6" fill="#0f172a" stroke="#3b82f6" stroke-dasharray="4 2"/>
    <text x="30" y="85" font-family="monospace" font-size="11" fill="#38bdf8">> 真终端 (xterm + pty)</text>
    <text x="30" y="105" font-family="monospace" font-size="11" fill="#94a3b8">> 大爆炸 / 选区拆词</text>
    <text x="30" y="125" font-family="monospace" font-size="11" fill="#94a3b8">> 右键识屏跳转源码</text>

    <text x="80" y="195" font-family="system-ui, sans-serif" font-size="11" fill="#818cf8">横向滑动切换 ↔</text>

    <rect x="20" y="210" width="220" height="90" rx="6" fill="#0f172a" stroke="#818cf8"/>
    <text x="30" y="238" font-family="system-ui, sans-serif" font-size="12" fill="#f1f5f9">🌿 Git 面板</text>
    <text x="30" y="258" font-family="system-ui, sans-serif" font-size="11" fill="#94a3b8">多分支切换 / Graph拓扑</text>
    <text x="30" y="278" font-family="system-ui, sans-serif" font-size="11" fill="#94a3b8">Diff 语法高亮与暂存</text>
  </g>

  <!-- Module 3: Rich Previews & Agent -->
  <g transform="translate(610, 120)">
    <rect width="240" height="320" rx="10" fill="#1e293b" stroke="#475569" stroke-width="1.5"/>
    <text x="20" y="35" font-family="system-ui, sans-serif" font-size="15" font-weight="600" fill="#f43f5e">3. 富媒体与调度 Agent</text>
    
    <g transform="translate(20, 55)">
      <rect width="200" height="42" rx="6" fill="#0f172a" stroke="#334155"/>
      <text x="14" y="26" font-family="system-ui, sans-serif" font-size="12" fill="#e2e8f0">📄 HTML 仪表盘预览</text>
    </g>

    <g transform="translate(20, 105)">
      <rect width="200" height="42" rx="6" fill="#0f172a" stroke="#334155"/>
      <text x="14" y="26" font-family="system-ui, sans-serif" font-size="12" fill="#e2e8f0">📑 PDF 内嵌阅读器</text>
    </g>

    <g transform="translate(20, 155)">
      <rect width="200" height="42" rx="6" fill="#0f172a" stroke="#334155"/>
      <text x="14" y="26" font-family="system-ui, sans-serif" font-size="12" fill="#e2e8f0">🎬 视频 / 音频播放</text>
    </g>

    <g transform="translate(20, 205)">
      <rect width="200" height="95" rx="6" fill="#0f172a" stroke="#f43f5e"/>
      <text x="14" y="28" font-family="system-ui, sans-serif" font-size="12" font-weight="600" fill="#fb7185">🤖 调度 Agent (Pi SDK)</text>
      <text x="14" y="52" font-family="system-ui, sans-serif" font-size="11" fill="#94a3b8">悬浮球 / 通知胶囊联动</text>
      <text x="14" y="74" font-family="system-ui, sans-serif" font-size="11" fill="#94a3b8">Host 协议 & 技能分发</text>
    </g>
  </g>
</svg>`;
}

/** 生成 HTML 交互仪表盘 */
function buildSampleHtmlDashboard(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muster Console 实时监控仪表盘</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #090d16;
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 24px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      border-bottom: 1px solid #1e293b;
      padding-bottom: 16px;
    }
    .title { font-size: 20px; font-weight: 700; color: #38bdf8; }
    .badge {
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 12px;
      border: 1px solid rgba(56, 189, 248, 0.3);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: #131b2e;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 16px;
    }
    .card-label { font-size: 12px; color: #94a3b8; margin-bottom: 8px; }
    .card-value { font-size: 24px; font-weight: 700; color: #f8fafc; }
    .card-value.green { color: #34d399; }
    .card-value.blue { color: #60a5fa; }
    .card-value.amber { color: #fbbf24; }
    .chart-box {
      background: #131b2e;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 20px;
    }
    canvas { width: 100%; height: 160px; display: block; }
    .actions { display: flex; gap: 12px; }
    button {
      background: #0284c7;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
      transition: background 0.15s;
    }
    button:hover { background: #0369a1; }
    button.secondary { background: #334155; }
    button.secondary:hover { background: #475569; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="title">${PRODUCT_NAME_ZH}实时指标</div>
      <div style="font-size: 12px; color: #64748b; margin-top: 4px;">HTML 实时预览与交互渲染示例</div>
    </div>
    <div class="badge" id="clock">LIVE</div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="card-label">活跃会话 (Sessions)</div>
      <div class="card-value green" id="val-sessions">4</div>
    </div>
    <div class="card">
      <div class="card-label">未读通知 (Notifications)</div>
      <div class="card-value amber" id="val-notifies">3</div>
    </div>
    <div class="card">
      <div class="card-label">增量编译延时</div>
      <div class="card-value blue">240 ms</div>
    </div>
    <div class="card">
      <div class="card-label">Git 分支状态</div>
      <div class="card-value">2 Branches</div>
    </div>
  </div>

  <div class="chart-box">
    <div style="font-size: 14px; font-weight: 600; margin-bottom: 12px;">实时性能波形</div>
    <canvas id="chart"></canvas>
  </div>

  <div class="actions">
    <button onclick="triggerAlert()">触发测试通知</button>
    <button class="secondary" onclick="randomize()">刷新随机指标</button>
  </div>

  <script>
    function updateClock() {
      document.getElementById('clock').innerText = new Date().toLocaleTimeString();
    }
    setInterval(updateClock, 1000);
    updateClock();

    function triggerAlert() {
      alert('【Muster Console 交互演示】HTML 页面在编辑器预览区域中原生运行！');
    }

    function randomize() {
      document.getElementById('val-sessions').innerText = Math.floor(Math.random() * 5 + 3);
      document.getElementById('val-notifies').innerText = Math.floor(Math.random() * 4);
    }

    // 绘制简易波形
    const canvas = document.getElementById('chart');
    const ctx = canvas.getContext('2d');
    canvas.width = 600;
    canvas.height = 160;

    let offset = 0;
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let x = 0; x < canvas.width; x += 5) {
        const y = 80 + Math.sin((x + offset) * 0.04) * 35 + Math.cos((x + offset) * 0.02) * 15;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      offset += 1.5;
      requestAnimationFrame(draw);
    }
    draw();
  </script>
</body>
</html>`;
}

/** 初始化示例仓库与演示场景（代码兜底生成） */
export function seedSampleWorkspaces(workspacesDir: string, force = false): void {
  fs.mkdirSync(workspacesDir, { recursive: true });

  const playgroundDir = path.join(workspacesDir, 'demo-playground');
  const frontendDir = path.join(workspacesDir, 'demo-frontend');
  const backendDir = path.join(workspacesDir, 'demo-backend');

  if (force) {
    for (const dir of [playgroundDir, frontendDir, backendDir]) {
      try {
        if (fs.existsSync(dir)) {
          removeDevSandboxDirectorySync(dir);
        }
      } catch (e) {
        console.error('[devSandbox] failed to remove dir for reset:', dir, (e as Error).message);
      }
    }
  }

  // 1. demo-playground
  if (needsSeedRepo(playgroundDir)) {
    seedSingleRepo(
      playgroundDir,
      {
        'package.json': JSON.stringify(
          {
            name: 'demo-playground',
            version: '1.2.0',
            description: `${PRODUCT_NAME_ZH}全功能特性演练与实操游乐场`,
            scripts: {
              test: 'node --test src/utils/calculator.test.ts',
              build: 'node -e "console.log(\'Build complete! See docs/dashboard.html\')"',
              watch: 'node -e "console.log(\'Watching files in src/index.ts:18:10\')"'
            }
          },
          null,
          2
        ),
        'tsconfig.json': JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              strict: true,
              esModuleInterop: true
            },
            include: ['src/**/*']
          },
          null,
          2
        ),
        'src/index.ts': `import { calculateDiscount, sumTotal } from './utils/calculator';

export function runDemo(name: string): string {
  const price = 299;
  const discountRate = 0.2;
  const finalPrice = calculateDiscount(price, discountRate);
  
  console.log(\`[Demo] User: \${name}, Final Price: ¥\${finalPrice}\`);
  return \`Welcome \${name}! Muster Console features are ready.\`;
}

// 供右键识屏与大爆炸提取演示的路径入口：
// 查看统计报表: docs/dashboard.html
// 查阅架构文档: docs/architecture-report.pdf
// 观看功能录屏: assets/demo-screencast.webm
// 工具库实现位置: src/utils/calculator.ts:8:15

runDemo('Muster Console Developer');
`,
        'src/utils/calculator.ts': `export function calculateDiscount(price: number, rate: number): number {
  if (price <= 0 || rate < 0 || rate > 1) return 0;
  return Number((price * (1 - rate)).toFixed(2));
}

export function sumTotal(items: number[]): number {
  return items.reduce((acc, cur) => acc + cur, 0);
}
`,
        'src/components/Card.tsx': `import React from 'react';

export interface CardProps {
  title: string;
  description: string;
  badge?: string;
}

export function Card({ title, description, badge }: CardProps): React.JSX.Element {
  return (
    <div className="demo-card">
      <div className="demo-card-header">
        <h3>{title}</h3>
        {badge ? <span className="demo-badge">{badge}</span> : null}
      </div>
      <p>{description}</p>
    </div>
  );
}
`,
        'docs/dashboard.html': buildSampleHtmlDashboard(),
        'docs/architecture-report.pdf': buildSamplePdf(),
        'assets/demo-screencast.webm': buildSampleWebm(),
        'assets/notification-chime.wav': buildSampleWav(),
        'assets/logo.png': buildSamplePng(),
        'assets/workbench-architecture.svg': buildSampleSvg(),

        'docs/features-guide.md': `# ${PRODUCT_NAME_ZH}特色功能演示指南

本工作区专为演示与体验${PRODUCT_NAME_ZH}的核心特色设计：

## 1. 虚拟屏（Virtual Screen）
- 顶部导航栏支持**终端 ↔ Git 面板**无缝横向滑动切换；
- 点击顶栏 Git 图标或按快捷键即可滑入 Git 工作区；
- 支持多分支对比（\`main\` 与 \`feature/analytics\`）、图形化提交树、实时 Diff 语法高亮与暂存区操作。

## 2. 选区大爆炸（Terminal Bang Overlay）
- 在终端中选中任意一段日志或文本；
- 点击浮出的「爆炸」按钮，文本将被智能分词拆解为独立芯片；
- 支持自由拖拽多选、一键复制、搜索或直接发送给调度 Agent。

## 3. 右键识屏与文件秒跳（Smart Path Recognition）
- 终端与文本中的工作区文件路径可被**智能识别并秒级定位**；
- 在终端中直接选中以下路径，点击「打开文件」或右键即可在右侧编辑器中高亮打开：
  - \`src/index.ts:18:10\`
  - \`src/utils/calculator.ts:8:15\`
  - \`src/components/Card.tsx:12:8\`
  - \`docs/dashboard.html\`
  - \`docs/architecture-report.pdf\`
  - \`assets/demo-screencast.webm\`
  - \`assets/workbench-architecture.svg\`

## 4. 多会话胶囊与状态管理
- 左侧会话列表展示了真实运行中的多种业务状态胶囊：
  - 🟢 \`active\`（正在监听文件）
  - 🔵 \`done\`（审查通过 · 0 缺陷）
  - 🟠 \`waiting\`（等待确认发布）
  - 🔴 \`error\`（端口冲突告警）
- 支持置顶（Pinned）、多 Runtime（Cursor CLI / Claude Code / OpenCode）协同。

## 5. 通知体系（Notifications）
- 会话需要出手/知晓的时刻（需要你/完成/出错等）弹系统桌面通知，点击回跳工作区与会话；
- 左下角调度 Agent 悬浮球实时显示各工作区的回合状态。
`,
        '.muster/workspace.json': JSON.stringify(
          {
            maxConcurrentWorkers: 5
          },
          null,
          2
        ),
        '.muster/extensions/hello-action/manifest.json': JSON.stringify(
          {
            name: '你好扩展',
            description: '集序 演示快捷动作扩展',
            icon: '✨',
            entry: 'action.js'
          },
          null,
          2
        ),
        '.muster/extensions/hello-action/action.js': `// 演示快捷动作\nconsole.log('来自 demo-playground 的问候！当前时间：' + new Date().toLocaleTimeString());\n`,
        '.agents/skills/demo-helper/SKILL.md': `# Demo Helper Skill\n\n这是一个演示 Skill，展示工作区自定义技能的自动发现机制。\n`,
        '.muster/memory/journal/2026-08-20.md': `## [功能演练与实操] 已完成\n- 问题：配置 demo-playground 全功能展示场景。\n- 要点：验证了虚拟屏、选区大爆炸、右键识屏、通知胶囊与富媒体预览支持。\n`,
        'README.md': `# ${PRODUCT_NAME} Demo Playground\n\n这是 ${PRODUCT_NAME} 的全功能演示游乐场。详情请查看 \`docs/features-guide.md\`。\n`
      },
      'feat: initial demo playground with full feature assets',
      {
        branchName: 'feature/analytics',
        files: {
          'src/utils/analytics.ts': `export function trackEvent(name: string, data?: Record<string, unknown>): void {\n  console.log('[Analytics]', name, data);\n}\n`
        },
        commitMsg: 'feat(analytics): add telemetry event tracker'
      },
      {
        'src/index.ts': `import { calculateDiscount, sumTotal } from './utils/calculator';

export function runDemo(name: string): string {
  const price = 299;
  const discountRate = 0.25;
  const finalPrice = calculateDiscount(price, discountRate);
  
  console.log(\`[Demo] User: \${name}, Final Price: ¥\${finalPrice}\`);
  return \`Welcome \${name}! Muster Console features are ready.\`;
}

// 供右键识屏与大爆炸提取演示的路径入口：
// 查看统计报表: docs/dashboard.html
// 查阅架构文档: docs/architecture-report.pdf
// 观看功能录屏: assets/demo-screencast.webm
// 工具库实现位置: src/utils/calculator.ts:8:15

runDemo('Muster Console Developer');
`
      }
    );
  }

  // 2. demo-frontend
  if (needsSeedRepo(frontendDir)) {
    seedSingleRepo(
      frontendDir,
      {
        'package.json': JSON.stringify(
          {
            name: 'demo-frontend',
            version: '0.1.0',
            private: true,
            dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' }
          },
          null,
          2
        ),
        'src/main.tsx': `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport { App } from './App';\nimport './App.css';\n\nReactDOM.createRoot(document.getElementById('root')!).render(<App />);\n`,
        'src/App.tsx': `import React from 'react';\n\nexport function App(): React.JSX.Element {\n  return (\n    <div className="container">\n      <h1>Muster Console Frontend Demo</h1>\n      <p>This is a sample React app for UI and Git branch testing.</p>\n    </div>\n  );\n}\n`,
        'src/App.css': `.container {\n  padding: 24px;\n  font-family: sans-serif;\n}\nh1 {\n  color: #3b82f6;\n}\n`,
        'README.md': `# Demo Frontend\n\nReact + TypeScript 演示前端项目，包含多分支供 Git 面板测试。\n`
      },
      'feat: initial React frontend project',
      {
        branchName: 'feature/dark-mode',
        files: {
          'src/App.tsx': `import React, { useState } from 'react';\n\nexport function App(): React.JSX.Element {\n  const [dark, setDark] = useState(true);\n  return (\n    <div className={\`container \${dark ? 'theme-dark' : 'theme-light'}\`}>\n      <h1>Muster Console Frontend Demo (Dark Mode)</h1>\n      <button onClick={() => setDark(!dark)}>Toggle Dark Mode</button>\n    </div>\n  );\n}\n`
        },
        commitMsg: 'feat: add dark mode toggle support'
      }
    );
  }

  // 3. demo-backend
  if (needsSeedRepo(backendDir)) {
    seedSingleRepo(
      backendDir,
      {
        'package.json': JSON.stringify(
          {
            name: 'demo-backend',
            version: '1.0.0',
            description: 'Node.js/TypeScript API 演示后端',
            scripts: { test: 'node --test' }
          },
          null,
          2
        ),
        'src/server.ts': `export function calculateDiscount(price: number, rate: number): number {\n  if (price < 0 || rate < 0 || rate > 1) return 0;\n  return price * (1 - rate);\n}\n\nexport function formatCurrency(num: number): string {\n  return '¥' + num.toFixed(2);\n}\n`,
        'src/calc.test.ts': `import { calculateDiscount } from './server';\n\nconsole.assert(calculateDiscount(100, 0.2) === 80, 'discount calculation failed');\n`,
        'README.md': `# Demo Backend\n\nNode.js/TypeScript 演示后端服务，提供纯函数测试用例。\n`
      },
      'feat: initial backend service with discount calculator'
    );
  }
}

/** 预设沙箱演示会话列表 (代码兜底) */
export function getPresetDemoSessions(workspacesDir: string): SessionMeta[] {
  const pgPath = path.resolve(workspacesDir, 'demo-playground');
  const now = Date.now();

  return [
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
}

/** 将当前沙箱状态完整冻结并保存为基准快照模板 (.dev-sandbox-template) */
export function saveDevSandboxAsTemplate(): { ok: boolean; message?: string } {
  const rootDir = getDevSandboxRootDir();
  const userDataDir = path.join(rootDir, 'userData');
  const workspacesDir = path.join(rootDir, 'workspaces');
  const tplDir = getDevSandboxTemplateDir();
  const tplUserDataDir = path.join(tplDir, 'userData');
  const tplWorkspacesDir = path.join(tplDir, 'workspaces');

  try {
    if (!fs.existsSync(workspacesDir)) {
      return { ok: false, message: '沙箱工作区目录不存在，无法保存快照' };
    }

    if (fs.existsSync(tplDir)) {
      removeDevSandboxDirectorySync(tplDir);
    }
    fs.mkdirSync(tplDir, { recursive: true });
    fs.mkdirSync(tplUserDataDir, { recursive: true });
    fs.mkdirSync(tplWorkspacesDir, { recursive: true });

    // 1. 复制所有内部测试工作区（包含完整的 .git 树与未提交文件），跳过巨型外部工程
    const internalWorkspaces = ['demo-playground', 'demo-frontend', 'demo-backend'];
    for (const name of internalWorkspaces) {
      const srcWs = path.join(workspacesDir, name);
      const destWs = path.join(tplWorkspacesDir, name);
      if (fs.existsSync(srcWs)) {
        copyDirectorySync(srcWs, destWs, new Set(['node_modules']));
      }
    }

    // 2. 复制关键用户配置与会话
    const keyUserFiles = ['sessions.json', 'prompt-tasks.json', 'config.json'];
    for (const file of keyUserFiles) {
      const srcFile = path.join(userDataDir, file);
      const destFile = path.join(tplUserDataDir, file);
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, destFile);
      }
    }

    console.log(`[devSandbox] 💾 成功将当前沙箱保存为快照模板: ${tplDir}`);
    return { ok: true, message: '已成功将当前沙箱环境保存为默认基准快照！' };
  } catch (err) {
    console.error('[devSandbox] 保存沙箱快照失败:', err);
    return { ok: false, message: (err as Error).message };
  }
}

/** 从基准快照模板还原沙箱 */
function restoreDevSandboxFromTemplate(workspacesDir: string, userDataDir: string): boolean {
  const tplDir = getDevSandboxTemplateDir();
  const tplUserDataDir = path.join(tplDir, 'userData');
  const tplWorkspacesDir = path.join(tplDir, 'workspaces');

  if (!fs.existsSync(tplWorkspacesDir)) return false;

  try {
    // 1. 还原工作区
    const entries = fs.readdirSync(tplWorkspacesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const srcWs = path.join(tplWorkspacesDir, entry.name);
      const destWs = path.join(workspacesDir, entry.name);
      if (fs.existsSync(destWs)) {
        removeDevSandboxDirectorySync(destWs);
      }
      copyDirectorySync(srcWs, destWs);
    }

    // 2. 还原会话与配置
    for (const name of ['sessions.json', 'prompt-tasks.json', 'config.json']) {
      const srcFile = path.join(tplUserDataDir, name);
      const destFile = path.join(userDataDir, name);
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, destFile);
      }
    }

    // 确保 config.json 中保留外部大型项目 (metaworldmobile)
    const configPath = path.join(userDataDir, 'config.json');
    const mobileEnv = process.env.MUSTER_DEV_MOBILE_WS?.trim();
    const mobileCandidate = mobileEnv ? path.resolve(mobileEnv) : undefined;
    if (mobileCandidate && fs.existsSync(configPath) && fs.existsSync(mobileCandidate)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<AppConfig>;
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

    console.log(`[devSandbox] 🎯 从快照模板 (${tplDir}) 成功还原沙箱！`);
    return true;
  } catch (err) {
    console.warn('[devSandbox] 从快照模板还原失败，将回退至代码初始化:', err);
    return false;
  }
}

/** 尝试从生产配置继承已有的 API Key / Base URL / 模型 */
function inheritProdConfig(prodUserDataDir: string, seedWorkspaces: WorkspaceInfo[]): Partial<AppConfig> {
  const prodConfigPath = path.join(prodUserDataDir, 'config.json');
  let openai = {
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    // 与 DEFAULT_LLM_CONFIG 的默认模型一致（曾用 deepseek-v4-flash——预设表里不存在的 id）
    model: 'deepseek-chat'
  };
  let mcp: McpConfig = {
    enabled: true,
    servers: []
  };
  let defaultRuntime = 'cursor-cli';

  if (fs.existsSync(prodConfigPath)) {
    try {
      const raw = fs.readFileSync(prodConfigPath, 'utf-8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      if (parsed.openai) {
        openai = {
          baseUrl: parsed.openai.baseUrl || openai.baseUrl,
          apiKey: parsed.openai.apiKey || '',
          model: parsed.openai.model || openai.model
        };
      }
      if (parsed.mcp) {
        mcp = {
          enabled: parsed.mcp.enabled !== false,
          servers: Array.isArray(parsed.mcp.servers) ? (parsed.mcp.servers as McpConfig['servers']) : []
        };
      }
      if (typeof parsed.defaultRuntime === 'string') {
        defaultRuntime = parsed.defaultRuntime;
      }
    } catch (e) {
      console.warn('[devSandbox] failed to read prod config for inheritance:', (e as Error).message);
    }
  }

  const primaryWs = seedWorkspaces[0];
  return {
    openai,
    mcp,
    defaultRuntime,
    workspaces: seedWorkspaces,
    activeWorkspaceId: primaryWs.id,
    workspace: primaryWs.path,
    dispatcherAppendPrompt: ''
  };
}

/**
 * 在主进程最早阶段调用：
 * 1. 判定是否启用开发沙箱；
 * 2. 重定向 app.getPath('userData') 到 .dev-sandbox/userData；
 * 3. 自动准备好测试仓库、多会话、通知胶囊（优先从快照模板恢复）。
 */
export function setupDevSandbox(options: { initialize?: boolean } = {}): DevSandboxInfo | null {
  if (!isDevSandboxEnabled()) {
    sandboxState = null;
    sandboxPaths = null;
    return null;
  }

  if (sandboxState) return sandboxState;

  if (!sandboxPaths) {
    originalUserDataPath ??= app.getPath('userData');
    const rootDir = getDevSandboxRootDir();
    const templateDir = getDevSandboxTemplateDir();
    const userDataDir = path.join(rootDir, 'userData');
    const workspacesDir = path.join(rootDir, 'workspaces');
    app.setPath('userData', userDataDir);
    sandboxPaths = { rootDir, templateDir, userDataDir, workspacesDir };
  } else {
    app.setPath('userData', sandboxPaths.userDataDir);
  }

  const { rootDir, templateDir, userDataDir, workspacesDir } = sandboxPaths;
  if (options.initialize === false) {
    return { enabled: true, rootDir, templateDir, userDataDir, workspacesDir, hasTemplate: hasDevSandboxTemplate(), workspaces: [] };
  }

  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(workspacesDir, { recursive: true });

  const hasTemplate = hasDevSandboxTemplate();

  // 1. 优先从快照模板还原，若无模板则走代码兜底
  if (hasTemplate) {
    restoreDevSandboxFromTemplate(workspacesDir, userDataDir);
  } else {
    seedSampleWorkspaces(workspacesDir);
  }

  const seedWorkspaces = getSeedWorkspaceInfos(workspacesDir);

  // 2. 初始化或补充沙箱配置
  const sandboxConfigPath = path.join(userDataDir, 'config.json');
  if (!fs.existsSync(sandboxConfigPath)) {
    const inherited = inheritProdConfig(originalUserDataPath!, seedWorkspaces);
    fs.writeFileSync(sandboxConfigPath, JSON.stringify(inherited, null, 2), 'utf-8');
  } else {
    try {
      const raw = fs.readFileSync(sandboxConfigPath, 'utf-8').replace(/^\uFEFF/, '');
      const existing = JSON.parse(raw) as Partial<AppConfig>;
      const existingWs = Array.isArray(existing.workspaces) ? [...existing.workspaces] : [];
      let changed = false;
      for (const seed of seedWorkspaces) {
        if (!existingWs.some((w) => w.id === seed.id || path.resolve(w.path) === path.resolve(seed.path))) {
          existingWs.push(seed);
          changed = true;
        }
      }
      if (changed) {
        existing.workspaces = existingWs;
        fs.writeFileSync(sandboxConfigPath, JSON.stringify(existing, null, 2), 'utf-8');
      }
    } catch {
      /* ignore */
    }
  }

  // 3. 若无会话列表且无模板，写入代码兜底会话
  const sessionsPath = path.join(userDataDir, 'sessions.json');
  if (!fs.existsSync(sessionsPath)) {
    const presetSessions = getPresetDemoSessions(workspacesDir);
    fs.writeFileSync(sessionsPath, JSON.stringify(presetSessions, null, 2), 'utf-8');
  }

  sandboxState = {
    enabled: true,
    rootDir,
    userDataDir,
    workspacesDir,
    templateDir,
    hasTemplate,
    workspaces: seedWorkspaces
  };

  console.log(`[devSandbox] 🌟 Dev Sandbox active: userData=${userDataDir}, workspaces=${workspacesDir}`);
  return sandboxState;
}

/** 获取当前沙箱运行状态 */
export function getDevSandboxInfo(): DevSandboxInfo | null {
  if (sandboxState) {
    sandboxState.hasTemplate = hasDevSandboxTemplate();
  }
  return sandboxState;
}

/**
 * 重置前置清理：fs.promises.rm 带 maxRetries/retryDelay（Windows 上杀软/索引器
 * 会短暂锁住刚写入的文件，同步 rmSync 遇 EPERM 直接失败且不可重试，曾致
 * 「一键重置」半途而废留下半删除工作区；异步 rm 的内置重试是官方解法）。
 * 之后 resetDevSandbox 的同步还原因目录已清空而不再触发 rm。
 */
export async function preCleanDevSandboxWorkspaces(): Promise<void> {
  const rootDir = getDevSandboxRootDir();
  const tplWorkspaces = path.join(getDevSandboxTemplateDir(), 'workspaces');
  const names = fs.existsSync(tplWorkspaces)
    ? fs
        .readdirSync(tplWorkspaces, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : ['demo-playground', 'demo-frontend', 'demo-backend'];
  for (const name of names) {
    await fs.promises.rm(path.join(rootDir, 'workspaces', name), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200
    });
  }
}

/** 一键重置沙箱状态（优先从模板恢复） */
export function resetDevSandbox(opts?: {
  cleanWorkspaces?: boolean;
  cleanUserData?: boolean;
}): { ok: boolean; message?: string } {
  const rootDir = getDevSandboxRootDir();
  const userDataDir = path.join(rootDir, 'userData');
  const workspacesDir = path.join(rootDir, 'workspaces');

  const cleanWorkspaces = opts?.cleanWorkspaces ?? true;
  const cleanUserData = opts?.cleanUserData ?? false;

  try {
    const hasTemplate = hasDevSandboxTemplate();

    if (hasTemplate) {
      // 优先从快照模板 1:1 还原；失败必须显式报错，不能静默返回 ok（否则 UI 与
      // e2e 都以为重置成功，实际沙箱原样未动）
      const restored = restoreDevSandboxFromTemplate(workspacesDir, userDataDir);
      if (!restored) {
        return { ok: false, message: '从快照模板还原失败（详见主进程日志）' };
      }
    } else {
      // 代码兜底还原
      if (cleanWorkspaces) {
        seedSampleWorkspaces(workspacesDir, true);
      }

      if (cleanUserData) {
        const prodDir = originalUserDataPath || productUserDataPath();
        const seedWorkspaces = getSeedWorkspaceInfos(workspacesDir);
        const inherited = inheritProdConfig(prodDir, seedWorkspaces);

        const curConfigPath = path.join(userDataDir, 'config.json');
        if (fs.existsSync(curConfigPath)) {
          try {
            const raw = fs.readFileSync(curConfigPath, 'utf-8');
            const cur = JSON.parse(raw) as Partial<AppConfig>;
            if (cur.openai?.apiKey) inherited.openai = cur.openai;
          } catch {
            /* ignore */
          }
        }

        for (const name of ['prompt-tasks.json', 'task-runs.json']) {
          const p = path.join(userDataDir, name);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        for (const sub of ['pi-sessions', 'terminal-captures']) {
          const p = path.join(userDataDir, sub);
          if (fs.existsSync(p)) removeDevSandboxDirectorySync(p);
        }

        fs.writeFileSync(curConfigPath, JSON.stringify(inherited, null, 2), 'utf-8');
      }

      const sessionsPath = path.join(userDataDir, 'sessions.json');
      const presetSessions = getPresetDemoSessions(workspacesDir);
      fs.writeFileSync(sessionsPath, JSON.stringify(presetSessions, null, 2), 'utf-8');
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
