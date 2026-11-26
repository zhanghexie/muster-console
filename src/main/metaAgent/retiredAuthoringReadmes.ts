import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// SHA-256 of the former generators' outputs, with LF and outer whitespace normalized.
// A managed marker alone does not distinguish generated content from local edits.
const generatedReadmes = {
  extensions: [
    'b030b4241ef92afc5ebfc4aa9fed9639a690f4ff5bd0037e7cbf16c97a0e61df',
    'c69cb8683cef02ca120427755bc494e6f7eab93b16f6ccc4f1cfb955aee5894a',
    '64706a0eafcecfdcb0279a37b80b47606618750dd501015d857a9c2df2f934f8' // English authoring guide
  ],
  workflows: [
    '7d4488f8ce5c9372adc39322ca5ad4e35880e19564c97b3ca1aa2deacaa8ed00',
    'b2ed8f9c3be7052d33e93fb52c71ebcce0c75ed99703d61bdadf507f9db358b7'
  ]
};

/** Remove only intact copies of the retired public guides in this workspace. */
export function removeRetiredAuthoringReadmes(managementDirectory: string): void {
  if (!fs.lstatSync(managementDirectory).isDirectory()) return;
  for (const [name, fingerprints] of Object.entries(generatedReadmes)) {
    const directory = path.join(managementDirectory, name);
    const file = path.join(directory, 'README.md');
    try {
      if (!fs.lstatSync(directory).isDirectory()) continue;
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.size > 64 * 1024) continue;
      const contents = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
      const fingerprint = createHash('sha256').update(contents).digest('hex');
      if (!fingerprints.includes(fingerprint)) continue;
      const after = fs.lstatSync(file);
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.ctimeMs !== after.ctimeMs) continue;
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[muster] Could not remove retired authoring README:', file, error);
      }
    }
  }
}
