import path from 'node:path';

export function externalExtensionSource(id) {
  const directory = process.env.MUSTER_EXTENSION_FIXTURE_ROOT;
  if (!directory) throw new Error('Set MUSTER_EXTENSION_FIXTURE_ROOT to the parent directory of the extension checkouts');
  return path.resolve(directory, id, id);
}
