import fs from 'node:fs/promises';
import path from 'node:path';

/** Build-time assets for the supervised Unix Escape and Wayland Stop helpers. */
export async function buildDesktopStopAssets(projectRoot: string, outputRoot = projectRoot): Promise<void> {
  if (!path.isAbsolute(projectRoot) || !path.isAbsolute(outputRoot)) throw new Error('Desktop helper build paths must be absolute');
  const esbuild = await import('esbuild');
  const source = path.join(projectRoot, 'src', 'main', 'desktop');
  const output = path.join(outputRoot, 'out', 'main', 'desktop');
  await fs.mkdir(output, { recursive: true });
  await esbuild.build({ entryPoints: [path.join(source, 'unixEscapeWorker.ts')],
    outfile: path.join(output, 'unix-escape-worker.cjs'), bundle: true, platform: 'node', format: 'cjs',
    packages: 'external', logLevel: 'silent' });
  await fs.copyFile(path.join(source, 'waylandStopHelper.py'), path.join(output, 'waylandStopHelper.py'));
}
