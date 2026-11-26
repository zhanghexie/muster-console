import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Copy after the main build; electron-builder must also unpack this path. */
export function copyWaylandStopHelper(projectRoot) {
  const root = path.resolve(projectRoot);
  const source = path.join(root, 'src', 'main', 'desktop', 'waylandStopHelper.py');
  const directory = path.join(root, 'out', 'main', 'desktop');
  const destination = path.join(directory, 'waylandStopHelper.py');
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(source, destination);
  return destination;
}

const current = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === current) {
  const root = path.resolve(path.dirname(current), '../..');
  console.log(copyWaylandStopHelper(root));
}
