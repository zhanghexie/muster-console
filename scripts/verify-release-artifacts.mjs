import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.resolve(process.argv[2] ?? path.join(root, 'release'));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const supported = /\.(?:exe|dmg|AppImage|deb)$/i;

function collect(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (/-unpacked$/i.test(entry.name) || entry.name.endsWith('.app')) continue;
      result.push(...collect(file));
    }
    else if (entry.isFile() && supported.test(entry.name)) result.push(file);
  }
  return result;
}

const files = collect(releaseDir);
if (!files.length) throw new Error(`No release installers found under ${releaseDir}`);
const escapedVersion = packageJson.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const versionToken = new RegExp(`(?:^|[-_.])${escapedVersion}(?:[-_.]|$)`);
const missingVersion = files.filter(file => !versionToken.test(path.basename(file)));
if (missingVersion.length) {
  throw new Error(`Release artifact filename is missing package version ${packageJson.version}: ${missingVersion.map(file => path.basename(file)).join(', ')}`);
}
const artifacts = files.sort().map(file => ({
  file: path.relative(releaseDir, file).replaceAll(path.sep, '/'),
  bytes: fs.statSync(file).size,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}));
const manifest = { product: packageJson.name, version: packageJson.version, generatedAt: new Date().toISOString(), artifacts };
fs.writeFileSync(path.join(releaseDir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`release artifacts verified: ${artifacts.length} files, version ${packageJson.version}`);
