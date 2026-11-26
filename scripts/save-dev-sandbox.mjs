/**
 * 将当前沙箱的全部工作区与会话、通知状态冻结并保存为快照基准模板 (.dev-sandbox-template)
 * 运行: npm run save:sandbox
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sandboxDir = path.join(repoRoot, '.dev-sandbox');
const tplDir = path.join(repoRoot, '.dev-sandbox-template');

const workspacesDir = path.join(sandboxDir, 'workspaces');
const userDataDir = path.join(sandboxDir, 'userData');
const tplWorkspacesDir = path.join(tplDir, 'workspaces');
const tplUserDataDir = path.join(tplDir, 'userData');

console.log('[save-sandbox] 正在将当前开发沙箱状态保存为默认基准快照...');

if (!fs.existsSync(workspacesDir)) {
  console.error('[save-sandbox] 错误: 未检测到沙箱工作区目录 (.dev-sandbox/workspaces/)，请先启动应用或初始化沙箱。');
  process.exit(1);
}

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

// 1. 清理并准备模板目录
if (fs.existsSync(tplDir)) {
  fs.rmSync(tplDir, { recursive: true, force: true });
}
fs.mkdirSync(tplDir, { recursive: true });
fs.mkdirSync(tplWorkspacesDir, { recursive: true });
fs.mkdirSync(tplUserDataDir, { recursive: true });

// 2. 复制工作区仓库（包含完整的 .git 树、提交历史与未暂存修改）
const internalWorkspaces = ['demo-playground', 'demo-frontend', 'demo-backend'];
let savedWsCount = 0;

for (const name of internalWorkspaces) {
  const srcWs = path.join(workspacesDir, name);
  const destWs = path.join(tplWorkspacesDir, name);
  if (fs.existsSync(srcWs)) {
    copyDirectorySync(srcWs, destWs, new Set(['node_modules']));
    savedWsCount++;
    console.log(`  - 已保存工作区: ${name}`);
  }
}

// 3. 复制关键用户配置、会话列表与通知胶囊
const keyUserFiles = ['sessions.json', 'workspace-notifies.json', 'prompt-tasks.json', 'config.json'];
let savedUserFilesCount = 0;

for (const file of keyUserFiles) {
  const srcFile = path.join(userDataDir, file);
  const destFile = path.join(tplUserDataDir, file);
  if (fs.existsSync(srcFile)) {
    fs.copyFileSync(srcFile, destFile);
    savedUserFilesCount++;
    console.log(`  - 已保存配置数据: ${file}`);
  }
}

console.log('\n[save-sandbox] ✅ 基准快照保存成功！');
console.log(`  - 模板路径: ${tplDir}`);
console.log(`  - 工作区数量: ${savedWsCount} 个`);
console.log(`  - 配置文件: ${savedUserFilesCount} 个`);
console.log('  - 效果: 以后执行重置或启动沙箱时，将 1:1 完美还原为此快照状态！');
