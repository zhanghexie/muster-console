// Build-time only: never downloads or trusts a caller-supplied digest.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existingLocation } from './cache.mjs';
import { inspectPrepared } from './prepare.mjs';
import { resolveAsset } from './catalog.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLATFORM_KEYS = Object.freeze({ win32: 'win', darwin: 'mac', linux: 'linux' });
const ARCH_NAMES = Object.freeze(['ia32', 'x64', 'armv7l', 'arm64', 'universal']);

/** Translate electron-builder's target, not the host running the build. */
export function buildTarget(platform, arch) {
  const key = PLATFORM_KEYS[platform];
  const name = typeof arch === 'number' ? ARCH_NAMES[arch] : arch;
  if (!key || typeof name !== 'string') throw new Error(`Unsupported Cua build target: ${platform}/${String(name)}`);
  const assetArch = platform === 'darwin' && name === 'universal' ? 'x64' : name;
  try { resolveAsset(platform, assetArch); }
  catch { throw new Error(`No pinned Cua build asset for ${platform}/${name}`); }
  if (name === 'universal' && platform !== 'darwin') throw new Error(`No pinned Cua build asset for ${platform}/${name}`);
  return { platform, arch: name, assetArch, cacheName: `${key}-${name}` };
}

export function cachePath(projectRoot, target) {
  return path.join(path.resolve(projectRoot), '.tmp', 'desktop-driver', target.cacheName);
}

export function assertBuildModes(result, target) {
  if (target.platform !== 'win32' && result.modeVerified !== true) {
    throw new Error(`Cannot verify Unix executable modes for ${target.platform}/${target.arch} on ${process.platform}; prepare and package on macOS or Linux`);
  }
}

/** Recheck both Git cache policy and pinned contents immediately before a build. */
export async function verifyBuildCache(projectRoot, platform, arch) {
  const target = buildTarget(platform, arch), output = cachePath(projectRoot, target);
  try {
    existingLocation(output, projectRoot);
    const result = await inspectPrepared(output, { platform: target.platform, arch: target.assetArch });
    assertBuildModes(result, target);
    return { ...target, output, driverPath: result.driverPath };
  } catch (error) {
    throw new Error(
      `Cua driver cache is missing or invalid for ${platform}/${target.arch} at ${output}: ${error.message}. ` +
      `Prepare the pinned archive with node scripts/desktop-driver/prepare.mjs --prepare --platform ${platform} ` +
      `--arch ${target.assetArch} --output "${output}" --archive "<verified local archive>"`,
      { cause: error }
    );
  }
}

export async function beforePack(context) {
  const result = await verifyBuildCache(context.packager.projectDir, context.electronPlatformName, context.arch);
  console.log(`[desktop-driver] Verified pinned cache for ${result.platform}/${result.arch}: ${result.output}`);
}

export default beforePack;

/** electron-builder has already copied extraResources; verify the actual staged files. */
export async function afterPack(context) {
  const target = buildTarget(context.electronPlatformName, context.arch);
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const output = path.join(resources, 'desktop-driver');
  try {
    const result = await inspectPrepared(output, { platform: target.platform, arch: target.assetArch });
    assertBuildModes(result, target);
  } catch (error) {
    throw new Error(`Packaged Cua driver is missing or differs from the pinned ${target.platform}/${target.arch} bundle at ${output}: ${error.message}`, { cause: error });
  }
  console.log(`[desktop-driver] Verified staged resources for ${target.platform}/${target.arch}: ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--check-host') {
    console.error('Usage: node scripts/desktop-driver/build.mjs --check-host');
    process.exitCode = 1;
  } else {
    verifyBuildCache(PROJECT_ROOT, process.platform, process.arch)
      .then(result => console.log(`[desktop-driver] Verified development cache: ${result.output}`))
      .catch(error => { console.error(`[desktop-driver] ${error.message}`); process.exitCode = 1; });
  }
}
