import path from 'node:path';

/** SQLite on Windows needs a namespaced filesystem path for long names. */
export function sqliteFilePath(file: string, platform: NodeJS.Platform = process.platform): string {
  if (file === ':memory:' || file.startsWith('file:') || platform !== 'win32') return file;
  return path.win32.toNamespacedPath(file);
}
