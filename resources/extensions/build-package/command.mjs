import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const PLATFORMS = [
  { system: 'darwin', label: 'macOS', script: 'build:mac', shellProfileId: 'zsh' },
  { system: 'win32', label: 'Windows', script: 'build:win', shellProfileId: 'powershell' },
  { system: 'linux', label: 'Linux', script: 'build:linux', shellProfileId: 'bash' }
];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CHOICE_CANCELLED = /^(?:Error: )*Question was aborted before the user answered$/;

function parseVersion(value, field) {
  const match = typeof value === 'string' && value.length <= 256 && VERSION.exec(value);
  if (match) {
    const [, major, minor, patch, prerelease] = match;
    if ([major, minor, patch].every(part => Number.isSafeInteger(Number(part))) &&
        !prerelease?.split('.').some(part => /^0\d+$/.test(part))) {
      return { major, minor, patch: Number(patch), prerelease };
    }
  }
  throw new Error(`${field}格式无效。请输入有效的版本号（如 1.2.3 或 1.2.3-beta.1，含 +build 元数据会被拒绝）。`);
}

function suggestVersion(currentVersion) {
  const { major, minor, patch, prerelease } = parseVersion(currentVersion, '项目当前版本');
  const nextPatch = prerelease ? patch : patch + 1;
  if (!Number.isSafeInteger(nextPatch)) throw new Error('package.json 的 patch 版本已达 npm 支持的上限。');
  return `${major}.${minor}.${nextPatch}`;
}

async function readPackage(projectRoot, signal) {
  try {
    const json = await readFile(join(projectRoot, 'package.json'), { encoding: 'utf8', signal });
    const manifest = JSON.parse(json.replace(/^\uFEFF/, ''));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('内容必须是 JSON 对象');
    return manifest;
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(`无法读取绑定项目的 package.json：${error.message}`, { cause: error });
  }
}

async function askPlatform(call, current) {
  const options = [
    { label: current.label, description: '当前平台（默认）' },
    ...PLATFORMS.filter(item => item !== current).map(item => ({ label: item.label }))
  ];
  let result;
  try {
    result = await call('host.ask', {
      kind: 'choice', title: '选择目标平台',
      questions: [{ id: 'platform', question: '选择目标平台', options }]
    });
  } catch (error) {
    // The projected choice tool reports a dismissed host dialog as an error.
    if (error instanceof Error && CHOICE_CANCELLED.test(error.message)) return;
    throw error;
  }
  if (result?.cancelled || !result?.answers?.length) return;
  const [answer] = result.answers;
  const target = PLATFORMS.find(item => item.label === answer?.selected?.[0]);
  if (result.answers.length !== 1 || answer?.id !== 'platform' || answer.custom !== undefined ||
      answer.selected?.length !== 1 || !target) {
    throw new Error('请选择列表中的 macOS、Windows 或 Linux。');
  }
  return target;
}

async function checkPrerequisites(projectRoot, currentVersion, script, signal) {
  const manifest = await readPackage(projectRoot, signal);
  if (manifest.version !== currentVersion) throw new Error('确认期间项目版本发生了变化，请重新点击「一键打包」。');
  const build = manifest.scripts?.[script];
  if (typeof build !== 'string' || !build.trim()) throw new Error(`绑定项目的 package.json 缺少 ${script} 脚本。`);

  try {
    if ((await stat(join(projectRoot, 'node_modules', 'electron-builder'))).isDirectory()) return;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      throw new Error(`无法检查 electron-builder：${error.message}`, { cause: error });
    }
  }
  throw new Error('绑定项目缺少 node_modules/electron-builder，请先在项目目录运行 npm install。');
}

export function createCommandRuntime({ broker, platform = process.platform }) {
  return {
    async execute({ command, context }) {
      if (command !== 'build-package') throw new Error(`未知的一键打包命令：${command}`);
      const { sourceRoot, sourceRootId, rootsRevision, signal } = context;
      if (typeof sourceRoot !== 'string' || !isAbsolute(sourceRoot)) throw new Error('请先为当前工作区选择绑定项目。');
      const current = PLATFORMS.find(item => item.system === platform);
      if (!current) throw new Error(`当前系统没有受支持的打包终端：${platform}`);

      const call = (name, args) => {
        signal?.throwIfAborted();
        return broker('tool', [name, args], context);
      };
      const { version: currentVersion } = await readPackage(sourceRoot, signal);
      const input = await call('host.ask', {
        kind: 'text', title: '输入打包版本号', defaultValue: suggestVersion(currentVersion), placeholder: '1.2.3'
      });
      if (input?.cancelled !== false) return;
      const version = typeof input.value === 'string' ? input.value.trim() : input.value;
      parseVersion(version, '打包版本号');

      const target = await askPlatform(call, current);
      if (!target) return;
      const build = `npm run ${target.script}`;
      const line = version === currentVersion ? build : `npm version ${version} --no-git-tag-version && ${build}`;
      const confirmation = await call('host.ask', { kind: 'confirm', title: '确认执行打包命令？', detail: line });
      if (confirmation?.cancelled || confirmation?.confirmed !== true) return;

      await checkPrerequisites(sourceRoot, currentVersion, target.script, signal);
      const session = await call('host.terminal.create', {
        name: `一键打包 v${version}`.slice(0, 60), shellProfileId: current.shellProfileId,
        cwd: sourceRoot, rootId: sourceRootId, rootsRevision, select: true
      });
      const sessionId = session?.sessionId ?? session?.id;
      if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('宿主未返回打包终端的会话 ID。');

      // Windows PowerShell 5.1 cannot parse &&. cmd also resolves the npm.cmd shim.
      const text = platform === 'win32' ? `cmd.exe /d /s /c "${line}"` : line;
      await call('host.terminal.write', { sessionId, text, submit: true, enterCount: 1 });
    }
  };
}
