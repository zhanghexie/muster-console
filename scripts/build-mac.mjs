import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const developerIdPrefix = 'Developer ID Application: ';
const certificateHash = /^[A-Fa-f0-9]{40}$/;
const require = createRequire(import.meta.url);

export function selectMacSigning(env, findIdentities) {
  const requested = env.CSC_NAME?.trim();
  if (env.CSC_LINK?.trim()) return { mode: 'developer-id' };
  if (!requested && env.CSC_IDENTITY_AUTO_DISCOVERY === 'false') return { mode: 'ad-hoc', identity: '-' };

  const developerIds = new Map();
  for (const line of findIdentities(env.CSC_KEYCHAIN || undefined).split(/\r?\n/)) {
    const match = /^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"(Developer ID Application: [^"]+)"\s*$/.exec(line);
    if (match) developerIds.set(match[1].toUpperCase(), match[2]);
  }
  const matching = [...developerIds].filter(([hash, name]) => !requested || hash === requested.toUpperCase() ||
    requested === name || requested === name.slice(developerIdPrefix.length));
  if (matching.length === 1) return { mode: 'developer-id', identity: matching[0][0] };
  if (requested && !matching.length) throw new Error('CSC_NAME did not match a valid Developer ID Application identity in the macOS Keychain.');
  if (matching.length > 1) throw new Error('Multiple Developer ID Application identities match. Set CSC_NAME to the SHA-1 of the intended certificate.');
  return { mode: 'ad-hoc', identity: '-' };
}

export function macSigningEnvironment(env) {
  const signingEnv = { ...env };
  if (signingEnv.CSC_LINK?.trim()) {
    // The imported certificate is in a temporary keychain. Discover it there
    // without applying the user's filters for the regular keychain.
    delete signingEnv.CSC_NAME;
    signingEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
  } else {
    delete signingEnv.CSC_LINK;
  }
  return signingEnv;
}

function signWithElectronBuilder(options) {
  const builder = createRequire(require.resolve('electron-builder/package.json'));
  return builder('app-builder-lib/out/codeSign/macCodeSign.js').sign(options);
}

/** The named mac.sign hook preserves the resolved fingerprint in signing options. */
export async function sign(options, packager, signApp = signWithElectronBuilder) {
  const { identity } = options;
  const expected = packager.platformSpecificBuildOptions.identity;
  if (identity !== '-' && (typeof identity !== 'string' || !certificateHash.test(identity))) {
    throw new Error('The macOS signer did not resolve an exact certificate fingerprint.');
  }
  if (expected !== undefined && (typeof expected !== 'string' || expected.toUpperCase() !== identity.toUpperCase())) {
    throw new Error('The resolved macOS signing identity does not match the requested certificate fingerprint.');
  }
  // The default electron-builder sign path replaces this hash with the
  // certificate's name. Renewed certificates can share that same name.
  await signApp(options);
}

export function verifySigningDetails(details, appId, adHoc) {
  const lines = details.split(/\r?\n/);
  if (!lines.includes(`Identifier=${appId}`) || !lines.some(line => /^Info\.plist entries=[1-9]\d*$/.test(line)) ||
      !lines.some(line => line.startsWith('Sealed Resources version='))) {
    throw new Error('The packaged app must have its expected bundle identifier, Info.plist and resources sealed by the signature.');
  }
  const valid = adHoc
    ? lines.includes('Signature=adhoc')
    : lines.some(line => line.startsWith(`Authority=${developerIdPrefix}`)) && lines.some(line => /^TeamIdentifier=[A-Z0-9]{10}$/.test(line));
  if (!valid) throw new Error(`The packaged app does not have the expected ${adHoc ? 'ad-hoc' : 'Developer ID Application'} signature.`);
}

/** electron-builder calls this for each architecture before creating its DMG. */
export default async function verifyLocalMacSigning({ appOutDir, packager }) {
  const bundle = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
  const details = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', bundle], { encoding: 'utf8' });
  if (details.error) throw details.error;
  if (details.status !== 0) throw new Error('Could not read the packaged app signature.');
  verifySigningDetails(details.stderr, packager.appInfo.id, packager.platformSpecificBuildOptions.identity === '-');
}

function buildMac(args) {
  if (process.platform !== 'darwin') throw new Error('Local macOS packaging requires macOS.');
  const signing = selectMacSigning(process.env, keychain => execFileSync('/usr/bin/security',
    ['find-identity', '-v', '-p', 'codesigning', ...(keychain ? [keychain] : [])], { encoding: 'utf8', timeout: 10_000 }));
  if (signing.mode === 'ad-hoc') {
    console.log('[mac package] Ad-hoc signature. New builds may require granting macOS desktop permissions again.');
  } else {
    console.log('[mac package] Developer ID Application signature. Keep the same signing team and bundle ID across builds.');
  }
  const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--mac', ...args, '--publish', 'never',
    '-c.forceCodeSigning=true', '-c.mac.type=distribution', '-c.mac.notarize=false', '-c.afterSign=./scripts/build-mac.mjs',
    '-c.mac.sign=./scripts/build-mac.mjs',
    ...(signing.identity ? [`-c.mac.identity=${signing.identity}`] : []),
    `-c.mac.hardenedRuntime=${signing.mode === 'developer-id'}`], { env: macSigningEnvironment(process.env), stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { buildMac(process.argv.slice(2)); }
  catch (error) { console.error(`[mac package] ${error.message}`); process.exitCode = 1; }
}
