import { openSync, closeSync, fsyncSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export function privateDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
    throw new Error('Keyshoal requires a private data directory owned by your account.');
  }
  return dir;
}

export function readPrivate(file, maxBytes) {
  let stat;
  try { stat = lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.size > maxBytes ||
      (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
    throw new Error('Invalid or unprotected Keyshoal file.');
  }
  return readFileSync(file);
}

export function writePrivate(file, bytes) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.new-' + randomBytes(16).toString('hex'));
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* only this operation's temporary file */ }
    throw error;
  }
  // A rename is already committed for this process. Don't report a failed
  // commit (and diverge memory/disk) if the filesystem can't fsync directories.
  if (process.platform !== 'win32') {
    try {
      const directory = openSync(dir, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { /* best effort on filesystems without directory fsync */ }
  }
}
