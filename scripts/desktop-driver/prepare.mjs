import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DRIVER_COMMIT, DRIVER_VERSION, resolveAsset, supportedTargets } from './catalog.mjs';
import { extractVerifiedArchive, verifyBundle, hashFile } from './archive.mjs';
import { downloadPinned } from './download.mjs';
import { assertUnlinkedDirectory, outputLocation, directoryIdentity, cleanupOwnedScratch, publishContents } from './cache.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..', '..');
const NOTICE_PINS = Object.freeze({
  'node-runtime-NOTICE.md': Object.freeze({ size: 531, sha256: '66a466cc022b4bf4a41f678e4d31d9b82098cc55cc364d6e9295366dfd02cef2' }),
  'MPL-2.0.txt': Object.freeze({ size: 16726, sha256: '3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04' }),
  'SOURCES.md': Object.freeze({ size: 1439, sha256: 'd90c292a04bcfed617cfc17fbcd7da8f2449460a302a459b1d3c9bb320337446' })
});
const NOTICE_NAMES = Object.keys(NOTICE_PINS);

function copyNotices(target) {
  fs.mkdirSync(target, { mode: 0o700 });
  for (const name of NOTICE_NAMES) fs.copyFileSync(path.join(here, 'notices', name), path.join(target, name), fs.constants.COPYFILE_EXCL);
}

export async function verifyNotices(directory) {
  const root = await fs.promises.lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Driver notices directory is missing or invalid');
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  if (entries.length !== NOTICE_NAMES.length) throw new Error('Driver notices are incomplete or contain extra entries');
  for (const name of NOTICE_NAMES) {
    const entry = entries.find(item => item.name === name);
    if (!entry?.isFile() || entry.isSymbolicLink()) throw new Error(`Missing driver notice: ${name}`);
    const actual = await hashFile(path.join(directory, name));
    const expected = NOTICE_PINS[name];
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error(`Driver notice differs from the supplied material: ${name}`);
  }
}

/** Fixed asset lookup; this is not a probe of OS permissions or runtime capability. */
export function describeTarget(platform = process.platform, arch = process.arch) {
  const asset = resolveAsset(platform, arch);
  return { platform, arch, version: DRIVER_VERSION, commit: DRIVER_COMMIT, name: asset.name,
    url: asset.url, size: asset.size, sha256: asset.sha256, signatureVerified: false, distributionReady: false };
}

/** Environment hints do not prove that a compositor, permission or driver works. */
export function describeDesktopEnvironment(platform = process.platform, env = process.env) {
  if (platform !== 'linux') return { session: 'unverified', source: 'not-probed' };
  const type = String(env.XDG_SESSION_TYPE ?? '').trim().toLowerCase();
  const wayland = Boolean(String(env.WAYLAND_DISPLAY ?? '').trim());
  const x11 = Boolean(String(env.DISPLAY ?? '').trim());
  const session = type === 'x11' && wayland ? 'ambiguous'
    : type === 'wayland' || wayland ? 'wayland'
      : type === 'x11' || x11 ? 'x11' : 'unknown';
  return { session, source: 'environment-only' };
}

/** Verify existing files against fixed catalog hashes, never against a local receipt. */
export async function inspectPrepared(output, { platform = process.platform, arch = process.arch } = {}) {
  const asset = resolveAsset(platform, arch);
  if (typeof output !== 'string' || !path.isAbsolute(output)) throw new Error('Output must be an absolute path');
  if (output.split(/[\\/]+/).includes('..')) throw new Error('Output path cannot contain parent traversal');
  assertUnlinkedDirectory(output);
  const contents = path.join(output, 'contents'), stat = await fs.promises.lstat(contents);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Prepared contents is not a real directory');
  const entries = await fs.promises.readdir(contents);
  if (entries.length !== 2 || !entries.includes('driver') || !entries.includes('notices')) throw new Error('Prepared contents has missing or unexpected entries');
  const result = await verifyBundle(path.join(contents, 'driver'), asset);
  await verifyNotices(path.join(contents, 'notices'));
  // Windows bundles do not have POSIX executable modes to verify.
  const modeVerified = platform === 'win32' ? null : process.platform !== 'win32';
  return { ...describeTarget(platform, arch), contentVerified: true, files: result.files,
    modeVerified, runtimeVerified: false, hostMatchesTarget: platform === process.platform && arch === process.arch,
    desktopEnvironment: platform === process.platform ? describeDesktopEnvironment(platform) : { session: 'unverified', source: 'different-host' },
    driverPath: path.join(contents, 'driver', platform === 'win32' ? 'cua-driver.exe' : 'cua-driver') };
}

/** Prepare a new directory only; never overwrites or downloads into tracked paths. */
export async function prepareDriver({ output, platform = process.platform, arch = process.arch, archivePath } = {}) {
  const asset = resolveAsset(platform, arch);
  // Windows cannot preserve the Unix executable modes needed by these bundles.
  if (process.platform === 'win32' && platform !== 'win32') throw new Error('Preparing a Unix bundle on Windows cannot preserve executable modes; run preparation on macOS or Linux');
  const location = outputLocation(output, projectRoot), { parent, target } = location;
  const scratch = fs.mkdtempSync(path.join(parent, '.cua-driver-'));
  let scratchIdentity;
  try { scratchIdentity = directoryIdentity(scratch); }
  catch (error) { throw new Error(`Cannot identify new scratch directory; preserved at ${scratch}: ${error.message}`, { cause: error }); }
  let published = false, failure;
  try {
    const archive = path.join(scratch, asset.name), contents = path.join(scratch, 'contents');
    fs.mkdirSync(contents, { mode: 0o700 });
    if (archivePath !== undefined) {
      if (typeof archivePath !== 'string' || !path.isAbsolute(archivePath)) throw new Error('Archive must be an absolute file path');
      const stat = fs.lstatSync(archivePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Archive must be a regular file, not a link');
      fs.copyFileSync(archivePath, archive, fs.constants.COPYFILE_EXCL);
    } else await downloadPinned(asset, archive);
    await extractVerifiedArchive(archive, path.join(contents, 'driver'), asset, path.join(scratch, 'unpacked.tar'));
    copyNotices(path.join(contents, 'notices'));
    await verifyNotices(path.join(contents, 'notices'));
    publishContents(contents, location);
    published = true;
  } catch (error) { failure = error; }
  try { cleanupOwnedScratch(scratch, parent, scratchIdentity); }
  catch (error) {
    throw new Error(`Scratch cleanup failed at ${scratch}${published ? `; prepared files remain at ${target}` : ''}: ${error.message}`, { cause: failure ?? error });
  }
  if (failure) throw failure;
  return inspectPrepared(target, { platform, arch });
}

function parseArgs(args) {
  const options = {};
  let action;
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (['--list', '--prepare', '--check'].includes(value)) {
      if (action) throw new Error('Choose exactly one action');
      action = value;
    } else if (['--platform', '--arch', '--output', '--archive'].includes(value)) {
      const next = args[++i];
      if (!next || next.startsWith('--') || Object.hasOwn(options, value)) throw new Error(`Missing or duplicate value for ${value}`);
      options[value] = next;
    } else throw new Error(`Unknown argument: ${value}`);
  }
  if (!action) throw new Error('Use --list, --prepare or --check');
  if (action === '--list' && Object.keys(options).length) throw new Error('--list takes no options');
  if (action !== '--list' && !options['--output']) throw new Error('--output is required');
  if (action === '--check' && options['--archive']) throw new Error('--archive is valid only with --prepare');
  return { action, options };
}

async function main() {
  const { action, options } = parseArgs(process.argv.slice(2));
  if (action === '--list') return supportedTargets().map(key => {
    const separator = key.lastIndexOf('-');
    return describeTarget(key.slice(0, separator), key.slice(separator + 1));
  });
  const target = { platform: options['--platform'] ?? process.platform, arch: options['--arch'] ?? process.arch };
  return action === '--prepare'
    ? prepareDriver({ ...target, output: options['--output'], archivePath: options['--archive'] })
    : inspectPrepared(options['--output'], target);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(`Desktop driver preparation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
