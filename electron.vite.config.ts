import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { Plugin } from 'vite';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { buildDesktopStopAssets } from './src/main/desktop/buildStopAssets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 打包进 out/main 后 __dirname=out/main，须落在 out/main/runtime/builtins/ */
function copyRuntimeBuiltinsToOut(): void {
  const srcDir = path.join(__dirname, 'src/main/runtime/builtins');
  const destDir = path.join(__dirname, 'out/main/runtime/builtins');
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(path.join(destDir, 'scripts'), { recursive: true });
  fs.copyFileSync(
    path.join(srcDir, 'registry.json'),
    path.join(destDir, 'registry.json')
  );
  const scriptsDir = path.join(srcDir, 'scripts');
  for (const name of fs.readdirSync(scriptsDir)) {
    if (name.endsWith('.mjs')) {
      fs.copyFileSync(path.join(scriptsDir, name), path.join(destDir, 'scripts', name));
    }
  }
}

function copyRuntimeBuiltins(): Plugin {
  return {
    name: 'copy-runtime-builtins',
    buildStart() {
      copyRuntimeBuiltinsToOut();
    },
    writeBundle() {
      copyRuntimeBuiltinsToOut();
    }
  };
}

/** 面板 SDK 资产打包后须落在 out/main/extensions/sdk/（协议层 __sdk__ 保留路径） */
function copyExtensionSdkToOut(): void {
  const srcDir = path.join(__dirname, 'src/main/extensions/sdk');
  const destDir = path.join(__dirname, 'out/main/extensions/sdk');
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    if (name.endsWith('.css') || name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs')) {
      fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
    }
  }
}

function copyExtensionSdk(): Plugin {
  return {
    name: 'copy-extension-sdk',
    buildStart() {
      execFileSync(process.execPath, [path.join(__dirname, 'scripts/build-daily-report.mjs')], { cwd: __dirname, stdio: 'inherit', windowsHide: true });
      copyExtensionSdkToOut();
    },
    writeBundle() {
      copyExtensionSdkToOut();
    }
  };
}

/** DomainRuntime and toolbar modules execute in an owned Node child. */
function buildExtensionRuntimeWorker(): Plugin {
  const build = async (): Promise<void> => {
    const esbuild = await import('esbuild');
    const outfile = path.join(__dirname, 'out/main/extensions/sdk/extension-runtime-worker.mjs');
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
    await esbuild.build({ entryPoints: [path.join(__dirname, 'src/main/extensions/extensionRuntimeWorker.ts')], bundle: true, platform: 'node', format: 'esm', outfile, packages: 'external', logLevel: 'silent' });
  };
  return { name: 'build-extension-runtime-worker', buildStart: build, writeBundle: build };
}

/** Native window enumeration must run outside the Electron main process. */
function buildDesktopInventoryWorker(): Plugin {
  const build = async (): Promise<void> => {
    const esbuild = await import('esbuild');
    const outfile = path.join(__dirname, 'out/main/desktop/inventory-worker.cjs');
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
    await esbuild.build({ entryPoints: [path.join(__dirname, 'src/main/desktop/inventoryWorker.ts')], bundle: true,
      platform: 'node', format: 'cjs', outfile, packages: 'external', logLevel: 'silent' });
  };
  return { name: 'build-desktop-inventory-worker', buildStart: build, writeBundle: build };
}

/** The built-in engine runs as a managed Node child and needs a real bundle. */
function buildBuiltinEngineWorker(): Plugin {
  const build = async (): Promise<void> => {
    const esbuild = await import('esbuild');
    const outfile = path.join(__dirname, 'out/main/agentSession/drivers/pi/worker.cjs');
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'src/main/agentSession/drivers/pi/worker.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      packages: 'external',
      logLevel: 'silent'
    });
  };
  return { name: 'build-builtin-engine-worker', buildStart: build, writeBundle: build };
}

/** The phone service owns SQLite on a worker thread; it needs its own packaged entry. */
function buildAgentAppsWorker(): Plugin {
  const build = async (): Promise<void> => {
    const esbuild = await import('esbuild');
    const outfile = path.join(__dirname, 'out/main/agentApps/service-worker.cjs');
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
    await esbuild.build({ entryPoints: [path.join(__dirname, 'src/main/agentApps/serviceWorker.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, packages: 'external', logLevel: 'silent' });
  };
  return { name: 'build-agent-apps-worker', buildStart: build, writeBundle: build };
}

/**
 * Windows hide-console.cjs 预加载由 NODE_OPTIONS --require 引用——不能打进 bundle，
 * 须原样落在 out/main/agentSession/drivers/win32/（Cursor worker 子进程用）。
 */
function copyWin32PreloadToOut(): void {
  const srcDir = path.join(__dirname, 'src/main/agentSession/drivers/win32');
  const destDir = path.join(__dirname, 'out/main/agentSession/drivers/win32');
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    if (name.endsWith('.cjs')) {
      fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name));
    }
  }
}

function copyWin32Preload(): Plugin {
  return {
    name: 'copy-win32-preload',
    buildStart() {
      copyWin32PreloadToOut();
    },
    writeBundle() {
      copyWin32PreloadToOut();
    }
  };
}

function copyCodexWorker(): Plugin {
  const copy = (): void => {
    const src = path.join(__dirname, 'src/main/agentSession/drivers/codex/worker');
    const dest = path.join(__dirname, 'out/main/agentSession/drivers/codex/worker');
    fs.mkdirSync(dest, { recursive: true });
    for (const name of ['native-worker.mjs', 'appServerOutput.mjs', 'windows-job.ps1']) fs.copyFileSync(path.join(src, name), path.join(dest, name));
  };
  return { name: 'copy-codex-worker', buildStart: copy, writeBundle: copy };
}

function copyDesktopEscapeMonitor(): Plugin {
  const copy = (): void => {
    const dest = path.join(__dirname, 'out/main/desktop');
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'src/main/desktop/windows-escape-monitor.ps1'), path.join(dest, 'windows-escape-monitor.ps1'));
  };
  return { name: 'copy-desktop-escape-monitor', buildStart: copy, writeBundle: copy };
}

/** Process-backed Unix stop helpers must also exist as unpacked files. */
function buildDesktopUnixStopHelpers(): Plugin {
  const build = (): Promise<void> => buildDesktopStopAssets(__dirname);
  return { name: 'build-desktop-unix-stop-helpers', buildStart: build, writeBundle: build };
}

/** 入站 stdio MCP 入口独立 bundle（同款 esbuild 构建供 buildStart/writeBundle 双钩子复用） */
async function buildInboundMcpStdio(): Promise<void> {
  const esbuild = await import('esbuild');
  const outfile = path.join(__dirname, 'out/main/inboundMcp/stdioEntry.mjs');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src/main/inboundMcp/stdioEntry.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    packages: 'external',
    logLevel: 'silent'
  });
}

function buildAttachmentWorker(): Plugin {
  const build = async (): Promise<void> => {
    const esbuild = await import('esbuild');
    await esbuild.build({ entryPoints: [path.join(__dirname, 'src/main/attachments/worker.ts')],
      outfile: path.join(__dirname, 'out/main/attachments/worker.mjs'), bundle: true, platform: 'node',
      format: 'esm', packages: 'external', logLevel: 'silent' });
  };
  return { name: 'build-attachment-worker', buildStart: build, writeBundle: build };
}

function buildMessagingRuntime(): Plugin {
  const build = (): void => {
    execFileSync(process.execPath, [path.join(__dirname, 'scripts/build-messaging.mjs')], {
      cwd: __dirname, stdio: 'inherit', windowsHide: true
    });
  };
  return { name: 'build-messaging-runtime', buildStart: build, writeBundle: build };
}

function buildCliEntry(): Plugin {
  const build = async (): Promise<void> => {
    const esbuild = await import('esbuild');
    await esbuild.build({ entryPoints: [path.join(__dirname, 'src/main/cliRuns/entry.ts')], outfile: path.join(__dirname, 'out/main/cliRuns/entry.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  };
  return { name: 'build-cli-entry', buildStart: build, writeBundle: build };
}

function copyInboundMcpServer(): Plugin {
  return {
    name: 'copy-inbound-mcp-server',
    async buildStart() {
      await buildInboundMcpStdio();
    },
    async writeBundle() {
      await buildInboundMcpStdio();
    }
  };
}

/**
 * 渲染层分包：按 node_modules 模块路径把重依赖分家族独立成 chunk，配合
 * 懒加载（SettingsModal / FilesPanel(FileEditor→CodeMirror) / GitPanel）
 * 让首屏入口只剩 react 系。判定顺序敏感：markdown / diff 系包名都含
 * "react"，须排在 react 系之前；兜底返回 undefined 交回 vite 默认策略。
 */
function rendererManualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;
  const inPkg = (name: string): boolean =>
    id.includes(`node_modules/${name}/`) || id.includes(`node_modules\\${name}\\`);
  if (id.includes('@codemirror/') || inPkg('codemirror')) return 'vendor-codemirror';
  if (id.includes('@xterm/')) return 'vendor-xterm';
  if (
    id.includes('react-markdown') ||
    id.includes('remark') ||
    id.includes('refractor') ||
    id.includes('unist') ||
    id.includes('micromark') ||
    id.includes('mdast') ||
    id.includes('hast')
  ) {
    return 'vendor-markdown';
  }
  if (id.includes('react-diff-view') || id.includes('unidiff') || id.includes('@rexxars/')) {
    return 'vendor-diff';
  }
  if (inPkg('react') || inPkg('react-dom') || inPkg('scheduler')) return 'vendor-react';
  return undefined;
}

export default defineConfig({
  main: {
    define: {
      __MUSTER_GITHUB_APP_CLIENT_ID__: JSON.stringify(process.env.MUSTER_GITHUB_APP_CLIENT_ID ?? ''),
      __MUSTER_GITHUB_APP_SLUG__: JSON.stringify(process.env.MUSTER_GITHUB_APP_SLUG ?? '')
    },
    build: { rollupOptions: { input: {
      index: path.join(__dirname, 'src/main/launch.ts'),
      workbench: path.join(__dirname, 'src/main/index.ts'),
      demo: path.join(__dirname, 'src/main/demo/boot.ts')
    } } },
    plugins: [
      // yaml 由 composition 静态 import。外置成 require("yaml") 时，打包机若没
      // npm install 到该包，asar 里就没有它，安装包启动即 Cannot find module 'yaml'。
      // exclude 后打进 bundle，构建期缺包会失败，不会产出一开就崩的安装包。
      externalizeDepsPlugin({ exclude: ['yaml'], include: ['@napi-rs/canvas'] }),
      copyRuntimeBuiltins(),
      copyExtensionSdk(),
      buildExtensionRuntimeWorker(),
      buildDesktopInventoryWorker(),
      buildBuiltinEngineWorker(),
      buildAgentAppsWorker(),
      copyWin32Preload(),
      copyCodexWorker(),
      copyDesktopEscapeMonitor(),
      buildDesktopUnixStopHelpers(),
      copyInboundMcpServer(),
      buildCliEntry(),
      buildAttachmentWorker(),
      buildMessagingRuntime()
    ]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: {
      index: path.join(__dirname, 'src/preload/index.ts'),
      demoReplay: path.join(__dirname, 'src/preload/demoReplay.ts'),
      desktopIndicator: path.join(__dirname, 'src/preload/desktopIndicator.ts')
    } } }
  },
  renderer: {
    plugins: [react()],
    // First inspecting a request during a stream must not trigger Vite's late-dependency page reload.
    optimizeDeps: { include: [
      'jsonc-parser', '@codemirror/state', '@codemirror/view', '@codemirror/lang-json',
      '@codemirror/language', '@lezer/highlight'
    ] },
    server: {
      // 主检出区默认 5188；并行跑第二个 dev（如 worktree）时用 ELECTRON_RENDERER_PORT 覆盖
      port: Number(process.env.ELECTRON_RENDERER_PORT) || 5188,
      strictPort: true
    },
    build: {
      rollupOptions: {
        input: {
          index: path.join(__dirname, 'src/renderer/index.html'),
          demoReplay: path.join(__dirname, 'src/renderer/demo-replay.html'),
          desktopIndicator: path.join(__dirname, 'src/renderer/desktop-indicator.html')
        },
        output: {
          manualChunks: rendererManualChunks
        }
      }
    }
  }
});
