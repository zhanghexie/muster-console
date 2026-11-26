/**
 * 首启零工作区 + 推荐根回归：
 * - 新装不自动登记工作区，也不预建 ~/Muster 目录；config.workspace 只是 cwd 投影；
 * - 推荐根只在已有登记引用它（或用户提交「一键填入」）时创建；老配置不迁移、不凭空建目录；
 * - 显式空列表的配置重启后保持零工作区，新建引导面板才能常驻；
 * - 创建失败必须抛错，由启动链明确提示，不静默回退。
 * 纯路径计算可注入 homeDir，测试全程不碰真实用户主目录。
 * 运行: node test/default-workspace-root.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'default-workspace-root-'));
try {
  // createSharedCompiler 自带 electron stub，app.getPath('userData') 固定落在
  // <tmp>/electron-userData；配置文件必须写到该目录，不能另造一份 mock。
  const userData = path.join(tmp, 'electron-userData');
  fs.mkdirSync(userData, { recursive: true });

  const compile = createSharedCompiler(repo, tmp);
  const { ConfigManager, DEFAULT_WORKSPACE_FOLDER, RECOMMENDED_WORKSPACE_NAME, defaultWorkspaceRoot, ensureDefaultWorkspaceRoot } =
    await import(pathToFileURL(compile('main/config.ts')).href);

  // 1) 纯路径计算：三平台统一交给 path.join，绝不等于主目录本身
  const home = path.join(tmp, 'home');
  assert.equal(DEFAULT_WORKSPACE_FOLDER, 'Muster');
  assert.equal(RECOMMENDED_WORKSPACE_NAME, 'muster 默认工作区');
  assert.equal(defaultWorkspaceRoot(home), path.join(home, 'Muster'));
  assert.notEqual(defaultWorkspaceRoot(home), home);

  // 2) 首启（无 config.json）：零工作区 / 无活动区，workspace 只是推荐 cwd 投影
  const fresh = new ConfigManager().get();
  const expected = path.join(os.homedir(), 'Muster');
  assert.equal(fresh.workspace, expected, '首启推荐 cwd');
  assert.equal(fresh.workspaces.length, 0, '首启不得自动创建工作区');
  assert.equal(fresh.activeWorkspaceId, '', '首启无活动工作区');
  assert.notEqual(fresh.workspace, os.homedir(), '不能把用户主目录整个登记为工作区');

  // 3) 首启零工作区不得凭空建目录：config.workspace 等于推荐根也不算「已登记」
  const sandboxRoot = path.join(home, 'Muster');
  assert.equal(ensureDefaultWorkspaceRoot(fresh, home), sandboxRoot);
  assert.equal(fs.existsSync(sandboxRoot), false, '首启不预建推荐目录');

  // 4) 已有登记引用推荐根时创建目录；幂等且不清空已有内容
  const sandboxConfig = {
    workspace: sandboxRoot,
    workspaces: [{ id: 'ws', path: sandboxRoot, controlRoot: sandboxRoot,
      roots: [{ id: 'root-ws', path: sandboxRoot }] }]
  };
  assert.equal(ensureDefaultWorkspaceRoot(sandboxConfig, home), sandboxRoot);
  assert.ok(fs.statSync(sandboxRoot).isDirectory());
  const marker = path.join(sandboxRoot, 'keep.txt');
  fs.writeFileSync(marker, 'user data');
  ensureDefaultWorkspaceRoot(sandboxConfig, home);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'user data', '重复创建不得清空目录');

  // 5) 老配置不引用默认根：既不迁移，也不凭空多出空目录
  const legacyHome = path.join(tmp, 'legacy-home');
  fs.mkdirSync(legacyHome);
  const legacyRoot = path.join(tmp, 'old-workspace');
  const legacy = {
    workspace: legacyRoot,
    workspaces: [{ id: 'old', path: legacyRoot, name: 'old', controlRoot: legacyRoot,
      roots: [{ id: 'root-old', path: legacyRoot }] }]
  };
  ensureDefaultWorkspaceRoot(legacy, legacyHome);
  assert.equal(fs.existsSync(path.join(legacyHome, 'Muster')), false, '老用户机器不应多出空目录');

  // 6) 同名文件占用 / 权限问题：必须抛错，由启动链明确提示，不静默回退
  const blockedHome = path.join(tmp, 'blocked-home');
  fs.mkdirSync(blockedHome);
  const blockedRoot = path.join(blockedHome, 'Muster');
  fs.writeFileSync(blockedRoot, 'not a directory');
  assert.throws(() => ensureDefaultWorkspaceRoot(
    { workspace: blockedRoot, workspaces: [{ path: blockedRoot }] }, blockedHome
  ));

  // 7) 已有 config.json 指向旧默认（用户主目录）时保持原登记，不迁移
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    workspace: os.homedir(), activeWorkspaceId: 'default-workspace',
    workspaces: [{ id: 'default-workspace', path: os.homedir(), name: 'legacy', openedAt: 0 }]
  }));
  const upgraded = new ConfigManager().get();
  assert.equal(upgraded.workspace, os.homedir());
  assert.equal(upgraded.workspaces[0].path, os.homedir());

  // 8) 删掉最后一个工作区后重启：显式空数组必须保持零工作区，不能凭 cwd 投影补默认区
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    workspace: legacyRoot, workspaces: [], activeWorkspaceId: '',
    closedWorkspaces: [{ id: 'closed', path: legacyRoot, name: 'old' }]
  }));
  const emptied = new ConfigManager().get();
  assert.equal(emptied.workspaces.length, 0, '删空后重启仍是零工作区');
  assert.equal(emptied.activeWorkspaceId, '', '删空后重启无活动区');

  // 9) 老配置只有 workspace 字段、没有 workspaces 数组：仍按旧路径迁出一个工作区
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    workspace: legacyRoot, activeWorkspaceId: ''
  }));
  const migrated = new ConfigManager().get();
  assert.equal(migrated.workspaces.length, 1, '老配置不丢弃已有工作目录');
  assert.equal(migrated.workspaces[0].path, legacyRoot);
  assert.ok(migrated.activeWorkspaceId, '老配置恢复出有效活动区');

  console.log('default-workspace-root: ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
