/** Resolve files deliberately unpacked from an Electron asar on every platform. */
export function toUnpackedAsarPath(file: string): string {
  return file.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
}
