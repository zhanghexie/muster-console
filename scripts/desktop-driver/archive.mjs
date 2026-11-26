// Internal archive routines. The public entry point supplies only catalog assets.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { unzipSync } from 'fflate';

const MAX_ENTRIES = 256;
const MAX_TOTAL = 1024 * 1024 * 1024;
const MAX_FILE = 256 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function hashFile(filePath) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}

function limits(asset) {
  const entries = Object.entries(asset.files);
  if (!entries.length || entries.length > MAX_ENTRIES) throw new Error('Invalid pinned file count');
  let total = 0;
  for (const [, item] of entries) {
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      throw new Error('Invalid pinned file metadata');
    }
    total += item.size;
  }
  if (total > MAX_TOTAL) throw new Error('Pinned archive exceeds extraction limit');
  return total;
}

function allowedDirectories(asset) {
  const result = new Set(['']);
  for (const name of Object.keys(asset.files)) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) result.add(parts.slice(0, i).join('/'));
  }
  return result;
}

function relativeName(name, root, isDirectory) {
  if (typeof name !== 'string' || /[\\:\u0000-\u001f\u007f]/.test(name) || name.startsWith('/')) throw new Error('Unsafe archive path');
  const trimmed = isDirectory && name.endsWith('/') ? name.slice(0, -1) : name;
  if (trimmed === root && isDirectory) return '';
  if (!trimmed.startsWith(`${root}/`)) throw new Error('Archive path is outside its pinned root');
  const relative = trimmed.slice(root.length + 1);
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe archive path');
  return relative;
}

function validateEntry(name, isDirectory, asset, directories, seen) {
  const relative = relativeName(name, asset.root, isDirectory);
  if (!relative) return relative;
  const key = relative.toLowerCase();
  if (seen.has(key)) throw new Error('Duplicate or case-colliding archive path');
  seen.add(key);
  if (isDirectory ? !directories.has(relative) : !Object.hasOwn(asset.files, relative)) {
    throw new Error(`Unexpected archive entry: ${relative}`);
  }
  return relative;
}

function destination(root, relative) {
  return path.join(root, ...relative.split('/'));
}

function writeBuffer(root, relative, bytes, expected) {
  if (bytes.length !== expected.size || digest(bytes) !== expected.sha256) throw new Error(`File checksum mismatch: ${relative}`);
  const target = destination(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  if (process.platform !== 'win32' && expected.mode !== null && expected.mode !== undefined) fs.chmodSync(target, expected.mode);
}

function zipDirectory(buffer, asset) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP end record is missing');
  const disk = buffer.readUInt16LE(eocd + 4), cdDisk = buffer.readUInt16LE(eocd + 6);
  const onDisk = buffer.readUInt16LE(eocd + 8), count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12), cdOffset = buffer.readUInt32LE(eocd + 16);
  if (disk || cdDisk || onDisk !== count || count > MAX_ENTRIES || count === 0xffff || cdOffset + cdSize !== eocd) throw new Error('Unsupported ZIP directory');
  let cursor = cdOffset;
  const seen = new Set(), names = new Set(), dirs = allowedDirectories(asset);
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP directory entry');
    const creator = buffer.readUInt16LE(cursor + 4) >> 8, flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10), size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    const external = buffer.readUInt32LE(cursor + 38), next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > eocd || (flags & 1) || ![0, 8].includes(method) || size === 0xffffffff) throw new Error('Unsupported ZIP entry');
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    if (!(flags & 0x800) && nameBytes.some(byte => byte >= 0x80)) throw new Error('Unsupported ZIP name encoding');
    const name = decoder.decode(nameBytes), isDirectory = name.endsWith('/');
    const kind = (external >>> 16) & 0o170000;
    if (creator === 3 && kind && kind !== (isDirectory ? 0o040000 : 0o100000)) throw new Error('Links and special ZIP entries are unsupported');
    const relative = validateEntry(name, isDirectory, asset, dirs, seen);
    if (!isDirectory && relative) {
      if (size !== asset.files[relative].size) throw new Error(`ZIP size mismatch: ${relative}`);
      names.add(relative);
    }
    cursor = next;
  }
  if (cursor !== eocd || names.size !== Object.keys(asset.files).length) throw new Error('ZIP file list does not match the pinned release');
}

function extractZip(archivePath, payload, asset) {
  const bytes = fs.readFileSync(archivePath);
  zipDirectory(bytes, asset);
  const entries = unzipSync(bytes);
  let files = 0;
  for (const [name, data] of Object.entries(entries)) {
    const isDirectory = name.endsWith('/');
    const relative = relativeName(name, asset.root, isDirectory);
    if (!relative || isDirectory) continue;
    const expected = asset.files[relative];
    if (!expected) throw new Error(`Unexpected ZIP file: ${relative}`);
    writeBuffer(payload, relative, data, expected);
    files++;
  }
  if (files !== Object.keys(asset.files).length) throw new Error('ZIP file list is incomplete');
}

function tarString(bytes) {
  const nul = bytes.indexOf(0);
  return decoder.decode(nul < 0 ? bytes : bytes.subarray(0, nul));
}
function tarNumber(bytes) {
  const text = tarString(bytes).trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error('Unsupported TAR numeric field');
  const number = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(number)) throw new Error('TAR numeric field is too large');
  return number;
}
function readExact(fd, buffer, offset) {
  let done = 0;
  while (done < buffer.length) {
    const read = fs.readSync(fd, buffer, done, buffer.length - done, offset + done);
    if (!read) throw new Error('Truncated TAR archive');
    done += read;
  }
}
function extractTar(tarPath, payload, asset) {
  const fd = fs.openSync(tarPath, 'r');
  const archiveSize = fs.fstatSync(fd).size;
  const dirs = allowedDirectories(asset), seen = new Set(), files = new Set();
  let offset = 0, count = 0, endFound = false;
  try {
    while (offset + 512 <= archiveSize) {
      const header = Buffer.alloc(512);
      readExact(fd, header, offset);
      offset += 512;
      if (header.every(byte => byte === 0)) { endFound = true; break; }
      if (++count > MAX_ENTRIES) throw new Error('Too many TAR entries');
      let sum = 0;
      for (let i = 0; i < header.length; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
      if (sum !== tarNumber(header.subarray(148, 156))) throw new Error('Invalid TAR header checksum');
      const prefix = tarString(header.subarray(345, 500)), basename = tarString(header.subarray(0, 100));
      const name = prefix ? `${prefix}/${basename}` : basename;
      const type = header[156], isDirectory = type === 53;
      if (!(type === 0 || type === 48 || isDirectory)) throw new Error('Links, extensions and special TAR entries are unsupported');
      const size = tarNumber(header.subarray(124, 136));
      const mode = tarNumber(header.subarray(100, 108)) & 0o777;
      if (isDirectory && size !== 0) throw new Error('Invalid TAR directory size');
      if (offset + Math.ceil(size / 512) * 512 > archiveSize) throw new Error('Truncated TAR payload');
      const relative = validateEntry(name, isDirectory, asset, dirs, seen);
      if (relative && isDirectory) fs.mkdirSync(destination(payload, relative), { recursive: true, mode: 0o700 });
      if (relative && !isDirectory) {
        const expected = asset.files[relative];
        if (size !== expected.size || (expected.mode !== null && expected.mode !== undefined && mode !== expected.mode)) throw new Error(`TAR metadata mismatch: ${relative}`);
        const target = destination(payload, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const out = fs.openSync(target, 'wx', 0o600), hash = createHash('sha256');
        try {
          let copied = 0;
          const chunk = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, size)));
          while (copied < size) {
            const length = Math.min(chunk.length, size - copied), part = chunk.subarray(0, length);
            readExact(fd, part, offset + copied);
            hash.update(part);
            let written = 0;
            while (written < length) written += fs.writeSync(out, part, written, length - written);
            copied += length;
          }
          if (hash.digest('hex') !== expected.sha256) throw new Error(`File checksum mismatch: ${relative}`);
          if (process.platform !== 'win32' && expected.mode !== null && expected.mode !== undefined) fs.fchmodSync(out, expected.mode);
        } finally { fs.closeSync(out); }
        files.add(relative);
      }
      offset += Math.ceil(size / 512) * 512;
    }
    if (!endFound || files.size !== Object.keys(asset.files).length) throw new Error('TAR file list is incomplete');
  } finally { fs.closeSync(fd); }
}

export async function extractVerifiedArchive(archivePath, payload, asset, scratchTar) {
  const expectedTotal = limits(asset);
  const first = await hashFile(archivePath);
  if (first.size !== asset.size || first.sha256 !== asset.sha256) throw new Error('Pinned archive checksum mismatch');
  fs.mkdirSync(payload, { mode: 0o700 });
  if (asset.format === 'zip') extractZip(archivePath, payload, asset);
  else if (asset.format === 'tar.gz') {
    let expanded = 0;
    const bound = expectedTotal + 8 * 1024 * 1024;
    const limit = new Transform({ transform(chunk, _encoding, callback) {
      expanded += chunk.length;
      callback(expanded > bound ? new Error('Expanded TAR exceeds its bound') : null, chunk);
    } });
    await pipeline(fs.createReadStream(archivePath), createGunzip(), limit, fs.createWriteStream(scratchTar, { flags: 'wx', mode: 0o600 }));
    extractTar(scratchTar, payload, asset);
  } else throw new Error(`Unsupported archive format: ${asset.format}`);
  if (process.platform !== 'win32' && asset.directoryMode !== null && asset.directoryMode !== undefined) {
    for (const relative of allowedDirectories(asset)) fs.chmodSync(relative ? destination(payload, relative) : payload, asset.directoryMode);
  }
  const second = await hashFile(archivePath);
  if (second.size !== asset.size || second.sha256 !== asset.sha256) throw new Error('Archive changed during extraction');
  await verifyBundle(payload, asset);
}

export async function verifyBundle(directory, asset) {
  limits(asset);
  const rootStat = await fs.promises.lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Driver bundle is not a real directory');
  if (process.platform !== 'win32' && asset.directoryMode !== null && asset.directoryMode !== undefined && (rootStat.mode & 0o777) !== asset.directoryMode) {
    throw new Error('Driver bundle directory mode mismatch');
  }
  const allowed = allowedDirectories(asset), found = new Set();
  async function walk(relative) {
    for (const entry of await fs.promises.readdir(relative ? destination(directory, relative) : directory, { withFileTypes: true })) {
      const item = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Unexpected bundle link: ${item}`);
      if (entry.isDirectory()) {
        if (!allowed.has(item)) throw new Error(`Unexpected bundle directory: ${item}`);
        if (process.platform !== 'win32' && asset.directoryMode !== null && asset.directoryMode !== undefined) {
          const dirStat = await fs.promises.lstat(destination(directory, item));
          if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o777) !== asset.directoryMode) throw new Error(`Bundle directory mode mismatch: ${item}`);
        }
        await walk(item);
      } else if (entry.isFile() && Object.hasOwn(asset.files, item)) {
        const expected = asset.files[item], full = destination(directory, item), stat = await fs.promises.lstat(full);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid bundle file: ${item}`);
        if (process.platform !== 'win32' && expected.mode !== null && expected.mode !== undefined && (stat.mode & 0o777) !== expected.mode) throw new Error(`Bundle mode mismatch: ${item}`);
        const actual = await hashFile(full);
        if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error(`Bundle checksum mismatch: ${item}`);
        found.add(item);
      } else throw new Error(`Unexpected bundle entry: ${item}`);
    }
  }
  await walk('');
  if (found.size !== Object.keys(asset.files).length) throw new Error('Driver bundle is missing pinned files');
  return { files: found.size };
}
